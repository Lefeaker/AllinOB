import { isObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import {
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME,
  normalizeVideoScreenshotCacheBlobEntry,
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobMetadata,
  type VideoScreenshotCacheBlobStore,
  type VideoScreenshotCacheBlobStorePruneResult
} from '../../content/video/videoScreenshotCacheStore';
import {
  isVideoScreenshotCachePageKey,
  normalizeVideoScreenshotCacheMaxContentBytes
} from '../../content/video/videoScreenshotCacheTypes';
import type {
  VideoScreenshotCacheIndexedDbDatabase,
  VideoScreenshotCacheIndexedDbFactory,
  VideoScreenshotCacheIndexedDbObjectStore,
  VideoScreenshotCacheIndexedDbRecord,
  VideoScreenshotCacheIndexedDbRequest,
  VideoScreenshotCacheIndexedDbTransaction
} from './videoScreenshotCacheIndexedDbStoreTypes';

export interface VideoScreenshotCacheIndexedDbStoreOptions {
  indexedDb?: VideoScreenshotCacheIndexedDbFactory | undefined;
  maxContentBytes?: number | undefined;
  now?: (() => number) | undefined;
}

export function createVideoScreenshotCacheIndexedDbStore(
  options: VideoScreenshotCacheIndexedDbStoreOptions = {}
): VideoScreenshotCacheBlobStore {
  const indexedDb = options.indexedDb;
  const now = options.now ?? (() => Date.now());
  const maxContentBytes = normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes);
  const validationOptions = { maxContentBytes };
  const readAllEntries = (store: VideoScreenshotCacheIndexedDbObjectStore) =>
    requestToRecordArray(store, 'Failed to read video screenshot cache blob rows.').then(
      (rawValues) => collectEntries(rawValues, validationOptions)
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
        return null;
      }
      return withStore('readwrite', indexedDb, async (store) => {
        const rawValue = await requestToPromise(
          store.get(key),
          'Failed to read video screenshot cache blob entry.'
        );
        if (!isObjectRecord(rawValue)) {
          return null;
        }
        const entry = normalizeVideoScreenshotCacheBlobEntry(rawValue, validationOptions);
        if (entry !== null) {
          const touched = {
            ...entry,
            lastAccessedAt: Math.max(now(), entry.lastAccessedAt ?? entry.updatedAt)
          } satisfies VideoScreenshotCacheBlobEntry;
          await requestToPromise(
            store.put(touched),
            'Failed to update video screenshot cache blob access time.'
          );
          return touched;
        }
        await deleteKeys(store, [key]);
        return null;
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

    async deleteAll() {
      return withStore('readwrite', indexedDb, async (store) => {
        const rawValues = await requestToRecordArray(
          store,
          'Failed to enumerate video screenshot cache blob rows for deletion.'
        );
        const keys = sanitizeKeys(
          rawValues.map((rawValue) => extractKey(rawValue)).filter(isNonEmptyString)
        );
        await deleteKeys(store, keys);
        return keys.length;
      });
    },

    async listByPageKey(pageKey) {
      if (!isVideoScreenshotCachePageKey(pageKey)) {
        return [];
      }
      return withStore('readwrite', indexedDb, async (store) => {
        const rawValues = await requestToPromise(
          store.index(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME).getAll(pageKey),
          'Failed to read video screenshot cache page blob entries.'
        );
        const { entries, invalidKeys } = collectEntries(rawValues, validationOptions);
        await deleteKeys(store, invalidKeys);
        return sortVideoScreenshotCacheBlobMetadataNewestFirst(entries);
      });
    },

    async listAllMetadata() {
      return withStore('readwrite', indexedDb, async (store) => {
        const { entries, invalidKeys } = await readAllEntries(store);
        await deleteKeys(store, invalidKeys);
        return sortVideoScreenshotCacheBlobMetadataNewestFirst(entries.map(toMetadata));
      });
    },

    async prune(pruneOptions) {
      return withStore('readwrite', indexedDb, async (store) => {
        const { entries, invalidKeys } = await readAllEntries(store);
        const result = pruneVideoScreenshotCacheBlobMetadataEntries(
          entries.map(toMetadata),
          pruneOptions
        );
        const removedKeys = sanitizeKeys([...invalidKeys, ...result.removedKeys]);
        await deleteKeys(store, removedKeys);
        return {
          entries: result.entries,
          removedKeys,
          dirty: result.dirty || invalidKeys.length > 0
        } satisfies VideoScreenshotCacheBlobStorePruneResult;
      });
    }
  };
}

async function withStore<T>(
  mode: IDBTransactionMode,
  indexedDb: VideoScreenshotCacheIndexedDbFactory | undefined,
  operation: (store: VideoScreenshotCacheIndexedDbObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDatabase(indexedDb);
  const transaction = db.transaction(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME, mode);
  const store = transaction.objectStore(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME);
  const transactionDone = waitForTransaction(transaction, mode);
  try {
    const result = await operation(store);
    await transactionDone;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // Ignore abort races when the transaction has already completed.
    }
    await transactionDone.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

function openDatabase(
  indexedDb: VideoScreenshotCacheIndexedDbFactory | undefined
): Promise<VideoScreenshotCacheIndexedDbDatabase> {
  return new Promise((resolve, reject) => {
    const factory = indexedDb ?? globalThis.indexedDB;
    if (!factory || typeof factory.open !== 'function') {
      reject(new Error('IndexedDB is not available for video screenshot cache storage.'));
      return;
    }

    const request = factory.open(
      VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
      VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db) {
        reject(new Error('Video screenshot cache database upgrade opened without a database.'));
        return;
      }
      const store = db.createObjectStore(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME, {
        keyPath: 'key'
      });
      store.createIndex(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME, 'pageKey');
      store.createIndex(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME, 'expiresAt');
      store.createIndex(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME, 'updatedAt');
      store.createIndex(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME, [
        'pageKey',
        'captureId'
      ]);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open video screenshot cache database.'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db) {
        reject(new Error('Video screenshot cache database opened without a database.'));
        return;
      }
      resolve(db);
    };
  });
}

function waitForTransaction(
  transaction: VideoScreenshotCacheIndexedDbTransaction,
  mode: IDBTransactionMode
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(`Video screenshot cache ${mode} transaction failed.`));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(`Video screenshot cache ${mode} transaction aborted.`));
  });
}

function requestToPromise<T>(
  request: VideoScreenshotCacheIndexedDbRequest<T>,
  errorMessage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(errorMessage));
  });
}

async function requestToRecordArray(
  store: VideoScreenshotCacheIndexedDbObjectStore,
  errorMessage: string
): Promise<VideoScreenshotCacheIndexedDbRecord[]> {
  const rawValues = await requestToPromise(store.getAll(), errorMessage);
  return Array.isArray(rawValues) ? rawValues.filter(isObjectRecord) : [];
}

function collectEntries(
  rawValues: readonly VideoScreenshotCacheIndexedDbRecord[],
  options: { maxContentBytes: number }
): {
  entries: VideoScreenshotCacheBlobEntry[];
  invalidKeys: string[];
} {
  const entries: VideoScreenshotCacheBlobEntry[] = [];
  const invalidKeys: string[] = [];
  for (const rawValue of rawValues) {
    const entry = normalizeVideoScreenshotCacheBlobEntry(rawValue, options);
    if (entry !== null) {
      entries.push(entry);
      continue;
    }
    const rawKey = extractKey(rawValue);
    if (rawKey !== null) {
      invalidKeys.push(rawKey);
    }
  }
  return { entries, invalidKeys: sanitizeKeys(invalidKeys) };
}

function extractKey(value: RuntimePropertyValue): string | null {
  return isObjectRecord(value) && isNonEmptyString(value.key) ? value.key : null;
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
