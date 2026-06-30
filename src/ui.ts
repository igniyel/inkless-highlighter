/**
 * User interface: a floating toolbar that appears in Reading view, a palette /
 * parameter popover opened from the tool buttons, and a small management
 * popover shown when an existing annotation is clicked.
 *
 * The UI never owns persisted state; it reads from and calls back into the
 * host (the plugin), which is the single source of truth.
 */

import { App, Modal, Platform, Setting, setIcon, setTooltip } from "obsidian";
import { brighten, genId, rgba } from "./engine";
import type {
  ActiveTool,
  PaletteColor,
  PluginSettings,
  ToolType,
  ToolbarPlacement,
} from "./types";

/** Contract the plugin fulfils so the UI can stay decoupled. */
export interface UIHost {
  readonly app: App;
  settings: PluginSettings;

  getActiveTool(): ActiveTool;
  setActiveTool(tool: ActiveTool): void;

  /** Resolve a palette colour id to a hex string (with sensible fallback). */
  resolveColor(colorId: string): string;
  getToolColorId(tool: ToolType): string;
  setToolColorId(tool: ToolType, colorId: string): void;

  /** Debounced persistence of settings. */
  saveSettings(): void;
  /** Open the plugin's settings tab. */
  openSettings(): void;

  /** Device-local toolbar placement (not synced across devices). */
  getToolbarPlacement(): ToolbarPlacement;
  /** Persist the toolbar placement for this device. */
  saveToolbarPlacement(): void;

  /** Management actions, operating on a clicked wrapper element. */
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
};

/** How long a press must be held (ms) before it counts as a long-press. */
const LONG_PRESS_MS = 480;
/** Movement (px) that cancels a long-press, treating it as a scroll instead. */
const LONG_PRESS_SLOP = 10;

/* ------------------------------------------------------------------ */
/* Platform helpers                                                    */
/* ------------------------------------------------------------------ */

/** True on Obsidian's mobile app (phone or tablet, including iPad). */
export function isTouch(): boolean {
  return Platform.isMobile === true;
}

/* ------------------------------------------------------------------ */
/* Shared popover plumbing                                             */
/* ------------------------------------------------------------------ */

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
  // Make sure we can measure it.
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

/* ------------------------------------------------------------------ */
/* Floating toolbar                                                    */
/* ------------------------------------------------------------------ */

export class Toolbar {
  readonly el: HTMLElement;
  private host: UIHost;
  private buttons = new Map<string, HTMLElement>();
  private dragCleanup: (() => void) | null = null;
  private visible = false;
  /** Timestamp of the last touch gesture, so we can ignore the synthetic click. */
  private lastToolTouch = 0;

  constructor(host: UIHost) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "rhl-toolbar";
    if (isTouch()) this.el.classList.add("is-touch");
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Inkless Highlighter");
    // The tool buttons use right-click / long-press themselves, so suppress
    // the OS context menu over the whole toolbar.
    this.el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    document.body.appendChild(this.el);
    this.build();
    this.applyPlacement();
    this.el.style.display = "none";
    // Keep the toolbar on-screen when the window resizes or the device rotates.
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

  /**
   * A drawing-tool button (highlighter / underline). It carries a colour bar
   * and responds to three gestures:
   *   - mouse click / right-click (roles configurable in settings),
   *   - touch tap (select the tool) and long-press (open colours & options).
   */
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
      // A touch gesture already handled this; ignore the synthetic click.
      if (Date.now() - this.lastToolTouch < 700) return;
      this.onToolPrimary(tool, ev);
    });
    btn.addEventListener("contextmenu", (ev) => this.onToolSecondary(tool, ev));
    this.attachLongPress(btn, tool);

    this.el.appendChild(btn);
    this.buttons.set(key, btn);
    return btn;
  }

  /** Device-aware hint for a drawing-tool button. */
  private toolTooltip(name: string): string {
    if (isTouch()) {
      return `${name} — tap to use · long-press for colours & options`;
    }
    const swap = this.host.settings.swapClickRoles;
    return swap
      ? `${name} — click to use · right-click for colours & options`
      : `${name} — click for colours & options · right-click to use`;
  }

  /** Touch: short tap selects the tool; a sustained press opens its options. */
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
          /* haptics are best-effort */
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
        return; // the press already opened the options popover
      }
      // A plain tap simply arms (or disarms) the tool, ready to drag.
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

  /** Primary mouse button on a tool icon (left, unless roles are swapped). */
  private onToolPrimary(tool: ToolType, ev: MouseEvent): void {
    const action = this.host.settings.swapClickRoles ? "select" : "palette";
    this.handleToolAction(tool, action, ev.currentTarget as HTMLElement);
  }

  /** Secondary mouse button on a tool icon (right, unless roles are swapped). */
  private onToolSecondary(tool: ToolType, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const action = this.host.settings.swapClickRoles ? "palette" : "select";
    this.handleToolAction(tool, action, ev.currentTarget as HTMLElement);
  }

  /**
   * Route a tool-button gesture. "select" just arms (or toggles off) the tool;
   * "palette" arms it and opens its colour / parameters popover.
   */
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
    // "palette": arm the tool and show its popover (toggle if already open).
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

  /** Re-paint active state and colour bars. */
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
  }

  /* ----- placement & dragging ----- */

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

  /**
   * If the toolbar was dragged to a manual position, keep that position inside
   * the current viewport. Called on show, on resize, and on device rotation, so
   * a position saved in one orientation never strands the toolbar off-screen in
   * another. Corner-docked toolbars need no clamping (they hug an edge already).
   */
  clampIntoView(): void {
    const p = this.host.getToolbarPlacement();
    if (p.x === null || p.y === null) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    if (w === 0 || h === 0) return; // not laid out yet (e.g. hidden)
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

  /* ----- visibility ----- */

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

/* ------------------------------------------------------------------ */
/* Swatch grid (shared by both popovers)                               */
/* ------------------------------------------------------------------ */

interface SwatchHandlers {
  /** Currently selected colour id, if the grid should ring one. */
  selectedId?: () => string | null;
  /** Called when a swatch is chosen. */
  onPick: (id: string) => void;
  /** Whether to re-ring the grid after a pick (false when the popover closes). */
  repaintAfterPick: boolean;
  /** Called after a brand-new colour is added through the "+" tile. */
  onAdded?: (id: string) => void;
}

/**
 * Render the palette as a grid of swatches followed by a dashed "+" tile that
 * adds a new, named colour. Returns a `paint` function that re-renders in place.
 */
function buildSwatchGrid(
  parent: HTMLElement,
  host: UIHost,
  handlers: SwatchHandlers,
): { grid: HTMLElement; paint: () => void } {
  const grid = parent.createDiv({ cls: "rhl-swatch-grid" });

  const paint = () => {
    grid.replaceChildren();
    const selected = handlers.selectedId?.() ?? null;
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
    }
    // The "+" tile: an inner dashed border with a plus, for adding a colour.
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

/* ------------------------------------------------------------------ */
/* Add-colour modal                                                    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Palette / parameters popover                                        */
/* ------------------------------------------------------------------ */

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

  // Swatches with the inline "add colour" tile.
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
  });

  // Tool-specific controls.
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

  // Emphasis toggle: a neon glow for highlights, a brighter colour for
  // underlines. They are independent defaults, one per tool.
  const isHighlight = tool === "highlight";
  const getEmphasis = () =>
    isHighlight ? host.settings.neonEffect : host.settings.brightUnderline;
  const emphasisRow = controls.createDiv({ cls: "rhl-control-row" });
  emphasisRow.createSpan({
    cls: "rhl-control-label",
    text: isHighlight ? "Neon glow" : "Brighter",
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

  // Live preview.
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
      // Brighter underlines change only the line colour — never a background.
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

/* ------------------------------------------------------------------ */
/* Annotation management popover                                       */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Popover lifecycle helper                                            */
/* ------------------------------------------------------------------ */

function finishPopover(el: HTMLElement): OpenPopover {
  const onDocPointer = (ev: PointerEvent) => {
    if (!el.contains(ev.target as Node)) closeCurrentPopover();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closeCurrentPopover();
  };
  // Defer attaching so the opening click doesn't immediately close it.
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

/** Exposed so the plugin can dismiss popovers on unload / view change. */
export function dismissPopovers(): void {
  closeCurrentPopover();
}
