import type { FileHighlights, HighlightRecord, HistoryRecord, Operation, PersistedData, PluginSettings, StoredAnnotation } from "./types";

export type WalMutation =
  | { type: "add"; path: string; records: StoredAnnotation[] }
  | { type: "removeGroup"; path: string; groupId: string }
  | { type: "updateGroup"; path: string; groupId: string; patch: Partial<HighlightRecord> }
  | { type: "rename"; oldPath: string; newPath: string }
  | { type: "deleteFile"; path: string }
  | { type: "settings"; settings: PluginSettings }
  | { type: "clearAll" };

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

export class IndexManager {
  private readonly maxFiles = 25;
  private files = new Map<string, StoredAnnotation[]>();
  readonly groupIndex = new Map<string, Set<string>>();
  readonly contentHashIndex = new Map<string, Set<string>>();

  setFile(path: string, records: StoredAnnotation[]): void {
    this.files.delete(path);
    this.files.set(path, records);
    this.rebuildSecondary();
    this.evict();
  }
  getFile(path: string): StoredAnnotation[] | undefined {
    const hit = this.files.get(path);
    if (hit) { this.files.delete(path); this.files.set(path, hit); }
    return hit;
  }
  deleteFile(path: string): void { this.files.delete(path); this.rebuildSecondary(); }
  allFiles(): FileHighlights { const out: FileHighlights = {}; for (const [p, r] of this.files) out[p] = r.filter((x) => !x.deletedAt); return out; }
  private evict(): void { while (this.files.size > this.maxFiles) this.files.delete(this.files.keys().next().value as string); }
  private rebuildSecondary(): void {
    this.groupIndex.clear(); this.contentHashIndex.clear();
    for (const [path, records] of this.files) for (const r of records) {
      addSet(this.groupIndex, r.groupId, path); if (r.contentHash) addSet(this.contentHashIndex, r.contentHash, r.id);
    }
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
  private async put(store: string, value: unknown): Promise<void> { if (!this.db) return; await this.tx([store], "readwrite", (tx) => tx.objectStore(store).put(value)); }
  private async readIndex<T>(store: string, index: string, query: IDBValidKey): Promise<T[]> { return new Promise((resolve, reject) => { const out: T[] = []; const req = this.db!.transaction(store).objectStore(store).index(index).openCursor(query); req.onsuccess = () => { const c = req.result; if (!c) resolve(out); else { out.push(c.value); c.continue(); } }; req.onerror = () => reject(req.error); }); }
  private async tx(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> { if (!this.db) return; await new Promise<void>((resolve, reject) => { const tx = this.db!.transaction(stores, mode); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); fn(tx); }); }
}

export function makeHistory(path: string, sequence: number, description: string, inverseOps: Operation[], forwardOps: Operation[]): HistoryRecord {
  return { filePath: path, sequence, timestamp: Date.now(), type: "undoable", description, inverseOps, forwardOps, preState: SimHashEngine.fingerprint(JSON.stringify(inverseOps)), postState: SimHashEngine.fingerprint(JSON.stringify(forwardOps)) };
}
function stableFileId(path: string): string { return SimHashEngine.fingerprint(path); }
function addSet(m: Map<string, Set<string>>, k: string, v: string): void { const s = m.get(k) ?? new Set<string>(); s.add(v); m.set(k, s); }
function fnv1a64(input: string): bigint { let h = BigInt("0xcbf29ce484222325"); for (let i = 0; i < input.length; i++) { h ^= BigInt(input.charCodeAt(i)); h = BigInt.asUintN(64, h * BigInt("0x100000001b3")); } return h; }
function hamming64(a: bigint, b: bigint): number { let x = a ^ b, n = 0; while (x) { n++; x &= x - BigInt(1); } return n; }
function crc32(s: string): number { let c = ~0; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i); for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function mergeClock(a: Record<string, number>, b: Record<string, number>): Record<string, number> { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v); return out; }
function compareClock(a: Record<string, number>, b: Record<string, number>): "a" | "b" | "concurrent" { let ag = false, bg = false; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if ((a[k] ?? 0) > (b[k] ?? 0)) ag = true; if ((b[k] ?? 0) > (a[k] ?? 0)) bg = true; } return ag && !bg ? "a" : bg && !ag ? "b" : "concurrent"; }
