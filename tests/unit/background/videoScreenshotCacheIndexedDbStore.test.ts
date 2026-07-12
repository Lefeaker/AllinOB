/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import {
  VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  createVideoScreenshotCacheStorageKey
} from '@content/video/videoScreenshotCacheTypes';
import {
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobMetadata
} from '@content/video/videoScreenshotCacheStore';
import type { ObjectRecord } from '@shared/guards/object';
import { createVideoScreenshotCacheIndexedDbStore } from '../../../src/background/services/videoScreenshotCacheIndexedDbStore';

const BASE_TIME = 2_000_000_000_000;

type RawRecord = ObjectRecord;
type FakeRequest<T> = {
  result: T;
  error: DOMException | Error | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};
type FakeOpenRequest = FakeRequest<FakeDatabase | undefined> & {
  onupgradeneeded: ((event: Event) => void) | null;
};

class FakeIndexedDbFactory {
  private readonly state = new FakeDatabaseState();

  open = (name: string, version?: number) => {
    const request: FakeOpenRequest = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };

    queueMicrotask(() => {
      const shouldUpgrade = !this.state.initialized;
      this.state.initialize(name, version ?? 1);
      request.result = new FakeDatabase(this.state);
      if (shouldUpgrade) {
        request.onupgradeneeded?.(new Event('upgradeneeded'));
      }
      request.onsuccess?.(new Event('success'));
    });

    return request;
  };

  seed(value: RawRecord): void {
    const key = value.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('FakeIndexedDbFactory seed requires a string key.');
    }
    this.state.records.set(key, value);
  }

  seedRaw(key: IDBValidKey, value: RawRecord): void {
    this.state.records.set(key, value);
  }

  rawCount(): number {
    return this.state.records.size;
  }

  getRaw(key: string): RawRecord | undefined {
    return this.state.records.get(key);
  }

  snapshotSchema() {
    return {
      name: this.state.name,
      version: this.state.version,
      objectStore: this.state.objectStoreName,
      keyPath: this.state.keyPath,
      indexes: Array.from(this.state.indexes.entries()).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    };
  }
}

class FakeDatabaseState {
  initialized = false;
  name = '';
  version = 0;
  objectStoreName = '';
  keyPath = '';
  readonly indexes = new Map<string, string | string[]>();
  readonly records = new Map<IDBValidKey, RawRecord>();

  initialize(name: string, version: number): void {
    this.initialized = true;
    this.name = name;
    this.version = version;
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.state.objectStoreName === name
  };

  constructor(private readonly state: FakeDatabaseState) {}

  createObjectStore(
    name: string,
    options?: { keyPath?: string | string[] | null }
  ): FakeObjectStore {
    this.state.objectStoreName = name;
    this.state.keyPath = typeof options?.keyPath === 'string' ? options.keyPath : '';
    return new FakeObjectStore(this.state, null);
  }

  transaction(name: string): FakeTransaction {
    if (name !== this.state.objectStoreName) {
      throw new Error(`Unknown object store: ${name}`);
    }
    return new FakeTransaction(this.state);
  }

  close(): void {}
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;

  private completionScheduled = false;
  private finished = false;

  constructor(private readonly state: FakeDatabaseState) {}

  objectStore(name: string): FakeObjectStore {
    if (name !== this.state.objectStoreName) {
      throw new Error(`Unknown object store: ${name}`);
    }
    return new FakeObjectStore(this.state, this);
  }

  abort(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.error = new DOMException('Transaction aborted.', 'AbortError');
    queueMicrotask(() => this.onabort?.(new Event('abort')));
  }

  touch(): void {
    if (this.completionScheduled || this.finished) {
      return;
    }
    this.completionScheduled = true;
    setTimeout(() => {
      if (this.finished) {
        return;
      }
      this.finished = true;
      this.oncomplete?.(new Event('complete'));
    }, 0);
  }
}

class FakeObjectStore {
  constructor(
    private readonly state: FakeDatabaseState,
    private readonly transaction: FakeTransaction | null
  ) {}

  createIndex(name: string, keyPath: string | string[]): FakeIndex {
    this.state.indexes.set(name, keyPath);
    return new FakeIndex(this.state, keyPath, this.transaction);
  }

  index(name: string): FakeIndex {
    const keyPath = this.state.indexes.get(name);
    if (!keyPath) {
      throw new Error(`Unknown index: ${name}`);
    }
    return new FakeIndex(this.state, keyPath, this.transaction);
  }

  put(value: RawRecord): FakeRequest<undefined> {
    const key = value[this.state.keyPath];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('FakeObjectStore put requires a string key.');
    }
    this.state.records.set(key, value);
    return createRequest(undefined, this.transaction);
  }

  get(key: IDBValidKey): FakeRequest<RawRecord | undefined> {
    return createRequest(this.state.records.get(key), this.transaction);
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    this.state.records.delete(key);
    return createRequest(undefined, this.transaction);
  }

  getAll(): FakeRequest<RawRecord[]> {
    return createRequest(Array.from(this.state.records.values()), this.transaction);
  }

  getAllKeys(): FakeRequest<IDBValidKey[]> {
    return createRequest(Array.from(this.state.records.keys()), this.transaction);
  }

  count(): FakeRequest<number> {
    return createRequest(this.state.records.size, this.transaction);
  }

  clear(): FakeRequest<undefined> {
    this.state.records.clear();
    return createRequest(undefined, this.transaction);
  }
}

class FakeIndex {
  constructor(
    private readonly state: FakeDatabaseState,
    private readonly keyPath: string | string[],
    private readonly transaction: FakeTransaction | null
  ) {}

  getAll(query?: IDBValidKey | IDBKeyRange | null): FakeRequest<RawRecord[]> {
    const filtered = Array.from(this.state.records.values()).filter((value) =>
      matchesQuery(resolveKeyPathValue(value, this.keyPath), query)
    );
    return createRequest(filtered, this.transaction);
  }
}

function createRequest<T>(result: T, transaction: FakeTransaction | null): FakeRequest<T> {
  const request: FakeRequest<T> = {
    result,
    error: null,
    onsuccess: null,
    onerror: null
  };

  queueMicrotask(() => {
    request.onsuccess?.(new Event('success'));
    transaction?.touch();
  });

  return request;
}

function resolveKeyPathValue(value: RawRecord, keyPath: string | string[]): unknown {
  if (Array.isArray(keyPath)) {
    return keyPath.map((part) => value[part]);
  }
  return value[keyPath];
}

function matchesQuery(
  value: unknown,
  query: IDBValidKey | IDBKeyRange | null | undefined
): boolean {
  if (query == null) {
    return true;
  }
  const keyRangeCtor = globalThis.IDBKeyRange;
  if (typeof keyRangeCtor !== 'undefined' && query instanceof keyRangeCtor) {
    throw new Error('FakeIndexedDbFactory does not support IDBKeyRange queries.');
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value) === JSON.stringify(query);
  }
  return value === query;
}

function createMetadata(
  overrides: Partial<VideoScreenshotCacheBlobMetadata> = {}
): VideoScreenshotCacheBlobMetadata {
  const pageKey = overrides.pageKey ?? 'page-a';
  const captureId = overrides.captureId ?? 'capture-a';
  const id = overrides.id ?? 'shot-a';
  const capturedAt = overrides.capturedAt ?? BASE_TIME;
  const createdAt = overrides.createdAt ?? capturedAt + 10;
  const updatedAt = overrides.updatedAt ?? createdAt + 10;
  const expiresAt = overrides.expiresAt ?? updatedAt + 10_000;
  const byteLength = overrides.byteLength ?? 7;

  return {
    schemaVersion: 1,
    key:
      overrides.key ??
      createVideoScreenshotCacheStorageKey({
        pageKey,
        captureId,
        screenshotId: id
      }),
    pageKey,
    captureId,
    id,
    fileName: overrides.fileName ?? `${id}.jpg`,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    byteLength,
    capturedAt,
    createdAt,
    updatedAt,
    expiresAt
  };
}

function createEntry(
  overrides: Partial<VideoScreenshotCacheBlobMetadata> = {},
  content: BlobPart = 'frame-a'
): VideoScreenshotCacheBlobEntry {
  const blob = new Blob([content], { type: 'image/jpeg' });
  return {
    ...createMetadata({ ...overrides, byteLength: blob.size }),
    blob
  };
}

describe('videoScreenshotCacheIndexedDbStore', () => {
  it('stores entries in the expected database schema and lists page entries newest first', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb });
    const older = createEntry(
      {
        pageKey: 'page-a',
        captureId: 'capture-a',
        id: 'shot-a',
        capturedAt: BASE_TIME + 10,
        createdAt: BASE_TIME + 20,
        updatedAt: BASE_TIME + 30
      },
      'older'
    );
    const newer = createEntry(
      {
        pageKey: 'page-a',
        captureId: 'capture-b',
        id: 'shot-b',
        capturedAt: BASE_TIME + 40,
        createdAt: BASE_TIME + 50,
        updatedAt: BASE_TIME + 60
      },
      'newer'
    );
    const otherPage = createEntry(
      {
        pageKey: 'page-b',
        captureId: 'capture-c',
        id: 'shot-c',
        capturedAt: BASE_TIME + 70,
        createdAt: BASE_TIME + 80,
        updatedAt: BASE_TIME + 90
      },
      'other'
    );

    await store.put(older);
    await store.put(newer);
    await store.put(otherPage);

    expect(indexedDb.snapshotSchema()).toEqual({
      name: VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
      version: VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION,
      objectStore: VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME,
      keyPath: 'key',
      indexes: [
        [VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME, 'expiresAt'],
        [VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME, ['pageKey', 'captureId']],
        [VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME, 'pageKey'],
        [VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME, 'updatedAt']
      ]
    });

    const loaded = await store.get(newer.key);
    expect(loaded).toMatchObject({ status: 'found', entry: { key: newer.key } });
    await expect(loaded.status === 'found' ? loaded.entry.blob.text() : null).resolves.toBe(
      'newer'
    );

    const pageEntries = await store.listByPageKey('page-a');
    expect(pageEntries.entries.map((entry) => entry.key)).toEqual([newer.key, older.key]);
    expect(pageEntries.invalidKeys).toEqual([]);

    await store.delete(older.key);
    await store.deleteMany([otherPage.key, otherPage.key]);

    expect((await store.listAllMetadata()).entries.map((entry) => entry.key)).toEqual([newer.key]);
  });

  it('touches valid reads and deletes all entries with idempotent count semantics', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    let now = BASE_TIME + 500;
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb, now: () => now });
    const first = createEntry({ captureId: 'capture-first', id: 'shot-first' }, 'first');
    const second = createEntry({ captureId: 'capture-second', id: 'shot-second' }, 'second');
    await store.put(first);
    await store.put(second);
    indexedDb.seedRaw(7, { key: 7, malformed: true });
    indexedDb.seedRaw('empty-key-row', { key: '', malformed: true });
    indexedDb.seedRaw('missing-key-row', { malformed: true });

    expect(await store.get(first.key)).toMatchObject({
      status: 'found',
      entry: { key: first.key, lastAccessedAt: now }
    });
    now += 100;
    expect(await store.get(first.key)).toMatchObject({
      status: 'found',
      entry: { key: first.key, lastAccessedAt: now }
    });
    await expect(store.deleteAll()).resolves.toBe(5);
    expect(indexedDb.rawCount()).toBe(0);
    await expect(store.deleteAll()).resolves.toBe(0);
    await expect(store.listAllMetadata()).resolves.toEqual({ entries: [], invalidKeys: [] });
  });

  it('fails closed when deleting all without IndexedDB availability', async () => {
    const store = createVideoScreenshotCacheIndexedDbStore({
      indexedDb: undefined
    });
    const originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    try {
      await expect(store.deleteAll()).rejects.toThrow(
        'IndexedDB is not available for video screenshot cache storage.'
      );
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: originalIndexedDb
      });
    }
  });

  it('selects expired and over-limit candidates without deleting IndexedDB rows', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb });
    const keepNewest = createEntry({
      pageKey: 'page-a',
      captureId: 'capture-new',
      id: 'shot-new',
      capturedAt: BASE_TIME + 200,
      createdAt: BASE_TIME + 210,
      updatedAt: BASE_TIME + 220,
      expiresAt: BASE_TIME + 20_000
    });
    const pageOverflow = createEntry({
      pageKey: 'page-a',
      captureId: 'capture-old',
      id: 'shot-old',
      capturedAt: BASE_TIME + 120,
      createdAt: BASE_TIME + 130,
      updatedAt: BASE_TIME + 140,
      expiresAt: BASE_TIME + 20_000
    });
    const keepGlobal = createEntry({
      pageKey: 'page-b',
      captureId: 'capture-b',
      id: 'shot-b',
      capturedAt: BASE_TIME + 180,
      createdAt: BASE_TIME + 190,
      updatedAt: BASE_TIME + 200,
      expiresAt: BASE_TIME + 20_000
    });
    const expired = createEntry({
      pageKey: 'page-c',
      captureId: 'capture-expired',
      id: 'shot-expired',
      capturedAt: BASE_TIME + 20,
      createdAt: BASE_TIME + 30,
      updatedAt: BASE_TIME + 40,
      expiresAt: BASE_TIME + 50
    });

    await store.put(pageOverflow);
    await store.put(expired);
    await store.put(keepNewest);
    await store.put(keepGlobal);

    const result = await store.prune({
      now: BASE_TIME + 100,
      maxGlobalEntries: 2,
      maxPageEntries: 1,
      applyLimits: true
    });

    expect(result.entries.map((entry) => entry.key)).toEqual([keepNewest.key, keepGlobal.key]);
    expect(new Set(result.candidateKeys)).toEqual(new Set([expired.key, pageOverflow.key]));
    expect(result.invalidKeys).toEqual([]);
    expect(indexedDb.getRaw(expired.key)).toBeDefined();
    expect(indexedDb.getRaw(pageOverflow.key)).toBeDefined();
  });

  it('returns typed invalid get and peek results with the exact primary key and preserves corrupt rows', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const corrupt = createEntry(
      {
        pageKey: 'page-z',
        captureId: 'capture-z',
        id: 'shot-z'
      },
      'broken'
    );
    indexedDb.seed({
      ...corrupt,
      byteLength: corrupt.byteLength + 1
    });

    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb });
    await expect(store.get(corrupt.key)).resolves.toEqual({
      status: 'invalid',
      key: corrupt.key
    });
    await expect(store.peek?.(corrupt.key)).resolves.toEqual({
      status: 'invalid',
      key: corrupt.key
    });
    expect(indexedDb.getRaw(corrupt.key)).toBeDefined();
  });

  it('reports invalid page and all-list rows by primary key without deleting them', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    indexedDb.seedRaw('non-object-row', 42 as unknown as RawRecord);
    indexedDb.seedRaw('missing-key-row', { pageKey: 'page-a', malformed: true });
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb });

    await expect(store.listByPageKey('page-a')).resolves.toEqual({
      entries: [],
      invalidKeys: ['missing-key-row', 'non-object-row']
    });
    await expect(store.listAllMetadata()).resolves.toEqual({
      entries: [],
      invalidKeys: ['missing-key-row', 'non-object-row']
    });
    expect(indexedDb.rawCount()).toBe(2);
  });

  it('reports prune candidates and invalid primary keys without deleting either class', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const expired = createEntry({
      capturedAt: BASE_TIME - 100,
      createdAt: BASE_TIME - 90,
      updatedAt: BASE_TIME - 80,
      expiresAt: BASE_TIME - 1
    });
    indexedDb.seed(expired as unknown as RawRecord);
    indexedDb.seedRaw('missing-key-row', { malformed: true });
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb });

    await expect(
      store.prune({
        now: BASE_TIME,
        maxGlobalEntries: 10,
        maxPageEntries: 10,
        applyLimits: true
      })
    ).resolves.toEqual({
      entries: [],
      candidateKeys: [expired.key],
      invalidKeys: ['missing-key-row'],
      dirty: true
    });
    expect(indexedDb.rawCount()).toBe(2);
  });

  it('uses the injected content byte cap when normalizing IndexedDB blob rows', async () => {
    const indexedDb = new FakeIndexedDbFactory();
    const maxContentBytes = VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 2_048;
    const store = createVideoScreenshotCacheIndexedDbStore({ indexedDb, maxContentBytes });
    const content = new Uint8Array(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    const entry = createEntry(
      {
        pageKey: 'page-a',
        captureId: 'capture-large',
        id: 'shot-large'
      },
      content
    );

    await store.put(entry);

    const loaded = await store.get(entry.key);
    expect(loaded).toMatchObject({
      status: 'found',
      entry: { byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1 }
    });
    expect(loaded.status === 'found' ? loaded.entry.blob.size : null).toBe(
      VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
    );
    expect((await store.listByPageKey('page-a')).entries.map((current) => current.key)).toEqual([
      entry.key
    ]);
    expect((await store.listAllMetadata()).entries.map((current) => current.key)).toEqual([
      entry.key
    ]);

    const pruneResult = await store.prune({
      now: BASE_TIME,
      maxGlobalEntries: 10,
      maxPageEntries: 10,
      applyLimits: true
    });
    expect(pruneResult.entries.map((current) => current.key)).toEqual([entry.key]);
    expect(pruneResult.candidateKeys).toEqual([]);
    expect(pruneResult.invalidKeys).toEqual([]);
  });
});
