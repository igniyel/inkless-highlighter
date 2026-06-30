# Inkless Highlighter

Highlight and underline text **directly in Obsidian's Reading view** by dragging
to select it. Pick a colour from a customisable palette, switch between the
highlighter and the underline tool with a click, and never touch a hotkey or
edit the underlying note.

Annotations are stored **non-destructively**: your Markdown files are never
rewritten. The plugin remembers each annotation by the text it covers and
re-applies it every time the note is rendered.

---

## Table of contents

1. [What this plugin does](#what-this-plugin-does)
2. [The interaction model](#the-interaction-model)
3. [Why non-destructive highlighting](#why-non-destructive-highlighting)
4. [How anchoring works](#how-anchoring-works)
5. [Feature reference](#feature-reference)
6. [Settings reference](#settings-reference)
7. [Edge cases and how they are handled](#edge-cases-and-how-they-are-handled)
8. [Accessibility](#accessibility)
9. [Performance](#performance)
10. [Security and privacy](#security-and-privacy)
11. [Compatibility](#compatibility)
12. [Installation](#installation)
13. [Building from source](#building-from-source)
14. [Troubleshooting](#troubleshooting)
15. [Known limitations](#known-limitations)
16. [Roadmap](#roadmap)
17. [Data format](#data-format)
18. [License](#license)

---

## What this plugin does

- Adds a small floating **toolbar** to the Reading view of any note.
- Lets you **drag-select** text and have it instantly highlighted or underlined.
- Provides an editable **colour palette** with per-colour opacity (for
  highlights) and thickness / line-style (for underlines).
- Stores annotations **with the plugin**, not in the note, so the source
  Markdown stays exactly as you wrote it and the same note can be highlighted
  differently across vaults if you choose.
- Lets you **recolour, convert, copy, or delete** an annotation by clicking it.
- Survives note **renames and moves**, and optionally cleans up when a note is
  deleted.
- Requires **no hotkeys**. Commands exist for power users, but nothing is bound
  by default.

### Non-goals

- It does **not** rewrite your notes with `==marks==` or HTML. (You can *export*
  to that format on demand — see the export command — but it is never automatic.)
- It does **not** highlight in the editor's *typing* surface. Reading view is
  the place you drag to annotate. Live Preview can optionally *display* existing
  annotations, read-only.
- It is **not** a comments or footnotes system. A free-text note field exists in
  the data model for future use but has no UI yet.

---

## The interaction model

This is the exact flow the plugin implements.

1. **Open a note in Reading view.** A compact toolbar appears in a corner
   (bottom-right by default). It has a drag handle, a highlighter button, an
   underline button, an eraser, a "stop" button, and a settings gear. The
   eraser and gear can be hidden in settings.

2. **Pick a tool.**

   *On a computer*, each tool button responds to two clicks:
   - **Left-click** opens that tool's **palette popover** — where you pick a
     colour and set everything (opacity and a neon glow for the highlighter;
     thickness, line style, and a brighter line for the underline) — and arms
     the tool at the same time.
   - **Right-click** *only selects* the tool (arms it) without opening the
     popover. Right-click an already-selected tool to deselect it.

   You can swap these two roles in settings ("Swap left/right click on tool
   buttons") if you prefer right-click for the palette.

   *On a phone or iPad*, the same two intents map to touch:
   - **Tap** a tool to select it (tap again to deselect), then drag to annotate.
   - **Long-press** a tool to open its colours and options.

   The button shows a coloured bar indicating the current colour. While a tool
   is armed, the Reading view keeps a text cursor so you can still select
   normally.

3. **Drag across some text.** When you release the mouse (or lift your finger),
   the selected text is wrapped and styled immediately, and the annotation is
   saved. If "sticky" is on (the default) the tool stays armed for the next
   selection; if not, it disarms after one annotation.

4. **Adjust parameters any time.** Re-open a tool's palette popover whenever it
   is already armed — left-click it (computer) or long-press it (touch); this
   does **not** disarm it. In the popover:
   - **Highlighter:** choose a colour, set **opacity**, and toggle a **neon
     glow**.
   - **Underline:** choose a colour, set **thickness** and **line style**
     (solid / dashed / dotted / wavy), and toggle a **brighter** line.
   - **Both:** add a new named colour from the dashed **“+” tile** at the end of
     the palette.
   A live preview shows the result.

5. **Manage an existing annotation.** With no tool armed, click any highlight or
   underline to open a small popover that lets you **recolour** it, **convert**
   between highlight and underline, **copy** its text, or **delete** it.

6. **Erase quickly.** Click the eraser button, then click annotations to remove
   them. Click "stop" (the cursor icon) to disarm everything.

7. **Undo and redo.** In Reading view, `Ctrl/Cmd+Z` undoes your last annotation
   change — so pressing it straight after annotating removes what you just
   added — and `Ctrl/Cmd+Shift+Z` redoes it. History is per note, covers the
   last 50 changes, and starts fresh each time you open the note's tab. Optional
   undo/redo toolbar buttons can be enabled in settings.

8. **Move the toolbar.** Drag the grip handle to reposition it; the position is
   remembered **per device** (it is never synced to your other devices, so a
   spot that suits your phone never displaces the toolbar on your desktop).
   "Reset toolbar position" in settings snaps it back to its corner.

On a computer, a click on a tool icon reaches every parameter and a right-click
is the quick "just select it" gesture (the two can be swapped in settings). On
touch, a long-press reaches the parameters and a tap is the quick select.

---

## Why non-destructive highlighting

There are two ways a Reading-mode highlighter could work:

- **Rewrite the note** — insert `==text==` or `<mark>` into the Markdown. This is
  portable but invasive: it changes your files, pollutes diffs, can collide with
  other Markdown, and requires solving the hard problem of mapping a position in
  *rendered* HTML back to an exact offset in *source* Markdown (rendering is
  lossy and many-to-one).

- **Annotate non-destructively** — leave the file alone and remember each
  annotation by the text it covers, re-applying it on every render. This is the
  approach here.

The trade-off: non-destructive annotations live with the plugin's data, so they
travel through Obsidian Sync or Git as part of the plugin folder, not inside the
note. For portability when you need it, an **export to Markdown** command turns a
note's annotations into `==highlight==` / `<u>underline</u>` text you can paste
anywhere.

---

## How anchoring works

Each annotation is stored as a **text quote**, the same idea behind the W3C Web
Annotation model:

- **`exact`** — the selected text, with runs of whitespace collapsed to single
  spaces and the ends trimmed. This is the primary key.
- **`prefix` / `suffix`** — a short run of context (32 characters each by
  default) immediately before and after the selection, normalised the same way.
- **`occurrence`** — which instance of `exact` this was, counting from the start
  of its block, used as a final tie-breaker.

On every render the engine:

1. Collects the visible text of the rendered container (skipping code and any
   text already inside an annotation wrapper).
2. Builds a whitespace-normalised copy of that text **plus a map back to the raw
   character offsets**, so a match in normalised space can be translated to real
   DOM positions.
3. Finds every position of `exact` and keeps the one whose surrounding text best
   matches the stored `prefix`/`suffix` (with `occurrence` breaking ties) — but
   **only if that context is convincing**. A bare repeat of the same words in a
   different place, with different surroundings, is deliberately left untouched.
   This matters because Obsidian renders Reading view section by section, so
   without the context check the same record would be re-applied to every
   section that merely repeats its words.
4. **If `exact` is gone** — because you edited the annotated sentence — it
   *re-anchors* instead of giving up: it brackets the annotation between the
   strongest anchor on each side (the stored context, or the selection's own
   first / last word) and re-applies to whatever text now sits between them.
   The candidate span is length-bounded so a stray match can't engulf the page.
5. Wraps the matching characters by **splitting and wrapping the existing text
   nodes** — never by injecting HTML. A selection that crosses inline elements
   (bold, links, etc.) yields several adjacent wrappers that share one id.

Because matching is text-based and self-healing, an annotation keeps working
when you reword the sentence it covers, when the surrounding note is edited, when
the note is re-rendered lazily as you scroll, or when it is viewed on another
device.

### Capturing a selection

When you release a drag, the selection is split into **one capture per
block-level element** it touches (paragraph, list item, heading, table cell,
blockquote, callout title, definition term/description, figure caption). Each
capture records its own `exact`/`prefix`/`suffix`/`occurrence`, and all captures
from a single drag share a **group id** so they are recoloured or deleted
together.

---

## Feature reference

### Tools

| Tool | Armed by | Effect |
| --- | --- | --- |
| Highlighter | click (or long-press on touch) opens its palette and arms it; right-click or tap only selects it | drag-select paints a background highlight |
| Underline | click (or long-press on touch) opens its palette and arms it; right-click or tap only selects it | drag-select draws an underline |
| Eraser | clicking the eraser button | clicking an annotation removes it |
| Stop | clicking the cursor button | disarms all tools |

(Left/right roles for the highlighter and underline buttons can be swapped in
settings; on touch, tap selects and long-press opens the options.)

### Palette popover

- A six-column grid of palette swatches; the current one is ringed. The grid
  grows downward as you add colours, and ends with a dashed **“+” tile** that
  adds a new, named colour on the spot.
- **Highlighter:** opacity slider (10–100%).
- **Underline:** thickness slider (1–5 px) and a style dropdown
  (solid / dashed / dotted / wavy).
- A **neon glow** toggle for the highlighter, or a **brighter** toggle for the
  underline.
- A live preview of the current settings.

### Annotation popover (click an annotation with no tool armed)

- Recolour using any palette swatch.
- **Make underline / Make highlight** — convert the annotation's type.
- **Copy text** — copy the annotated text to the clipboard.
- **Delete** — remove the annotation (with optional confirmation).

### Commands (no default hotkeys; bind your own if you like)

- **Toggle highlighter**
- **Toggle underline**
- **Cycle to next colour** (of the current tool)
- **Stop annotating**
- **Undo last annotation change** (Reading view: `Ctrl/Cmd+Z`)
- **Redo annotation change** (Reading view: `Ctrl/Cmd+Shift+Z`)
- **Erase last annotation in note**
- **Copy note's annotations as Markdown**
- **Open highlighter settings**

---

## Settings reference

### Behaviour

| Setting | Default | What it does |
| --- | --- | --- |
| Default tool | Highlighter | Which tool the toggle commands fall back to. |
| Keep tool active (sticky) | On | Stay armed after each annotation. |
| Clear selection after annotating | On | Deselect text once applied. |
| Confirm before deleting | Off | Ask before removing an annotation. |
| Skip code | On | Never annotate inside code blocks / inline code. |
| Show annotations in Live Preview | On | Also paint (read-only) in the editor's Live Preview. |
| Context length | 64 | Characters of context stored per side for re-locating. |
| Follow renames | On | Move annotations with a renamed/moved note. |
| Delete annotations with note | On | Remove annotations when the note is deleted. |

### Appearance

| Setting | Default | What it does |
| --- | --- | --- |
| Default highlight opacity | 50% | Starting strength for new highlights. |
| Neon glow on highlights | Off | Wrap new highlights in a luminous halo of their colour. |
| Brighter underlines | Off | Draw new underlines in a more vivid version of their colour (line only). |
| Default underline thickness | 3 px | Line thickness for new underlines. |
| Default underline style | Solid | Line style for new underlines. |
| Default underline offset | 3 px | Gap between baseline and underline. |
| High-contrast outline | Off | Adds a subtle border to highlights for low-contrast themes. |

### Toolbar

| Setting | Default | What it does |
| --- | --- | --- |
| Swap left/right click on tool buttons | On | Off: left-click opens the palette, right-click selects. On: swap them. |
| Show toolbar in Reading view | On | Hide it entirely if you prefer commands. |
| Toolbar corner | Bottom right | Where it docks before you drag it (remembered per device). |
| Reset toolbar position | — | Clears this device's manual drag offset. |
| Show eraser button | On | Show/hide the eraser. |
| Show undo/redo buttons | On | Show undo and redo buttons in the toolbar (the shortcuts work either way). |
| Show settings button | On | Show/hide the gear. |

### Colour palette

A full editor: change a colour with the colour picker, rename it, reorder with
the up/down buttons, delete it, **add** new colours, or **reset** to the five
defaults. The five defaults are tuned to read well both as a glowing neon
highlight and as a crisp underline. Editing a colour affects *future*
annotations; existing annotations keep the colour they were created with (their
appearance is snapshotted).

### Data

- **Stored annotations** — a live count across your notes.
- **Export all annotations** — download a JSON backup.
- **Import annotations** — merge a previously exported backup (existing
  annotations are kept; duplicates by id are skipped).
- **Reset everything** — delete all annotations and restore default settings.

---

## Edge cases and how they are handled

- **Selection spanning bold/italic/links.** The matched characters are wrapped
  in several adjacent elements sharing one id, so inline formatting is preserved
  and the whole run behaves as a single annotation.
- **Selection spanning several paragraphs or list items.** Split into one
  capture per block; all share a group id.
- **Tables, callouts, blockquotes, definition lists, figure captions.** Treated
  as first-class blocks and can be annotated.
- **Code.** Skipped by default (configurable). Inline and fenced code are never
  wrapped, and their text is excluded from matching so offsets stay correct.
- **Duplicate text in the note** (e.g. the word "set" in several places).
  Disambiguated by the stored prefix/suffix context and the occurrence index:
  the annotation sticks to the one place whose surroundings match, and other
  copies of the same words — in the same block or any other section — are left
  untouched.
- **Lazy rendering of long notes.** Obsidian renders Reading view in sections as
  you scroll; the post-processor runs per section, so annotations appear as
  their text scrolls into view.
- **Re-renders.** Applying is idempotent within a render: an annotation already
  present (by id) in a container is not wrapped again.
- **Renames / moves.** Annotations follow the note (if "Follow renames" is on).
- **Deletes.** Kept by default so they return if the note does; can be pruned.
- **Palette edits / deletions.** Existing annotations keep their snapshotted
  colour. If a currently-selected tool colour is deleted, it falls back to the
  first palette colour.
- **Malformed colour values.** Coerced to a safe hex; a bad value never breaks
  rendering.

---

## Accessibility

- The toolbar is a labelled `toolbar` with real `<button>` elements and tooltips.
- Keyboard focus rings use the theme's accent colour (`:focus-visible`).
- Popovers close on **Escape** and on outside click.
- Annotation wrappers carry an `aria-label` describing their type.
- Animations are disabled under `prefers-reduced-motion`.
- A high-contrast outline option keeps highlights legible on dark or
  low-contrast themes.

---

## Performance and storage

Annotations are stored as **per-file JSON shards** in the plugin folder, with a
small `index.json` manifest, rather than one growing `data.json` blob:

- **Incremental writes.** Changing one note rewrites only that note's shard (a
  few KB), never the whole dataset. Writes are **debounced** (500 ms) and the
  manifest tracks per-file counts so totals and listings never touch a shard.
- **Lazy loading + LRU.** A note's annotations load on demand when it is opened
  or rendered, and idle notes are evicted from memory, so RAM tracks the working
  set instead of the entire vault. A quick manifest check means unannotated
  notes load nothing at all.
- **In-memory indexes.** Each loaded note keeps `byId` and `byGroup` maps, so
  recolouring, converting and deleting are O(1) instead of array scans.
- **One-time migration.** An existing `data.json` is migrated into shards on
  first run (with a `legacy-backup-*.json` kept for safety); settings stay in
  `data.json`. Shards live in the plugin folder, so annotations still travel
  with the vault through Obsidian Sync / Git exactly as before.

Matching is also cheap: a pre-filter skips sections whose distinctive anchors do
not appear, text-node collection is linear in the rendered text, and DOM work
wraps existing text nodes in place (no innerHTML rebuilds).

---

## Security and privacy

- **No HTML injection.** The engine only ever wraps text nodes that are already
  in the document, so note content cannot introduce script or markup through
  this plugin.
- **No network access.** Nothing is sent anywhere. Annotations live in local
  JSON shards in the plugin folder.
- **Your notes are unchanged.** The Markdown on disk is never modified by normal
  use.

---

## Compatibility

- **Minimum Obsidian:** 1.4.0.
- **Desktop and mobile:** both. Touch drag-to-select works in Reading view; on
  phones and iPad the toolbar uses larger targets, a **tap** selects a tool and
  a **long-press** opens its options. The toolbar is kept on-screen when the
  device rotates or the window resizes, and its position is stored **per device**
  so cloud sync never moves it on your other machines.
- **Themes:** the UI is built entirely from Obsidian theme variables, so it
  adapts to light, dark, and community themes automatically.

---

## Installation

### Manual (works today)

1. Build the plugin (see below) or use the prebuilt files.
2. In your vault, create the folder
   `<vault>/.obsidian/plugins/inkless-highlighter/`.
3. Copy these three files into it:
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. In Obsidian: **Settings → Community plugins**, enable **Inkless
   Highlighter**. (Turn off Restricted/Safe mode if prompted.)
5. Open a note, switch to Reading view, and start highlighting.

> The included ready-to-install archive already contains exactly these three
> files in the right layout.

---

## Building from source

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run build      # type-checks, then bundles to main.js
# or, for live rebuilds while developing:
npm run dev
```

`npm run build` runs `tsc` in no-emit mode (strict, with unused-locals/parameters
checks) and then bundles `src/main.ts` to `main.js` with esbuild. The source is
organised as:

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Shared types. |
| `src/constants.ts` | CSS class names, default palette, default settings. |
| `src/engine.ts` | Capture, anchoring, matching, and DOM wrapping. |
| `src/persistence.ts` | Storage adapter contract, shard/manifest types, file-id hashing. |
| `src/store.ts` | Sharded, indexed, lazily-loaded annotation storage + migration. |
| `src/ui.ts` | Floating toolbar and popovers. |
| `src/settings.ts` | Settings tab and palette editor. |
| `src/main.ts` | Plugin wiring, post-processor, events, commands. |
| `styles.css` | All styling, via theme variables. |

---

## Troubleshooting

- **The toolbar isn't showing.** It only appears in **Reading view**. Switch the
  note to Reading mode (the open-book icon). Check that "Show toolbar in Reading
  view" is on.
- **Dragging selects text but nothing gets highlighted.** Make sure a tool is
  **armed** (its button is accent-coloured). Click the highlighter or underline
  button first.
- **An annotation disappeared after I edited the note.** Editing the annotated
  sentence now *re-anchors* it automatically, as long as either its surrounding
  context or its first and last words still survive. If you replaced the whole
  passage — anchors and all — there is nothing left to latch onto; increase
  "Context length" for more resilience, or re-create the annotation.
- **An annotation jumped to, or duplicated onto, a different copy of the same
  words.** This is prevented: a match is only applied where the surrounding
  context agrees. If a genuine annotation ever fails to appear because its
  context was heavily edited on both sides, increase "Context length" or
  re-create it.
- **Highlights look too faint on my dark theme.** Raise the opacity or turn on
  "High-contrast outline".
- **I want the highlights inside the note itself.** Use **Copy note's
  annotations as Markdown** and paste, or keep using the non-destructive store.

---

## Known limitations

- Annotations are anchored to **text** and re-anchor automatically when the
  annotated sentence is edited, but replacing a passage together with all of its
  surrounding context can still orphan an annotation.
- Selection boundaries that fall on element edges (rather than inside text) are
  snapped to the nearest text position; this is robust in practice but not
  pixel-exact in every theme.
- Live Preview display is read-only and depends on Obsidian rendering the
  relevant section; the primary, fully-supported surface is Reading view.
- Because this build has not been exercised inside a live Obsidian runtime here,
  treat the first run as a shakeout: try highlights across bold/links, tables,
  callouts, long notes, and on mobile, and report anything that looks off.

---

## Roadmap

- Annotation notes/comments (the data field already exists).
- A sidebar listing all annotations in the current note or vault.
- Optional automatic export of annotations into note frontmatter or a sidecar.
- Per-colour default tool and named styles.

---

## Data format

Settings live in the plugin's `data.json` (`{ "schema": 2, "settings": { … } }`).
Annotations live in `<plugin>/highlights/`:

- **`index.json`** — the manifest: `{ "schema": 1, "files": { "<fileId>": { "path",
  "count", "updatedAt" } } }`, where `fileId` is a stable hash of the note's path.
- **`<fileId>.json`** — one note's shard:

```jsonc
{
  "schema": 1,
  "path": "Folder/Note.md",
  "annotations": [
    {
      "id": "…",
      "groupId": "…",
      "type": "highlight",        // or "underline"
      "colorId": "c-yellow",
      "color": "#ffe14d",
      "opacity": 0.4,
      "neon": false,             // neon glow (highlight) / brighter (underline)
      "underline": { "thickness": 2, "style": "solid", "offset": 3 },
      "exact": "the selected text",
      "prefix": "context before",
      "suffix": "context after",
      "occurrence": 0,
      "createdAt": 1700000000000
    }
  ]
}
```

Upgrading from the older single-blob format is automatic on first run: each
note's annotations are written to a shard and the original blob is preserved as
`highlights/legacy-backup-<timestamp>.json`. An exported backup (Settings →
Export) still uses the original combined `{ schema, settings, highlights }`
shape, so old and new backups import the same way.

---

## License

MIT — see [LICENSE](LICENSE).
