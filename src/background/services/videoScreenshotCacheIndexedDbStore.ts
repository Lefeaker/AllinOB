import type { RuntimePropertyValue } from '../../shared/guards/object';
import {
  normalizeVideoScreenshotCacheBlobEntry,
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobMetadata,
  type VideoScreenshotCacheBlobMaintenanceStore,
  type VideoScreenshotCacheBlobStorePruneResult
} from '../../content/video/videoScreenshotCacheStore';
import {
  isVideoScreenshotCachePageKey,
  normalizeVideoScreenshotCacheMaxContentBytes
} from '../../content/video/videoScreenshotCacheTypes';
import type {
  VideoScreenshotCacheIndexedDbFactory,
  VideoScreenshotCacheIndexedDbObjectStore,
  VideoScreenshotCacheIndexedDbRecord
} from './videoScreenshotCacheIndexedDbStoreTypes';
import {
  videoScreenshotCacheRequest as requestToPromise,
  withVideoScreenshotCacheStore as withStore
} from './videoScreenshotCacheIndexedDbAccess';

export interface VideoScreenshotCacheIndexedDbStoreOptions {
  indexedDb?: VideoScreenshotCacheIndexedDbFactory | undefined;
  maxContentBytes?: number | undefined;
  now?: (() => number) | undefined;
}

export function createVideoScreenshotCacheIndexedDbStore(
  options: VideoScreenshotCacheIndexedDbStoreOptions = {}
): VideoScreenshotCacheBlobMaintenanceStore {
  const indexedDb = options.indexedDb;
  const now = options.now ?? (() => Date.now());
  const maxContentBytes = normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes);
  const validationOptions = { maxContentBytes };
  const readAllEntries = (store: VideoScreenshotCacheIndexedDbObjectStore) =>
    requestToRecordRows(store, 'Failed to read video screenshot cache blob rows.').then((rows) =>
      collectEntries(rows, validationOptions)
    );

  return {
    async put(entry) {
      const normalizedEntry = normalizeVideoScreenshotCacheBlobEntry(entry, validationOptions);
      if (normalizedEntry === null) {
        throw new Error('Video screenshot cache blob store rejected an invalid blob entry.');
      }
      await withStore('readwrite', indexedDb, (store) =>
        requestToPromise(
          store.put(normalizedEntry),
          'Failed to write video screenshot cache blob entry.'
        )
      );
    },

    async get(key) {
      if (!isNonEmptyString(key)) {
        return { status: 'missing' };
      }
      return withStore('readwrite', indexedDb, async (store) => {
        const rawValue = await requestToPromise(
          store.get(key),
          'Failed to read video screenshot cache blob entry.'
        );
        if (rawValue === undefined) return { status: 'missing' };
        const entry = normalizeVideoScreenshotCacheBlobEntry(rawValue, validationOptions);
        if (entry !== null && entry.key === key) {
          const touched = {
            ...entry,
            lastAccessedAt: Math.max(now(), entry.lastAccessedAt ?? entry.updatedAt)
          } satisfies VideoScreenshotCacheBlobEntry;
          await requestToPromise(
            store.put(touched),
            'Failed to update video screenshot cache blob access time.'
          );
          return { status: 'found', entry: touched };
        }
        return { status: 'invalid', key };
      });
    },

    async peek(key) {
      if (!isNonEmptyString(key)) return { status: 'missing' };
      return withStore('readonly', indexedDb, async (store) => {
        const rawValue = await requestToPromise(
          store.get(key),
          'Failed to inspect video screenshot cache blob entry.'
        );
        if (rawValue === undefined) return { status: 'missing' };
        const entry = normalizeVideoScreenshotCacheBlobEntry(rawValue, validationOptions);
        return entry !== null && entry.key === key
          ? { status: 'found', entry }
          : { status: 'invalid', key };
      });
    },

    async delete(key) {
      if (isNonEmptyString(key)) {
        await withStore('readwrite', indexedDb, (store) => deleteKeys(store, [key]));
      }
    },

    async deleteMany(keys) {
      const uniqueKeys = sanitizeKeys(keys);
      if (uniqueKeys.length > 0) {
        await withStore('readwrite', indexedDb, (store) => deleteKeys(store, uniqueKeys));
      }
    },

    async countAll() {
      return withStore('readonly', indexedDb, (store) =>
        requestToPromise(
          store.count(),
          'Failed to count video screenshot cache blob rows for deletion.'
        )
      );
    },

    async deleteAll() {
      return withStore('readwrite', indexedDb, async (store) => {
        const count = await requestToPromise(
          store.count(),
          'Failed to count video screenshot cache blob rows for deletion.'
        );
        await requestToPromise(store.clear(), 'Failed to clear video screenshot cache blob rows.');
        return count;
      });
    },

    async listByPageKey(pageKey) {
      if (!isVideoScreenshotCachePageKey(pageKey)) {
        return { entries: [], invalidKeys: [] };
      }
      return withStore('readonly', indexedDb, async (store) => {
        const { entries, invalidKeys } = await readAllEntries(store);
        return {
          entries: sortVideoScreenshotCacheBlobMetadataNewestFirst(
            entries.filter((entry) => entry.pageKey === pageKey)
          ),
          invalidKeys
        };
      });
    },

    async listAllMetadata() {
      return withStore('readonly', indexedDb, async (store) => {
        const { entries, invalidKeys } = await readAllEntries(store);
        return {
          entries: sortVideoScreenshotCacheBlobMetadataNewestFirst(entries.map(toMetadata)),
          invalidKeys
        };
      });
    },

    async prune(pruneOptions) {
      return withStore('readonly', indexedDb, async (store) => {
        const { entries, invalidKeys } = await readAllEntries(store);
        const result = pruneVideoScreenshotCacheBlobMetadataEntries(
          entries.map(toMetadata),
          pruneOptions
        );
        return {
          entries: result.entries,
          candidateKeys: sanitizeKeys(result.removedKeys),
          invalidKeys,
          dirty: result.dirty || invalidKeys.length > 0
        } satisfies VideoScreenshotCacheBlobStorePruneResult;
      });
    }
  };
}

async function requestToRecordRows(
  store: VideoScreenshotCacheIndexedDbObjectStore,
  errorMessage: string
): Promise<Array<{ primaryKey: string; value: VideoScreenshotCacheIndexedDbRecord }>> {
  const [rawValues, rawKeys] = await Promise.all([
    requestToPromise(store.getAll(), errorMessage),
    requestToPromise(store.getAllKeys(), errorMessage)
  ]);
  if (!Array.isArray(rawValues) || !Array.isArray(rawKeys) || rawValues.length !== rawKeys.length) {
    throw new Error(errorMessage);
  }
  return rawValues.flatMap((value, index) => {
    const primaryKey = rawKeys[index];
    return typeof primaryKey === 'string' && primaryKey.length > 0 ? [{ primaryKey, value }] : [];
  });
}

function collectEntries(
  rows: ReadonlyArray<{ primaryKey: string; value: VideoScreenshotCacheIndexedDbRecord }>,
  options: { maxContentBytes: number }
): {
  entries: VideoScreenshotCacheBlobEntry[];
  invalidKeys: string[];
} {
  const entries: VideoScreenshotCacheBlobEntry[] = [];
  const invalidKeys: string[] = [];
  for (const { primaryKey, value } of rows) {
    const entry = normalizeVideoScreenshotCacheBlobEntry(value, options);
    if (entry !== null && entry.key === primaryKey) {
      entries.push(entry);
      continue;
    }
    invalidKeys.push(primaryKey);
  }
  return { entries, invalidKeys: sanitizeKeys(invalidKeys).sort() };
}

function toMetadata(entry: VideoScreenshotCacheBlobEntry): VideoScreenshotCacheBlobMetadata {
  const { blob, ...metadata } = entry;
  void blob;
  return metadata;
}

async function deleteKeys(
  store: VideoScreenshotCacheIndexedDbObjectStore,
  keys: readonly string[]
): Promise<void> {
  for (const key of sanitizeKeys(keys)) {
    await requestToPromise(
      store.delete(key),
      `Failed to delete video screenshot cache blob entry: ${key}`
    );
  }
}

function sanitizeKeys(keys: readonly string[]): string[] {
  return Array.from(new Set(keys.filter(isNonEmptyString)));
}

function isNonEmptyString(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0;
}
