import {
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME
} from '../../content/video/videoScreenshotCacheStore';
import type {
  VideoScreenshotCacheIndexedDbDatabase,
  VideoScreenshotCacheIndexedDbFactory,
  VideoScreenshotCacheIndexedDbObjectStore,
  VideoScreenshotCacheIndexedDbRequest,
  VideoScreenshotCacheIndexedDbTransaction
} from './videoScreenshotCacheIndexedDbStoreTypes';

export async function withVideoScreenshotCacheStore<T>(
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
      // The transaction may already be complete.
    }
    await transactionDone.catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
}

export function videoScreenshotCacheRequest<T>(
  request: VideoScreenshotCacheIndexedDbRequest<T>,
  errorMessage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(errorMessage));
  });
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
      if (db) resolve(db);
      else reject(new Error('Video screenshot cache database opened without a database.'));
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
