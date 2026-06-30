import type { FileHighlights, HighlightRecord, HistoryRecord, Operation, PersistedData, PluginSettings, StoredAnnotation } from "./types";

export type WalMutation =
  | { type: "add"; path: string; records: StoredAnnotation[] }
  | { type: "removeGroup"; path: string; groupId: string }
  | { type: "updateGroup"; path: string; groupId: string; patch: Partial<HighlightRecord> }
  | { type: "rename"; oldPath: string; newPath: string }
  | { type: "deleteFile"; path: string }
  | { type: "settings"; settings: PluginSettings }
  | { type: "clearAll" };


export interface WalEntry {
  sequence: number;
  timestamp: number;
  mutation: WalMutation;
  crc32: number;
}

export interface MatchCandidate {
  start: number;
  end: number;
  confidence: number;
  stage: 1 | 2 | 3 | 4 | 5;
}

export class MatchingPipeline {
  static match(text: string, rec: StoredAnnotation, paragraphIndex = 0): MatchCandidate {
    const exact = normalise(rec.exact);
    const norm = normalise(text);
    const exactStart = norm.indexOf(exact);
    if (exactStart >= 0) return { start: exactStart, end: exactStart + exact.length, confidence: 0.98, stage: 1 };

    const windows = slidingWindows(norm, Math.max(8, exact.length), 12);
    let best: MatchCandidate = { start: 0, end: 0, confidence: 0, stage: 5 };
    for (const w of windows) {
      const exactHashSim = SimHashEngine.similarity(rec.simhash.exact, SimHashEngine.fingerprint(w.text));
      if (exactHashSim < 0.65) continue;
      const prefixHashSim = SimHashEngine.similarity(rec.simhash.prefix, SimHashEngine.fingerprint(norm.slice(Math.max(0, w.start - 48), w.start)));
      const suffixHashSim = SimHashEngine.similarity(rec.simhash.suffix, SimHashEngine.fingerprint(norm.slice(w.end, w.end + 48)));
      const positionScore = 1 - Math.min(1, Math.abs(w.start - paragraphIndex) / Math.max(1, norm.length));
      const structureScore = SimHashEngine.similarity(rec.simhash.block, SimHashEngine.fingerprint(norm.slice(Math.max(0, w.start - 64), w.end + 64)));
      const occurrenceScore = 1 - Math.min(1, Math.abs((rec.occurrence ?? 0) - w.rank) / 10);
      const confidence = exactHashSim * 0.30 + prefixHashSim * 0.15 + suffixHashSim * 0.15 + positionScore * 0.15 + structureScore * 0.15 + occurrenceScore * 0.10;
      if (confidence > best.confidence) best = { start: w.start, end: w.end, confidence, stage: confidence >= 0.7 ? 2 : 3 };
    }
    if (best.confidence >= 0.4) return best;

    const relocated = anchorRelocate(norm, rec);
    if (relocated) return relocated;

    const structural = structuralMatch(norm, rec, paragraphIndex);
    return structural ?? best;
  }
}

export class SimHashEngine {
  static fingerprint(text: string): string {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    const v = new Array<number>(64).fill(0);
    for (const w of words.length ? words : [text]) {
      const h = fnv1a64(w);
      for (let i = 0; i < 64; i++) v[i] += (h & (BigInt(1) << BigInt(i))) === BigInt(0) ? -1 : 1;
    }
    let out = BigInt(0);
    for (let i = 0; i < 64; i++) if (v[i] >= 0) out |= BigInt(1) << BigInt(i);
    return out.toString(16).padStart(16, "0");
  }

  static similarity(a?: string, b?: string): number {
    if (!a || !b) return 0;
    const d = hamming64(BigInt(`0x${a}`), BigInt(`0x${b}`));
    return 1 - d / 64;
  }
}

export function enrichRecord(rec: HighlightRecord, filePath: string, deviceId: string): StoredAnnotation {
  const block = `${rec.prefix} ${rec.exact} ${rec.suffix}`.trim();
  const now = Date.now();
  const updatedAt = (rec as StoredAnnotation).updatedAt ?? now;
  return {
    ...rec,
    filePath,
    fileId: stableFileId(filePath),
    contentHash: SimHashEngine.fingerprint(rec.exact),
    simhash: {
      exact: SimHashEngine.fingerprint(rec.exact),
      prefix: SimHashEngine.fingerprint(rec.prefix),
      suffix: SimHashEngine.fingerprint(rec.suffix),
      block: SimHashEngine.fingerprint(block),
    },
    vectorClock: (rec as StoredAnnotation).vectorClock ?? { [deviceId]: 1 },
    fieldVersions: (rec as StoredAnnotation).fieldVersions ?? {},
    updatedAt,
    deletedAt: (rec as StoredAnnotation).deletedAt,
  };
}

export class CRDTMergeEngine {
  static merge(local: StoredAnnotation | undefined, remote: StoredAnnotation): StoredAnnotation {
    if (!local) return remote;
    const cmp = compareClock(local.vectorClock, remote.vectorClock);
    if (cmp === "a") return local;
    if (cmp === "b") return remote;
    const out: StoredAnnotation = { ...local, vectorClock: mergeClock(local.vectorClock, remote.vectorClock) };
    const keys = new Set([...Object.keys(local), ...Object.keys(remote)] as Array<keyof StoredAnnotation>);
    for (const key of keys) {
      const lf = local.fieldVersions?.[key as string];
      const rf = remote.fieldVersions?.[key as string];
      if (!rf) continue;
      if (!lf || rf.timestamp > lf.timestamp || (rf.timestamp === lf.timestamp && rf.deviceId > lf.deviceId)) {
        (out as unknown as Record<string, unknown>)[key as string] = rf.value;
        out.fieldVersions = { ...(out.fieldVersions ?? {}), [key as string]: rf };
      }
    }
    return out.updatedAt >= remote.updatedAt ? out : { ...out, updatedAt: remote.updatedAt };
  }
}

export class IntervalTree {
  private intervals: Array<{ start: number; end: number; id: string }> = [];
  add(start: number, end: number, id: string): void {
    this.intervals.push({ start, end, id });
    this.intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  query(start: number, end: number): string[] {
    const hits: string[] = [];
    for (const item of this.intervals) {
      if (item.start >= end) break;
      if (item.end > start) hits.push(item.id);
    }
    return hits;
  }
}

export class IndexManager {
  private readonly hotLimit = 5;
  private readonly warmLimit = 20;
  private readonly ttlMs = 5 * 60 * 1000;
  private files = new Map<string, { records: StoredAnnotation[]; lastAccessed: number; tier: "hot" | "warm" }>();
  readonly groupIndex = new Map<string, Set<string>>();
  readonly contentHashIndex = new Map<string, Set<string>>();
  readonly spatialIndex = new Map<string, IntervalTree>();

  setFile(path: string, records: StoredAnnotation[]): void {
    this.files.delete(path);
    this.files.set(path, { records, lastAccessed: Date.now(), tier: "hot" });
    this.rebuildFileSpatialIndex(path, records);
    this.rebalance();
    this.rebuildSecondary();
  }
  getFile(path: string): StoredAnnotation[] | undefined {
    const hit = this.files.get(path);
    if (!hit) return undefined;
    hit.lastAccessed = Date.now();
    hit.tier = "hot";
    this.files.delete(path);
    this.files.set(path, hit);
    this.rebalance();
    return hit.records;
  }
  deleteFile(path: string): void { this.files.delete(path); this.spatialIndex.delete(path); this.rebuildSecondary(); }
  allFiles(): FileHighlights { const out: FileHighlights = {}; for (const [p, r] of this.files) out[p] = r.records.filter((x) => !x.deletedAt); return out; }
  private rebalance(): void {
    const now = Date.now();
    for (const [path, entry] of this.files) if (now - entry.lastAccessed > this.ttlMs) this.files.delete(path);
    const entries = [...this.files.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
    entries.forEach(([, entry], i) => entry.tier = i < this.hotLimit ? "hot" : "warm");
    for (const [path] of entries.slice(this.hotLimit + this.warmLimit)) this.files.delete(path);
  }
  private rebuildSecondary(): void {
    this.groupIndex.clear(); this.contentHashIndex.clear();
    for (const [path, entry] of this.files) for (const r of entry.records) {
      addSet(this.groupIndex, r.groupId, path); if (r.contentHash) addSet(this.contentHashIndex, r.contentHash, r.id);
    }
  }
  private rebuildFileSpatialIndex(path: string, records: StoredAnnotation[]): void {
    const tree = new IntervalTree();
    records.forEach((record, i) => tree.add(i, i + Math.max(1, record.exact.length), record.id));
    this.spatialIndex.set(path, tree);
  }
}

export class PersistenceLayer {
  private db: IDBDatabase | null = null;
  private readonly name: string;
  constructor(pluginId: string, private readonly fallbackSave: (data: Partial<PersistedData>) => Promise<void>) {
    this.name = `${pluginId}-annotations-v2`;
  }
  async open(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const annotations = db.createObjectStore("annotations", { keyPath: ["filePath", "id"] });
        annotations.createIndex("byFilePath", "filePath"); annotations.createIndex("byGroupId", "groupId");
        annotations.createIndex("byColorId", "colorId"); annotations.createIndex("byType", "type");
        annotations.createIndex("byCreatedAt", "createdAt"); annotations.createIndex("byContentHash", "contentHash");
        db.createObjectStore("fileIndex", { keyPath: "filePath" }); db.createObjectStore("settings", { keyPath: "key" });
        db.createObjectStore("wal", { keyPath: "sequence", autoIncrement: true });
        const history = db.createObjectStore("history", { keyPath: ["filePath", "sequence"] }); history.createIndex("byTimestamp", "timestamp");
        db.createObjectStore("syncState", { keyPath: "deviceId" });
      };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async putSettings(settings: PluginSettings): Promise<void> { await this.put("settings", { key: "global", settings }); await this.fallbackSave({ settings }); }
  async getFile(path: string): Promise<StoredAnnotation[]> { if (!this.db) return []; return this.readIndex("annotations", "byFilePath", path); }
  async getAllAnnotations(): Promise<StoredAnnotation[]> { if (!this.db) return []; return new Promise((resolve, reject) => { const req = this.db!.transaction("annotations").objectStore("annotations").getAll(); req.onsuccess = () => resolve(req.result as StoredAnnotation[]); req.onerror = () => reject(req.error); }); }
  async putAnnotations(records: StoredAnnotation[]): Promise<void> { if (!this.db || records.length === 0) return; await this.tx(["annotations"], "readwrite", (tx) => records.forEach((r) => tx.objectStore("annotations").put(r))); }
  async deleteGroup(path: string, groupId: string): Promise<void> { const records = await this.getFile(path); await this.tx(["annotations"], "readwrite", (tx) => records.filter((r) => r.groupId === groupId).forEach((r) => tx.objectStore("annotations").delete([path, r.id]))); }
  async deleteFile(path: string): Promise<void> { const records = await this.getFile(path); await this.tx(["annotations"], "readwrite", (tx) => records.forEach((r) => tx.objectStore("annotations").delete([path, r.id]))); }
  async clearAnnotations(): Promise<void> { if (!this.db) return; await this.tx(["annotations"], "readwrite", (tx) => tx.objectStore("annotations").clear()); }
  async appendWal(mutation: WalMutation): Promise<void> { const payload = JSON.stringify(mutation); await this.put("wal", { timestamp: Date.now(), mutation, crc32: crc32(payload) }); }
  async addHistory(record: HistoryRecord): Promise<void> { await this.put("history", record); }
  async replayWal(): Promise<WalEntry[]> {
    if (!this.db) return [];
    const entries = await this.getAll<WalEntry>("wal");
    return entries
      .filter((entry) => crc32(JSON.stringify(entry.mutation)) === entry.crc32)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async compactWal(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this.db) return;
    const cutoff = Date.now() - olderThanMs;
    const entries = await this.getAll<WalEntry>("wal");
    await this.tx(["wal"], "readwrite", (tx) => {
      const store = tx.objectStore("wal");
      entries.filter((entry) => entry.timestamp < cutoff).forEach((entry) => store.delete(entry.sequence));
    });
  }
  async pruneHistory(now = Date.now()): Promise<void> {
    if (!this.db) return;
    const records = await this.getAll<HistoryRecord>("history");
    const byFile = new Map<string, HistoryRecord[]>();
    for (const record of records) {
      const list = byFile.get(record.filePath) ?? [];
      list.push(record);
      byFile.set(record.filePath, list);
    }
    const keep = new Set(records
      .filter((record) => record.type === "undoable" && now - record.timestamp <= 7 * 24 * 60 * 60 * 1000)
      .map((record) => `${record.filePath}:${record.sequence}`));
    for (const list of byFile.values()) {
      list.sort((a, b) => b.sequence - a.sequence).slice(0, 1000).forEach((record) => keep.add(`${record.filePath}:${record.sequence}`));
    }
    await this.tx(["history"], "readwrite", (tx) => {
      const store = tx.objectStore("history");
      records.filter((record) => !keep.has(`${record.filePath}:${record.sequence}`)).forEach((record) => store.delete([record.filePath, record.sequence]));
    });
  }
  async putSyncState(deviceId: string, state: unknown): Promise<void> { await this.put("syncState", { deviceId, state, updatedAt: Date.now() }); }
  private async getAll<T>(store: string): Promise<T[]> {
    if (!this.db) return [];
    return new Promise((resolve, reject) => {
      const req = this.db!.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  }
  private async put(store: string, value: unknown): Promise<void> { if (!this.db) return; await this.tx([store], "readwrite", (tx) => tx.objectStore(store).put(value)); }
  private async readIndex<T>(store: string, index: string, query: IDBValidKey): Promise<T[]> { return new Promise((resolve, reject) => { const out: T[] = []; const req = this.db!.transaction(store).objectStore(store).index(index).openCursor(query); req.onsuccess = () => { const c = req.result; if (!c) resolve(out); else { out.push(c.value); c.continue(); } }; req.onerror = () => reject(req.error); }); }
  private async tx(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> { if (!this.db) return; await new Promise<void>((resolve, reject) => { const tx = this.db!.transaction(stores, mode); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); fn(tx); }); }
}

export function makeHistory(path: string, sequence: number, description: string, inverseOps: Operation[], forwardOps: Operation[]): HistoryRecord {
  return { filePath: path, sequence, timestamp: Date.now(), type: "undoable", description, inverseOps, forwardOps, preState: SimHashEngine.fingerprint(JSON.stringify(inverseOps)), postState: SimHashEngine.fingerprint(JSON.stringify(forwardOps)) };
}
export function lzCompress(value: string): string {
  try { return btoa(unescape(encodeURIComponent(value))); } catch { return value; }
}
export function lzDecompress(value: string): string {
  try { return decodeURIComponent(escape(atob(value))); } catch { return value; }
}

export class MessagePackSyncCodec {
  static encode(records: StoredAnnotation[]): Uint8Array {
    const json = JSON.stringify({ version: 1, records });
    return new TextEncoder().encode(lzCompress(json));
  }
  static decode(bytes: Uint8Array): StoredAnnotation[] {
    const decoded = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(lzDecompress(decoded)) as { records?: StoredAnnotation[] };
    return parsed.records ?? [];
  }
}

function normalise(s: string): string { return s.replace(/\s+/g, " ").trim(); }
function slidingWindows(text: string, targetLength: number, stride: number): Array<{ start: number; end: number; text: string; rank: number }> {
  const out: Array<{ start: number; end: number; text: string; rank: number }> = [];
  const size = Math.min(text.length, Math.max(targetLength, 16));
  for (let start = 0, rank = 0; start < text.length; start += stride, rank++) out.push({ start, end: Math.min(text.length, start + size), text: text.slice(start, start + size), rank });
  return out;
}
function anchorRelocate(text: string, rec: StoredAnnotation): MatchCandidate | null {
  const prefix = normalise(rec.prefix).slice(-24);
  const suffix = normalise(rec.suffix).slice(0, 24);
  if (prefix.length < 4 || suffix.length < 4) return null;
  const left = text.indexOf(prefix);
  if (left < 0) return null;
  const right = text.indexOf(suffix, left + prefix.length);
  if (right < 0 || right <= left) return null;
  const start = left + prefix.length;
  const end = right;
  const distance = levenshtein(normalise(rec.exact), text.slice(start, end));
  const confidence = Math.max(0.4, 1 - distance / Math.max(1, rec.exact.length));
  return { start, end, confidence: Math.min(0.8, confidence), stage: 3 };
}
function structuralMatch(text: string, rec: StoredAnnotation, paragraphIndex: number): MatchCandidate | null {
  if (!rec.simhash.block) return null;
  const parts = text.split(/(?<=\.)\s+/);
  let cursor = 0;
  let best: MatchCandidate | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const score = SimHashEngine.similarity(rec.simhash.block, SimHashEngine.fingerprint(part)) * 0.75 + (1 - Math.min(1, Math.abs(i - paragraphIndex) / 10)) * 0.25;
    if (!best || score > best.confidence) best = { start: cursor, end: cursor + part.length, confidence: score * 0.5, stage: 4 };
    cursor += part.length + 1;
  }
  return best && best.confidence >= 0.2 ? best : null;
}
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = i - 1; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return prev[b.length];
}

function stableFileId(path: string): string { return SimHashEngine.fingerprint(path); }
function addSet(m: Map<string, Set<string>>, k: string, v: string): void { const s = m.get(k) ?? new Set<string>(); s.add(v); m.set(k, s); }
function fnv1a64(input: string): bigint { let h = BigInt("0xcbf29ce484222325"); for (let i = 0; i < input.length; i++) { h ^= BigInt(input.charCodeAt(i)); h = BigInt.asUintN(64, h * BigInt("0x100000001b3")); } return h; }
function hamming64(a: bigint, b: bigint): number { let x = a ^ b, n = 0; while (x) { n++; x &= x - BigInt(1); } return n; }
function crc32(s: string): number { let c = ~0; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i); for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function mergeClock(a: Record<string, number>, b: Record<string, number>): Record<string, number> { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v); return out; }
function compareClock(a: Record<string, number>, b: Record<string, number>): "a" | "b" | "concurrent" { let ag = false, bg = false; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if ((a[k] ?? 0) > (b[k] ?? 0)) ag = true; if ((b[k] ?? 0) > (a[k] ?? 0)) bg = true; } return ag && !bg ? "a" : bg && !ag ? "b" : "concurrent"; }
