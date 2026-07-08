import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoCaptureScreenshot } from './types';
import {
  buildVideoScreenshotCacheRef,
  matchesVideoScreenshotCacheRef,
  requireVideoScreenshotCacheIndexEntry
} from './videoScreenshotCacheIndex';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobStore
} from './videoScreenshotCacheStore';
import {
  loadLegacyVideoScreenshotCacheEntry,
  pruneLegacyVideoScreenshotCache,
  removeLegacyVideoScreenshotCacheKeys,
  saveLegacyVideoScreenshotCacheEntry
} from './videoScreenshotCacheLegacyRepository';
import {
  VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_TTL_MS,
  createVideoScreenshotCacheStorageKey,
  isVideoScreenshotCachePageKey,
  normalizeVideoScreenshotCacheMaxContentBytes,
  normalizeVideoScreenshotCacheRef,
  type VideoScreenshotCacheIndexEntry,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';

const VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED = 'VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED';
const VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED = 'VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED';

export interface VideoScreenshotCacheRepositoryOptions {
  ttlMs?: number;
  maxGlobalEntries?: number;
  maxPageEntries?: number;
  maxContentBytes?: number;
  now?: () => number;
}

export interface VideoScreenshotCacheRepositoryDependencies {
  blobStore: VideoScreenshotCacheBlobStore;
  legacyArea?: StorageAreaService;
}

export interface VideoScreenshotCacheSaveInput {
  pageKey: string;
  captureId: string;
  screenshot: VideoCaptureScreenshot;
}

export type VideoScreenshotCacheSaveResult =
  | { status: 'saved'; ref: VideoScreenshotCacheRef }
  | { status: 'skipped'; reason: 'missing-blob-content' }
  | { status: 'skipped'; reason: 'invalid-metadata'; field: 'pageKey' }
  | {
      status: 'skipped';
      reason: 'content-too-large';
      byteLength: number;
      maxContentBytes: number;
    }
  | { status: 'skipped'; reason: 'serialize-failed'; error: string };

export interface VideoScreenshotCacheRepository {
  save(input: VideoScreenshotCacheSaveInput): Promise<VideoScreenshotCacheSaveResult>;
  load(ref: VideoScreenshotCacheRef): Promise<VideoCaptureScreenshot | null>;
  remove(ref: VideoScreenshotCacheRef): Promise<void>;
  removeMany(refs: readonly VideoScreenshotCacheRef[]): Promise<void>;
  pruneExpired(): Promise<void>;
  pruneToLimits(): Promise<void>;
}

interface ResolvedOptions {
  ttlMs: number;
  maxGlobalEntries: number;
  maxPageEntries: number;
  maxContentBytes: number;
  now: () => number;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveOptions(options: VideoScreenshotCacheRepositoryOptions): ResolvedOptions {
  return {
    ttlMs: normalizePositiveInteger(options.ttlMs, VIDEO_SCREENSHOT_CACHE_TTL_MS),
    maxGlobalEntries: normalizePositiveInteger(
      options.maxGlobalEntries,
      VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES
    ),
    maxPageEntries: normalizePositiveInteger(
      options.maxPageEntries,
      VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES
    ),
    maxContentBytes: normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes),
    now: options.now ?? (() => Date.now())
  };
}

function hasBlobContent(
  screenshot: VideoCaptureScreenshot
): screenshot is VideoCaptureScreenshot & {
  content: NonNullable<VideoCaptureScreenshot['content']>;
} {
  return screenshot.content?.kind === 'blob';
}

function isStorageAreaService(
  value: StorageAreaService | VideoScreenshotCacheRepositoryDependencies
): value is StorageAreaService {
  return typeof (value as StorageAreaService).get === 'function';
}

function createMutationSerializer() {
  let chain = Promise.resolve();
  return async function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = chain.then(operation, operation);
    chain = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  };
}

function buildEntryMetadata(
  pageKey: string,
  captureId: string,
  screenshot: Pick<VideoCaptureScreenshot, 'id' | 'fileName' | 'mimeType' | 'capturedAt'>,
  byteLength: number,
  options: ResolvedOptions,
  operationTime: number
): VideoScreenshotCacheIndexEntry {
  const writeTime = Math.max(operationTime, screenshot.capturedAt);
  return requireVideoScreenshotCacheIndexEntry(
    {
      schemaVersion: 1,
      key: createVideoScreenshotCacheStorageKey({
        pageKey,
        captureId,
        screenshotId: screenshot.id
      }),
      pageKey,
      captureId,
      id: screenshot.id,
      fileName: screenshot.fileName,
      mimeType: screenshot.mimeType,
      byteLength,
      capturedAt: screenshot.capturedAt,
      createdAt: writeTime,
      updatedAt: writeTime,
      expiresAt: writeTime + options.ttlMs
    },
    options
  );
}

function tryBuildEntryMetadata(
  pageKey: string,
  captureId: string,
  screenshot: Pick<VideoCaptureScreenshot, 'id' | 'fileName' | 'mimeType' | 'capturedAt'>,
  byteLength: number,
  options: ResolvedOptions,
  operationTime: number
): VideoScreenshotCacheIndexEntry | null {
  try {
    return buildEntryMetadata(pageKey, captureId, screenshot, byteLength, options, operationTime);
  } catch {
    return null;
  }
}

function toScreenshot(
  entry: Pick<
    VideoScreenshotCacheIndexEntry,
    'id' | 'fileName' | 'mimeType' | 'capturedAt' | 'byteLength'
  >,
  blob: Blob
): VideoCaptureScreenshot {
  return {
    id: entry.id,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    capturedAt: entry.capturedAt,
    content: {
      kind: 'blob',
      blob,
      byteLength: entry.byteLength
    }
  };
}

export function createVideoScreenshotCacheRepository(
  area: StorageAreaService,
  options?: VideoScreenshotCacheRepositoryOptions
): VideoScreenshotCacheRepository;
export function createVideoScreenshotCacheRepository(
  dependencies: VideoScreenshotCacheRepositoryDependencies,
  options?: VideoScreenshotCacheRepositoryOptions
): VideoScreenshotCacheRepository;
export function createVideoScreenshotCacheRepository(
  target: StorageAreaService | VideoScreenshotCacheRepositoryDependencies,
  options: VideoScreenshotCacheRepositoryOptions = {}
): VideoScreenshotCacheRepository {
  const resolved = resolveOptions(options);
  const legacyMode = isStorageAreaService(target);
  const legacyArea = legacyMode ? target : target.legacyArea;
  const legacyStore = legacyMode ? target : undefined;
  const blobStore = legacyMode ? undefined : target.blobStore;
  const runBlobMutation = legacyMode ? undefined : createMutationSerializer();

  async function prune(applyLimits: boolean): Promise<void> {
    if (blobStore && runBlobMutation) {
      await runBlobMutation(async () => {
        const result = await blobStore.prune({
          now: resolved.now(),
          maxGlobalEntries: resolved.maxGlobalEntries,
          maxPageEntries: resolved.maxPageEntries,
          maxContentBytes: resolved.maxContentBytes,
          applyLimits
        });
        await removeLegacyVideoScreenshotCacheKeys(legacyArea, result.removedKeys, resolved);
      });
      return;
    }
    if (!legacyStore) {
      return;
    }
    await pruneLegacyVideoScreenshotCache(legacyStore, resolved, applyLimits);
  }

  return {
    async save(input) {
      const { pageKey, captureId, screenshot } = input;
      if (!isVideoScreenshotCachePageKey(pageKey)) {
        return { status: 'skipped', reason: 'invalid-metadata', field: 'pageKey' };
      }
      if (!hasBlobContent(screenshot)) {
        return { status: 'skipped', reason: 'missing-blob-content' };
      }

      const operationTime = resolved.now();
      const buildMetadata = (byteLength: number) =>
        tryBuildEntryMetadata(pageKey, captureId, screenshot, byteLength, resolved, operationTime);
      if (legacyMode) {
        if (!legacyStore) {
          return {
            status: 'skipped',
            reason: 'serialize-failed',
            error: VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED
          };
        }
        return saveLegacyVideoScreenshotCacheEntry(
          legacyStore,
          {
            pageKey,
            captureId,
            screenshot
          },
          resolved,
          operationTime,
          buildMetadata
        );
      }

      const byteLength = screenshot.content.blob.size;
      if (byteLength > resolved.maxContentBytes || !blobStore || !runBlobMutation) {
        return {
          status: 'skipped',
          reason: 'content-too-large',
          byteLength,
          maxContentBytes: resolved.maxContentBytes
        };
      }

      const entry = buildMetadata(byteLength);
      if (entry === null) {
        return {
          status: 'skipped',
          reason: 'serialize-failed',
          error: VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED
        };
      }
      const ref = buildVideoScreenshotCacheRef(entry, resolved);

      await runBlobMutation(async () => {
        const replacedKeys = (await blobStore.listByPageKey(entry.pageKey))
          .filter(
            (currentEntry) =>
              currentEntry.key !== entry.key && currentEntry.captureId === entry.captureId
          )
          .map((currentEntry) => currentEntry.key);

        await blobStore.put({
          ...entry,
          blob: screenshot.content.blob
        } satisfies VideoScreenshotCacheBlobEntry);

        if (replacedKeys.length > 0) {
          await blobStore.deleteMany(replacedKeys);
        }

        const pruneResult = await blobStore.prune({
          now: operationTime,
          maxGlobalEntries: resolved.maxGlobalEntries,
          maxPageEntries: resolved.maxPageEntries,
          maxContentBytes: resolved.maxContentBytes,
          applyLimits: true
        });

        await removeLegacyVideoScreenshotCacheKeys(
          legacyArea,
          [...replacedKeys, ...pruneResult.removedKeys],
          resolved
        );
      });

      return { status: 'saved', ref };
    },

    async load(ref) {
      const normalizedRef = normalizeVideoScreenshotCacheRef(ref, resolved);
      if (normalizedRef === null) {
        return null;
      }

      const operationTime = resolved.now();
      if (blobStore) {
        const blobEntry = await blobStore.get(normalizedRef.key);
        if (
          blobEntry &&
          blobEntry.expiresAt > operationTime &&
          matchesVideoScreenshotCacheRef(blobEntry, normalizedRef)
        ) {
          return toScreenshot(blobEntry, blobEntry.blob);
        }
        if (blobEntry) {
          await blobStore.delete(normalizedRef.key);
        }
      }

      const legacyLoaded = await loadLegacyVideoScreenshotCacheEntry(
        legacyArea,
        normalizedRef,
        operationTime,
        resolved
      );
      if (!legacyLoaded) {
        return null;
      }

      if (blobStore) {
        try {
          await blobStore.put({
            ...legacyLoaded.entry,
            blob: legacyLoaded.blob
          } satisfies VideoScreenshotCacheBlobEntry);
          await removeLegacyVideoScreenshotCacheKeys(legacyArea, [normalizedRef.key], resolved);
        } catch {
          // Best-effort migration. A valid legacy load still returns the screenshot.
        }
      }

      return toScreenshot(legacyLoaded.entry, legacyLoaded.blob);
    },

    async remove(ref) {
      const normalizedRef = normalizeVideoScreenshotCacheRef(ref, resolved);
      if (normalizedRef === null) {
        return;
      }

      if (blobStore && runBlobMutation) {
        await runBlobMutation(async () => {
          await blobStore.delete(normalizedRef.key);
          await removeLegacyVideoScreenshotCacheKeys(legacyArea, [normalizedRef.key], resolved);
        });
        return;
      }

      await removeLegacyVideoScreenshotCacheKeys(legacyStore, [normalizedRef.key], resolved);
    },

    async removeMany(refs) {
      const keys = refs
        .map((ref) => normalizeVideoScreenshotCacheRef(ref, resolved))
        .filter((ref): ref is VideoScreenshotCacheRef => ref !== null)
        .map((ref) => ref.key);
      if (keys.length === 0) {
        return;
      }

      if (blobStore && runBlobMutation) {
        await runBlobMutation(async () => {
          await blobStore.deleteMany(keys);
          await removeLegacyVideoScreenshotCacheKeys(legacyArea, keys, resolved);
        });
        return;
      }

      await removeLegacyVideoScreenshotCacheKeys(legacyStore, keys, resolved);
    },

    async pruneExpired() {
      await prune(false);
    },

    async pruneToLimits() {
      await prune(true);
    }
  };
}
