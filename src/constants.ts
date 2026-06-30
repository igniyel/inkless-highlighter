import type { PaletteColor, PluginSettings, ToolbarPlacement } from "./types";

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

/**
 * Default colour palette — five vivid hues, each chosen to do double duty: as a
 * luminous neon highlight (with the glow effect on) and as a crisp, legible
 * underline. They stay distinct from one another on both light and dark themes.
 */
export const DEFAULT_PALETTE: PaletteColor[] = [
  { id: "c-yellow", name: "Citrus", color: "#ffe14d" },
  { id: "c-green", name: "Lime", color: "#46f08c" },
  { id: "c-cyan", name: "Aqua", color: "#33e1ff" },
  { id: "c-pink", name: "Magenta", color: "#ff5fb0" },
  { id: "c-orange", name: "Coral", color: "#ff8a3d" },
];

/** Factory for default settings (so each load gets a fresh object). */
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

/**
 * Default toolbar placement. Kept separate from {@link defaultSettings} because
 * placement is stored per device (localStorage), not in the synced plugin data.
 */
export function defaultToolbarPlacement(): ToolbarPlacement {
  return { corner: "br", x: null, y: null };
}
