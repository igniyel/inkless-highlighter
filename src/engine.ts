/**
 * Engine: turns a Reading-view text selection into a persistent, re-applicable
 * annotation, and re-applies stored annotations onto freshly rendered Markdown.
 *
 * Design: annotations are NON-DESTRUCTIVE. The Markdown file is never rewritten.
 * Each annotation is anchored with a W3C-style text quote (exact text + a short
 * prefix/suffix of surrounding context). On every render we search the rendered
 * text for that quote and wrap the matching characters in styled elements.
 *
 * All DOM mutation works by isolating and wrapping existing Text nodes — we
 * never inject HTML strings, so there is no XSS surface from note content.
 */

import {
  ATTR_GROUP,
  ATTR_ID,
  ATTR_TYPE,
  CLS_HIGHLIGHT,
  CLS_UNDERLINE,
  CLS_WRAPPER,
  SKIP_TAGS,
} from "./constants";
import { MatchingPipeline, SimHashEngine } from "./production";
import type { HighlightRecord, PluginSettings, StoredAnnotation } from "./types";

/** Block-level elements we treat as anchoring units. */
const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption, .callout-title-inner";

/** A contiguous run of selected text confined to one block. */
export interface CapturePart {
  block: HTMLElement;
  rawStart: number;
  rawEnd: number;
  exact: string;
  prefix: string;
  suffix: string;
  occurrence: number;
  paragraphIndex?: number;
  headingIndex?: number;
}

interface TextPiece {
  node: Text;
  start: number;
  end: number;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** Reasonably unique id without external deps. */
export function genId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8) +
    Math.random().toString(36).slice(2, 6)
  );
}

/** Collapse internal whitespace and trim — the canonical anchor form. */
export function normStore(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Convert a #rgb / #rrggbb hex to an `rgba(...)` string with the given alpha. */
export function rgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(int)) {
    // Fall back to a neutral, readable yellow if the hex is malformed.
    return `rgba(255, 213, 79, ${clamp01(alpha)})`;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/** Parse a #rgb / #rrggbb hex into 0–255 channels, or null if malformed. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(int)) return null;
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function toHex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
}

/**
 * Return a brighter, more vivid version of a hex colour, used to emphasise
 * underlines. Works in HSL: it lifts saturation and keeps lightness in a
 * legible 0.5–0.7 band, so the line reads as "neon-bright" without ever
 * tinting the area behind the text.
 */
export function brighten(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let l = (max + min) / 2;
  let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  s = Math.min(1, s * 1.3 + 0.1);
  l = Math.min(0.7, Math.max(0.5, l));

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];

  return "#" + toHex((rr + m) * 255) + toHex((gg + m) * 255) + toHex((bb + m) * 255);
}

/* ------------------------------------------------------------------ */
/* Text-node collection and offset maths                              */
/* ------------------------------------------------------------------ */

/** True if `node` lives inside a skipped element (code, or an existing wrapper). */
function isSkipped(node: Node, skipCode: boolean): boolean {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    if (el.classList && el.classList.contains(CLS_WRAPPER)) return true;
    if (skipCode && SKIP_TAGS.has(el.tagName)) return true;
    el = el.parentElement;
  }
  return false;
}

/** Collect the visible text nodes of `container` in document order. */
function collectTextNodes(
  container: HTMLElement,
  skipCode: boolean,
): { pieces: TextPiece[]; text: string } {
  const pieces: TextPiece[] = [];
  let text = "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      if (!node.textContent || node.textContent.length === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      return isSkipped(node, skipCode)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let offset = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.data.length;
    pieces.push({ node: t, start: offset, end: offset + len });
    text += t.data;
    offset += len;
  }
  return { pieces, text };
}

/**
 * Raw character offset (within the collected text) of a DOM boundary point.
 * Handles boundaries that land in Text nodes (the common case) and degrades
 * gracefully for element boundaries.
 */
function rawOffsetOf(
  boundaryNode: Node,
  boundaryOffset: number,
  pieces: TextPiece[],
): number {
  const r = document.createRange();
  try {
    r.setStart(boundaryNode, boundaryOffset);
    r.collapse(true);
  } catch {
    return 0;
  }
  let total = 0;
  for (const p of pieces) {
    const len = p.node.data.length;
    let endCmp: number;
    try {
      endCmp = r.comparePoint(p.node, len);
    } catch {
      endCmp = -1;
    }
    if (endCmp <= 0) {
      total += len;
      continue;
    }
    let startCmp: number;
    try {
      startCmp = r.comparePoint(p.node, 0);
    } catch {
      startCmp = 1;
    }
    if (startCmp >= 0) break; // whole piece is after the boundary
    // Boundary lies strictly inside this piece.
    total += boundaryNode === p.node ? boundaryOffset : 0;
    break;
  }
  return total;
}

/** Build a whitespace-collapsed string plus a map back to raw offsets. */
function buildNorm(text: string): { norm: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inWs) {
        out.push(" ");
        map.push(i);
        inWs = true;
      }
    } else {
      out.push(ch);
      map.push(i);
      inWs = false;
    }
  }
  return { norm: out.join(""), map };
}

/** First normalised index whose raw offset is >= `raw`. */
function rawToNorm(map: number[], raw: number): number {
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= raw) return i;
  }
  return map.length;
}

/* ------------------------------------------------------------------ */
/* Anchor matching                                                     */
/* ------------------------------------------------------------------ */

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Characters of matching context required to trust an occurrence. */
const CTX_MIN_ABS = 8;

/**
 * How many characters of the stored prefix/suffix actually match the text
 * around a candidate occurrence. The boundary space between context and the
 * annotated word is dropped first, because `prefix`/`suffix` are stored trimmed
 * while the rendered text keeps the separating space.
 */
function contextMatch(
  norm: string,
  s: number,
  e: number,
  wantPrefix: string,
  wantSuffix: string,
): number {
  let pm = 0;
  if (wantPrefix) {
    let before = norm.slice(Math.max(0, s - wantPrefix.length - 1), s);
    if (before.endsWith(" ")) before = before.slice(0, -1);
    pm = commonSuffixLen(before, wantPrefix);
  }
  let sm = 0;
  if (wantSuffix) {
    let after = norm.slice(e, e + wantSuffix.length + 1);
    if (after.startsWith(" ")) after = after.slice(1);
    sm = commonPrefixLen(after, wantSuffix);
  }
  return pm + sm;
}

/**
 * Is `matched` characters of context enough to believe this is the real spot?
 * With no stored context (a whole-block selection) there is nothing to check.
 * Otherwise require a solid run of matching context — enough to rule out a
 * different place that merely repeats the same words.
 */
function contextConvincing(matched: number, want: number): boolean {
  if (want === 0) return true;
  return matched >= Math.min(want, CTX_MIN_ABS);
}

/**
 * Locate `rec` within a normalised string. Returns the [start, end) range in
 * normalised coordinates, or null if not found.
 *
 * Critically, a match is accepted only when its surrounding context is
 * convincing. Obsidian runs the post-processor per rendered section, so without
 * this check the same record would be wrapped in *every* section that happens
 * to repeat its words — highlighting unrelated duplicates elsewhere in the note.
 */
function findInNorm(
  norm: string,
  rec: HighlightRecord,
): { s: number; e: number; confidence: number } | null {
  const target = normStore(rec.exact);
  if (!target) return null;
  const starts: number[] = [];
  let idx = norm.indexOf(target);
  while (idx >= 0) {
    starts.push(idx);
    idx = norm.indexOf(target, idx + 1);
  }
  // The exact text is gone (the user edited it): re-anchor by surrounding
  // context so the annotation survives instead of vanishing.
  if (starts.length === 0) return findFuzzy(norm, rec, target);

  const wantPrefix = normStore(rec.prefix);
  const wantSuffix = normStore(rec.suffix);

  // Pick the occurrence whose context matches best (occurrence index breaks
  // ties), then accept it only if that context clears the bar.
  let best = starts[0];
  let bestMatched = -1;
  let bestAdj = -Infinity;
  starts.forEach((s, rank) => {
    const matched = contextMatch(norm, s, s + target.length, wantPrefix, wantSuffix);
    const adj = matched * 1000 - Math.abs(rank - rec.occurrence);
    if (adj > bestAdj) {
      bestAdj = adj;
      best = s;
      bestMatched = matched;
    }
  });

  if (!contextConvincing(bestMatched, wantPrefix.length + wantSuffix.length)) return null;
  return { s: best, e: best + target.length, confidence: 0.95 + Math.min(0.05, bestMatched / Math.max(1, wantPrefix.length + wantSuffix.length) * 0.05) };
}

/* ------------------------------------------------------------------ */
/* Fuzzy re-anchoring (when the annotated text was edited)             */
/* ------------------------------------------------------------------ */

/** Minimum length of stored context before we trust it as a side anchor. */
const ANCHOR_MIN = 4;
/** How many context characters to use from each side as an anchor. */
const ANCHOR_LEN = 24;

/**
 * Re-locate an annotation whose exact text no longer exists, so an edit to the
 * annotated sentence does not make the highlight/underline disappear.
 *
 * It brackets the annotation between a left and a right anchor, choosing the
 * strongest available for each side: the stored surrounding context when there
 * is enough of it, otherwise the selection's own first / last word (which
 * usually survives when the middle is reworded). Every candidate is bounded by
 * a maximum span and scored toward the original length, so a stray match can't
 * swallow a huge stretch of text.
 */
function findFuzzy(
  norm: string,
  rec: HighlightRecord,
  target: string,
): { s: number; e: number; confidence: number } | null {
  const targetLen = target.length;
  const maxSpan = Math.max(targetLen * 4, targetLen + 120);

  const wantPrefix = normStore(rec.prefix);
  const wantSuffix = normStore(rec.suffix);
  const words = target.split(" ");
  const firstWord = words[0] ?? "";
  const lastWord = words.length > 1 ? words[words.length - 1] : "";

  // Pick the strongest available anchor for each side independently: the stored
  // surrounding context when there is enough of it, otherwise the selection's
  // own first / last word (which usually survives a reword of the middle).
  let left = "";
  let includeLeft = false;
  if (wantPrefix.length >= ANCHOR_MIN) {
    left = wantPrefix.slice(-ANCHOR_LEN);
  } else if (firstWord.length >= 3) {
    left = firstWord;
    includeLeft = true;
  }

  let right = "";
  let includeRight = false;
  if (wantSuffix.length >= ANCHOR_MIN) {
    right = wantSuffix.slice(0, ANCHOR_LEN);
  } else if (lastWord.length >= 3 && lastWord !== firstWord) {
    right = lastWord;
    includeRight = true;
  }

  if (!left || !right) {
    const structural = (rec as StoredAnnotation).simhash ? MatchingPipeline.match(norm, rec as StoredAnnotation, rec.paragraphIndex ?? 0) : null;
    return structural && structural.confidence >= 0.2 ? { s: structural.start, e: structural.end, confidence: structural.confidence } : null;
  }
  const hit = bracketBetween(norm, left, right, includeLeft, includeRight, targetLen, maxSpan);
  if (!hit) return null;

  // Drop any whitespace the anchors left dangling at the edges.
  let { s, e } = hit;
  while (s < e && norm[s] === " ") s++;
  while (e > s && norm[e - 1] === " ") e--;
  if (e <= s) return null;
  const stored = rec as StoredAnnotation;
  const moved = norm.slice(s, e);
  const exactHashSim = SimHashEngine.similarity(stored.simhash?.exact, SimHashEngine.fingerprint(moved));
  const prefixHashSim = SimHashEngine.similarity(stored.simhash?.prefix, SimHashEngine.fingerprint(norm.slice(Math.max(0, s - 48), s)));
  const suffixHashSim = SimHashEngine.similarity(stored.simhash?.suffix, SimHashEngine.fingerprint(norm.slice(e, e + 48)));
  const positionScore = 1 - Math.min(1, Math.abs((e - s) - targetLen) / Math.max(1, targetLen));
  const structureScore = stored.simhash?.block ? SimHashEngine.similarity(stored.simhash.block, SimHashEngine.fingerprint(norm.slice(Math.max(0, s - 48), e + 48))) : 0.5;
  const occurrenceScore = 0.7;
  const confidence = exactHashSim * 0.30 + prefixHashSim * 0.15 + suffixHashSim * 0.15 + positionScore * 0.15 + structureScore * 0.15 + occurrenceScore * 0.10;
  return { s, e, confidence };
}

/**
 * Find a range delimited by a `left` and `right` anchor string. `includeLeft` /
 * `includeRight` decide whether each anchor is part of the range (end-word
 * bracket) or merely borders it (context bracket). Among valid candidates,
 * prefers the one whose length is closest to `targetLen`.
 */
function bracketBetween(
  norm: string,
  left: string,
  right: string,
  includeLeft: boolean,
  includeRight: boolean,
  targetLen: number,
  maxSpan: number,
): { s: number; e: number } | null {
  let best: { s: number; e: number } | null = null;
  let bestScore = Infinity;
  let li = norm.indexOf(left);
  while (li >= 0) {
    const s = includeLeft ? li : li + left.length;
    const searchFrom = li + left.length;
    const ri = norm.indexOf(right, searchFrom);
    if (ri >= 0) {
      const e = includeRight ? ri + right.length : ri;
      const span = e - s;
      if (span > 0 && span <= maxSpan) {
        const score = Math.abs(span - targetLen);
        if (score < bestScore) {
          bestScore = score;
          best = { s, e };
        }
      }
    }
    li = norm.indexOf(left, li + 1);
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Wrapper element creation / styling                                  */
/* ------------------------------------------------------------------ */

/** Apply visual styles to an existing wrapper element from a record. */
export function styleWrapper(
  el: HTMLElement,
  rec: HighlightRecord,
  settings: PluginSettings,
): void {
  el.className = CLS_WRAPPER + " " + (rec.type === "underline" ? CLS_UNDERLINE : CLS_HIGHLIGHT);
  el.setAttribute(ATTR_ID, rec.id);
  el.setAttribute(ATTR_GROUP, rec.groupId);
  el.setAttribute(ATTR_TYPE, rec.type);
  el.style.removeProperty("background-color");
  el.style.removeProperty("text-decoration-line");
  el.style.removeProperty("text-decoration-color");
  el.style.removeProperty("text-decoration-style");
  el.style.removeProperty("text-decoration-thickness");
  el.style.removeProperty("text-underline-offset");
  el.style.removeProperty("box-shadow");
  el.style.removeProperty("filter");

  if (rec.type === "highlight") {
    el.style.backgroundColor = rgba(rec.color, rec.opacity);
    el.style.color = "inherit";
    const shadows: string[] = [];
    if (settings.highContrast) {
      shadows.push(`inset 0 0 0 1px ${rgba(rec.color, Math.min(1, rec.opacity + 0.4))}`);
    }
    if (rec.neon) {
      // A soft outer halo in the annotation's own colour for the neon look.
      shadows.push(`0 0 4px ${rgba(rec.color, 0.95)}`, `0 0 10px ${rgba(rec.color, 0.55)}`);
    }
    if (shadows.length) el.style.boxShadow = shadows.join(", ");
  } else {
    el.style.backgroundColor = "transparent";
    el.style.textDecorationLine = "underline";
    // "Brighter" underlines simply use a more vivid line colour. No glow or
    // filter, so nothing is ever painted behind the text itself.
    el.style.textDecorationColor = rec.neon ? brighten(rec.color) : rec.color;
    el.style.textDecorationStyle = rec.underline?.style ?? "solid";
    el.style.textDecorationThickness = `${rec.underline?.thickness ?? 2}px`;
    el.style.textUnderlineOffset = `${rec.underline?.offset ?? 3}px`;
  }
  const confidence = (rec as StoredAnnotation).confidence ?? 1;
  el.dataset.rhlConfidence = confidence.toFixed(2);
  if (confidence < 0.95) el.style.opacity = confidence >= 0.8 ? "0.82" : confidence >= 0.5 ? "0.68" : "0.38";
  if (confidence >= 0.5 && confidence < 0.8) el.style.borderBottom = `1px dashed ${rec.color}`;
  el.setAttribute("aria-label", rec.note ? rec.note : `${rec.type} annotation${confidence < 0.95 ? ` (${Math.round(confidence * 100)}% match confidence)` : ""}`);
}

/** Create a fresh wrapper element for a record. */
function createWrapperEl(rec: HighlightRecord, settings: PluginSettings): HTMLElement {
  const tag = rec.type === "underline" ? "span" : "mark";
  const el = document.createElement(tag);
  styleWrapper(el, rec, settings);
  return el;
}

/* ------------------------------------------------------------------ */
/* Range wrapping                                                      */
/* ------------------------------------------------------------------ */

/**
 * Wrap the characters [rawStart, rawEnd) of `container` (in collected-text
 * coordinates) using `makeWrapper`. A range that spans several inline elements
 * yields several adjacent wrappers that share the record id. Returns the number
 * of wrapper elements created.
 */
export function wrapRange(
  container: HTMLElement,
  rawStart: number,
  rawEnd: number,
  makeWrapper: () => HTMLElement,
  skipCode: boolean,
): number {
  if (rawEnd <= rawStart) return 0;
  const { pieces } = collectTextNodes(container, skipCode);
  let wrapped = 0;
  for (const p of pieces) {
    const s = Math.max(rawStart, p.start);
    const e = Math.min(rawEnd, p.end);
    if (e <= s) continue;
    let target: Text = p.node;
    const localStart = s - p.start;
    const wantLen = e - s;
    try {
      if (localStart > 0) target = target.splitText(localStart);
      if (wantLen < target.data.length) target.splitText(wantLen);
      const parent = target.parentNode;
      if (!parent) continue;
      const w = makeWrapper();
      const fragment = document.createDocumentFragment();
      fragment.appendChild(w);
      parent.insertBefore(fragment, target);
      w.appendChild(target);
      wrapped++;
    } catch {
      // Skip pieces that fail to split (detached/odd nodes) rather than throw.
    }
  }
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* Capturing a selection                                               */
/* ------------------------------------------------------------------ */

/** Nearest block-level ancestor used as an anchoring unit. */
function closestBlock(node: Node, root: HTMLElement): HTMLElement {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  while (el && el !== root) {
    if (el.matches?.(BLOCK_SELECTOR)) return el;
    el = el.parentElement;
  }
  // Fall back to the closest element child of the root, else the root itself.
  let cur: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  return cur ?? root;
}

/** Collect leaf blocks (no nested block) intersecting the range, in order. */
function leafBlocksInRange(range: Range, root: HTMLElement): HTMLElement[] {
  const common =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!common) return [];
  const all = Array.from(common.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const candidates = all.filter((b) => {
    try {
      return range.intersectsNode(b);
    } catch {
      return false;
    }
  });
  // Keep only leaves (drop blocks that contain another candidate block).
  const leaves = candidates.filter(
    (b) => !candidates.some((other) => other !== b && b.contains(other)),
  );
  if (leaves.length > 0) return leaves;
  // Single-block fallback.
  const b = closestBlock(range.startContainer, root);
  return b ? [b] : [];
}

function structuralPosition(block: HTMLElement): { paragraphIndex: number; headingIndex: number } {
  const root = block.closest(".markdown-preview-section, .markdown-reading-view, .markdown-preview-view") ?? block.parentElement;
  const blocks = root ? Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) : [block];
  const headings = root ? Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) : [];
  return {
    paragraphIndex: Math.max(0, blocks.indexOf(block)),
    headingIndex: headings.filter((heading) => heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).length,
  };
}

function buildPart(
  block: HTMLElement,
  rawStart: number,
  rawEnd: number,
  contextLength: number,
  skipCode: boolean,
): CapturePart | null {
  const { text } = collectTextNodes(block, skipCode);
  const rawSel = text.slice(rawStart, rawEnd);
  const exact = normStore(rawSel);
  if (!exact) return null;
  const prefix = normStore(text.slice(Math.max(0, rawStart - contextLength), rawStart));
  const suffix = normStore(text.slice(rawEnd, rawEnd + contextLength));

  // Occurrence index in normalised space (aligns with re-apply matching).
  const { norm, map } = buildNorm(text);
  const nStart = rawToNorm(map, rawStart);
  let occurrence = 0;
  let idx = norm.indexOf(exact);
  while (idx >= 0 && idx < nStart) {
    occurrence++;
    idx = norm.indexOf(exact, idx + 1);
  }
  return { block, rawStart, rawEnd, exact, prefix, suffix, occurrence, ...structuralPosition(block) };
}

/**
 * Convert the current selection into one or more capture parts (one per block).
 * Returns an empty array if the selection is empty or whitespace-only.
 */
export function captureSelection(
  sel: Selection,
  root: HTMLElement,
  settings: PluginSettings,
): CapturePart[] {
  if (sel.rangeCount === 0 || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  if (range.collapsed) return [];

  const blocks = leafBlocksInRange(range, root);
  const parts: CapturePart[] = [];

  if (blocks.length <= 1) {
    const block = blocks[0] ?? closestBlock(range.startContainer, root);
    const { pieces } = collectTextNodes(block, settings.skipCodeBlocks);
    const rawStart = rawOffsetOf(range.startContainer, range.startOffset, pieces);
    const rawEnd = rawOffsetOf(range.endContainer, range.endOffset, pieces);
    const lo = Math.min(rawStart, rawEnd);
    const hi = Math.max(rawStart, rawEnd);
    const part = buildPart(block, lo, hi, settings.contextLength, settings.skipCodeBlocks);
    if (part) parts.push(part);
    return parts;
  }

  // Multi-block: cover each block's portion.
  blocks.forEach((block, i) => {
    const { pieces, text } = collectTextNodes(block, settings.skipCodeBlocks);
    let rawStart = 0;
    let rawEnd = text.length;
    if (i === 0) {
      rawStart = rawOffsetOf(range.startContainer, range.startOffset, pieces);
    }
    if (i === blocks.length - 1) {
      rawEnd = rawOffsetOf(range.endContainer, range.endOffset, pieces);
    }
    if (rawEnd <= rawStart) return;
    const part = buildPart(block, rawStart, rawEnd, settings.contextLength, settings.skipCodeBlocks);
    if (part) parts.push(part);
  });
  return parts;
}

/* ------------------------------------------------------------------ */
/* Applying records (re-render path + live)                            */
/* ------------------------------------------------------------------ */

/**
 * Cheap pre-filter for {@link applyToContainer}: does this container plausibly
 * contain `rec`, either verbatim or in an edited form we could re-anchor to?
 * Returns true unless none of the record's distinctive anchors appear, so it
 * never hides a record that fuzzy matching could still place.
 */
function mayContain(haystack: string, rec: HighlightRecord): boolean {
  const probes: string[] = [];
  const words = normStore(rec.exact).split(" ");
  if (words[0]) probes.push(words[0]);
  if (words.length > 1) probes.push(words[words.length - 1]);
  const pfx = normStore(rec.prefix);
  const sfx = normStore(rec.suffix);
  if (pfx) probes.push(pfx.slice(-12));
  if (sfx) probes.push(sfx.slice(0, 12));
  const usable = probes.filter((p) => p.length >= 4);
  if (usable.length === 0) return true; // nothing distinctive to test on
  return usable.some((p) => haystack.includes(p));
}

/**
 * Apply all records that occur within `container`. Safe to call repeatedly:
 * a record already present (by id) in this container is skipped.
 */
export function applyToContainer(
  container: HTMLElement,
  records: HighlightRecord[],
  settings: PluginSettings,
): void {
  if (records.length === 0) return;
  const haystack = container.textContent ?? "";
  if (!haystack) return;

  for (const rec of records) {
    // Cheap pre-filter: skip a record only when none of its distinctive anchors
    // (first/last word of the selection, or a slice of the surrounding context)
    // appear here — so an edit to the span itself still leaves the record a
    // chance to re-anchor via findFuzzy.
    if (!mayContain(haystack, rec)) continue;
    // Idempotency within this render pass.
    if (container.querySelector(`[${ATTR_ID}="${cssEscape(rec.id)}"]`)) continue;

    const { pieces, text } = collectTextNodes(container, settings.skipCodeBlocks);
    if (!text) break;
    const { norm, map } = buildNorm(text);
    const hit = findInNorm(norm, rec);
    if (!hit || hit.confidence < 0.2) {
      container.dispatchEvent(new CustomEvent("rhl-orphan", { bubbles: true, detail: { record: rec } }));
      continue;
    }
    (rec as StoredAnnotation).confidence = hit.confidence;
    const rawStart = map[hit.s];
    const rawEnd = hit.e - 1 >= 0 ? map[hit.e - 1] + 1 : rawStart;
    // pieces are recomputed inside wrapRange; we only needed `text`/`norm` here.
    void pieces;
    wrapRange(
      container,
      rawStart,
      rawEnd,
      () => createWrapperEl(rec, settings),
      settings.skipCodeBlocks,
    );
  }
}

/** Live-wrap a freshly captured part (instant feedback before re-render). */
export function applyPartLive(
  part: CapturePart,
  rec: HighlightRecord,
  settings: PluginSettings,
): number {
  return wrapRange(
    part.block,
    part.rawStart,
    part.rawEnd,
    () => createWrapperEl(rec, settings),
    settings.skipCodeBlocks,
  );
}

/** Remove every wrapper for `id` within `root`, merging the freed text. */
export function unwrapById(root: ParentNode, id: string): void {
  const els = root.querySelectorAll<HTMLElement>(`[${ATTR_ID}="${cssEscape(id)}"]`);
  els.forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    (parent as Element).normalize?.();
  });
}

/** Restyle every wrapper for a group in-place (used when recolouring). */
export function restyleGroup(
  root: ParentNode,
  groupId: string,
  rec: HighlightRecord,
  settings: PluginSettings,
): void {
  const els = root.querySelectorAll<HTMLElement>(`[${ATTR_GROUP}="${cssEscape(groupId)}"]`);
  els.forEach((el) => styleWrapper(el, rec, settings));
}

/** Minimal CSS attribute-value escape for use in selectors. */
function cssEscape(value: string): string {
  if (typeof (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === "function") {
    return (window as unknown as { CSS: { escape: (v: string) => string } }).CSS.escape(value);
  }
  return value.replace(/["\\\]]/g, "\\$&");
}
