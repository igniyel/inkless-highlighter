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
import { ATTR_GROUP, ATTR_ID, READING_VIEW_SELECTOR } from "./constants";
import type {
  ActiveTool,
  HighlightRecord,
  PluginSettings,
  ToolType,
} from "./types";

/** Minimal structural types for semi-private Obsidian APIs we touch. */
interface AppWithSetting extends App {
  setting?: { open(): void; openTabById(id: string): void };
}
interface Rerenderable {
  rerender?(full?: boolean): void;
}

export default class ReadingHighlighterPlugin extends Plugin implements UIHost {
  store!: HighlightStore;
  /** Same object reference as store.settings, so edits propagate both ways. */
  settings!: PluginSettings;
  private toolbar!: Toolbar;
  private activeTool: ActiveTool = null;
  /** Timestamp of the last successful capture, to swallow the trailing click. */
  private lastCaptureAt = 0;

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.store = new HighlightStore(loaded ?? null, (data) => this.saveData(data));
    this.settings = this.store.settings;

    this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));

    this.toolbar = new Toolbar(this);

    // Re-apply annotations on every render.
    this.registerMarkdownPostProcessor((el, ctx) => this.postProcess(el, ctx));

    // Create annotations from a drag-selection (Reading view only).
    this.registerDomEvent(document, "pointerup", (ev) => this.onPointerUp(ev));

    // Manage / erase annotations on click.
    this.registerDomEvent(document, "click", (ev) => this.onClick(ev), true);

    // Toolbar visibility tracks the active leaf's mode.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.updateToolbarVisibility()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.updateToolbarVisibility()),
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
    dismissPopovers();
    this.setBodyState(null);
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
    const color = this.resolveColor(colorId);
    this.store.updateGroup(path, groupId, { colorId, color });
    const root = this.rootFor(el);
    restyleGroup(root, groupId, { ...rec, colorId, color }, this.settings);
  }

  switchAnnotationType(el: HTMLElement): void {
    const path = this.activeFilePath();
    const groupId = el.getAttribute(ATTR_GROUP);
    const id = el.getAttribute(ATTR_ID);
    if (!path || !groupId || !id) return;
    const rec = this.store.findById(path, id);
    if (!rec) return;
    const nextType: ToolType = rec.type === "highlight" ? "underline" : "highlight";
    const patch: Partial<HighlightRecord> = { type: nextType };
    if (nextType === "underline" && !rec.underline) {
      patch.underline = { ...this.settings.underline };
    }
    this.store.updateGroup(path, groupId, patch);
    const root = this.rootFor(el);
    restyleGroup(root, groupId, { ...rec, ...patch }, this.settings);
  }

  deleteAnnotationEl(el: HTMLElement): void {
    const path = this.activeFilePath();
    const groupId = el.getAttribute(ATTR_GROUP);
    if (!path || !groupId) return;
    if (this.settings.confirmDelete && !confirm("Delete this annotation?")) return;
    const removed = this.store.removeGroup(path, groupId);
    removed.forEach((r) => unwrapById(document, r.id));
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

    applyToContainer(el, records, this.settings);
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
      neon: this.settings.neonEffect,
      underline: tool === "underline" ? { ...this.settings.underline } : undefined,
      exact: part.exact,
      prefix: part.prefix,
      suffix: part.suffix,
      occurrence: part.occurrence,
      createdAt: now,
    }));

    this.store.add(path, records);

    // Instant feedback: wrap the live DOM now (post-processor will skip dupes).
    parts.forEach((part, i) => applyPartLive(part, records[i], this.settings));

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
    const removed = this.store.removeGroup(path, latest.groupId);
    removed.forEach((r) => unwrapById(document, r.id));
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

  private updateToolbarVisibility(): void {
    if (!this.toolbar) return;
    if (!this.settings.showToolbar) {
      this.toolbar.setVisible(false);
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const visible = !!view && view.getMode() === "preview";
    this.toolbar.setVisible(visible);
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
