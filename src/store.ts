/**
 * Persistence for settings and per-file annotations.
 *
 * Annotations are stored as **per-file JSON shards** under the plugin folder,
 * with a small manifest (`index.json`) holding per-file metadata. This replaces
 * the old single data.json blob:
 *
 *  - **Incremental writes** — changing one note rewrites only that note's shard
 *    (a few KB), never the whole dataset.
 *  - **Lazy loading + LRU** — a file's annotations load on demand and idle files
 *    are evicted from memory, so RAM tracks the working set, not the vault.
 *  - **Indexed in memory** — each loaded file keeps `byId` / `byGroup` maps, so
 *    lookups, recolouring and deletion are O(1) instead of array scans.
 *
 * Shards live in the plugin folder, exactly where data.json did, so annotations
 * still travel with the vault through Obsidian Sync / Git. Settings stay in
 * data.json (small, and written through the host's saveData). Writes are
 * debounced; everything dirty is flushed on unload.
 */

import { debounce, type Debouncer } from "obsidian";
import { defaultSettings } from "./constants";
import {
  SHARD_SCHEMA,
  fileIdFor,
  sanitiseList,
  type FileMeta,
  type IndexFile,
  type ShardFile,
  type StorageAdapter,
} from "./persistence";
import type {
  FileHighlights,
  HighlightRecord,
  PersistedData,
  PluginSettings,
} from "./types";

/** Schema of the data.json blob once highlights have moved to shards. */
const DATA_SCHEMA = 2;
/** Schema of an exported backup (kept stable for import compatibility). */
const EXPORT_SCHEMA = 1;
/** Folder (relative to the plugin dir) holding the manifest and shards. */
const HL_SUBDIR = "highlights";
const INDEX_NAME = "index.json";
/** How many files' annotations stay resident before idle ones are evicted. */
const HOT_CAP = 8;

type SaveFn = (data: PersistedData) => Promise<void>;

/** A file's annotations held in memory, with its lookup indexes. */
interface LoadedFile {
  fileId: string;
  path: string;
  records: HighlightRecord[];
  byId: Map<string, HighlightRecord>;
  byGroup: Map<string, Set<string>>;
  dirty: boolean;
}

export class HighlightStore {
  settings: PluginSettings;
  /** True when this session migrated a legacy data.json into shards. */
  migrated = false;

  private readonly adapter: StorageAdapter;
  private readonly hlDir: string;
  private readonly indexPath: string;
  private readonly save: SaveFn;
  private readonly flush: Debouncer<[], void>;

  /** Manifest: fileId -> metadata (always resident). */
  private index = new Map<string, FileMeta>();
  private pathToId = new Map<string, string>();
  /** Resident shards (insertion order doubles as LRU order). */
  private cache = new Map<string, LoadedFile>();
  /** De-dupes concurrent loads of the same shard. */
  private inflight = new Map<string, Promise<LoadedFile>>();

  private indexDirty = false;
  private settingsDirty = false;

  constructor(adapter: StorageAdapter, pluginDir: string, save: SaveFn) {
    this.adapter = adapter;
    this.hlDir = `${pluginDir}/${HL_SUBDIR}`;
    this.indexPath = `${this.hlDir}/${INDEX_NAME}`;
    this.save = save;
    this.settings = defaultSettings();
    this.flush = debounce(() => {
      void this.persistNow().catch((e) =>
        console.error("[inkless-highlighter] failed to persist annotations", e),
      );
    }, 500, true);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Load settings + manifest, migrating a legacy data.json blob if present. */
  async init(legacy: Partial<PersistedData> | null): Promise<void> {
    this.settings = this.mergeSettings(legacy?.settings);
    await this.ensureDir();

    const manifest = await this.readJson<IndexFile>(this.indexPath);
    if (manifest && manifest.files && typeof manifest.files === "object") {
      for (const [fileId, meta] of Object.entries(manifest.files)) {
        if (!meta || typeof meta.path !== "string") continue;
        this.index.set(fileId, {
          path: meta.path,
          count: typeof meta.count === "number" ? meta.count : 0,
          updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
        });
        this.pathToId.set(meta.path, fileId);
      }
      return;
    }

    // No manifest yet: migrate the old blob's highlights into shards (once).
    const legacyHighlights = legacy?.highlights;
    if (legacyHighlights && Object.keys(legacyHighlights).length > 0) {
      await this.migrateLegacy(legacyHighlights);
    } else {
      await this.writeIndex();
    }
  }

  private async ensureDir(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.hlDir))) await this.adapter.mkdir(this.hlDir);
    } catch {
      /* directory may already exist or be created concurrently */
    }
  }

  /** One-time copy of legacy highlights into shards, with a safety backup. */
  private async migrateLegacy(raw: FileHighlights): Promise<void> {
    // Keep the original blob verbatim so migration is reversible.
    await this.adapter
      .write(
        `${this.hlDir}/legacy-backup-${Date.now()}.json`,
        JSON.stringify({ schema: 1, highlights: raw }),
      )
      .catch(() => {});

    for (const [path, list] of Object.entries(raw)) {
      const clean = sanitiseList(list);
      if (clean.length === 0) continue;
      const fileId = fileIdFor(path);
      await this.writeShard(fileId, path, clean);
      this.index.set(fileId, { path, count: clean.length, updatedAt: Date.now() });
      this.pathToId.set(path, fileId);
    }
    await this.writeIndex();
    // Ask the host to drop highlights from data.json on the next settings save.
    this.migrated = true;
    this.settingsDirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */

  private mergeSettings(partial: Partial<PluginSettings> | undefined): PluginSettings {
    const base = defaultSettings();
    if (!partial) return base;
    const merged: PluginSettings = {
      ...base,
      ...partial,
      underline: { ...base.underline, ...(partial.underline ?? {}) },
      palette:
        Array.isArray(partial.palette) && partial.palette.length > 0
          ? partial.palette
          : base.palette,
    };
    // Toolbar placement is device-local (localStorage); never keep a synced copy.
    delete (merged as unknown as Record<string, unknown>).toolbarPlacement;
    return merged;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  /** Annotations for a file that is already resident (else empty). */
  getForFile(path: string): HighlightRecord[] {
    const id = this.pathToId.get(path) ?? fileIdFor(path);
    const lf = this.cache.get(id);
    if (!lf) return [];
    this.touch(id);
    return lf.records;
  }

  /** Ensure a file's shard is loaded, returning its records. */
  async ensureFileLoaded(path: string): Promise<HighlightRecord[]> {
    const lf = await this.load(path);
    return lf.records;
  }

  isLoaded(path: string): boolean {
    const id = this.pathToId.get(path) ?? fileIdFor(path);
    return this.cache.has(id);
  }

  hasFile(path: string): boolean {
    const id = this.pathToId.get(path);
    return !!id && (this.index.get(id)?.count ?? 0) > 0;
  }

  totalCount(): number {
    let n = 0;
    for (const meta of this.index.values()) n += meta.count;
    return n;
  }

  fileCount(): number {
    let n = 0;
    for (const meta of this.index.values()) if (meta.count > 0) n += 1;
    return n;
  }

  findById(path: string, id: string): HighlightRecord | undefined {
    const lf = this.cache.get(this.pathToId.get(path) ?? fileIdFor(path));
    return lf?.byId.get(id);
  }

  /* ------------------------------------------------------------------ */
  /* Mutations (operate on a resident file)                              */
  /* ------------------------------------------------------------------ */

  add(path: string, records: HighlightRecord[]): void {
    if (records.length === 0) return;
    const lf = this.acquire(path);
    if (!lf) return;
    for (const r of records) {
      lf.records.push(r);
      lf.byId.set(r.id, r);
      this.indexGroup(lf, r);
    }
    this.markFileChanged(lf);
  }

  /** Remove an entire group; returns the removed records. */
  removeGroup(path: string, groupId: string): HighlightRecord[] {
    const lf = this.cache.get(this.pathToId.get(path) ?? fileIdFor(path));
    if (!lf) return [];
    const ids = lf.byGroup.get(groupId);
    if (!ids || ids.size === 0) return [];
    const removed: HighlightRecord[] = [];
    for (const id of ids) {
      const rec = lf.byId.get(id);
      if (rec) removed.push(rec);
      lf.byId.delete(id);
    }
    lf.byGroup.delete(groupId);
    lf.records = lf.records.filter((r) => r.groupId !== groupId);
    if (removed.length) this.markFileChanged(lf);
    return removed;
  }

  /** Apply a partial update to every record in a group. */
  updateGroup(path: string, groupId: string, patch: Partial<HighlightRecord>): void {
    const lf = this.cache.get(this.pathToId.get(path) ?? fileIdFor(path));
    if (!lf) return;
    const ids = lf.byGroup.get(groupId);
    if (!ids) return;
    let changed = false;
    for (const id of ids) {
      const rec = lf.byId.get(id);
      if (rec) {
        Object.assign(rec, patch);
        changed = true;
      }
    }
    if (changed) this.markFileChanged(lf);
  }

  /* ------------------------------------------------------------------ */
  /* File lifecycle                                                      */
  /* ------------------------------------------------------------------ */

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldId = this.pathToId.get(oldPath);
    if (!oldId || (this.index.get(oldId)?.count ?? 0) === 0) return;
    const moving = (await this.load(oldPath)).records.slice();
    if (moving.length === 0) return;

    // Merge into any annotations already at the destination.
    const existing = (await this.load(newPath)).records;
    const seen = new Set(existing.map((r) => r.id));
    const target = this.cache.get(fileIdFor(newPath));
    if (!target) return;
    for (const r of moving) {
      if (seen.has(r.id)) continue;
      target.records.push(r);
      target.byId.set(r.id, r);
      this.indexGroup(target, r);
    }
    this.markFileChanged(target);
    await this.removeFileEntirely(oldId, oldPath);
  }

  async deleteFile(path: string): Promise<void> {
    const id = this.pathToId.get(path);
    if (id) await this.removeFileEntirely(id, path);
  }

  /** Replace all settings wholesale (used by the reset action). */
  setSettings(next: PluginSettings): void {
    this.settings = next;
    this.settingsDirty = true;
    this.flush();
  }

  /** Remove every stored annotation (settings untouched). */
  async clearAll(): Promise<void> {
    const ids = Array.from(this.index.keys());
    for (const id of ids) {
      await this.adapter.remove(`${this.hlDir}/${id}.json`).catch(() => {});
    }
    this.index.clear();
    this.pathToId.clear();
    this.cache.clear();
    this.indexDirty = true;
    await this.writeIndex();
  }

  /* ------------------------------------------------------------------ */
  /* Import / export                                                     */
  /* ------------------------------------------------------------------ */

  /** Assemble the whole dataset (loads every shard — used for backups). */
  async exportAll(): Promise<PersistedData> {
    const highlights: FileHighlights = {};
    for (const meta of this.index.values()) {
      if (meta.count === 0) continue;
      const records = await this.ensureFileLoaded(meta.path);
      if (records.length) highlights[meta.path] = records.slice();
    }
    return { schema: EXPORT_SCHEMA, settings: this.settings, highlights };
  }

  /** Merge imported annotations (by path); de-dupes on record id. */
  async importHighlights(data: FileHighlights, replace: boolean): Promise<number> {
    let added = 0;
    if (!data || typeof data !== "object") return 0;
    for (const [path, list] of Object.entries(data)) {
      const clean = sanitiseList(list);
      if (clean.length === 0) continue;
      const lf = await this.load(path);
      if (replace) {
        lf.records = [];
        lf.byId.clear();
        lf.byGroup.clear();
      }
      for (const r of clean) {
        if (lf.byId.has(r.id)) continue;
        lf.records.push(r);
        lf.byId.set(r.id, r);
        this.indexGroup(lf, r);
        added++;
      }
      if (added) this.markFileChanged(lf);
    }
    if (added || replace) this.flush();
    return added;
  }

  /* ------------------------------------------------------------------ */
  /* Saving                                                              */
  /* ------------------------------------------------------------------ */

  /** Flush every dirty shard, the manifest, and (if needed) settings. */
  async persistNow(): Promise<void> {
    for (const lf of Array.from(this.cache.values())) {
      if (!lf.dirty) continue;
      if (lf.records.length === 0) {
        await this.removeFileEntirely(lf.fileId, lf.path);
      } else {
        await this.writeShard(lf.fileId, lf.path, lf.records);
        this.index.set(lf.fileId, {
          path: lf.path,
          count: lf.records.length,
          updatedAt: Date.now(),
        });
        this.pathToId.set(lf.path, lf.fileId);
        this.indexDirty = true;
        lf.dirty = false;
      }
    }
    if (this.indexDirty) {
      await this.writeIndex();
      this.indexDirty = false;
    }
    if (this.settingsDirty) {
      await this.save({ schema: DATA_SCHEMA, settings: this.settings, highlights: {} });
      this.settingsDirty = false;
    }
    this.evictIdle();
  }

  /** Mark settings dirty and schedule a debounced flush. */
  scheduleSave(): void {
    this.settingsDirty = true;
    this.flush();
  }

  /** Flag settings as needing a write on the next persist (no scheduling). */
  markSettingsDirty(): void {
    this.settingsDirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* Internals: indexes, LRU, shard I/O                                  */
  /* ------------------------------------------------------------------ */

  private indexGroup(lf: LoadedFile, r: HighlightRecord): void {
    let set = lf.byGroup.get(r.groupId);
    if (!set) {
      set = new Set();
      lf.byGroup.set(r.groupId, set);
    }
    set.add(r.id);
  }

  private rebuildIndexes(lf: LoadedFile): void {
    lf.byId.clear();
    lf.byGroup.clear();
    for (const r of lf.records) {
      lf.byId.set(r.id, r);
      this.indexGroup(lf, r);
    }
  }

  private markFileChanged(lf: LoadedFile): void {
    lf.dirty = true;
    // Keep the manifest count fresh even before the shard is written.
    this.index.set(lf.fileId, {
      path: lf.path,
      count: lf.records.length,
      updatedAt: Date.now(),
    });
    this.pathToId.set(lf.path, lf.fileId);
    this.indexDirty = true;
    this.touch(lf.fileId);
    this.flush();
  }

  /** Resident file for a path, creating an empty one for a brand-new file. */
  private acquire(path: string): LoadedFile | null {
    const id = this.pathToId.get(path) ?? fileIdFor(path);
    const cached = this.cache.get(id);
    if (cached) {
      this.touch(id);
      return cached;
    }
    // Refuse to fabricate an empty file over an existing-but-unloaded shard,
    // which would clobber it on the next flush. Callers must ensureFileLoaded
    // first; in practice the active note is always loaded before it is mutated.
    if (this.index.has(id)) {
      console.error(`[inkless-highlighter] mutated unloaded file ${path}; skipped to avoid data loss`);
      return null;
    }
    const lf = this.makeLoaded(id, path, []);
    this.cache.set(id, lf);
    return lf;
  }

  private makeLoaded(fileId: string, path: string, records: HighlightRecord[]): LoadedFile {
    const lf: LoadedFile = {
      fileId,
      path,
      records,
      byId: new Map(),
      byGroup: new Map(),
      dirty: false,
    };
    this.rebuildIndexes(lf);
    return lf;
  }

  private async load(path: string): Promise<LoadedFile> {
    const id = this.pathToId.get(path) ?? fileIdFor(path);
    const cached = this.cache.get(id);
    if (cached) {
      this.touch(id);
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const task = (async (): Promise<LoadedFile> => {
      let records: HighlightRecord[] = [];
      if (this.index.has(id)) {
        const shard = await this.readJson<ShardFile>(`${this.hlDir}/${id}.json`);
        if (shard) records = sanitiseList(shard.annotations);
      }
      const lf = this.makeLoaded(id, path, records);
      this.cache.set(id, lf);
      this.pathToId.set(path, id);
      this.inflight.delete(id);
      this.evictIdle();
      return lf;
    })();
    this.inflight.set(id, task);
    return task;
  }

  /** Move a file to the most-recently-used end of the cache. */
  private touch(id: string): void {
    const lf = this.cache.get(id);
    if (!lf) return;
    this.cache.delete(id);
    this.cache.set(id, lf);
  }

  /** Drop the least-recently-used clean files once over the hot cap. */
  private evictIdle(): void {
    while (this.cache.size > HOT_CAP) {
      let removed = false;
      for (const [id, lf] of this.cache) {
        if (lf.dirty) continue; // never evict unsaved work
        this.cache.delete(id);
        removed = true;
        break;
      }
      if (!removed) break; // everything resident is still dirty
    }
  }

  private async removeFileEntirely(fileId: string, path: string): Promise<void> {
    await this.adapter.remove(`${this.hlDir}/${fileId}.json`).catch(() => {});
    this.index.delete(fileId);
    this.pathToId.delete(path);
    this.cache.delete(fileId);
    this.indexDirty = true;
    this.flush();
  }

  private async writeShard(
    fileId: string,
    path: string,
    records: HighlightRecord[],
  ): Promise<void> {
    const shard: ShardFile = { schema: SHARD_SCHEMA, path, annotations: records };
    await this.adapter.write(`${this.hlDir}/${fileId}.json`, JSON.stringify(shard));
  }

  private async writeIndex(): Promise<void> {
    const files: Record<string, FileMeta> = {};
    for (const [id, meta] of this.index) files[id] = meta;
    const manifest: IndexFile = { schema: SHARD_SCHEMA, files };
    await this.adapter.write(this.indexPath, JSON.stringify(manifest));
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const text = await this.adapter.read(path);
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
