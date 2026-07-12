import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  buildVideoScreenshotCacheRef,
  matchesVideoScreenshotCacheRef
} from './videoScreenshotCacheIndex';
import type { VideoScreenshotCacheBlobEntry } from './videoScreenshotCacheStore';
import {
  loadLegacyVideoScreenshotCacheEntry,
  removeLegacyVideoScreenshotCacheKeys
} from './videoScreenshotCacheLegacyRepository';
import {
  hasVideoScreenshotBlobContent,
  toVideoCaptureScreenshot,
  tryBuildVideoScreenshotCacheEntryMetadata
} from './videoScreenshotCacheRepositorySupport';
import type {
  ResolvedVideoScreenshotCacheRepositoryOptions,
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheRepositoryDependencies
} from './videoScreenshotCacheRepositoryTypes';
import {
  isVideoScreenshotCachePageKey,
  normalizeVideoScreenshotCacheRef,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';

const VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED = 'VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED';

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

async function removeVerifiedMigratedLegacyDuplicate(
  area: StorageAreaService | undefined,
  dependencies: VideoScreenshotCacheRepositoryDependencies,
  ref: VideoScreenshotCacheRef,
  options: Pick<ResolvedVideoScreenshotCacheRepositoryOptions, 'maxContentBytes'>
): Promise<void> {
  if (!area) return;
  const verification = await dependencies.blobStore.get(ref.key);
  if (verification.status !== 'found' || !matchesVideoScreenshotCacheRef(verification.entry, ref))
    return;
  try {
    await removeLegacyVideoScreenshotCacheKeys(area, [ref.key], options);
  } catch {
    // The verified IndexedDB copy remains authoritative; retaining a duplicate is safe.
  }
}

export function createStructuredVideoScreenshotCacheRepository(
  dependencies: VideoScreenshotCacheRepositoryDependencies,
  options: ResolvedVideoScreenshotCacheRepositoryOptions
): VideoScreenshotCacheRepository {
  const runMutation = createMutationSerializer();
  const deleteCandidates = (keys: readonly string[]) => dependencies.deleteCandidates(keys);

  async function prune(applyLimits: boolean): Promise<void> {
    await runMutation(async () => {
      const result = await dependencies.blobStore.prune({
        now: options.now(),
        maxGlobalEntries: options.maxGlobalEntries,
        maxPageEntries: options.maxPageEntries,
        maxContentBytes: options.maxContentBytes,
        applyLimits
      });
      const keys = [...result.candidateKeys, ...result.invalidKeys];
      if (keys.length > 0) await deleteCandidates(keys);
    });
  }

  return {
    async save({ pageKey, captureId, screenshot }) {
      if (!isVideoScreenshotCachePageKey(pageKey)) {
        return { status: 'skipped', reason: 'invalid-metadata', field: 'pageKey' };
      }
      if (!hasVideoScreenshotBlobContent(screenshot)) {
        return { status: 'skipped', reason: 'missing-blob-content' };
      }
      const operationTime = options.now();
      const byteLength = screenshot.content.blob.size;
      if (byteLength > options.maxContentBytes) {
        return {
          status: 'skipped',
          reason: 'content-too-large',
          byteLength,
          maxContentBytes: options.maxContentBytes
        };
      }
      const entry = tryBuildVideoScreenshotCacheEntryMetadata(
        pageKey,
        captureId,
        screenshot,
        byteLength,
        options,
        operationTime
      );
      if (!entry) {
        return {
          status: 'skipped',
          reason: 'serialize-failed',
          error: VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED
        };
      }
      const ref = buildVideoScreenshotCacheRef(entry, options);
      await runMutation(async () => {
        const page = await dependencies.blobStore.listByPageKey(entry.pageKey);
        if (page.invalidKeys.length > 0) await deleteCandidates(page.invalidKeys);
        const replaced = page.entries
          .filter((value) => value.key !== entry.key && value.captureId === entry.captureId)
          .map((value) => value.key);
        await dependencies.blobStore.put({
          ...entry,
          blob: screenshot.content.blob
        } satisfies VideoScreenshotCacheBlobEntry);
        if (replaced.length > 0) await deleteCandidates(replaced);
        const pruned = await dependencies.blobStore.prune({
          now: operationTime,
          maxGlobalEntries: options.maxGlobalEntries,
          maxPageEntries: options.maxPageEntries,
          maxContentBytes: options.maxContentBytes,
          applyLimits: true
        });
        const prunedKeys = [...pruned.candidateKeys, ...pruned.invalidKeys];
        if (prunedKeys.length > 0) await deleteCandidates(prunedKeys);
      });
      return { status: 'saved', ref };
    },
    async load(ref) {
      const normalized = normalizeVideoScreenshotCacheRef(ref, options);
      if (!normalized) return null;
      const operationTime = options.now();
      const blobResult = await dependencies.blobStore.get(normalized.key);
      const blobEntry = blobResult.status === 'found' ? blobResult.entry : null;
      if (
        blobEntry &&
        blobEntry.expiresAt > operationTime &&
        matchesVideoScreenshotCacheRef(blobEntry, normalized)
      )
        return toVideoCaptureScreenshot(blobEntry, blobEntry.blob);
      if (blobResult.status === 'invalid' || blobEntry) {
        await deleteCandidates([normalized.key]);
        return null;
      }
      const legacy = await loadLegacyVideoScreenshotCacheEntry(
        dependencies.legacyArea,
        normalized,
        operationTime,
        options,
        async (keys) => {
          await deleteCandidates(keys);
        }
      );
      if (!legacy) return null;
      try {
        await dependencies.blobStore.put({ ...legacy.entry, blob: legacy.blob });
        await removeVerifiedMigratedLegacyDuplicate(
          dependencies.legacyArea,
          dependencies,
          normalized,
          options
        );
      } catch {
        // Best-effort migration. The valid legacy load remains usable.
      }
      return toVideoCaptureScreenshot(legacy.entry, legacy.blob);
    },
    async remove(ref) {
      const normalized = normalizeVideoScreenshotCacheRef(ref, options);
      if (normalized)
        await runMutation(() => deleteCandidates([normalized.key]).then(() => undefined));
    },
    async removeMany(refs) {
      const keys = refs
        .map((ref) => normalizeVideoScreenshotCacheRef(ref, options))
        .filter((ref): ref is VideoScreenshotCacheRef => ref !== null)
        .map((ref) => ref.key);
      if (keys.length > 0) await runMutation(() => deleteCandidates(keys).then(() => undefined));
    },
    pruneExpired: () => prune(false),
    pruneToLimits: () => prune(true)
  };
}
