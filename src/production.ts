import type { FileHighlights, HighlightRecord, HistoryRecord, Operation, PersistedData, PluginSettings, StoredAnnotation } from "./types";

export type WalMutation =
  | { type: "add"; path: string; records: StoredAnnotation[] }
  | { type: "removeGroup"; path: string; groupId: string }
  | { type: "updateGroup"; path: string; groupId: string; patch: Partial<HighlightRecord> }
  | { type: "rename"; oldPath: string; newPath: string }
  | { type: "deleteFile"; path: string }
  | { type: "settings"; settings: PluginSettings }
  | { type: "clearAll" }
  | { type: "checkpoint"; sequence: number; timestamp: number };


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

export function enrichRecord(rec: HighlightRecord, filePath: string, deviceId: string, vaultName = ""): StoredAnnotation {
  const block = `${rec.prefix} ${rec.exact} ${rec.suffix}`.trim();
  const now = Date.now();
  const updatedAt = (rec as StoredAnnotation).updatedAt ?? now;
  return {
    ...rec,
    filePath,
    fileId: stableFileId(`${filePath}:${vaultName}`),
    contentHash: SimHashEngine.fingerprint(rec.exact),
    simhash: {
      exact: SimHashEngine.fingerprint(rec.exact),
      prefix: SimHashEngine.fingerprint(rec.prefix),
      suffix: SimHashEngine.fingerprint(rec.suffix),
      block: SimHashEngine.fingerprint(block),
    },
    vectorClock: (rec as StoredAnnotation).vectorClock ?? { [deviceId]: 1 },
    fieldVersions: (rec as StoredAnnotation).fieldVersions ?? {},
    compressedPrefix: (rec as StoredAnnotation).compressedPrefix ?? LZString.compressToUTF16(rec.prefix),
    compressedSuffix: (rec as StoredAnnotation).compressedSuffix ?? LZString.compressToUTF16(rec.suffix),
    tombstoneUntil: (rec as StoredAnnotation).deletedAt ? (rec as StoredAnnotation).deletedAt! + 90 * 24 * 60 * 60 * 1000 : (rec as StoredAnnotation).tombstoneUntil,
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

interface IntervalNode {
  center: number;
  intervals: Array<{ start: number; end: number; id: string }>;
  left: IntervalNode | null;
  right: IntervalNode | null;
}

export class IntervalTree {
  private pending: Array<{ start: number; end: number; id: string }> = [];
  private root: IntervalNode | null = null;
  add(start: number, end: number, id: string): void {
    this.pending.push({ start, end, id });
    this.root = buildIntervalNode(this.pending);
  }
  query(start: number, end: number): string[] {
    const hits: string[] = [];
    queryIntervalNode(this.root, start, end, hits);
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
      const req = indexedDB.open(this.name, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        const annotations = db.objectStoreNames.contains("annotations")
          ? req.transaction!.objectStore("annotations")
          : db.createObjectStore("annotations", { keyPath: ["filePath", "id"] });
        ensureIndex(annotations, "byFilePath", "filePath"); ensureIndex(annotations, "byGroupId", "groupId");
        ensureIndex(annotations, "byColorId", "colorId"); ensureIndex(annotations, "byType", "type");
        ensureIndex(annotations, "byCreatedAt", "createdAt"); ensureIndex(annotations, "byContentHash", "contentHash");
        if (!db.objectStoreNames.contains("fileIndex")) db.createObjectStore("fileIndex", { keyPath: "filePath" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("wal")) db.createObjectStore("wal", { keyPath: "sequence", autoIncrement: true });
        const history = db.objectStoreNames.contains("history")
          ? req.transaction!.objectStore("history")
          : db.createObjectStore("history", { keyPath: ["filePath", "sequence"] });
        ensureIndex(history, "byTimestamp", "timestamp");
        if (!db.objectStoreNames.contains("syncState")) db.createObjectStore("syncState", { keyPath: "deviceId" });
        if (!db.objectStoreNames.contains("checkpoints")) db.createObjectStore("checkpoints", { keyPath: "key" });
        for (let i = 0; i < 4; i++) if (!db.objectStoreNames.contains(`annotationShard${i}`)) db.createObjectStore(`annotationShard${i}`, { keyPath: ["filePath", "id"] });
      };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async putSettings(settings: PluginSettings): Promise<void> { await this.put("settings", { key: "global", settings }); await this.fallbackSave({ settings }); }
  async getFile(path: string): Promise<StoredAnnotation[]> { if (!this.db) return []; return this.readIndex("annotations", "byFilePath", path); }
  async getAllAnnotations(): Promise<StoredAnnotation[]> { if (!this.db) return []; return new Promise((resolve, reject) => { const req = this.db!.transaction("annotations").objectStore("annotations").getAll(); req.onsuccess = () => resolve(req.result as StoredAnnotation[]); req.onerror = () => reject(req.error); }); }
  async putAnnotations(records: StoredAnnotation[]): Promise<void> { if (!this.db || records.length === 0) return; await this.tx(["annotations", "annotationShard0", "annotationShard1", "annotationShard2", "annotationShard3"], "readwrite", (tx) => records.forEach((r) => { tx.objectStore("annotations").put(r); tx.objectStore(`annotationShard${shardFor(r.filePath)}`).put(r); })); }
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
    const maxSequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
    await this.put("checkpoints", { key: "last", sequence: maxSequence, timestamp: Date.now() });
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
      records.filter((record) => now - record.timestamp > 90 * 24 * 60 * 60 * 1000 && !keep.has(`${record.filePath}:${record.sequence}`)).forEach((record) => store.delete([record.filePath, record.sequence]));
    });
  }
  async putSyncState(deviceId: string, state: unknown): Promise<void> { await this.put("syncState", { deviceId, state, updatedAt: Date.now() }); }
  async getSyncStates(): Promise<Array<{ deviceId: string; state: unknown; updatedAt: number }>> { return this.getAll("syncState"); }
  async getHistory(filePath: string, limit = 50): Promise<HistoryRecord[]> {
    const records = await this.getAll<HistoryRecord>("history");
    return records.filter((record) => record.filePath === filePath && record.type === "undoable").sort((a, b) => b.sequence - a.sequence).slice(0, limit).reverse();
  }
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
export class LZString {
  static compressToUTF16(input: string): string {
    if (!input) return "";
    return lzCompress(input);
  }
  static decompressFromUTF16(input: string): string {
    if (!input) return "";
    return lzDecompress(input);
  }
}

export function lzCompress(value: string): string {
  // Small, dependency-free LZ-style dictionary compressor suitable for short
  // prefix/suffix anchors. Output is base64 so it can live safely in IndexedDB
  // records and sync payloads.
  const dict = new Map<string, number>();
  const codes: number[] = [];
  let phrase = "";
  let nextCode = 256;
  for (const char of value) {
    const combo = phrase + char;
    if (dict.has(combo) || combo.length === 1) phrase = combo;
    else {
      codes.push(phrase.length === 1 ? phrase.charCodeAt(0) : dict.get(phrase) ?? 0);
      dict.set(combo, nextCode++);
      phrase = char;
    }
  }
  if (phrase) codes.push(phrase.length === 1 ? phrase.charCodeAt(0) : dict.get(phrase) ?? 0);
  const bytes = new Uint8Array(codes.length * 2);
  codes.forEach((code, i) => { bytes[i * 2] = code >> 8; bytes[i * 2 + 1] = code & 255; });
  return bytesToBase64(bytes);
}
export function lzDecompress(value: string): string {
  try {
    const bytes = base64ToBytes(value);
    const codes: number[] = [];
    for (let i = 0; i < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
    const dict = new Map<number, string>();
    let nextCode = 256;
    let phrase = String.fromCharCode(codes[0] ?? 0);
    let out = phrase;
    for (let i = 1; i < codes.length; i++) {
      const code = codes[i];
      const entry = code < 256 ? String.fromCharCode(code) : dict.get(code) ?? phrase + phrase[0];
      out += entry;
      dict.set(nextCode++, phrase + entry[0]);
      phrase = entry;
    }
    return out;
  } catch { return value; }
}

export class MessagePackSyncCodec {
  static encode(records: StoredAnnotation[]): Uint8Array {
    return msgPackEncode({ version: 1, records });
  }
  static decode(bytes: Uint8Array): StoredAnnotation[] {
    const parsed = msgPackDecode(bytes) as { records?: StoredAnnotation[] };
    return parsed.records ?? [];
  }
}

export class WorkerBridge {
  private worker: Worker | null = null;
  constructor() {
    if (typeof Worker === "undefined" || typeof Blob === "undefined") return;
    const source = `self.onmessage=e=>{const s=e.data.text||"";let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)};self.postMessage({id:e.data.id,hash:(h>>>0).toString(16)})}`;
    this.worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  }
  fingerprint(text: string): Promise<string> {
    if (!this.worker) return Promise.resolve(SimHashEngine.fingerprint(text));
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent<{ id: string; hash: string }>) => {
        if (event.data.id !== id) return;
        this.worker?.removeEventListener("message", onMessage);
        resolve(event.data.hash.padStart(16, "0"));
      };
      const worker = this.worker;
      if (!worker) { resolve(SimHashEngine.fingerprint(text)); return; }
      worker.addEventListener("message", onMessage);
      worker.postMessage({ id, text });
    });
  }
}

function msgPackEncode(value: unknown): Uint8Array {
  const bytes: number[] = [];
  writeMsgPack(value, bytes);
  return new Uint8Array(bytes);
}
function writeMsgPack(value: unknown, bytes: number[]): void {
  if (value === null || value === undefined) { bytes.push(0xc0); return; }
  if (typeof value === "boolean") { bytes.push(value ? 0xc3 : 0xc2); return; }
  if (typeof value === "number") { bytes.push(0xcb); const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); for (let i = 0; i < 8; i++) bytes.push(view.getUint8(i)); return; }
  if (typeof value === "string") { const encoded = new TextEncoder().encode(value); bytes.push(0xdb, encoded.length >>> 24, encoded.length >>> 16 & 255, encoded.length >>> 8 & 255, encoded.length & 255, ...encoded); return; }
  if (Array.isArray(value)) { bytes.push(0xdd, value.length >>> 24, value.length >>> 16 & 255, value.length >>> 8 & 255, value.length & 255); value.forEach((item) => writeMsgPack(item, bytes)); return; }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  bytes.push(0xdf, entries.length >>> 24, entries.length >>> 16 & 255, entries.length >>> 8 & 255, entries.length & 255);
  entries.forEach(([k, v]) => { writeMsgPack(k, bytes); writeMsgPack(v, bytes); });
}
function msgPackDecode(bytes: Uint8Array): unknown {
  let offset = 0;
  const read = (): unknown => {
    const tag = bytes[offset++];
    if (tag === 0xc0) return null;
    if (tag === 0xc2) return false;
    if (tag === 0xc3) return true;
    if (tag === 0xcb) { const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8); offset += 8; return view.getFloat64(0); }
    if (tag === 0xdb) { const len = readU32(bytes, offset); offset += 4; const text = new TextDecoder().decode(bytes.slice(offset, offset + len)); offset += len; return text; }
    if (tag === 0xdd) { const len = readU32(bytes, offset); offset += 4; return Array.from({ length: len }, () => read()); }
    if (tag === 0xdf) { const len = readU32(bytes, offset); offset += 4; const out: Record<string, unknown> = {}; for (let i = 0; i < len; i++) out[String(read())] = read(); return out; }
    throw new Error(`Unsupported MessagePack tag ${tag}`);
  };
  return read();
}
function readU32(bytes: Uint8Array, offset: number): number { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; bytes.forEach((b) => binary += String.fromCharCode(b)); return btoa(binary); }
function base64ToBytes(value: string): Uint8Array { const binary = atob(value); const out = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i); return out; }

function buildIntervalNode(items: Array<{ start: number; end: number; id: string }>): IntervalNode | null {
  if (items.length === 0) return null;
  const points = items.flatMap((item) => [item.start, item.end]).sort((a, b) => a - b);
  const center = points[Math.floor(points.length / 2)];
  const left: typeof items = [];
  const right: typeof items = [];
  const intervals: typeof items = [];
  for (const item of items) {
    if (item.end < center) left.push(item);
    else if (item.start > center) right.push(item);
    else intervals.push(item);
  }
  return { center, intervals, left: buildIntervalNode(left), right: buildIntervalNode(right) };
}
function queryIntervalNode(node: IntervalNode | null, start: number, end: number, hits: string[]): void {
  if (!node) return;
  for (const item of node.intervals) if (item.start < end && item.end > start) hits.push(item.id);
  if (start <= node.center) queryIntervalNode(node.left, start, end, hits);
  if (end >= node.center) queryIntervalNode(node.right, start, end, hits);
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
function shardFor(path: string): number { return Math.abs([...path].reduce((n, c) => ((n << 5) - n + c.charCodeAt(0)) | 0, 0)) % 4; }
function addSet(m: Map<string, Set<string>>, k: string, v: string): void { const s = m.get(k) ?? new Set<string>(); s.add(v); m.set(k, s); }
function fnv1a64(input: string): bigint { let h = BigInt("0xcbf29ce484222325"); for (let i = 0; i < input.length; i++) { h ^= BigInt(input.charCodeAt(i)); h = BigInt.asUintN(64, h * BigInt("0x100000001b3")); } return h; }
function hamming64(a: bigint, b: bigint): number { let x = a ^ b, n = 0; while (x) { n++; x &= x - BigInt(1); } return n; }
function crc32(s: string): number { let c = ~0; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i); for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function mergeClock(a: Record<string, number>, b: Record<string, number>): Record<string, number> { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v); return out; }
function compareClock(a: Record<string, number>, b: Record<string, number>): "a" | "b" | "concurrent" { let ag = false, bg = false; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if ((a[k] ?? 0) > (b[k] ?? 0)) ag = true; if ((b[k] ?? 0) > (a[k] ?? 0)) bg = true; } return ag && !bg ? "a" : bg && !ag ? "b" : "concurrent"; }

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath);
}
