import type { ObjectRecord, RuntimePropertyValue } from '../../shared/guards/object';

export type VideoScreenshotCacheIndexedDbRecord = ObjectRecord;

export type VideoScreenshotCacheIndexedDbRequest<T> = {
  result: T;
  error: DOMException | Error | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type VideoScreenshotCacheIndexedDbOpenRequest = VideoScreenshotCacheIndexedDbRequest<
  VideoScreenshotCacheIndexedDbDatabase | undefined
> & {
  onupgradeneeded: ((event: Event) => void) | null;
};

export type VideoScreenshotCacheIndexedDbIndex = {
  getAll(
    query?: IDBValidKey | IDBKeyRange | null
  ): VideoScreenshotCacheIndexedDbRequest<VideoScreenshotCacheIndexedDbRecord[]>;
};

export type VideoScreenshotCacheIndexedDbObjectStore = {
  put(entry: RuntimePropertyValue): VideoScreenshotCacheIndexedDbRequest<RuntimePropertyValue>;
  get(key: string): VideoScreenshotCacheIndexedDbRequest<RuntimePropertyValue>;
  delete(key: string): VideoScreenshotCacheIndexedDbRequest<undefined>;
  getAll(): VideoScreenshotCacheIndexedDbRequest<VideoScreenshotCacheIndexedDbRecord[]>;
  index(name: string): VideoScreenshotCacheIndexedDbIndex;
  createIndex(name: string, keyPath: string | string[]): VideoScreenshotCacheIndexedDbIndex;
};

export type VideoScreenshotCacheIndexedDbTransaction = {
  error: DOMException | Error | null;
  oncomplete: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
  objectStore(name: string): VideoScreenshotCacheIndexedDbObjectStore;
  abort(): void;
};

export type VideoScreenshotCacheIndexedDbDatabase = {
  createObjectStore(
    name: string,
    options?: {
      keyPath?: string | string[] | null;
    }
  ): VideoScreenshotCacheIndexedDbObjectStore;
  transaction(name: string, mode: IDBTransactionMode): VideoScreenshotCacheIndexedDbTransaction;
  close(): void;
};

export type VideoScreenshotCacheIndexedDbFactory = {
  open(name: string, version?: number): VideoScreenshotCacheIndexedDbOpenRequest;
};
