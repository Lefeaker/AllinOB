import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  createVideoScreenshotCacheIndex,
  normalizeVideoScreenshotCacheIndex,
  normalizeVideoScreenshotCacheIndexEntry,
  normalizeVideoScreenshotCacheRef,
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  type VideoScreenshotCacheContentValidationOptions,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';
import type { VideoScreenshotCacheIndexEntry } from './videoScreenshotCacheTypes';

export interface VideoScreenshotCacheIndexState {
  entries: VideoScreenshotCacheIndexEntry[];
  dirty: boolean;
}

export interface VideoScreenshotCachePruneOptions {
  now: number;
  maxGlobalEntries: number;
  maxPageEntries: number;
  maxContentBytes?: number;
  applyLimits: boolean;
}

export interface VideoScreenshotCachePruneResult {
  entries: VideoScreenshotCacheIndexEntry[];
  removedKeys: string[];
  dirty: boolean;
}

export function sortVideoScreenshotCacheEntriesNewestFirst(
  entries: readonly VideoScreenshotCacheIndexEntry[]
): VideoScreenshotCacheIndexEntry[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.capturedAt - left.capturedAt;
  });
}

export function pruneVideoScreenshotCacheIndexEntries(
  entries: readonly VideoScreenshotCacheIndexEntry[],
  options: VideoScreenshotCachePruneOptions
): VideoScreenshotCachePruneResult {
  const newestFirst = sortVideoScreenshotCacheEntriesNewestFirst(entries);
  const uniqueEntries: VideoScreenshotCacheIndexEntry[] = [];
  const seenKeys = new Set<string>();

  for (const entry of newestFirst) {
    if (seenKeys.has(entry.key)) {
      continue;
    }
    seenKeys.add(entry.key);
    uniqueEntries.push(entry);
  }

  const removedKeys: string[] = [];
  let retained = uniqueEntries.filter((entry) => {
    if (entry.expiresAt <= options.now) {
      removedKeys.push(entry.key);
      return false;
    }
    return true;
  });

  if (options.applyLimits) {
    const perPageRetained: VideoScreenshotCacheIndexEntry[] = [];
    const groupedByPage = new Map<string, VideoScreenshotCacheIndexEntry[]>();

    for (const entry of retained) {
      const pageEntries = groupedByPage.get(entry.pageKey);
      if (pageEntries) {
        pageEntries.push(entry);
      } else {
        groupedByPage.set(entry.pageKey, [entry]);
      }
    }

    for (const pageEntries of groupedByPage.values()) {
      const sorted = sortVideoScreenshotCacheEntriesNewestFirst(pageEntries);
      perPageRetained.push(...sorted.slice(0, options.maxPageEntries));
      for (const entry of sorted.slice(options.maxPageEntries)) {
        removedKeys.push(entry.key);
      }
    }

    retained = sortVideoScreenshotCacheEntriesNewestFirst(perPageRetained);

    if (retained.length > options.maxGlobalEntries) {
      for (const entry of retained.slice(options.maxGlobalEntries)) {
        removedKeys.push(entry.key);
      }
      retained = retained.slice(0, options.maxGlobalEntries);
    }
  }

  const finalEntries = sortVideoScreenshotCacheEntriesNewestFirst(retained);
  const originalKeys = entries.map((entry) => entry.key);
  const finalKeys = finalEntries.map((entry) => entry.key);
  const dirty =
    removedKeys.length > 0 ||
    uniqueEntries.length !== entries.length ||
    originalKeys.length !== finalKeys.length ||
    originalKeys.some((key, index) => finalKeys[index] !== key);

  return {
    entries: finalEntries,
    removedKeys: Array.from(new Set(removedKeys)),
    dirty
  };
}

export function requireVideoScreenshotCacheIndexEntry(
  value: {
    schemaVersion: 1;
    key: string;
    pageKey: string;
    captureId: string;
    id: string;
    fileName: string;
    mimeType: 'image/jpeg';
    byteLength: number;
    capturedAt: number;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
  },
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheIndexEntry {
  const entry = normalizeVideoScreenshotCacheIndexEntry(value, options);
  if (entry === null) {
    throw new Error('Invalid video screenshot cache index entry.');
  }
  return entry;
}

export function buildVideoScreenshotCacheRef(
  entry: VideoScreenshotCacheIndexEntry,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheRef {
  const ref = normalizeVideoScreenshotCacheRef(entry, options);
  if (ref === null) {
    throw new Error('Invalid video screenshot cache ref.');
  }
  return ref;
}

export function matchesVideoScreenshotCacheRef(
  entry: VideoScreenshotCacheIndexEntry,
  ref: VideoScreenshotCacheRef
): boolean {
  return (
    entry.schemaVersion === ref.schemaVersion &&
    entry.key === ref.key &&
    entry.pageKey === ref.pageKey &&
    entry.captureId === ref.captureId &&
    entry.id === ref.id &&
    entry.fileName === ref.fileName &&
    entry.mimeType === ref.mimeType &&
    entry.byteLength === ref.byteLength &&
    entry.capturedAt === ref.capturedAt &&
    entry.expiresAt === ref.expiresAt
  );
}

export async function readVideoScreenshotCacheIndexState(
  area: Pick<StorageAreaService, 'get'>,
  options: VideoScreenshotCacheContentValidationOptions = {}
): Promise<VideoScreenshotCacheIndexState> {
  const raw = await area.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY);
  if (raw === undefined) {
    return { entries: [], dirty: false };
  }
  const parsed = normalizeVideoScreenshotCacheIndex(raw, options);
  if (parsed === null) {
    return { entries: [], dirty: true };
  }
  return { entries: parsed.entries, dirty: false };
}

export async function persistVideoScreenshotCacheIndex(
  area: Pick<StorageAreaService, 'set' | 'remove'>,
  entries: VideoScreenshotCacheIndexEntry[],
  removedKeys: readonly string[],
  dirty: boolean
): Promise<void> {
  const uniqueRemovedKeys = Array.from(new Set(removedKeys));
  if (uniqueRemovedKeys.length > 0) {
    await area.remove(uniqueRemovedKeys);
  }
  if (dirty || uniqueRemovedKeys.length > 0) {
    await area.set(VIDEO_SCREENSHOT_CACHE_INDEX_KEY, createVideoScreenshotCacheIndex(entries));
  }
}
