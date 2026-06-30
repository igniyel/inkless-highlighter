/**
 * Plugin entry point.
 *
 * Responsibilities:
 *  - Load / save persisted data through HighlightStore.
 *  - Re-apply stored annotations onto every rendered note via a Markdown
 *    post-processor (the only reliable hook for Reading view, including lazy
 *    rendering of long notes).
 *  - Turn a drag-selection in Reading view into a new annotation (no hotkeys).
 *  - Manage existing annotations (recolour / convert / copy / delete).
 *  - Own the floating toolbar and the active-tool state, and expose the UIHost
 *    contract the UI calls back into.
 */

import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type App,
  type MarkdownPostProcessorContext,
} from "obsidian";
import {
  applyPartLive,
  applyToContainer,
  captureSelection,
  genId,
  restyleGroup,
  unwrapById,
} from "./engine";
import { HighlightStore } from "./store";
import { ReadingHighlighterSettingTab } from "./settings";
import {
  Toolbar,
  dismissPopovers,
  openAnnotationPopover,
  type UIHost,
} from "./ui";
import {
  ATTR_GROUP,
  ATTR_ID,
  READING_VIEW_SELECTOR,
  defaultToolbarPlacement,
} from "./constants";
import type {
  ActiveTool,
  HighlightRecord,
  PluginSettings,
  ToolType,
  ToolbarCorner,
  ToolbarPlacement,
} from "./types";

/** Minimal structural types for semi-private Obsidian APIs we touch. */
interface AppWithSetting extends App {
  setting?: { open(): void; openTabById(id: string): void };
}
interface Rerenderable {
  rerender?(full?: boolean): void;
}

/**
 * One reversible change to a single annotation group, expressed as the group's
 * full record set before and after. An empty array means "the group did not
 * exist" — so creation is `before: []`, deletion is `after: []`, and an edit
 * (recolour / convert) carries both states.
 */
interface HistoryOp {
  groupId: string;
  before: HighlightRecord[];
  after: HighlightRecord[];
}

export default class ReadingHighlighterPlugin extends Plugin implements UIHost {
  store!: HighlightStore;
  /** Same object reference as store.settings, so edits propagate both ways. */
  settings!: PluginSettings;
  /** Device-local toolbar placement (kept out of synced data). */
  private toolbarPlacement!: ToolbarPlacement;
  private toolbar!: Toolbar;
  private activeTool: ActiveTool = null;
  /** Timestamp of the last successful capture, to swallow the trailing click. */
  private lastCaptureAt = 0;
  private lastSyncTimestamp = 0;
  private syncTimer: number | null = null;
  private lazyObserver: IntersectionObserver | null = null;
  private orphanPanel: HTMLElement | null = null;

  /**
   * In-memory undo/redo history, one stack pair per file. Not persisted: it is
   * renewed whenever a note's tab is (re)opened, and capped per file.
   */
  private history = new Map<string, { undo: HistoryOp[]; redo: HistoryOp[] }>();
  /** Set while undo/redo is replaying, so the replay itself isn't recorded. */
  private applyingHistory = false;
  /** Most undoable steps kept per file. */
  private static readonly MAX_HISTORY = 50;

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.store = new HighlightStore(loaded ?? null, (data) => this.saveData(data));
    await this.store.init(this.manifest.id, this.app.vault.getName());
    this.settings = this.store.settings;

    this.toolbarPlacement = this.loadToolbarPlacement();

    this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));

    this.toolbar = new Toolbar(this);

    this.lazyObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.lazyObserver?.unobserve(entry.target);
        const target = entry.target as HTMLElement & { rhlLazyApply?: () => void };
        target.rhlLazyApply?.();
      }
    }, { rootMargin: "600px 0px" });

    // Re-apply annotations on every render.
    this.registerMarkdownPostProcessor((el, ctx) => this.postProcess(el, ctx));
    this.registerDomEvent(document, "rhl-orphan" as keyof DocumentEventMap, (ev) => this.showOrphan(ev as CustomEvent), true);

    // Create annotations from a drag-selection (Reading view only).
    this.registerDomEvent(document, "pointerup", (ev) => this.onPointerUp(ev));

    // Manage / erase annotations on click.
    this.registerDomEvent(document, "click", (ev) => this.onClick(ev), true);

    // Undo / redo the most recent annotation changes (Reading view only).
    this.registerDomEvent(document, "keydown", (ev) => this.onKeyDown(ev), true);

    // Renew a note's undo history whenever its tab is opened.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile) void this.restorePersistentHistory(file.path);
      }),
    );

    // Toolbar visibility tracks the active leaf's mode.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.updateToolbarVisibility()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.updateToolbarVisibility()),
    );

    // Import CRDT sync payloads emitted by another device.
    this.registerEvent(
      this.app.vault.on("create", (file) => void this.importSyncFile(file)),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => void this.importSyncFile(file)),
    );

    // Keep annotations attached to their note across renames / deletes.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.settings.followRenames && file instanceof TFile) {
          this.store.rename(oldPath, file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.settings.pruneOnDelete && file instanceof TFile) {
          this.store.deleteFile(file.path);
        }
      }),
    );

    this.registerCommands();

    this.app.workspace.onLayoutReady(() => this.updateToolbarVisibility());
  }

  async onunload(): Promise<void> {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    await this.writeSyncSnapshot();
    dismissPopovers();
    this.setBodyState(null);
    this.lazyObserver?.disconnect();
    this.orphanPanel?.remove();
    this.toolbar?.destroy();
    await this.store?.persistNow();
  }

  /* ------------------------------------------------------------------ */
  /* UIHost contract                                                     */
  /* ------------------------------------------------------------------ */

  getActiveTool(): ActiveTool {
    return this.activeTool;
  }

  setActiveTool(tool: ActiveTool): void {
    this.activeTool = tool;
    this.setBodyState(tool);
    this.toolbar?.render();
  }

  resolveColor(colorId: string): string {
    const found = this.settings.palette.find((c) => c.id === colorId);
    if (found) return found.color;
    return this.settings.palette[0]?.color ?? "#ffd54f";
  }

  getToolColorId(tool: ToolType): string {
    return tool === "highlight"
      ? this.settings.lastHighlightColorId
      : this.settings.lastUnderlineColorId;
  }

  setToolColorId(tool: ToolType, colorId: string): void {
    if (tool === "highlight") this.settings.lastHighlightColorId = colorId;
    else this.settings.lastUnderlineColorId = colorId;
  }

  saveSettings(): void {
    this.store.scheduleSave();
    this.toolbar?.render();
  }

  /* ----- device-local toolbar placement ----- */

  getToolbarPlacement(): ToolbarPlacement {
    return this.toolbarPlacement;
  }

  /** Persist the toolbar placement to this device only (never synced). */
  saveToolbarPlacement(): void {
    const key = this.toolbarStorageKey();
    try {
      if (typeof this.app.saveLocalStorage === "function") {
        this.app.saveLocalStorage(key, this.toolbarPlacement);
      } else {
        window.localStorage.setItem(this.fallbackKey(key), JSON.stringify(this.toolbarPlacement));
      }
    } catch {
      /* localStorage may be unavailable; placement just won't persist. */
    }
  }

  private toolbarStorageKey(): string {
    return `${this.manifest.id}:toolbar-placement`;
  }

  /**
   * window.localStorage is shared across vaults on a device, so namespace the
   * fallback key by vault name. (App.loadLocalStorage already scopes per vault.)
   */
  private fallbackKey(key: string): string {
    return `${key}:${this.app.vault.getName()}`;
  }

  /** Read the per-device placement, falling back to a sane default. */
  private loadToolbarPlacement(): ToolbarPlacement {
    const fallback = defaultToolbarPlacement();
    const key = this.toolbarStorageKey();
    let raw: unknown = null;
    try {
      if (typeof this.app.loadLocalStorage === "function") {
        raw = this.app.loadLocalStorage(key);
      } else {
        const stored = window.localStorage.getItem(this.fallbackKey(key));
        raw = stored ? JSON.parse(stored) : null;
      }
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "object") return fallback;
    const p = raw as Partial<ToolbarPlacement>;
    const corners: ToolbarCorner[] = ["tl", "tr", "bl", "br"];
    return {
      corner: corners.includes(p.corner as ToolbarCorner) ? (p.corner as ToolbarCorner) : "br",
      x: typeof p.x === "number" && Number.isFinite(p.x) ? p.x : null,
      y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : null,
    };
  }

  openSettings(): void {
    const app = this.app as AppWithSetting;
    app.setting?.open();
    app.setting?.openTabById(this.manifest.id);
  }

  recolorAnnotation(el: HTMLElement, colorId: string): void {
    const path = this.activeFilePath();
    const groupId = el.getAttribute(ATTR_GROUP);
    const id = el.getAttribute(ATTR_ID);
    if (!path || !groupId || !id) return;
    const rec = this.store.findById(path, id);
    if (!rec) return;
    const before = this.snapshotGroup(path, groupId);
    const color = this.resolveColor(colorId);
    this.store.updateGroup(path, groupId, { colorId, color });
    this.scheduleSyncExport();
    const root = this.rootFor(el);
    restyleGroup(root, groupId, { ...rec, colorId, color }, this.settings);
    this.recordHistory(path, groupId, before, this.snapshotGroup(path, groupId));
  }

  switchAnnotationType(el: HTMLElement): void {
    const path = this.activeFilePath();
    const groupId = el.getAttribute(ATTR_GROUP);
    const id = el.getAttribute(ATTR_ID);
    if (!path || !groupId || !id) return;
    const rec = this.store.findById(path, id);
    if (!rec) return;
    const before = this.snapshotGroup(path, groupId);
    const nextType: ToolType = rec.type === "highlight" ? "underline" : "highlight";
    const patch: Partial<HighlightRecord> = { type: nextType };
    if (nextType === "underline" && !rec.underline) {
      patch.underline = { ...this.settings.underline };
    }
    this.store.updateGroup(path, groupId, patch);
    this.scheduleSyncExport();
    const root = this.rootFor(el);
    restyleGroup(root, groupId, { ...rec, ...patch }, this.settings);
    this.recordHistory(path, groupId, before, this.snapshotGroup(path, groupId));
  }

  deleteAnnotationEl(el: HTMLElement): void {
    const path = this.activeFilePath();
    const groupId = el.getAttribute(ATTR_GROUP);
    if (!path || !groupId) return;
    if (this.settings.confirmDelete && !confirm("Delete this annotation?")) return;
    const removed = this.store.removeGroup(path, groupId);
    removed.forEach((r) => unwrapById(document, r.id));
    if (removed.length) {
      this.recordHistory(path, groupId, cloneRecords(removed), []);
      this.scheduleSyncExport();
    }
  }

  copyAnnotationText(el: HTMLElement): void {
    const groupId = el.getAttribute(ATTR_GROUP);
    if (!groupId) return;
    const parts = Array.from(
      document.querySelectorAll<HTMLElement>(`[${ATTR_GROUP}="${cssEscape(groupId)}"]`),
    ).map((n) => n.textContent ?? "");
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    void this.copyToClipboard(text, "Copied annotation text.");
  }


  private async restorePersistentHistory(path: string): Promise<void> {
    const undo = await this.store.getPersistentHistory(path);
    this.history.set(path, { undo, redo: [] });
    this.toolbar?.render();
  }

  /* ------------------------------------------------------------------ */
  /* Undo / redo                                                         */
  /* ------------------------------------------------------------------ */

  canUndo(): boolean {
    const path = this.activeFilePath();
    return !!path && (this.history.get(path)?.undo.length ?? 0) > 0;
  }

  canRedo(): boolean {
    const path = this.activeFilePath();
    return !!path && (this.history.get(path)?.redo.length ?? 0) > 0;
  }

  undo(): void {
    const path = this.activeFilePath();
    if (!path) return;
    const h = this.history.get(path);
    if (!h || h.undo.length === 0) {
      new Notice("Nothing to undo.");
      return;
    }
    const op = h.undo.pop() as HistoryOp;
    this.applyingHistory = true;
    this.applyGroupState(path, op.groupId, op.before);
    this.applyingHistory = false;
    h.redo.push(op);
    this.toolbar?.render();
  }

  redo(): void {
    const path = this.activeFilePath();
    if (!path) return;
    const h = this.history.get(path);
    if (!h || h.redo.length === 0) {
      new Notice("Nothing to redo.");
      return;
    }
    const op = h.redo.pop() as HistoryOp;
    this.applyingHistory = true;
    this.applyGroupState(path, op.groupId, op.after);
    this.applyingHistory = false;
    h.undo.push(op);
    this.toolbar?.render();
  }

  /** Record one undoable step (skipped while a replay is in progress). */
  private recordHistory(
    path: string,
    groupId: string,
    before: HighlightRecord[],
    after: HighlightRecord[],
  ): void {
    if (this.applyingHistory) return;
    let h = this.history.get(path);
    if (!h) {
      h = { undo: [], redo: [] };
      this.history.set(path, h);
    }
    const previous = h.undo[h.undo.length - 1];
    const sameAdjacentGroup = previous?.groupId === groupId && Date.now() - (after[0]?.createdAt ?? Date.now()) < 24 * 60 * 60 * 1000;
    if (previous && sameAdjacentGroup) {
      previous.after = after;
    } else {
      h.undo.push({ groupId, before, after });
    }
    // Cap the per-file history; oldest steps fall off the back.
    if (h.undo.length > ReadingHighlighterPlugin.MAX_HISTORY) h.undo.shift();
    // A fresh action invalidates any redo branch.
    h.redo.length = 0;
    this.toolbar?.render();
  }

  /** Deep copy of all records currently in a group, for a history snapshot. */
  private snapshotGroup(path: string, groupId: string): HighlightRecord[] {
    return cloneRecords(this.store.getForFile(path).filter((r) => r.groupId === groupId));
  }

  /**
   * Force a group into a given set of records: removes whatever is there now
   * (store + DOM) and, if `target` is non-empty, re-adds and re-renders it.
   */
  private applyGroupState(path: string, groupId: string, target: HighlightRecord[]): void {
    const removed = this.store.removeGroup(path, groupId);
    removed.forEach((r) => unwrapById(document, r.id));
    if (target.length === 0) return;
    const copy = cloneRecords(target);
    this.store.add(path, copy);
    this.renderRecordsInActiveView(path, copy);
  }

  /** Paint a set of records into the active note's Reading view, if it is open. */
  private renderRecordsInActiveView(path: string, records: HighlightRecord[]): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== path) return;
    const root = view.containerEl.querySelector(READING_VIEW_SELECTOR) as HTMLElement | null;
    if (root) applyToContainer(root, records, this.settings);
  }

  /* ------------------------------------------------------------------ */
  /* Methods used by the settings tab                                    */
  /* ------------------------------------------------------------------ */

  async persistSettings(): Promise<void> {
    await this.store.persistNow();
    this.toolbar?.render();
  }

  rebuildToolbar(): void {
    this.toolbar?.rebuild();
    this.toolbar?.render();
    this.updateToolbarVisibility();
  }

  refreshReadingViews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        (view.previewMode as unknown as Rerenderable | undefined)?.rerender?.(true);
      }
    });
  }

  async resetAll(defaults: PluginSettings): Promise<void> {
    this.store.setSettings(defaults);
    this.settings = this.store.settings;
    this.store.clearAll();
    await this.store.persistNow();
    this.toolbarPlacement = defaultToolbarPlacement();
    this.saveToolbarPlacement();
    this.setActiveTool(null);
    this.rebuildToolbar();
    this.refreshReadingViews();
  }

  /* ------------------------------------------------------------------ */
  /* Render path                                                         */
  /* ------------------------------------------------------------------ */

  private async postProcess(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): Promise<void> {
    const path = ctx.sourcePath;
    if (!path) return;
    const records = this.store.getForFile(path);
    if (records.length === 0) return;

    // Ensure the section is attached so we can tell Reading from Live Preview.
    if (!el.isConnected) await nextFrame();
    if (!el.isConnected) return;

    const inLivePreview = !!el.closest(".markdown-source-view");
    if (inLivePreview && !this.settings.applyInLivePreview) return;

    const apply = () => applyToContainer(el, records, this.settings);
    if (this.lazyObserver && !isInViewport(el)) {
      (el as HTMLElement & { rhlLazyApply?: () => void }).rhlLazyApply = apply;
      this.lazyObserver.observe(el);
      return;
    }
    apply();
  }

  /* ------------------------------------------------------------------ */
  /* Create annotations from a selection                                 */
  /* ------------------------------------------------------------------ */

  private onPointerUp(ev: PointerEvent): void {
    const tool = this.activeTool;
    if (tool !== "highlight" && tool !== "underline") return;

    const target = ev.target as HTMLElement | null;
    if (target && target.closest(".rhl-toolbar, .rhl-popover")) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const root = readingRootOf(sel.anchorNode);
    if (!root) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "preview" || !view.file) return;
    if (!view.containerEl.contains(sel.anchorNode)) return;

    const path = view.file.path;
    const parts = captureSelection(sel, root, this.settings);
    if (parts.length === 0) return;

    const groupId = genId();
    const now = Date.now();
    const colorId = this.getToolColorId(tool);
    const color = this.resolveColor(colorId);

    const records: HighlightRecord[] = parts.map((part) => ({
      id: genId(),
      groupId,
      type: tool,
      colorId,
      color,
      opacity: this.settings.highlightOpacity,
      neon: tool === "highlight" ? this.settings.neonEffect : this.settings.brightUnderline,
      underline: tool === "underline" ? { ...this.settings.underline } : undefined,
      exact: part.exact,
      prefix: part.prefix,
      suffix: part.suffix,
      occurrence: part.occurrence,
      paragraphIndex: part.paragraphIndex,
      headingIndex: part.headingIndex,
      createdAt: now,
    }));

    this.store.add(path, records);
    this.scheduleSyncExport();

    // Instant feedback: wrap the live DOM now (post-processor will skip dupes).
    parts.forEach((part, i) => applyPartLive(part, records[i], this.settings));

    // Make this annotation undoable.
    this.recordHistory(path, groupId, [], cloneRecords(records));

    this.lastCaptureAt = now;
    if (this.settings.clearSelectionAfter) sel.removeAllRanges();
    if (!this.settings.stickyTool) this.setActiveTool(null);
  }

  /* ------------------------------------------------------------------ */
  /* Click handling (manage / erase)                                     */
  /* ------------------------------------------------------------------ */

  private onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".rhl-toolbar, .rhl-popover")) return;

    // Swallow the click the browser emits right after a drag-select.
    if (Date.now() - this.lastCaptureAt < 350) return;

    const wrapper = target.closest<HTMLElement>(`[${ATTR_ID}]`);
    if (!wrapper) return;
    if (!readingRootOf(wrapper)) return;

    if (this.activeTool === "eraser") {
      ev.preventDefault();
      ev.stopPropagation();
      this.deleteAnnotationEl(wrapper);
      return;
    }

    // A drawing tool is armed: leave existing annotations alone on a plain click.
    if (this.activeTool === "highlight" || this.activeTool === "underline") return;

    ev.preventDefault();
    ev.stopPropagation();
    openAnnotationPopover(this, wrapper);
  }

  /**
   * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes — but only in Reading view,
   * where there is no editor undo to clash with, and never while typing in an
   * input field.
   */
  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key.toLowerCase() !== "z" || ev.altKey) return;
    if (!(ev.ctrlKey || ev.metaKey)) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "preview") return;

    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }

    ev.preventDefault();
    ev.stopPropagation();
    if (ev.shiftKey) this.redo();
    else this.undo();
  }

  /* ------------------------------------------------------------------ */
  /* Commands (registered without default hotkeys)                      */
  /* ------------------------------------------------------------------ */

  private registerCommands(): void {
    this.addCommand({
      id: "toggle-highlighter",
      name: "Toggle highlighter",
      callback: () =>
        this.setActiveTool(this.activeTool === "highlight" ? null : "highlight"),
    });
    this.addCommand({
      id: "toggle-underline",
      name: "Toggle underline",
      callback: () =>
        this.setActiveTool(this.activeTool === "underline" ? null : "underline"),
    });
    this.addCommand({
      id: "cycle-colour",
      name: "Cycle to next colour",
      callback: () => this.cycleColour(),
    });
    this.addCommand({
      id: "stop-annotating",
      name: "Stop annotating",
      callback: () => this.setActiveTool(null),
    });
    this.addCommand({
      id: "undo-annotation",
      name: "Undo last annotation change",
      checkCallback: (checking: boolean) => {
        if (checking) return this.canUndo();
        this.undo();
        return true;
      },
    });
    this.addCommand({
      id: "redo-annotation",
      name: "Redo annotation change",
      checkCallback: (checking: boolean) => {
        if (checking) return this.canRedo();
        this.redo();
        return true;
      },
    });
    this.addCommand({
      id: "erase-last",
      name: "Erase last annotation in note",
      checkCallback: (checking: boolean) => {
        const path = this.activeFilePath();
        const can = !!path && this.store.hasFile(path);
        if (checking) return can;
        if (can) this.eraseLastInActiveFile();
        return can;
      },
    });
    this.addCommand({
      id: "export-note-markdown",
      name: "Copy note's annotations as Markdown",
      checkCallback: (checking: boolean) => {
        const path = this.activeFilePath();
        const can = !!path && this.store.hasFile(path);
        if (checking) return can;
        if (can) this.exportActiveNoteAsMarkdown();
        return can;
      },
    });
    this.addCommand({
      id: "open-settings",
      name: "Open highlighter settings",
      callback: () => this.openSettings(),
    });
  }

  private cycleColour(): void {
    const tool: ToolType = this.activeTool === "underline" ? "underline" : "highlight";
    const palette = this.settings.palette;
    if (palette.length === 0) return;
    const currentId = this.getToolColorId(tool);
    const idx = palette.findIndex((c) => c.id === currentId);
    const next = palette[(idx + 1 + palette.length) % palette.length];
    this.setToolColorId(tool, next.id);
    this.saveSettings();
    new Notice(`${tool === "highlight" ? "Highlighter" : "Underline"} colour: ${next.name}`);
  }

  private eraseLastInActiveFile(): void {
    const path = this.activeFilePath();
    if (!path) return;
    const list = this.store.getForFile(path);
    if (list.length === 0) {
      new Notice("No annotations in this note.");
      return;
    }
    let latest = list[0];
    for (const r of list) if (r.createdAt > latest.createdAt) latest = r;
    const groupId = latest.groupId;
    const removed = this.store.removeGroup(path, groupId);
    removed.forEach((r) => unwrapById(document, r.id));
    if (removed.length) {
      this.recordHistory(path, groupId, cloneRecords(removed), []);
      this.scheduleSyncExport();
    }
    new Notice("Removed last annotation.");
  }

  private exportActiveNoteAsMarkdown(): void {
    const path = this.activeFilePath();
    if (!path) return;
    const list = this.store.getForFile(path);
    if (list.length === 0) {
      new Notice("No annotations in this note.");
      return;
    }
    // Group by groupId, preserving first-seen order.
    const order: string[] = [];
    const groups = new Map<string, { type: ToolType; parts: string[] }>();
    for (const r of list) {
      let g = groups.get(r.groupId);
      if (!g) {
        g = { type: r.type, parts: [] };
        groups.set(r.groupId, g);
        order.push(r.groupId);
      }
      g.parts.push(r.exact);
    }
    const base = path.split("/").pop() ?? path;
    const lines: string[] = [`# Annotations — ${base}`, ""];
    for (const id of order) {
      const g = groups.get(id);
      if (!g) continue;
      const text = g.parts.join(" ").replace(/\s+/g, " ").trim();
      lines.push(g.type === "highlight" ? `- ==${text}==` : `- <u>${text}</u>`);
    }
    const md = lines.join("\n") + "\n";
    void this.copyToClipboard(md, `Copied ${order.length} annotation${order.length === 1 ? "" : "s"} as Markdown.`);
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */



  private showOrphan(ev: CustomEvent): void {
    const rec = (ev.detail as { record?: HighlightRecord }).record;
    if (!rec) return;
    if (!this.orphanPanel) {
      this.orphanPanel = document.body.createDiv({ cls: "rhl-orphans" });
      this.orphanPanel.createDiv({ text: "Orphaned annotations", cls: "rhl-orphans-title" });
    }
    if (this.orphanPanel.querySelector(`[data-rhl-orphan="${cssEscape(rec.id)}"]`)) return;
    const item = this.orphanPanel.createDiv({ cls: "rhl-orphan", attr: { "data-rhl-orphan": rec.id } });
    item.createSpan({ text: rec.exact.slice(0, 120) });
    item.onclick = () => new Notice("Open the note and reselect text to repair this orphaned annotation.");
  }

  private scheduleSyncExport(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.writeSyncSnapshot();
    }, 1000);
  }

  private async writeSyncSnapshot(): Promise<void> {
    const payload = this.store.exportSyncPayload(this.lastSyncTimestamp);
    if (payload.byteLength === 0) return;
    this.lastSyncTimestamp = Date.now();
    const dir = `.rhl-sync`;
    const path = `${dir}/${this.store.getDeviceId()}-${this.lastSyncTimestamp}.rhl-sync`;
    const adapter = this.app.vault.adapter as unknown as { mkdir?: (path: string) => Promise<void>; writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>; write?: (path: string, data: string) => Promise<void> };
    try {
      await adapter.mkdir?.(dir).catch?.(() => undefined);
      if (adapter.writeBinary) {
        const copy = new Uint8Array(payload.byteLength);
        copy.set(payload);
        await adapter.writeBinary(path, copy.buffer);
      }
      else await adapter.write?.(path, bytesToBase64(payload));
      await this.cleanupOldSyncFiles();
    } catch {
      // Sync export is opportunistic; WAL/IndexedDB remain authoritative locally.
    }
  }


  private async cleanupOldSyncFiles(): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as { list?: (path: string) => Promise<{ files: string[] }>; remove?: (path: string) => Promise<void> };
    try {
      const files = (await adapter.list?.(".rhl-sync"))?.files ?? [];
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      await Promise.all(files.filter((path) => {
        const match = path.match(/-(\d+)\.rhl-sync$/);
        return match ? Number(match[1]) < cutoff : false;
      }).map((path) => adapter.remove?.(path)));
    } catch {
      // Cleanup is best-effort; old sync payloads are harmless and self-contained.
    }
  }

  private async importSyncFile(file: unknown): Promise<void> {
    if (!(file instanceof TFile) || !file.path.endsWith(".rhl-sync")) return;
    if (file.path.includes(this.store.getDeviceId())) return;
    const adapter = this.app.vault.adapter as unknown as { readBinary?: (path: string) => Promise<ArrayBuffer>; read?: (path: string) => Promise<string> };
    try {
      const bytes = adapter.readBinary
        ? new Uint8Array(await adapter.readBinary(file.path))
        : base64ToBytes(await adapter.read?.(file.path) ?? "");
      const merged = this.store.importSyncPayload(bytes);
      if (merged > 0) this.refreshReadingViews();
    } catch {
      // Ignore corrupt or partially synced files; WAL CRC/replay protects local data.
    }
  }

  private updateToolbarVisibility(): void {
    if (!this.toolbar) return;
    if (!this.settings.showToolbar) {
      this.toolbar.setVisible(false);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const visible = !!view && view.getMode() === "preview";
    this.toolbar.setVisible(visible);
    // Refresh undo/redo enablement for the now-active note.
    this.toolbar.render();
  }

  private activeFilePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  /** Nearest rendered-Markdown root for an element, or the document body. */
  private rootFor(el: HTMLElement): HTMLElement {
    return (el.closest(READING_VIEW_SELECTOR) as HTMLElement | null) ?? document.body;
  }

  /** Reflect the active tool on <body> so CSS can drive cursors and affordances. */
  private setBodyState(tool: ActiveTool): void {
    const cls = document.body.classList;
    cls.remove("rhl-armed", "rhl-tool-highlight", "rhl-tool-underline", "rhl-tool-eraser");
    if (tool === "highlight" || tool === "underline" || tool === "eraser") {
      cls.add("rhl-armed", `rhl-tool-${tool}`);
    }
  }

  private async copyToClipboard(text: string, okMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(okMessage);
    } catch {
      new Notice("Could not access the clipboard.");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Module-local helpers                                                */
/* ------------------------------------------------------------------ */

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Deep copy a list of records so history snapshots can't alias live records. */
function cloneRecords(records: HighlightRecord[]): HighlightRecord[] {
  return records.map((r) => ({
    ...r,
    underline: r.underline ? { ...r.underline } : undefined,
  }));
}

function readingRootOf(node: Node | null): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  if (!el) return null;
  return el.closest(READING_VIEW_SELECTOR) as HTMLElement | null;
}

function cssEscape(value: string): string {
  const c = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (typeof c?.escape === "function") return c.escape(value);
  return value.replace(/["\\\]]/g, "\\$&");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const h = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom >= -600 && rect.top <= h + 600;
}
