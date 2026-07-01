/*
 * Inkless Highlighter — in-browser interactive demo.
 *
 * A faithful, dependency-free recreation of the plugin's core experience:
 * drag-to-highlight/underline, a colour palette (add + delete-on-hover),
 * neon / brighter styles, an annotation manager, an eraser, and undo/redo.
 * It runs entirely in the browser and mirrors the real plugin's behaviour.
 */
(function () {
  "use strict";

  const stage = document.getElementById("demo-stage");
  const note = document.getElementById("demo-note");
  if (!stage || !note) return;

  /* ----------------------------- state ----------------------------- */

  let palette = [
    { id: "c-yellow", name: "Citrus", color: "#ffe14d" },
    { id: "c-green", name: "Lime", color: "#46f08c" },
    { id: "c-cyan", name: "Aqua", color: "#33e1ff" },
    { id: "c-pink", name: "Magenta", color: "#ff5fb0" },
    { id: "c-orange", name: "Coral", color: "#ff8a3d" },
  ];
  const settings = {
    hlColor: "c-yellow",
    ulColor: "c-green",
    opacity: 0.5,
    neon: false,
    thickness: 3,
    ulStyle: "solid",
    bright: false,
  };

  let activeTool = null; // 'highlight' | 'underline' | 'eraser' | null
  let popover = null;
  let lastCreate = 0;
  let demoActive = false;

  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 50;

  /* ----------------------------- icons ----------------------------- */

  const ICON = {
    highlight:
      '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
    eraser:
      '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a6 6 0 0 0 0 12h3"/>',
    cursor: '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
    grip:
      '<circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    copy:
      '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  };

  function svg(name, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' +
      (size || 18) +
      '" height="' +
      (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      ICON[name] +
      "</svg>"
    );
  }

  /* --------------------------- colour utils ------------------------ */

  function resolveColor(id) {
    const c = palette.find((p) => p.id === id);
    return c ? c.color : palette[0] ? palette[0].color : "#ffe14d";
  }
  function rgba(hex, a) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function brighten(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    let r = ((n >> 16) & 255) / 255,
      g = ((n >> 8) & 255) / 255,
      b = (n & 255) / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    let l = (max + min) / 2;
    let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let hh = 0;
    if (d !== 0) {
      if (max === r) hh = ((g - b) / d) % 6;
      else if (max === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh *= 60;
      if (hh < 0) hh += 360;
    }
    s = Math.min(1, s * 1.3 + 0.1);
    l = Math.min(0.7, Math.max(0.5, l));
    const c = (1 - Math.abs(2 * l - 1)) * s,
      x = c * (1 - Math.abs(((hh / 60) % 2) - 1)),
      m = l - c / 2;
    let rr = 0, gg = 0, bb = 0;
    if (hh < 60) [rr, gg, bb] = [c, x, 0];
    else if (hh < 120) [rr, gg, bb] = [x, c, 0];
    else if (hh < 180) [rr, gg, bb] = [0, c, x];
    else if (hh < 240) [rr, gg, bb] = [0, x, c];
    else if (hh < 300) [rr, gg, bb] = [x, 0, c];
    else [rr, gg, bb] = [c, 0, x];
    const hx = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return "#" + hx(rr) + hx(gg) + hx(bb);
  }

  /* --------------------------- annotations ------------------------- */

  function styleMark(el) {
    const color = resolveColor(el.dataset.color);
    el.style.cssText = "";
    if (el.dataset.type === "highlight") {
      el.style.backgroundColor = rgba(color, parseFloat(el.dataset.opacity || "0.5"));
      if (el.dataset.neon)
        el.style.boxShadow = `0 0 4px ${rgba(color, 0.95)}, 0 0 10px ${rgba(color, 0.55)}`;
    } else {
      el.style.textDecoration = "underline";
      el.style.textDecorationColor = el.dataset.bright ? brighten(color) : color;
      el.style.textDecorationThickness = (el.dataset.thickness || "3") + "px";
      el.style.textDecorationStyle = el.dataset.style || "solid";
      el.style.textUnderlineOffset = "3px";
    }
  }

  function makeMark(tool) {
    const span = document.createElement("span");
    span.className = "demo-mark";
    span.dataset.type = tool;
    if (tool === "highlight") {
      span.dataset.color = settings.hlColor;
      span.dataset.opacity = String(settings.opacity);
      if (settings.neon) span.dataset.neon = "1";
    } else {
      span.dataset.color = settings.ulColor;
      span.dataset.thickness = String(settings.thickness);
      span.dataset.style = settings.ulStyle;
      if (settings.bright) span.dataset.bright = "1";
    }
    styleMark(span);
    return span;
  }

  function wrapSelection(tool) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!note.contains(range.commonAncestorContainer)) return false;
    if (range.toString().trim() === "") return false;
    snapshot();
    const span = makeMark(tool);
    try {
      range.surroundContents(span);
    } catch (e) {
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      } catch (e2) {
        return false;
      }
    }
    sel.removeAllRanges();
    lastCreate = Date.now();
    return true;
  }

  function unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  }

  /* ---------------------------- history ---------------------------- */

  function snapshot() {
    undoStack.push(note.innerHTML);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(note.innerHTML);
    note.innerHTML = undoStack.pop();
    updateHistoryButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(note.innerHTML);
    note.innerHTML = redoStack.pop();
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    const u = toolbar.querySelector('[data-btn="undo"]');
    const r = toolbar.querySelector('[data-btn="redo"]');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }

  /* ---------------------------- toolbar ---------------------------- */

  const toolbar = document.createElement("div");
  toolbar.className = "demo-toolbar";
  toolbar.style.right = "16px";
  toolbar.style.bottom = "16px";
  stage.appendChild(toolbar);

  function btn(key, iconName, title, onClick, opts) {
    const b = document.createElement("button");
    b.className = "demo-btn";
    b.type = "button";
    b.dataset.btn = key;
    b.title = title;
    b.innerHTML = svg(iconName);
    if (opts && opts.colorbar) {
      const bar = document.createElement("span");
      bar.className = "demo-colorbar";
      b.appendChild(bar);
    }
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(b);
    });
    toolbar.appendChild(b);
    return b;
  }

  const grip = btn("grip", "grip", "Drag to move", () => {});
  grip.classList.add("demo-grip");
  attachDrag(grip);

  btn("highlight", "highlight", "Highlighter — click for colours & options", (b) =>
    onTool("highlight", b),
  { colorbar: true });
  btn("underline", "underline", "Underline — click for colours & options", (b) =>
    onTool("underline", b),
  { colorbar: true });
  btn("eraser", "eraser", "Eraser — click an annotation to remove it", () => {
    closePopover();
    setTool(activeTool === "eraser" ? null : "eraser");
  });
  btn("undo", "undo", "Undo (Ctrl/Cmd+Z)", () => undo());
  btn("redo", "redo", "Redo (Ctrl/Cmd+Shift+Z)", () => redo());
  btn("cursor", "cursor", "Stop annotating", () => {
    closePopover();
    setTool(null);
  });

  function renderToolbar() {
    toolbar.querySelectorAll(".demo-btn").forEach((b) => {
      const key = b.dataset.btn;
      const on =
        (key === "cursor" && activeTool === null) ||
        (key !== "cursor" && key === activeTool);
      b.classList.toggle("active", on);
    });
    ["highlight", "underline"].forEach((tool) => {
      const b = toolbar.querySelector(`[data-btn="${tool}"] .demo-colorbar`);
      if (b)
        b.style.backgroundColor = resolveColor(
          tool === "highlight" ? settings.hlColor : settings.ulColor,
        );
    });
    updateHistoryButtons();
  }

  function setTool(tool) {
    activeTool = tool;
    stage.classList.toggle("armed", tool === "highlight" || tool === "underline");
    stage.classList.toggle("tool-eraser", tool === "eraser");
    renderToolbar();
  }

  function onTool(tool, anchor) {
    if (activeTool !== tool) {
      setTool(tool);
      openPalette(tool, anchor);
    } else if (popover) {
      closePopover();
    } else {
      openPalette(tool, anchor);
    }
    renderToolbar();
  }

  /* --------------------------- popovers ---------------------------- */

  function closePopover() {
    if (popover) {
      popover.remove();
      popover = null;
    }
  }

  function positionPopover(pop, anchor) {
    const tb = anchor.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = tb.right - st.left - pr.width;
    let top = tb.top - st.top - pr.height - 8;
    left = Math.max(8, Math.min(left, st.width - pr.width - 8));
    top = Math.max(8, Math.min(top, st.height - pr.height - 8));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function newPopover(anchor) {
    closePopover();
    const pop = document.createElement("div");
    pop.className = "demo-pop";
    pop.addEventListener("pointerdown", (e) => e.stopPropagation());
    stage.appendChild(pop);
    popover = pop;
    // position after content is added by caller; expose helper
    pop._place = () => positionPopover(pop, anchor);
    return pop;
  }

  function swatchGrid(pop, opts) {
    const grid = document.createElement("div");
    grid.className = "demo-swatches";
    const paint = () => {
      grid.innerHTML = "";
      const canDelete = palette.length > 1;
      palette.forEach((c) => {
        const sw = document.createElement("button");
        sw.className = "demo-swatch";
        sw.type = "button";
        sw.style.backgroundColor = c.color;
        sw.title = c.name;
        if (opts.selected && opts.selected() === c.id) sw.classList.add("sel");
        sw.addEventListener("click", (ev) => {
          ev.stopPropagation();
          opts.onPick(c.id);
          if (opts.repaint) paint();
        });
        if (canDelete) {
          const del = document.createElement("span");
          del.className = "demo-swatch-del";
          del.innerHTML = svg("x", 10);
          del.title = "Delete " + c.name;
          del.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            deleteColor(c.id);
            paint();
            if (opts.onChanged) opts.onChanged();
          });
          sw.appendChild(del);
        }
        grid.appendChild(sw);
      });
      const add = document.createElement("button");
      add.className = "demo-swatch demo-swatch-add";
      add.type = "button";
      add.title = "Add a new colour";
      add.innerHTML = svg("plus", 14);
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openAddForm(pop, (id) => {
          paint();
          opts.onPick(id);
          if (opts.repaint) paint();
          if (opts.onChanged) opts.onChanged();
        });
      });
      grid.appendChild(add);
    };
    paint();
    pop.appendChild(grid);
    return { grid, paint };
  }

  function deleteColor(id) {
    if (palette.length <= 1) return;
    const i = palette.findIndex((c) => c.id === id);
    if (i === -1) return;
    palette.splice(i, 1);
    const fb = palette[0].id;
    if (settings.hlColor === id) settings.hlColor = fb;
    if (settings.ulColor === id) settings.ulColor = fb;
    renderToolbar();
  }

  function openAddForm(pop, onAdd) {
    // Replace popover contents with a compact add form.
    pop.innerHTML = "";
    const t = document.createElement("div");
    t.className = "demo-pop-title";
    t.textContent = "Add a colour";
    pop.appendChild(t);

    const form = document.createElement("div");
    form.className = "demo-add-form";
    const color = document.createElement("input");
    color.type = "color";
    color.value = "#7c5cff";
    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = "Name (e.g. Lilac)";
    const actions = document.createElement("div");
    actions.className = "demo-add-actions";
    const cancel = document.createElement("button");
    cancel.className = "demo-mini-btn";
    cancel.textContent = "Cancel";
    const addBtn = document.createElement("button");
    addBtn.className = "demo-mini-btn primary";
    addBtn.textContent = "Add";
    actions.append(cancel, addBtn);
    form.append(color, name, actions);
    pop.appendChild(form);
    pop._place && pop._place();
    name.focus();

    const finish = (id) => {
      // Rebuild whichever tool popover we came from.
      if (activeTool === "highlight" || activeTool === "underline")
        openPalette(activeTool, toolbar.querySelector(`[data-btn="${activeTool}"]`));
      if (id && onAdd) onAdd(id);
    };
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(null);
    });
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = "c-" + Math.random().toString(36).slice(2, 8);
      palette.push({ id, name: name.value.trim() || "Colour", color: color.value });
      finish(id);
    });
  }

  function toggle(row, get, set) {
    const t = document.createElement("span");
    t.className = "demo-toggle" + (get() ? " on" : "");
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      set(!get());
      t.classList.toggle("on", get());
    });
    row.appendChild(t);
    return t;
  }

  function openPalette(tool, anchor) {
    const pop = newPopover(anchor);
    const isHl = tool === "highlight";

    const title = document.createElement("div");
    title.className = "demo-pop-title";
    title.textContent = isHl ? "Highlighter" : "Underline";
    pop.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "demo-pop-sub";
    sub.textContent = isHl
      ? "Pick a colour, then drag across text to highlight it."
      : "Pick a colour, then drag across text to underline it.";
    pop.appendChild(sub);

    let updatePreview = () => {};
    swatchGrid(pop, {
      selected: () => (isHl ? settings.hlColor : settings.ulColor),
      repaint: true,
      onPick: (id) => {
        if (isHl) settings.hlColor = id;
        else settings.ulColor = id;
        renderToolbar();
        updatePreview();
      },
      onChanged: () => updatePreview(),
    });

    if (isHl) {
      const row = mkRow(pop, "Opacity");
      const s = mkRange(row, 0.1, 1, 0.05, settings.opacity);
      const v = mkVal(row, Math.round(settings.opacity * 100) + "%");
      s.addEventListener("input", () => {
        settings.opacity = parseFloat(s.value);
        v.textContent = Math.round(settings.opacity * 100) + "%";
        updatePreview();
      });
    } else {
      const rowT = mkRow(pop, "Thickness");
      const s = mkRange(rowT, 1, 5, 1, settings.thickness);
      const v = mkVal(rowT, settings.thickness + "px");
      s.addEventListener("input", () => {
        settings.thickness = parseInt(s.value, 10);
        v.textContent = settings.thickness + "px";
        updatePreview();
      });
      const rowS = mkRow(pop, "Style");
      const sel = document.createElement("select");
      ["solid", "dashed", "dotted", "wavy"].forEach((o) => {
        const op = document.createElement("option");
        op.value = o;
        op.textContent = o[0].toUpperCase() + o.slice(1);
        if (o === settings.ulStyle) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener("change", () => {
        settings.ulStyle = sel.value;
        updatePreview();
      });
      rowS.appendChild(sel);
    }

    const emRow = mkRow(pop, isHl ? "Neon Glow" : "Brighter");
    toggle(
      emRow,
      () => (isHl ? settings.neon : settings.bright),
      (v) => {
        if (isHl) settings.neon = v;
        else settings.bright = v;
        updatePreview();
      },
    );

    const preview = document.createElement("div");
    preview.className = "demo-preview";
    preview.textContent = "The quick brown fox";
    pop.appendChild(preview);
    updatePreview = () => {
      const color = resolveColor(isHl ? settings.hlColor : settings.ulColor);
      preview.style.cssText =
        "padding:9px 12px;border:1px dashed var(--border-strong);border-radius:8px;text-align:center;";
      if (isHl) {
        preview.style.backgroundColor = rgba(color, settings.opacity);
        if (settings.neon)
          preview.style.boxShadow = `0 0 4px ${rgba(color, 0.95)}, 0 0 10px ${rgba(color, 0.55)}`;
      } else {
        preview.style.textDecoration = "underline";
        preview.style.textDecorationColor = settings.bright ? brighten(color) : color;
        preview.style.textDecorationThickness = settings.thickness + "px";
        preview.style.textDecorationStyle = settings.ulStyle;
        preview.style.textUnderlineOffset = "3px";
      }
    };
    updatePreview();
    pop._place();
  }

  function mkRow(pop, labelText) {
    const row = document.createElement("div");
    row.className = "demo-row";
    const l = document.createElement("label");
    l.textContent = labelText;
    row.appendChild(l);
    pop.appendChild(row);
    return row;
  }
  function mkRange(row, min, max, step, value) {
    const s = document.createElement("input");
    s.type = "range";
    s.min = min;
    s.max = max;
    s.step = step;
    s.value = value;
    row.appendChild(s);
    return s;
  }
  function mkVal(row, text) {
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = text;
    row.appendChild(v);
    return v;
  }

  /* --------------------- annotation management --------------------- */

  function openManagePopover(mark) {
    const pop = newPopover(toolbar);
    const isHl = mark.dataset.type === "highlight";
    const title = document.createElement("div");
    title.className = "demo-pop-title";
    title.textContent = "Recolour or edit";
    pop.appendChild(title);

    swatchGrid(pop, {
      repaint: false,
      onPick: (id) => {
        snapshot();
        mark.dataset.color = id;
        styleMark(mark);
        closePopover();
      },
      onChanged: () => {},
    });

    const actions = document.createElement("div");
    actions.className = "demo-actions";
    const mk = (icon, label, fn) => {
      const b = document.createElement("button");
      b.className = "demo-action";
      b.innerHTML = svg(icon, 15) + "<span>" + label + "</span>";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      actions.appendChild(b);
    };
    mk("swap", isHl ? "Convert to underline" : "Convert to highlight", () => {
      snapshot();
      if (isHl) {
        mark.dataset.type = "underline";
        delete mark.dataset.opacity;
        delete mark.dataset.neon;
        mark.dataset.thickness = String(settings.thickness);
        mark.dataset.style = settings.ulStyle;
      } else {
        mark.dataset.type = "highlight";
        delete mark.dataset.thickness;
        delete mark.dataset.style;
        delete mark.dataset.bright;
        mark.dataset.opacity = String(settings.opacity);
      }
      styleMark(mark);
      closePopover();
    });
    mk("copy", "Copy text", () => {
      const text = mark.textContent || "";
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      closePopover();
    });
    mk("trash", "Delete", () => {
      snapshot();
      unwrap(mark);
      closePopover();
    });
    pop.appendChild(actions);

    // Position near the clicked mark instead of the toolbar.
    const st = stage.getBoundingClientRect();
    const mr = mark.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let left = mr.left - st.left;
    let top = mr.bottom - st.top + 8;
    if (top + pr.height > st.height - 8) top = mr.top - st.top - pr.height - 8;
    left = Math.max(8, Math.min(left, st.width - pr.width - 8));
    top = Math.max(8, Math.min(top, st.height - pr.height - 8));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  /* ---------------------------- events ----------------------------- */

  note.addEventListener("mouseup", () => {
    if (activeTool === "highlight" || activeTool === "underline") {
      if (wrapSelection(activeTool)) renderToolbar();
    }
  });
  // Touch: apply on selection end.
  note.addEventListener("touchend", () => {
    if (activeTool === "highlight" || activeTool === "underline") {
      setTimeout(() => {
        if (wrapSelection(activeTool)) renderToolbar();
      }, 0);
    }
  });

  note.addEventListener("click", (ev) => {
    const t = ev.target;
    const mark = t && t.closest ? t.closest(".demo-mark") : null;
    if (Date.now() - lastCreate < 300) return;
    if (activeTool === "eraser") {
      if (mark) {
        ev.preventDefault();
        snapshot();
        unwrap(mark);
      }
      return;
    }
    if (activeTool === "highlight" || activeTool === "underline") return;
    if (mark) {
      ev.preventDefault();
      openManagePopover(mark);
    }
  });

  // Track whether the user is interacting with the demo (for scoped shortcuts).
  document.addEventListener(
    "pointerdown",
    (ev) => {
      demoActive = stage.contains(ev.target);
      if (popover && !popover.contains(ev.target) && !toolbar.contains(ev.target)) {
        closePopover();
      }
    },
    true,
  );

  document.addEventListener("keydown", (ev) => {
    if (!demoActive) return;
    if (ev.key.toLowerCase() !== "z" || ev.altKey) return;
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const el = ev.target;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  });

  window.addEventListener("resize", closePopover);

  /* ----------------------------- drag ------------------------------ */

  function attachDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      closePopover();
      const st = stage.getBoundingClientRect();
      const tb = toolbar.getBoundingClientRect();
      const offX = ev.clientX - tb.left;
      const offY = ev.clientY - tb.top;
      const onMove = (e) => {
        let x = e.clientX - st.left - offX;
        let y = e.clientY - st.top - offY;
        x = Math.max(6, Math.min(x, st.width - tb.width - 6));
        y = Math.max(6, Math.min(y, st.height - tb.height - 6));
        toolbar.style.left = x + "px";
        toolbar.style.top = y + "px";
        toolbar.style.right = "";
        toolbar.style.bottom = "";
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  /* ----------------------------- init ------------------------------ */

  renderToolbar();
})();
