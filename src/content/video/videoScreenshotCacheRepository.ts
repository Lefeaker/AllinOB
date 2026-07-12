import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  loadLegacyVideoScreenshotCacheEntry,
  pruneLegacyVideoScreenshotCache,
  removeLegacyVideoScreenshotCacheKeys,
  saveLegacyVideoScreenshotCacheEntry
} from './videoScreenshotCacheLegacyRepository';
import {
  hasVideoScreenshotBlobContent,
  resolveVideoScreenshotCacheRepositoryOptions,
  toVideoCaptureScreenshot,
  tryBuildVideoScreenshotCacheEntryMetadata
} from './videoScreenshotCacheRepositorySupport';
import { createStructuredVideoScreenshotCacheRepository } from './videoScreenshotCacheStructuredRepository';
import type {
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheRepositoryDependencies,
  VideoScreenshotCacheRepositoryOptions
} from './videoScreenshotCacheRepositoryTypes';
import {
  isVideoScreenshotCachePageKey,
  normalizeVideoScreenshotCacheRef,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';

export type {
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheRepositoryDependencies,
  VideoScreenshotCacheRepositoryOptions,
  VideoScreenshotCacheSaveInput,
  VideoScreenshotCacheSaveResult
} from './videoScreenshotCacheRepositoryTypes';

function isStorageAreaService(
  value: StorageAreaService | VideoScreenshotCacheRepositoryDependencies
): value is StorageAreaService {
  return typeof (value as StorageAreaService).get === 'function';
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
  const resolved = resolveVideoScreenshotCacheRepositoryOptions(options);
  if (!isStorageAreaService(target)) {
    return createStructuredVideoScreenshotCacheRepository(target, resolved);
  }
  const area = target;
  const prune = (applyLimits: boolean) =>
    pruneLegacyVideoScreenshotCache(area, resolved, applyLimits);
  return {
    async save({ pageKey, captureId, screenshot }) {
      if (!isVideoScreenshotCachePageKey(pageKey)) {
        return { status: 'skipped', reason: 'invalid-metadata', field: 'pageKey' };
      }
      if (!hasVideoScreenshotBlobContent(screenshot)) {
        return { status: 'skipped', reason: 'missing-blob-content' };
      }
      const operationTime = resolved.now();
      return saveLegacyVideoScreenshotCacheEntry(
        area,
        { pageKey, captureId, screenshot },
        resolved,
        operationTime,
        (byteLength) =>
          tryBuildVideoScreenshotCacheEntryMetadata(
            pageKey,
            captureId,
            screenshot,
            byteLength,
            resolved,
            operationTime
          )
      );
    },
    async load(ref) {
      const normalized = normalizeVideoScreenshotCacheRef(ref, resolved);
      if (!normalized) return null;
      const loaded = await loadLegacyVideoScreenshotCacheEntry(
        area,
        normalized,
        resolved.now(),
        resolved
      );
      return loaded ? toVideoCaptureScreenshot(loaded.entry, loaded.blob) : null;
    },
    async remove(ref) {
      const normalized = normalizeVideoScreenshotCacheRef(ref, resolved);
      if (normalized) await removeLegacyVideoScreenshotCacheKeys(area, [normalized.key], resolved);
    },
    async removeMany(refs) {
      const keys = refs
        .map((ref) => normalizeVideoScreenshotCacheRef(ref, resolved))
        .filter((ref): ref is VideoScreenshotCacheRef => ref !== null)
        .map((ref) => ref.key);
      if (keys.length > 0) await removeLegacyVideoScreenshotCacheKeys(area, keys, resolved);
    },
    pruneExpired: () => prune(false),
    pruneToLimits: () => prune(true)
  };
}
