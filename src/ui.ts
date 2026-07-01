// The floating toolbar, the palette/parameter popover, and the small popover for
// managing an existing annotation. The UI owns no persisted state — it reads and
// calls back into the host (the plugin).

import { App, Modal, Platform, Setting, setIcon, setTooltip } from "obsidian";
import { brighten, genId, rgba } from "./engine";
import type {
  ActiveTool,
  PaletteColor,
  PluginSettings,
  ToolType,
  ToolbarPlacement,
} from "./types";

// What the plugin provides so the UI can stay decoupled.
export interface UIHost {
  readonly app: App;
  settings: PluginSettings;

  getActiveTool(): ActiveTool;
  setActiveTool(tool: ActiveTool): void;

  resolveColor(colorId: string): string;
  getToolColorId(tool: ToolType): string;
  setToolColorId(tool: ToolType, colorId: string): void;
  deletePaletteColor(colorId: string): void;

  saveSettings(): void;
  openSettings(): void;

  getToolbarPlacement(): ToolbarPlacement;
  saveToolbarPlacement(): void;

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  recolorAnnotation(el: HTMLElement, colorId: string): void;
  switchAnnotationType(el: HTMLElement): void;
  deleteAnnotationEl(el: HTMLElement): void;
  copyAnnotationText(el: HTMLElement): void;
}

const ICONS = {
  highlight: "highlighter",
  underline: "underline",
  eraser: "eraser",
  cursor: "mouse-pointer",
  settings: "settings",
  grip: "grip-vertical",
  trash: "trash-2",
  copy: "copy",
  swap: "arrow-left-right",
  add: "plus",
  undo: "undo-2",
  redo: "redo-2",
};

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10; // px of movement that turns a press into a scroll

// True on Obsidian's mobile app (phone or tablet, including iPad).
export function isTouch(): boolean {
  return Platform.isMobile === true;
}

interface OpenPopover {
  el: HTMLElement;
  close: () => void;
}

let currentPopover: OpenPopover | null = null;

function closeCurrentPopover(): void {
  if (currentPopover) {
    const p = currentPopover;
    currentPopover = null;
    p.close();
  }
}

function positionNear(
  popover: HTMLElement,
  anchor: DOMRect,
  preferAbove: boolean,
  preferLeft: boolean,
): void {
  popover.style.visibility = "hidden";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const margin = 8;
  const rect = popover.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top: number;
  if (preferAbove && anchor.top - rect.height - margin >= 0) {
    top = anchor.top - rect.height - margin;
  } else if (anchor.bottom + rect.height + margin <= vh) {
    top = anchor.bottom + margin;
  } else {
    top = Math.max(margin, Math.min(anchor.top, vh - rect.height - margin));
  }

  let left: number;
  if (preferLeft) {
    left = anchor.right - rect.width;
  } else {
    left = anchor.left;
  }
  left = Math.max(margin, Math.min(left, vw - rect.width - margin));

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(Math.max(margin, top))}px`;
  popover.style.visibility = "visible";
}

export class Toolbar {
  readonly el: HTMLElement;
  private host: UIHost;
  private buttons = new Map<string, HTMLElement>();
  private dragCleanup: (() => void) | null = null;
  private visible = false;
  private lastToolTouch = 0; // so we can ignore the synthetic click after a tap

  constructor(host: UIHost) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "rhl-toolbar";
    if (isTouch()) this.el.classList.add("is-touch");
    this.el.setAttribute("role", "toolbar");
    // No aria-label on the container: Obsidian turns aria-label into a hover
    // tooltip, and a toolbar-wide one shows clipped at the screen edge. Each
    // button carries its own label instead. The tool buttons handle right-click
    // and long-press, so suppress the OS context menu here.
    this.el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    document.body.appendChild(this.el);
    this.build();
    this.applyPlacement();
    this.el.style.display = "none";
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("orientationchange", this.onViewportChange);
  }

  private build(): void {
    this.el.empty?.();
    this.el.replaceChildren();
    this.buttons.clear();

    const grip = this.addButton("grip", ICONS.grip, "Drag to move the toolbar", () => {});
    grip.classList.add("rhl-grip");
    this.attachDrag(grip);

    this.addToolButton("highlight", ICONS.highlight, "highlight", "Highlighter");
    this.addToolButton("underline", ICONS.underline, "underline", "Underline");

    if (this.host.settings.showEraser) {
      this.addButton(
        "eraser",
        ICONS.eraser,
        "Eraser — select it, then tap an annotation to remove it",
        () => {
          closeCurrentPopover();
          const next: ActiveTool = this.host.getActiveTool() === "eraser" ? null : "eraser";
          this.host.setActiveTool(next);
        },
      );
    }
    if (this.host.settings.showUndoRedo) {
      const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
      const hint = isTouch() ? "" : ` (${mod}+Z)`;
      this.addButton("undo", ICONS.undo, `Undo last annotation change${hint}`, () => {
        closeCurrentPopover();
        this.host.undo();
      });
      this.addButton("redo", ICONS.redo, `Redo annotation change${isTouch() ? "" : ` (${mod}+Shift+Z)`}`, () => {
        closeCurrentPopover();
        this.host.redo();
      });
    }
    this.addButton("cursor", ICONS.cursor, "Stop annotating", () => {
      closeCurrentPopover();
      this.host.setActiveTool(null);
    });
    if (this.host.settings.showSettingsButton) {
      this.addButton("settings", ICONS.settings, "Open Highlighter settings", () => {
        closeCurrentPopover();
        this.host.openSettings();
      });
    }
    this.render();
  }

  private addButton(
    key: string,
    icon: string,
    tooltip: string,
    onClick: (ev: MouseEvent) => void,
  ): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "rhl-tool-btn";
    btn.type = "button";
    setIcon(btn, icon);
    setTooltip(btn, tooltip, { placement: "top" });
    btn.setAttribute("aria-label", tooltip);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(ev);
    });
    this.el.appendChild(btn);
    this.buttons.set(key, btn);
    return btn;
  }

  // Highlighter / underline button: carries a colour bar and responds to mouse
  // click (+ right-click), and on touch to tap (select) / long-press (options).
  private addToolButton(
    key: "highlight" | "underline",
    icon: string,
    tool: ToolType,
    name: string,
  ): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "rhl-tool-btn";
    btn.type = "button";
    setIcon(btn, icon);
    setTooltip(btn, this.toolTooltip(name), { placement: "top" });
    btn.setAttribute("aria-label", name);

    const bar = document.createElement("span");
    bar.className = "rhl-colorbar";
    btn.appendChild(bar);

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (Date.now() - this.lastToolTouch < 700) return; // a touch already handled it
      this.onToolPrimary(tool, ev);
    });
    btn.addEventListener("contextmenu", (ev) => this.onToolSecondary(tool, ev));
    this.attachLongPress(btn, tool);

    this.el.appendChild(btn);
    this.buttons.set(key, btn);
    return btn;
  }

  private toolTooltip(name: string): string {
    if (isTouch()) {
      return `${name} — tap to use · long-press for colours & options`;
    }
    const swap = this.host.settings.swapClickRoles;
    return swap
      ? `${name} — click to use · right-click for colours & options`
      : `${name} — click for colours & options · right-click to use`;
  }

  // Touch: a short tap selects the tool, a sustained press opens its options.
  private attachLongPress(btn: HTMLElement, tool: ToolType): void {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let active = false;
    let longFired = false;

    const clearTimer = () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
    };

    btn.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.pointerType === "mouse") return; // desktop uses click / contextmenu
      active = true;
      longFired = false;
      startX = ev.clientX;
      startY = ev.clientY;
      clearTimer();
      timer = window.setTimeout(() => {
        longFired = true;
        this.lastToolTouch = Date.now();
        if (this.host.getActiveTool() !== tool) this.host.setActiveTool(tool);
        this.openPalette(tool, btn);
        this.render();
        try {
          (navigator as Navigator & { vibrate?: (n: number) => void }).vibrate?.(10);
        } catch {
          // haptics are best-effort
        }
      }, LONG_PRESS_MS);
    });

    btn.addEventListener("pointermove", (ev: PointerEvent) => {
      if (!active) return;
      if (
        Math.abs(ev.clientX - startX) > LONG_PRESS_SLOP ||
        Math.abs(ev.clientY - startY) > LONG_PRESS_SLOP
      ) {
        clearTimer();
        active = false;
      }
    });

    const end = (ev: PointerEvent) => {
      if (ev.pointerType === "mouse" || !active) return;
      active = false;
      clearTimer();
      this.lastToolTouch = Date.now();
      if (longFired) {
        longFired = false;
        return; // the press already opened the options
      }
      closeCurrentPopover();
      const current = this.host.getActiveTool();
      this.host.setActiveTool(current === tool ? null : tool);
      this.render();
    };
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", () => {
      clearTimer();
      active = false;
      longFired = false;
    });
  }

  private onToolPrimary(tool: ToolType, ev: MouseEvent): void {
    const action = this.host.settings.swapClickRoles ? "select" : "palette";
    this.handleToolAction(tool, action, ev.currentTarget as HTMLElement);
  }

  private onToolSecondary(tool: ToolType, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const action = this.host.settings.swapClickRoles ? "palette" : "select";
    this.handleToolAction(tool, action, ev.currentTarget as HTMLElement);
  }

  // "select" just arms (or toggles off) the tool; "palette" arms it and opens
  // its options popover.
  private handleToolAction(
    tool: ToolType,
    action: "palette" | "select",
    anchor: HTMLElement,
  ): void {
    const active = this.host.getActiveTool();
    if (action === "select") {
      closeCurrentPopover();
      this.host.setActiveTool(active === tool ? null : tool);
      this.render();
      return;
    }
    if (active !== tool) {
      this.host.setActiveTool(tool);
      this.openPalette(tool, anchor);
    } else if (currentPopover) {
      closeCurrentPopover();
    } else {
      this.openPalette(tool, anchor);
    }
    this.render();
  }

  private openPalette(tool: ToolType, anchor: HTMLElement): void {
    closeCurrentPopover();
    currentPopover = buildPalettePopover(this.host, tool, () => this.render());
    const rect = anchor.getBoundingClientRect();
    const corner = this.host.getToolbarPlacement().corner;
    const preferLeft = corner.endsWith("r");
    const preferAbove = corner.startsWith("b");
    positionNear(currentPopover.el, rect, preferAbove, preferLeft);
  }

  render(): void {
    const active = this.host.getActiveTool();
    (["highlight", "underline", "eraser", "cursor"] as const).forEach((key) => {
      const btn = this.buttons.get(key);
      if (!btn) return;
      const isActive =
        (key === "cursor" && active === null) || (key !== "cursor" && active === key);
      btn.classList.toggle("is-active", isActive);
    });
    (["highlight", "underline"] as const).forEach((tool) => {
      const btn = this.buttons.get(tool);
      const bar = btn?.querySelector<HTMLElement>(".rhl-colorbar");
      if (bar) bar.style.backgroundColor = this.host.resolveColor(this.host.getToolColorId(tool));
    });
    const undoBtn = this.buttons.get("undo");
    if (undoBtn) (undoBtn as HTMLButtonElement).disabled = !this.host.canUndo();
    const redoBtn = this.buttons.get("redo");
    if (redoBtn) (redoBtn as HTMLButtonElement).disabled = !this.host.canRedo();
  }

  applyPlacement(): void {
    const p = this.host.getToolbarPlacement();
    const s = this.el.style;
    s.top = s.bottom = s.left = s.right = "";
    const pad = 16;
    if (p.x !== null && p.y !== null) {
      s.left = `${p.x}px`;
      s.top = `${p.y}px`;
      this.clampIntoView();
      return;
    }
    if (p.corner.startsWith("t")) s.top = `${pad}px`;
    else s.bottom = `${pad}px`;
    if (p.corner.endsWith("l")) s.left = `${pad}px`;
    else s.right = `${pad}px`;
  }

  // Keep a dragged position inside the viewport (on show, resize and rotation),
  // so a spot saved in one orientation never strands the toolbar off-screen.
  // Corner-docked toolbars already hug an edge and need no clamping.
  clampIntoView(): void {
    const p = this.host.getToolbarPlacement();
    if (p.x === null || p.y === null) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    if (w === 0 || h === 0) return; // not laid out yet (hidden)
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - w - margin);
    const maxY = Math.max(margin, window.innerHeight - h - margin);
    const x = Math.min(Math.max(margin, p.x), maxX);
    const y = Math.min(Math.max(margin, p.y), maxY);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.style.right = "";
    this.el.style.bottom = "";
    if (x !== p.x || y !== p.y) {
      p.x = x;
      p.y = y;
      this.host.saveToolbarPlacement();
    }
  }

  private onViewportChange = (): void => {
    closeCurrentPopover();
    this.clampIntoView();
  };

  private attachDrag(handle: HTMLElement): void {
    const onDown = (ev: PointerEvent) => {
      ev.preventDefault();
      closeCurrentPopover();
      const rect = this.el.getBoundingClientRect();
      const offX = ev.clientX - rect.left;
      const offY = ev.clientY - rect.top;
      const placement = this.host.getToolbarPlacement();
      const onMove = (e: PointerEvent) => {
        const x = Math.max(0, Math.min(e.clientX - offX, window.innerWidth - rect.width));
        const y = Math.max(0, Math.min(e.clientY - offY, window.innerHeight - rect.height));
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.el.style.right = "";
        this.el.style.bottom = "";
        placement.x = x;
        placement.y = y;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        this.host.saveToolbarPlacement();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", onDown);
    this.dragCleanup = () => handle.removeEventListener("pointerdown", onDown);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.el.style.display = visible ? "" : "none";
    if (visible) this.clampIntoView();
    else closeCurrentPopover();
  }

  rebuild(): void {
    this.build();
    this.applyPlacement();
  }

  destroy(): void {
    closeCurrentPopover();
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("orientationchange", this.onViewportChange);
    this.dragCleanup?.();
    this.el.remove();
  }
}

interface SwatchHandlers {
  selectedId?: () => string | null;
  onPick: (id: string) => void;
  repaintAfterPick: boolean;
  onAdded?: (id: string) => void;
  onChanged?: () => void; // after a colour is deleted
}

// The palette grid: swatches (each with a hover delete badge) plus a dashed "+"
// tile to add a colour. Returns a paint() that re-renders in place.
function buildSwatchGrid(
  parent: HTMLElement,
  host: UIHost,
  handlers: SwatchHandlers,
): { grid: HTMLElement; paint: () => void } {
  const grid = parent.createDiv({ cls: "rhl-swatch-grid" });

  const paint = () => {
    grid.replaceChildren();
    const selected = handlers.selectedId?.() ?? null;
    const canDelete = host.settings.palette.length > 1;
    for (const c of host.settings.palette) {
      const sw = grid.createEl("button", { cls: "rhl-swatch" });
      sw.type = "button";
      sw.style.backgroundColor = c.color;
      setTooltip(sw, c.name, { placement: "top" });
      sw.setAttribute("aria-label", c.name);
      if (selected && c.id === selected) sw.classList.add("is-selected");
      sw.addEventListener("click", (ev) => {
        ev.stopPropagation();
        handlers.onPick(c.id);
        if (handlers.repaintAfterPick) paint();
      });
      if (canDelete) {
        const del = sw.createSpan({ cls: "rhl-swatch-del" });
        setIcon(del, "x");
        setTooltip(del, `Delete ${c.name}`, { placement: "top" });
        del.setAttribute("aria-label", `Delete ${c.name}`);
        del.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          host.deletePaletteColor(c.id);
          paint();
          handlers.onChanged?.();
        });
      }
    }
    const add = grid.createEl("button", { cls: "rhl-swatch rhl-swatch-add" });
    add.type = "button";
    setIcon(add, ICONS.add);
    setTooltip(add, "Add a new colour", { placement: "top" });
    add.setAttribute("aria-label", "Add a new colour");
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      new AddColorModal(host, (id) => {
        paint();
        handlers.onAdded?.(id);
      }).open();
    });
  };

  paint();
  return { grid, paint };
}

class AddColorModal extends Modal {
  private name = "";
  private color = "#ffe14d";

  constructor(
    private readonly host: UIHost,
    private readonly onAdded: (id: string) => void,
  ) {
    super(host.app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Add a colour");
    contentEl.createEl("p", {
      cls: "rhl-modal-note",
      text: "Choose a colour and give it a name. It joins your palette and becomes available to both the highlighter and the underline.",
    });

    new Setting(contentEl)
      .setName("Name")
      .addText((t) =>
        t.setPlaceholder("e.g. Lime").onChange((v) => {
          this.name = v;
        }),
      );

    new Setting(contentEl)
      .setName("Colour")
      .addColorPicker((p) =>
        p.setValue(this.color).onChange((v) => {
          this.color = v;
        }),
      );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Add to palette")
          .setCta()
          .onClick(() => this.commit()),
      )
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  private commit(): void {
    const fresh: PaletteColor = {
      id: "c-" + genId(),
      name: this.name.trim() || "Colour",
      color: this.color,
    };
    this.host.settings.palette.push(fresh);
    this.host.saveSettings();
    this.onAdded(fresh.id);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  warning?: boolean;
  onConfirm: () => void;
}

// Used instead of the browser confirm(), which is unreliable on mobile.
export class ConfirmModal extends Modal {
  constructor(app: App, private readonly opts: ConfirmOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title);
    contentEl.createEl("p", { cls: "rhl-modal-note", text: this.opts.message });
    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText(this.opts.confirmText ?? "Confirm").onClick(() => {
          this.close();
          this.opts.onConfirm();
        });
        if (this.opts.warning) b.setWarning();
        else b.setCta();
      })
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function buildPalettePopover(
  host: UIHost,
  tool: ToolType,
  onChange: () => void,
): OpenPopover {
  const el = document.createElement("div");
  el.className = "rhl-popover";
  document.body.appendChild(el);

  const header = el.createDiv({ cls: "rhl-popover-header" });
  header.createDiv({
    cls: "rhl-popover-title",
    text: tool === "highlight" ? "Highlighter" : "Underline",
  });
  header.createDiv({
    cls: "rhl-popover-subtitle",
    text:
      tool === "highlight"
        ? "Pick a colour, then drag across text to highlight it."
        : "Pick a colour, then drag across text to underline it.",
  });

  let updatePreview = () => {};
  buildSwatchGrid(el, host, {
    selectedId: () => host.getToolColorId(tool),
    repaintAfterPick: true,
    onPick: (id) => {
      host.setToolColorId(tool, id);
      host.saveSettings();
      updatePreview();
      onChange();
    },
    onAdded: (id) => {
      host.setToolColorId(tool, id);
      host.saveSettings();
      updatePreview();
      onChange();
    },
    onChanged: () => {
      updatePreview();
      onChange();
    },
  });

  const controls = el.createDiv({ cls: "rhl-popover-controls" });

  if (tool === "highlight") {
    const row = controls.createDiv({ cls: "rhl-control-row" });
    row.createSpan({ cls: "rhl-control-label", text: "Opacity" });
    const slider = row.createEl("input");
    slider.type = "range";
    slider.min = "0.1";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = String(host.settings.highlightOpacity);
    const val = row.createSpan({ cls: "rhl-control-value" });
    val.setText(`${Math.round(host.settings.highlightOpacity * 100)}%`);
    slider.addEventListener("input", () => {
      host.settings.highlightOpacity = parseFloat(slider.value);
      val.setText(`${Math.round(host.settings.highlightOpacity * 100)}%`);
      host.saveSettings();
      updatePreview();
    });
  } else {
    const rowT = controls.createDiv({ cls: "rhl-control-row" });
    rowT.createSpan({ cls: "rhl-control-label", text: "Thickness" });
    const thick = rowT.createEl("input");
    thick.type = "range";
    thick.min = "1";
    thick.max = "5";
    thick.step = "1";
    thick.value = String(host.settings.underline.thickness);
    const tv = rowT.createSpan({ cls: "rhl-control-value" });
    tv.setText(`${host.settings.underline.thickness}px`);
    thick.addEventListener("input", () => {
      host.settings.underline.thickness = parseInt(thick.value, 10);
      tv.setText(`${host.settings.underline.thickness}px`);
      host.saveSettings();
      updatePreview();
    });

    const rowS = controls.createDiv({ cls: "rhl-control-row" });
    rowS.createSpan({ cls: "rhl-control-label", text: "Style" });
    const select = rowS.createEl("select", { cls: "dropdown" });
    (["solid", "dashed", "dotted", "wavy"] as const).forEach((opt) => {
      const o = select.createEl("option", { text: opt[0].toUpperCase() + opt.slice(1) });
      o.value = opt;
      if (opt === host.settings.underline.style) o.selected = true;
    });
    select.addEventListener("change", () => {
      host.settings.underline.style = select.value as PluginSettings["underline"]["style"];
      host.saveSettings();
      updatePreview();
    });
  }

  // Neon glow for highlights, brighter colour for underlines — separate defaults.
  const isHighlight = tool === "highlight";
  const getEmphasis = () =>
    isHighlight ? host.settings.neonEffect : host.settings.brightUnderline;
  const emphasisRow = controls.createDiv({ cls: "rhl-control-row" });
  emphasisRow.createSpan({
    cls: "rhl-control-label",
    text: isHighlight ? "Neon Glow" : "Brighter",
  });
  const toggle = emphasisRow.createDiv({ cls: "checkbox-container rhl-toggle" });
  if (getEmphasis()) toggle.addClass("is-enabled");
  const toggleInput = toggle.createEl("input");
  toggleInput.type = "checkbox";
  toggleInput.checked = getEmphasis();
  toggle.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const next = !toggle.hasClass("is-enabled");
    toggle.toggleClass("is-enabled", next);
    toggleInput.checked = next;
    if (isHighlight) host.settings.neonEffect = next;
    else host.settings.brightUnderline = next;
    host.saveSettings();
    updatePreview();
  });

  const preview = el.createDiv({ cls: "rhl-preview" });
  preview.setText("The quick brown fox");
  updatePreview = () => {
    const color = host.resolveColor(host.getToolColorId(tool));
    const s = preview.style;
    s.cssText = "";
    if (tool === "highlight") {
      s.backgroundColor = rgba(color, host.settings.highlightOpacity);
      if (host.settings.neonEffect) {
        s.boxShadow = `0 0 4px ${rgba(color, 0.95)}, 0 0 10px ${rgba(color, 0.55)}`;
      }
    } else {
      s.textDecoration = "underline";
      s.textDecorationColor = host.settings.brightUnderline ? brighten(color) : color;
      s.textDecorationThickness = `${host.settings.underline.thickness}px`;
      s.textDecorationStyle = host.settings.underline.style;
      s.textUnderlineOffset = `${host.settings.underline.offset}px`;
    }
  };

  updatePreview();

  return finishPopover(el);
}

// Opened when an existing annotation is clicked with no tool armed.
export function openAnnotationPopover(host: UIHost, target: HTMLElement): void {
  closeCurrentPopover();
  const type = (target.getAttribute("data-rhl-type") as ToolType) ?? "highlight";
  const el = document.createElement("div");
  el.className = "rhl-popover rhl-annotation-popover";
  document.body.appendChild(el);

  el.createDiv({ cls: "rhl-popover-title", text: "Recolour or edit" });

  buildSwatchGrid(el, host, {
    repaintAfterPick: false,
    onPick: (id) => {
      host.recolorAnnotation(target, id);
      closeCurrentPopover();
    },
    onAdded: (id) => {
      host.recolorAnnotation(target, id);
      closeCurrentPopover();
    },
  });

  const actions = el.createDiv({ cls: "rhl-popover-actions" });
  const mkAction = (icon: string, label: string, fn: () => void) => {
    const b = actions.createEl("button", { cls: "rhl-action-btn" });
    b.type = "button";
    setIcon(b, icon);
    b.createSpan({ text: label });
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fn();
    });
  };
  mkAction(ICONS.swap, type === "highlight" ? "Convert to underline" : "Convert to highlight", () => {
    host.switchAnnotationType(target);
    closeCurrentPopover();
  });
  mkAction(ICONS.copy, "Copy text", () => {
    host.copyAnnotationText(target);
    closeCurrentPopover();
  });
  mkAction(ICONS.trash, "Delete", () => {
    host.deleteAnnotationEl(target);
    closeCurrentPopover();
  });

  const popover = finishPopover(el);
  currentPopover = popover;
  const rect = target.getBoundingClientRect();
  const preferAbove = rect.top > window.innerHeight / 2;
  positionNear(el, rect, preferAbove, false);
}

function finishPopover(el: HTMLElement): OpenPopover {
  const onDocPointer = (ev: PointerEvent) => {
    if (!el.contains(ev.target as Node)) closeCurrentPopover();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closeCurrentPopover();
  };
  // Defer, so the click that opened the popover doesn't immediately close it.
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  const close = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    el.remove();
  };
  const popover: OpenPopover = { el, close };
  currentPopover = popover;
  return popover;
}

export function dismissPopovers(): void {
  closeCurrentPopover();
}
