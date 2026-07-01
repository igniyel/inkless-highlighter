# Changelog

## 1.1.0

- **Mobile & iPad** — larger touch targets, tap a tool to select it and
  long-press to open its colours and options. The toolbar stays on-screen when
  the device rotates, and its position is remembered per device (never synced).
- **Palette** — five neon-ready default colours in a six-column grid. Add a
  named colour from the "+" tile, or remove one from the hover "×" on any swatch,
  without opening settings.
- **Styles** — a neon glow for highlights and a brighter line for underlines,
  as independent per-tool toggles (available in the tool popover and settings).
- **Undo / redo** — `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` in Reading view, per
  note (the last 50 changes, renewed when the note is reopened). Optional
  toolbar buttons.
- **Survives edits** — annotations re-anchor when you reword the text they
  cover, and a repeated word elsewhere in the note is no longer highlighted by
  mistake.
- **Storage** — annotations are kept as per-file JSON shards with lazy loading
  and in-memory indexes: incremental writes and lower memory, still stored in
  the plugin folder so they travel with your vault. An existing `data.json` is
  migrated automatically and a backup is kept.

## 1.0.0

- Initial release: drag to highlight or underline in Reading view,
  non-destructively, with an editable colour palette and no hotkeys required.
