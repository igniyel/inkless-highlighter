/**
 * Persistence for settings and per-file annotations.
 *
 * Everything is written to the plugin's own data.json (via Plugin.saveData),
 * so it travels with the vault and is carried by Obsidian Sync / Git. Saves are
 * debounced to avoid thrashing during rapid annotating.
 */

import { debounce, type Debouncer } from "obsidian";
import { SCHEMA_VERSION, defaultSettings } from "./constants";
import type {
  FileHighlights,
  HighlightRecord,
  PersistedData,
  PluginSettings,
} from "./types";

type SaveFn = (data: PersistedData) => Promise<void>;

export class HighlightStore {
  settings: PluginSettings;
  private highlights: FileHighlights;
  private readonly save: SaveFn;
  private readonly flush: Debouncer<[], void>;

  constructor(loaded: Partial<PersistedData> | null, save: SaveFn) {
    this.save = save;
    this.settings = this.mergeSettings(loaded?.settings);
    this.highlights = this.sanitise(loaded?.highlights);
    this.flush = debounce(() => void this.persistNow(), 500, true);
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
    list.push(...records);
    this.flush();
  }

  /** Remove an entire group; returns the removed records. */
  removeGroup(path: string, groupId: string): HighlightRecord[] {
    const list = this.highlights[path];
    if (!list) return [];
    const removed = list.filter((r) => r.groupId === groupId);
    const kept = list.filter((r) => r.groupId !== groupId);
    if (kept.length) this.highlights[path] = kept;
    else delete this.highlights[path];
    if (removed.length) this.flush();
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
    if (changed) this.flush();
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
    this.flush();
  }

  deleteFile(path: string): void {
    if (this.highlights[path]) {
      delete this.highlights[path];
      this.flush();
    }
  }

  /** Replace all settings wholesale (used by the reset action). */
  setSettings(next: PluginSettings): void {
    this.settings = next;
    this.flush();
  }

  /** Remove every stored annotation (settings are untouched). */
  clearAll(): void {
    this.highlights = {};
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

  /* ----- saving ----- */

  /** Persist immediately (e.g. on unload or after a settings change). */
  async persistNow(): Promise<void> {
    await this.save(this.exportAll());
  }

  /** Schedule a debounced settings+data save. */
  scheduleSave(): void {
    this.flush();
  }
}
