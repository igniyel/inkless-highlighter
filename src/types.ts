export type ToolType = "highlight" | "underline";

// The currently armed tool, if any.
export type ActiveTool = ToolType | "eraser" | null;

export interface UnderlineStyleOptions {
  thickness: number;
  style: "solid" | "dashed" | "dotted" | "wavy";
  offset: number;
}

export interface PaletteColor {
  id: string;
  name: string;
  color: string;
}

// A stored annotation. The note is never rewritten; each record keeps a
// text-quote anchor (exact text + surrounding context) so it can be found and
// re-applied on every render.
export interface HighlightRecord {
  id: string;
  // Shared by every sub-record from one multi-block selection, so they delete
  // and recolour together.
  groupId: string;
  type: ToolType;
  colorId: string;
  // Resolved colour, snapshotted so appearance survives palette edits.
  color: string;
  opacity: number;
  // Whether the tool's emphasis effect was on: neon glow for highlights,
  // brighter colour for underlines.
  neon?: boolean;
  underline?: UnderlineStyleOptions;

  exact: string;
  prefix: string;
  suffix: string;
  // Which occurrence of `exact` within its block this was, at creation time.
  occurrence: number;

  createdAt: number;
  note?: string;
}

export type FileHighlights = Record<string, HighlightRecord[]>;

export type ToolbarCorner = "tl" | "tr" | "bl" | "br";

// Kept per device (localStorage), not in the synced data — a pixel position
// that fits one screen is wrong on another.
export interface ToolbarPlacement {
  corner: ToolbarCorner;
  x: number | null;
  y: number | null;
}

export interface PluginSettings {
  palette: PaletteColor[];
  defaultTool: ToolType;
  lastHighlightColorId: string;
  lastUnderlineColorId: string;
  highlightOpacity: number;
  // Neon glow for new highlights; underlines use brightUnderline.
  neonEffect: boolean;
  brightUnderline: boolean;
  underline: UnderlineStyleOptions;

  stickyTool: boolean;
  // false: click opens the palette, right-click selects. true: swapped.
  swapClickRoles: boolean;
  clearSelectionAfter: boolean;
  confirmDelete: boolean;
  skipCodeBlocks: boolean;
  applyInLivePreview: boolean;
  contextLength: number;
  followRenames: boolean;
  pruneOnDelete: boolean;

  showToolbar: boolean;
  showEraser: boolean;
  showUndoRedo: boolean;
  showSettingsButton: boolean;

  highContrast: boolean;
}

// The data.json blob written through Plugin.saveData (settings only, since v2).
export interface PersistedData {
  schema: number;
  settings: PluginSettings;
  highlights: FileHighlights;
}
