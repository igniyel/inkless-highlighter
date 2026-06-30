/**
 * User interface: a floating toolbar that appears in Reading view, a palette /
 * parameter popover opened from the tool buttons, and a small management
 * popover shown when an existing annotation is clicked.
 *
 * The UI never owns persisted state; it reads from and calls back into the
 * host (the plugin), which is the single source of truth.
 */

import { App, Platform, setIcon, setTooltip } from "obsidian";
import { rgba } from "./engine";
import type { ActiveTool, PluginSettings, ToolType } from "./types";

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
};

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
  popover.style.top = `${Math.round(top)}px`;
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

  constructor(host: UIHost) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "rhl-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Inkless Highlighter");
    // The tool buttons use right-click themselves, so never show the OS menu.
    this.el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    document.body.appendChild(this.el);
    this.build();
    this.applyPlacement();
    this.el.style.display = "none";
  }

  private build(): void {
    this.el.empty?.();
    this.el.replaceChildren();
    this.buttons.clear();

    const grip = this.addButton("grip", ICONS.grip, "Drag to move", () => {});
    grip.classList.add("rhl-grip");
    this.attachDrag(grip);

    const swap = this.host.settings.swapClickRoles;
    const leftVerb = swap ? "select" : "pick colour";
    const rightVerb = swap ? "pick colour" : "select";
    const hlBtn = this.addButton(
      "highlight",
      ICONS.highlight,
      `Highlighter — left-click to ${leftVerb}, right-click to ${rightVerb}`,
      (ev) => this.onToolPrimary("highlight", ev),
    );
    hlBtn.addEventListener("contextmenu", (ev) => this.onToolSecondary("highlight", ev));
    const ulBtn = this.addButton(
      "underline",
      ICONS.underline,
      `Underline — left-click to ${leftVerb}, right-click to ${rightVerb}`,
      (ev) => this.onToolPrimary("underline", ev),
    );
    ulBtn.addEventListener("contextmenu", (ev) => this.onToolSecondary("underline", ev));
    if (this.host.settings.showEraser) {
      this.addButton("eraser", ICONS.eraser, "Eraser — click an annotation to remove it", () => {
        closeCurrentPopover();
        const next: ActiveTool = this.host.getActiveTool() === "eraser" ? null : "eraser";
        this.host.setActiveTool(next);
      });
    }
    this.addButton("cursor", ICONS.cursor, "Stop annotating", () => {
      closeCurrentPopover();
      this.host.setActiveTool(null);
    });
    if (this.host.settings.showSettingsButton) {
      this.addButton("settings", ICONS.settings, "Highlighter settings", () => {
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
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(ev);
    });
    // A tool button also shows the current colour as a bar.
    if (key === "highlight" || key === "underline") {
      const bar = document.createElement("span");
      bar.className = "rhl-colorbar";
      btn.appendChild(bar);
    }
    this.el.appendChild(btn);
    this.buttons.set(key, btn);
    return btn;
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
    const preferLeft = this.host.settings.toolbarPlacement.corner.endsWith("r");
    const preferAbove = this.host.settings.toolbarPlacement.corner.startsWith("b");
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
    const p = this.host.settings.toolbarPlacement;
    const s = this.el.style;
    s.top = s.bottom = s.left = s.right = "";
    const pad = 16;
    if (p.x !== null && p.y !== null) {
      s.left = `${p.x}px`;
      s.top = `${p.y}px`;
      return;
    }
    if (p.corner.startsWith("t")) s.top = `${pad}px`;
    else s.bottom = `${pad}px`;
    if (p.corner.endsWith("l")) s.left = `${pad}px`;
    else s.right = `${pad}px`;
  }

  private attachDrag(handle: HTMLElement): void {
    const onDown = (ev: PointerEvent) => {
      ev.preventDefault();
      closeCurrentPopover();
      const rect = this.el.getBoundingClientRect();
      const offX = ev.clientX - rect.left;
      const offY = ev.clientY - rect.top;
      const onMove = (e: PointerEvent) => {
        const x = Math.max(0, Math.min(e.clientX - offX, window.innerWidth - rect.width));
        const y = Math.max(0, Math.min(e.clientY - offY, window.innerHeight - rect.height));
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.el.style.right = "";
        this.el.style.bottom = "";
        this.host.settings.toolbarPlacement.x = x;
        this.host.settings.toolbarPlacement.y = y;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        this.host.saveSettings();
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
    if (!visible) closeCurrentPopover();
  }

  rebuild(): void {
    this.build();
    this.applyPlacement();
  }

  destroy(): void {
    closeCurrentPopover();
    this.dragCleanup?.();
    this.el.remove();
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

  const title = el.createDiv({ cls: "rhl-popover-title" });
  title.setText(tool === "highlight" ? "Highlight" : "Underline");

  // Swatches.
  const grid = el.createDiv({ cls: "rhl-swatch-grid" });
  const currentId = host.getToolColorId(tool);
  const paintSwatches = () => {
    grid.replaceChildren();
    for (const c of host.settings.palette) {
      const sw = grid.createEl("button", { cls: "rhl-swatch" });
      sw.type = "button";
      sw.style.backgroundColor = c.color;
      setTooltip(sw, c.name, { placement: "top" });
      if (c.id === host.getToolColorId(tool)) sw.classList.add("is-selected");
      sw.addEventListener("click", (ev) => {
        ev.stopPropagation();
        host.setToolColorId(tool, c.id);
        host.saveSettings();
        paintSwatches();
        updatePreview();
        onChange();
      });
    }
  };

  // Tool-specific controls.
  const controls = el.createDiv({ cls: "rhl-popover-controls" });
  let updatePreview = () => {};

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
      const o = select.createEl("option", { text: opt });
      o.value = opt;
      if (opt === host.settings.underline.style) o.selected = true;
    });
    select.addEventListener("change", () => {
      host.settings.underline.style = select.value as PluginSettings["underline"]["style"];
      host.saveSettings();
      updatePreview();
    });
  }

  // Live preview.
  const preview = el.createDiv({ cls: "rhl-preview" });
  preview.setText("The quick brown fox");
  updatePreview = () => {
    const color = host.resolveColor(host.getToolColorId(tool));
    preview.style.removeProperty("background-color");
    preview.style.removeProperty("text-decoration");
    preview.style.removeProperty("text-decoration-color");
    preview.style.removeProperty("text-decoration-thickness");
    preview.style.removeProperty("text-decoration-style");
    if (tool === "highlight") {
      preview.style.backgroundColor = rgba(color, host.settings.highlightOpacity);
    } else {
      preview.style.textDecoration = "underline";
      preview.style.textDecorationColor = color;
      preview.style.textDecorationThickness = `${host.settings.underline.thickness}px`;
      preview.style.textDecorationStyle = host.settings.underline.style;
    }
  };

  paintSwatches();
  updatePreview();
  void currentId;

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

  const grid = el.createDiv({ cls: "rhl-swatch-grid" });
  for (const c of host.settings.palette) {
    const sw = grid.createEl("button", { cls: "rhl-swatch" });
    sw.type = "button";
    sw.style.backgroundColor = c.color;
    setTooltip(sw, c.name, { placement: "top" });
    sw.addEventListener("click", (ev) => {
      ev.stopPropagation();
      host.recolorAnnotation(target, c.id);
      closeCurrentPopover();
    });
  }

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
  mkAction(ICONS.swap, type === "highlight" ? "Make underline" : "Make highlight", () => {
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

/** True on touch-first platforms — used to tune interactions. */
export function isTouch(): boolean {
  return Platform.isMobile === true;
}
