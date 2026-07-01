import type { PaletteColor, PluginSettings, ToolbarPlacement } from "./types";

export const SCHEMA_VERSION = 1;

export const CLS_WRAPPER = "rhl";
export const CLS_HIGHLIGHT = "rhl-highlight";
export const CLS_UNDERLINE = "rhl-underline";

export const ATTR_ID = "data-rhl-id";
export const ATTR_GROUP = "data-rhl-group";
export const ATTR_TYPE = "data-rhl-type";

export const READING_VIEW_SELECTOR = ".markdown-reading-view, .markdown-preview-view";

// Never wrap text inside these — it would break their formatting.
export const SKIP_TAGS = new Set(["PRE", "CODE", "KBD", "SAMP"]);

// Five vivid hues that work as a neon highlight and as a crisp underline, and
// stay distinct on light and dark themes.
export const DEFAULT_PALETTE: PaletteColor[] = [
  { id: "c-yellow", name: "Citrus", color: "#ffe14d" },
  { id: "c-green", name: "Lime", color: "#46f08c" },
  { id: "c-cyan", name: "Aqua", color: "#33e1ff" },
  { id: "c-pink", name: "Magenta", color: "#ff5fb0" },
  { id: "c-orange", name: "Coral", color: "#ff8a3d" },
];

export function defaultSettings(): PluginSettings {
  return {
    palette: DEFAULT_PALETTE.map((c) => ({ ...c })),
    defaultTool: "highlight",
    lastHighlightColorId: "c-yellow",
    lastUnderlineColorId: "c-green",
    highlightOpacity: 0.5,
    neonEffect: false,
    brightUnderline: false,
    underline: { thickness: 3, style: "solid", offset: 3 },

    stickyTool: true,
    swapClickRoles: true,
    clearSelectionAfter: true,
    confirmDelete: false,
    skipCodeBlocks: true,
    applyInLivePreview: true,
    contextLength: 64,
    followRenames: true,
    pruneOnDelete: true,

    showToolbar: true,
    showEraser: true,
    showUndoRedo: true,
    showSettingsButton: true,

    highContrast: false,
  };
}

// Separate from defaultSettings because placement is device-local, not synced.
export function defaultToolbarPlacement(): ToolbarPlacement {
  return { corner: "br", x: null, y: null };
}
