/**
 * Storage primitives for the sharded annotation store.
 *
 * Annotations are persisted as per-file JSON shards inside the plugin folder
 * (so they still travel with the vault through Obsidian Sync / Git, exactly as
 * the old single data.json did) plus a small manifest. This keeps writes
 * incremental — changing one note rewrites only that note's small shard, never
 * the whole dataset — and lets files load lazily instead of all at once.
 *
 * Everything here is dependency-free and side-effect-free so it can be unit
 * tested without an Obsidian runtime; the only I/O goes through StorageAdapter.
 */

import type { HighlightRecord } from "./types";

/** Minimal async file surface the store needs (a subset of Obsidian's DataAdapter). */
export interface StorageAdapter {
  /** Read a file's text, or null if it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

/** One 32-bit FNV-1a pass with a given offset basis. */
function fnv1a32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable 64-bit-wide id for a vault file path, as 16 hex chars. Two independent
 * FNV-1a hashes are concatenated; collision risk across a vault's worth of paths
 * is negligible, and the owning path is also stored inside each shard so a
 * collision could be detected rather than silently corrupt data.
 */
export function fileIdFor(path: string): string {
  const a = fnv1a32(path, 0x811c9dc5);
  const b = fnv1a32(path, 0x23d4a8f1);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Per-file metadata held in the manifest (so counts/listing need no shard reads). */
export interface FileMeta {
  path: string;
  count: number;
  updatedAt: number;
}

/** The manifest file: fileId -> metadata. */
export interface IndexFile {
  schema: number;
  files: Record<string, FileMeta>;
}

/** One file's annotation shard on disk. */
export interface ShardFile {
  schema: number;
  path: string;
  annotations: HighlightRecord[];
}

export const SHARD_SCHEMA = 1;

/** Validate one record's essential shape (used when reading untrusted JSON). */
export function isRecord(r: unknown): r is HighlightRecord {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as HighlightRecord).id === "string" &&
    typeof (r as HighlightRecord).exact === "string"
  );
}

/** Keep only well-formed records from an arbitrary array. */
export function sanitiseList(list: unknown): HighlightRecord[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord);
}
