/**
 * Persistence for settings and per-file annotations.
 *
 * Production persistence uses IndexedDB object stores plus an append-only WAL.
 * Obsidian data.json is retained only for settings and first-run migration from
 * legacy versions that stored every annotation in one JSON blob.
 */

import { debounce, type Debouncer } from "obsidian";
import { CRDTMergeEngine, MessagePackSyncCodec, WorkerBridge, enrichRecord, IndexManager, makeHistory, PersistenceLayer } from "./production";
import { SCHEMA_VERSION, defaultSettings } from "./constants";
import type {
  FileHighlights,
  HighlightRecord,
  PersistedData,
  StoredAnnotation,
  PluginSettings,
} from "./types";

type SaveFn = (data: PersistedData) => Promise<void>;

export class HighlightStore {
  settings: PluginSettings;
  private highlights: FileHighlights;
  private readonly save: SaveFn;
  private persistence: PersistenceLayer | null = null;
  private readonly index = new IndexManager();
  private readonly deviceId = this.getDeviceId();
  private vaultName = "";
  private readonly worker = new WorkerBridge();
  private historySequence = 0;
  private readonly flush: Debouncer<[], void>;

  constructor(loaded: Partial<PersistedData> | null, save: SaveFn) {
    this.save = save;
    this.settings = this.mergeSettings(loaded?.settings);
    this.highlights = this.sanitise(loaded?.highlights);
    for (const [path, records] of Object.entries(this.highlights)) {
      this.index.setFile(path, records.map((r) => enrichRecord(r, path, this.deviceId, this.vaultName)));
    }
    this.flush = debounce(() => void this.persistNow(), 500, true);
  }

  async init(pluginId: string, vaultName = ""): Promise<void> {
    this.vaultName = vaultName;
    this.persistence = new PersistenceLayer(pluginId, (data) => this.save({ schema: SCHEMA_VERSION, settings: this.settings, highlights: data.highlights ?? this.highlights } as PersistedData));
    try {
      await this.persistence.open();
      await this.persistence.putSettings(this.settings);
      await this.persistence.replayWal();
      void this.persistence.compactWal();
      void this.persistence.pruneHistory();
      const existing = await this.persistence.getAllAnnotations();
      if (existing.length > 0) {
        this.highlights = {};
        for (const rec of existing.filter((r) => !r.deletedAt)) {
          const list = this.highlights[rec.filePath] ?? (this.highlights[rec.filePath] = []);
          list.push(rec);
        }
        for (const [path, records] of Object.entries(this.highlights)) this.index.setFile(path, records as StoredAnnotation[]);
        return;
      }
      const batches = Object.entries(this.highlights).map(([path, records]) =>
        records.map((r) => enrichRecord(r, path, this.deviceId, this.vaultName)),
      );
      for (const batch of batches) await this.persistence.putAnnotations(batch);
    } catch (err) {
      console.error("Inkless Highlighter persistence backend unavailable", err);
      this.persistence = null;
    }
  }

  getDeviceId(): string {
    try {
      const key = "rhl-device-id";
      const existing = window.localStorage.getItem(key);
      if (existing) return existing;
      const id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
      window.localStorage.setItem(key, id);
      return id;
    } catch {
      return "device-local";
    }
  }

  /* ----- settings ----- */

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
    // Toolbar placement is now device-local (localStorage). Drop any copy that
    // older versions persisted into the synced data so it can't travel between
    // devices via Obsidian Sync.
    delete (merged as unknown as Record<string, unknown>).toolbarPlacement;
    return merged;
  }

  private sanitise(raw: FileHighlights | undefined): FileHighlights {
    const out: FileHighlights = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [path, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter(
        (r): r is HighlightRecord =>
          !!r && typeof r.id === "string" && typeof r.exact === "string",
      );
      if (clean.length) out[path] = clean;
    }
    return out;
  }


  private runTransaction(validate: () => boolean, mutate: () => void, commit: () => Promise<void>, notify: () => void): void {
    if (!validate()) return;
    mutate();
    void commit().finally(() => notify());
  }

  /* ----- queries ----- */

  getForFile(path: string): HighlightRecord[] {
    return this.highlights[path] ?? [];
  }

  hasFile(path: string): boolean {
    return (this.highlights[path]?.length ?? 0) > 0;
  }

  totalCount(): number {
    return Object.values(this.highlights).reduce((n, l) => n + l.length, 0);
  }

  fileCount(): number {
    return Object.keys(this.highlights).length;
  }

  /* ----- mutations ----- */

  add(path: string, records: HighlightRecord[]): void {
    if (records.length === 0) return;
    const list = this.highlights[path] ?? (this.highlights[path] = []);
    const stored = records.map((r) => enrichRecord(r, path, this.deviceId, this.vaultName));
    void Promise.all(stored.map((r) => this.worker.fingerprint(`${r.prefix} ${r.exact} ${r.suffix}`)));
    this.runTransaction(
      () => records.length > 0,
      () => {
        list.push(...stored);
        this.index.setFile(path, (this.highlights[path] as StoredAnnotation[]));
      },
      async () => {
        await this.persistence?.appendWal({ type: "add", path, records: stored });
        await this.persistence?.putAnnotations(stored);
        await this.persistence?.addHistory(makeHistory(path, ++this.historySequence, `Added ${records.length} annotation(s)`, [{ type: "remove", records: stored }], [{ type: "add", records: stored }]));
      },
      () => this.flush(),
    );
  }

  /** Remove an entire group; returns the removed records. */
  removeGroup(path: string, groupId: string): HighlightRecord[] {
    const list = this.highlights[path];
    if (!list) return [];
    const removed = list.filter((r) => r.groupId === groupId);
    const kept = list.filter((r) => r.groupId !== groupId);
    if (kept.length) this.highlights[path] = kept;
    else delete this.highlights[path];
    if (removed.length) {
      this.index.setFile(path, kept.map((r) => enrichRecord(r, path, this.deviceId, this.vaultName)));
      void this.persistence?.appendWal({ type: "removeGroup", path, groupId });
      void this.persistence?.deleteGroup(path, groupId);
      this.flush();
    }
    return removed;
  }

  /** Apply a partial update to every record in a group. */
  updateGroup(path: string, groupId: string, patch: Partial<HighlightRecord>): void {
    const list = this.highlights[path];
    if (!list) return;
    let changed = false;
    for (const r of list) {
      if (r.groupId === groupId) {
        Object.assign(r, patch);
        changed = true;
      }
    }
    if (changed) {
      const stored = list.map((r) => enrichRecord(r, path, this.deviceId, this.vaultName));
      this.index.setFile(path, stored);
      void this.persistence?.appendWal({ type: "updateGroup", path, groupId, patch });
      void this.persistence?.putAnnotations(stored.filter((r) => r.groupId === groupId));
      this.flush();
    }
  }

  findById(path: string, id: string): HighlightRecord | undefined {
    return this.highlights[path]?.find((r) => r.id === id);
  }

  /* ----- file lifecycle ----- */

  rename(oldPath: string, newPath: string): void {
    const list = this.highlights[oldPath];
    if (!list) return;
    delete this.highlights[oldPath];
    const existing = this.highlights[newPath] ?? [];
    this.highlights[newPath] = existing.concat(list);
    this.index.deleteFile(oldPath);
    this.index.setFile(newPath, this.highlights[newPath].map((r) => enrichRecord(r, newPath, this.deviceId, this.vaultName)));
    void this.persistence?.appendWal({ type: "rename", oldPath, newPath });
    void this.persistence?.deleteFile(oldPath);
    void this.persistence?.putAnnotations(this.highlights[newPath].map((r) => enrichRecord(r, newPath, this.deviceId, this.vaultName)));
    this.flush();
  }

  deleteFile(path: string): void {
    if (this.highlights[path]) {
      delete this.highlights[path];
      this.index.deleteFile(path);
      void this.persistence?.appendWal({ type: "deleteFile", path });
      void this.persistence?.deleteFile(path);
      this.flush();
    }
  }

  /** Replace all settings wholesale (used by the reset action). */
  setSettings(next: PluginSettings): void {
    this.settings = next;
    void this.persistence?.appendWal({ type: "settings", settings: next });
    void this.persistence?.putSettings(next);
    this.flush();
  }

  /** Remove every stored annotation (settings are untouched). */
  clearAll(): void {
    this.highlights = {};
    void this.persistence?.appendWal({ type: "clearAll" });
    void this.persistence?.clearAnnotations();
    this.flush();
  }

  /* ----- import / export ----- */

  exportAll(): PersistedData {
    return {
      schema: SCHEMA_VERSION,
      settings: this.settings,
      highlights: this.highlights,
    };
  }

  exportFile(path: string): HighlightRecord[] {
    return JSON.parse(JSON.stringify(this.getForFile(path)));
  }

  /** Merge imported annotations (by file path); de-dupes on record id. */
  importHighlights(data: FileHighlights, replace: boolean): number {
    let added = 0;
    for (const [path, list] of Object.entries(this.sanitise(data))) {
      const target = replace ? [] : this.highlights[path] ?? [];
      const seen = new Set(target.map((r) => r.id));
      for (const r of list) {
        if (seen.has(r.id)) continue;
        target.push(r);
        seen.add(r.id);
        added++;
      }
      if (target.length) this.highlights[path] = target;
    }
    if (added) this.flush();
    return added;
  }

  /** Serialize local changes for the vault-level CRDT sync file protocol. */
  exportSyncPayload(updatedAfter = 0): Uint8Array {
    const records = Object.values(this.highlights)
      .flat()
      .map((record) => enrichRecord(record, (record as StoredAnnotation).filePath ?? "", this.deviceId, this.vaultName))
      .filter((record) => record.updatedAt > updatedAfter);
    return MessagePackSyncCodec.encode(records);
  }

  /** Merge annotations received from another device using vector-clock CRDT rules. */
  importSyncPayload(payload: Uint8Array): number {
    let merged = 0;
    for (const remote of MessagePackSyncCodec.decode(payload)) {
      const path = remote.filePath;
      const list = (this.highlights[path] ?? []) as StoredAnnotation[];
      const idx = list.findIndex((local) => local.id === remote.id);
      const next = CRDTMergeEngine.merge(idx >= 0 ? list[idx] : undefined, remote);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      this.highlights[path] = list.filter((record) => !record.deletedAt);
      this.index.setFile(path, this.highlights[path] as StoredAnnotation[]);
      void this.persistence?.putAnnotations([next]);
      merged++;
    }
    if (merged) this.flush();
    return merged;
  }

  async getPersistentHistory(path: string): Promise<Array<{ groupId: string; before: HighlightRecord[]; after: HighlightRecord[] }>> {
    const records = await this.persistence?.getHistory(path, 50) ?? [];
    return records.map((record) => ({
      groupId: record.forwardOps[0]?.groupId ?? record.inverseOps[0]?.groupId ?? record.forwardOps[0]?.records?.[0]?.groupId ?? record.inverseOps[0]?.records?.[0]?.groupId ?? "",
      before: (record.inverseOps[0]?.records ?? []) as HighlightRecord[],
      after: (record.forwardOps[0]?.records ?? []) as HighlightRecord[],
    })).filter((record) => record.groupId);
  }

  /* ----- saving ----- */

  /** Persist immediately (e.g. on unload or after a settings change). */
  async persistNow(): Promise<void> {
    await this.persistence?.putSettings(this.settings);
    await this.save({ schema: SCHEMA_VERSION, settings: this.settings, highlights: this.persistence ? {} : this.highlights });
  }

  /** Schedule a debounced settings+data save. */
  scheduleSave(): void {
    this.flush();
  }
}
