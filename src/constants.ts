import type { PaletteColor, PluginSettings } from "./types";

/** Bump when the persisted-data shape changes in a breaking way. */
export const SCHEMA_VERSION = 1;

/** CSS class applied to every annotation wrapper element. */
export const CLS_WRAPPER = "rhl";
export const CLS_HIGHLIGHT = "rhl-highlight";
export const CLS_UNDERLINE = "rhl-underline";

/** data-* attribute names used on wrapper elements. */
export const ATTR_ID = "data-rhl-id";
export const ATTR_GROUP = "data-rhl-group";
export const ATTR_TYPE = "data-rhl-type";

/** Root classes used to detect rendered Markdown containers. */
export const READING_VIEW_SELECTOR = ".markdown-reading-view, .markdown-preview-view";

/** Elements whose text should never be wrapped (would break formatting). */
export const SKIP_TAGS = new Set(["PRE", "CODE", "KBD", "SAMP"]);

/** Default colour palette. Hex values are tuned to read well over body text. */
export const DEFAULT_PALETTE: PaletteColor[] = [
  { id: "c-yellow", name: "Yellow", color: "#ffd54f" },
  { id: "c-green", name: "Green", color: "#81c784" },
  { id: "c-blue", name: "Blue", color: "#64b5f6" },
  { id: "c-pink", name: "Pink", color: "#f06292" },
  { id: "c-orange", name: "Orange", color: "#ffb74d" },
  { id: "c-purple", name: "Purple", color: "#ba68c8" },
  { id: "c-red", name: "Red", color: "#e57373" },
  { id: "c-teal", name: "Teal", color: "#4db6ac" },
];

/** Factory for default settings (so each load gets a fresh object). */
export function defaultSettings(): PluginSettings {
  return {
    palette: DEFAULT_PALETTE.map((c) => ({ ...c })),
    defaultTool: "highlight",
    lastHighlightColorId: "c-yellow",
    lastUnderlineColorId: "c-red",
    highlightOpacity: 0.4,
    underline: { thickness: 2, style: "solid", offset: 3 },

    stickyTool: true,
    swapClickRoles: false,
    clearSelectionAfter: true,
    confirmDelete: false,
    skipCodeBlocks: true,
    applyInLivePreview: true,
    contextLength: 32,
    followRenames: true,
    pruneOnDelete: false,

    showToolbar: true,
    toolbarPlacement: { corner: "br", x: null, y: null },
    showEraser: true,
    showSettingsButton: true,

    highContrast: false,
  };
}
