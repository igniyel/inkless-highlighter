import type { HighlightRecord } from "./types";

// The bit of file I/O the store needs. Kept as an interface so the store can be
// tested without Obsidian.
export interface StorageAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

function fnv1a32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Stable 16-hex id for a file path (two FNV-1a hashes concatenated). The path is
// also stored in the shard, so a collision could be spotted rather than corrupt.
export function fileIdFor(path: string): string {
  const a = fnv1a32(path, 0x811c9dc5);
  const b = fnv1a32(path, 0x23d4a8f1);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export interface FileMeta {
  path: string;
  count: number;
  updatedAt: number;
}

// The manifest: fileId -> metadata, so counts don't need shard reads.
export interface IndexFile {
  schema: number;
  files: Record<string, FileMeta>;
}

// One file's shard on disk.
export interface ShardFile {
  schema: number;
  path: string;
  annotations: HighlightRecord[];
}

export const SHARD_SCHEMA = 1;

export function isRecord(r: unknown): r is HighlightRecord {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as HighlightRecord).id === "string" &&
    typeof (r as HighlightRecord).exact === "string"
  );
}

export function sanitiseList(list: unknown): HighlightRecord[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord);
}
