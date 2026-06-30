/**
 * Shared type definitions for the Inkless Highlighter plugin.
 */

/** The two annotation tools the user can switch between. */
export type ToolType = "highlight" | "underline";

/** Which tool (if any) is currently armed for drag-to-apply. */
export type ActiveTool = ToolType | "eraser" | null;

/** Underline appearance options. */
export interface UnderlineStyleOptions {
  /** Stroke thickness in pixels (text-decoration-thickness). */
  thickness: number;
  /** Line style. */
  style: "solid" | "dashed" | "dotted" | "wavy";
  /** Gap between the baseline and the line, in pixels (text-underline-offset). */
  offset: number;
}

/** A single, user-editable colour swatch in the palette. */
export interface PaletteColor {
  /** Stable identifier, referenced by highlight records. */
  id: string;
  /** Human-readable label shown in the UI. */
  name: string;
  /** Base colour as a hex string, e.g. "#ffd54f". */
  color: string;
}

/**
 * A persisted annotation.
 *
 * Highlights are stored non-destructively (the markdown file is never
 * rewritten). Each record carries a W3C-style text-quote anchor (exact text
 * plus surrounding context) so it can be re-located and re-applied on every
 * render, even if the surrounding note changes moderately.
 */
export interface HighlightRecord {
  /** Unique id for this annotation. */
  id: string;
  /**
   * Group id shared by sub-records produced from a single multi-block
   * selection. Deleting or recolouring one member affects the whole group.
   */
  groupId: string;
  /** Whether this is a background highlight or an underline. */
  type: ToolType;
  /** Palette colour id this annotation was created with (may be stale). */
  colorId: string;
  /** Resolved colour snapshot, so appearance survives palette edits. */
  color: string;
  /** Background opacity for highlights (0..1). Ignored for underlines. */
  opacity: number;
  /**
   * Whether this annotation was created with its tool's emphasis effect on —
   * the neon glow for highlights, or the brighter colour for underlines.
   * Snapshotted (like colour and opacity) so appearance survives later changes
   * to the global defaults.
   */
  neon?: boolean;
  /** Underline options snapshot. Present only for underline records. */
  underline?: UnderlineStyleOptions;

  /** Normalised, trimmed selected text. Primary anchor. */
  exact: string;
  /** Up to `contextLength` normalised characters before `exact`. */
  prefix: string;
  /** Up to `contextLength` normalised characters after `exact`. */
  suffix: string;
  /**
   * 0-based index of this occurrence of `exact` within its block at creation
   * time. Used as a tie-breaker when prefix/suffix cannot disambiguate.
   */
  occurrence: number;

  /** Structural paragraph index captured at creation for relocation fallback. */
  paragraphIndex?: number;
  /** Nearest heading index captured at creation for relocation fallback. */
  headingIndex?: number;

  /** Epoch milliseconds of creation. */
  createdAt: number;
  /** Optional free-text note (reserved for future annotation UI). */
  note?: string;
}

/** Map of vault-relative file path -> annotations in that file. */
export type FileHighlights = Record<string, HighlightRecord[]>;

/** Corner the floating toolbar docks to before any manual drag. */
export type ToolbarCorner = "tl" | "tr" | "bl" | "br";

/**
 * Toolbar placement. Stored **per device** in localStorage rather than in the
 * synced plugin data, because a pixel position that is right on one screen is
 * wrong on another — and Obsidian Sync would otherwise copy it everywhere.
 */
export interface ToolbarPlacement {
  corner: ToolbarCorner;
  /** Manual pixel offset from the docked corner, if the user dragged it. */
  x: number | null;
  y: number | null;
}

/** Everything the user can configure. */
export interface PluginSettings {
  /** Editable colour palette. */
  palette: PaletteColor[];
  /** Tool selected by default when the toolbar first appears. */
  defaultTool: ToolType;
  /** Last colour used for highlights. */
  lastHighlightColorId: string;
  /** Last colour used for underlines. */
  lastUnderlineColorId: string;
  /** Default background opacity for new highlights (0..1). */
  highlightOpacity: number;
  /**
   * Add a luminous neon glow to new *highlights*. The default palette colours
   * are tuned for it. Underlines use {@link brightUnderline} instead.
   */
  neonEffect: boolean;
  /**
   * Render new *underlines* in a brighter, more vivid version of their colour.
   * The highlighter's equivalent is {@link neonEffect}.
   */
  brightUnderline: boolean;
  /** Default underline options for new underlines. */
  underline: UnderlineStyleOptions;

  /** Keep the tool armed after each annotation (sticky) vs. one-shot. */
  stickyTool: boolean;
  /**
   * Which mouse button opens the colour palette vs. just selects the tool.
   * false (default): left-click opens the palette (+arms), right-click only
   * selects. true: those roles are swapped.
   */
  swapClickRoles: boolean;
  /** Clear the text selection immediately after applying. */
  clearSelectionAfter: boolean;
  /** Ask for confirmation before deleting an annotation. */
  confirmDelete: boolean;
  /** Never annotate inside fenced/inline code. */
  skipCodeBlocks: boolean;
  /** Also render existing annotations in Live Preview (edit) mode. */
  applyInLivePreview: boolean;
  /** How many context characters to capture on each side for anchoring. */
  contextLength: number;
  /** Migrate annotations to a note's new path when it is renamed/moved. */
  followRenames: boolean;
  /** Delete annotations when their note is deleted (vs. keep for restore). */
  pruneOnDelete: boolean;

  /** Show the floating toolbar in Reading view. */
  showToolbar: boolean;
  /** Show the eraser button in the toolbar. */
  showEraser: boolean;
  /** Show undo and redo buttons in the toolbar. */
  showUndoRedo: boolean;
  /** Show the settings (gear) button in the toolbar. */
  showSettingsButton: boolean;

  /** Add a subtle border to annotations for low-contrast themes. */
  highContrast: boolean;
}

/** Top-level persisted blob written via Plugin.saveData. */
export interface PersistedData {
  /** Schema version, for future migrations. */
  schema: number;
  settings: PluginSettings;
  highlights: FileHighlights;
}

/** SimHash fingerprints used by the production matching pipeline. */
export interface AnnotationFingerprints {
  exact: string;
  prefix: string;
  suffix: string;
  block: string;
}

/** CRDT value metadata for per-field conflict resolution. */
export interface FieldVersion<T = unknown> {
  value: T;
  timestamp: number;
  deviceId: string;
}

/** IndexedDB-backed annotation record with durability/sync metadata. */
export interface StoredAnnotation extends HighlightRecord {
  filePath: string;
  fileId: string;
  contentHash: string;
  simhash: AnnotationFingerprints;
  vectorClock: Record<string, number>;
  fieldVersions: Record<string, FieldVersion>;
  updatedAt: number;
  deletedAt?: number;
  tombstoneUntil?: number;
  compressedPrefix?: string;
  compressedSuffix?: string;
  confidence?: number;
}

export interface Operation {
  type: "add" | "remove" | "update";
  records?: StoredAnnotation[];
  patch?: Partial<HighlightRecord>;
  groupId?: string;
}

/** Persistent undo/redo entry stored for crash-safe history replay. */
export interface HistoryRecord {
  filePath: string;
  sequence: number;
  timestamp: number;
  type: "undoable" | "system" | "sync";
  description: string;
  inverseOps: Operation[];
  forwardOps: Operation[];
  preState: string;
  postState: string;
}
