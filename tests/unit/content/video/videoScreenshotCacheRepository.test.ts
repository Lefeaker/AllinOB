/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import type { StorageAreaService } from '@platform/interfaces/storage';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts';
import { createVideoScreenshotCacheRepository } from '@content/video/videoScreenshotCacheRepository';
import {
  normalizeVideoScreenshotCacheBlobEntry,
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobStore
} from '@content/video/videoScreenshotCacheStore';
import {
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  normalizeVideoScreenshotCacheEntry,
  normalizeVideoScreenshotCacheIndex,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import type { VideoCaptureScreenshot } from '@content/video/types';

const BASE_TIME = 2_000_000_000_000;
type StoredValue = unknown;

function castStoredValue<T>(value: StoredValue): T | undefined {
  return value as T | undefined;
}

class MemoryStorageArea implements StorageAreaService {
  private readonly values = new Map<string, StoredValue>();

  get<T = StoredValue>(key: string): Promise<T | undefined> {
    return Promise.resolve(castStoredValue<T>(this.values.get(key)));
  }

  set<T = StoredValue>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  getMany<T = StoredValue>(keys: string[]): Promise<Record<string, T | undefined>> {
    return Promise.resolve(
      Object.fromEntries(keys.map((key) => [key, castStoredValue<T>(this.values.get(key))]))
    );
  }

  setMany<T = StoredValue>(entries: Record<string, T>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }

  remove(key: string | string[]): Promise<void> {
    for (const currentKey of Array.isArray(key) ? key : [key]) {
      this.values.delete(currentKey);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.values.clear();
    return Promise.resolve();
  }

  watchKey(): () => void {
    return () => undefined;
  }

  watchAll(): () => void {
    return () => undefined;
  }

  snapshotKeys(): string[] {
    return [...this.values.keys()].sort();
  }
}

class MemoryBlobStore implements VideoScreenshotCacheBlobStore {
  private readonly values = new Map<string, VideoScreenshotCacheBlobEntry>();
  private readonly delayPageReads: boolean;
  private pendingPageReadResolvers: Array<() => void> = [];
  private pageReadReleaseScheduled = false;

  constructor(options: { delayPageReads?: boolean } = {}) {
    this.delayPageReads = options.delayPageReads === true;
  }

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    const normalizedEntry = normalizeVideoScreenshotCacheBlobEntry(entry);
    if (normalizedEntry === null) {
      throw new Error('MemoryBlobStore rejected an invalid blob entry.');
    }
    this.values.set(normalizedEntry.key, cloneBlobEntry(normalizedEntry));
    return Promise.resolve();
  }

  get(key: string): Promise<VideoScreenshotCacheBlobEntry | null> {
    const entry = this.values.get(key);
    return Promise.resolve(entry ? cloneBlobEntry(entry) : null);
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
    }
    return Promise.resolve();
  }

  async listByPageKey(pageKey: string): Promise<VideoScreenshotCacheBlobEntry[]> {
    if (this.delayPageReads) {
      await this.waitForPageReadTurn();
    }
    return this.sortedEntries().filter((entry) => entry.pageKey === pageKey);
  }

  listAllMetadata(): Promise<ReturnType<typeof toMetadata>[]> {
    return Promise.resolve(this.sortedEntries().map(toMetadata));
  }

  async prune(options: Parameters<VideoScreenshotCacheBlobStore['prune']>[0]) {
    const result = pruneVideoScreenshotCacheBlobMetadataEntries(
      await this.listAllMetadata(),
      options
    );
    await this.deleteMany(result.removedKeys);
    return result;
  }

  peek(key: string): VideoScreenshotCacheBlobEntry | null {
    const entry = this.values.get(key);
    return entry ? cloneBlobEntry(entry) : null;
  }

  snapshotKeys(): string[] {
    return [...this.values.keys()].sort();
  }

  snapshotMetadataIds(): string[] {
    return this.sortedEntries().map((entry) => entry.id);
  }

  private sortedEntries(): VideoScreenshotCacheBlobEntry[] {
    return sortVideoScreenshotCacheBlobMetadataNewestFirst(
      [...this.values.values()].map(cloneBlobEntry)
    );
  }

  private waitForPageReadTurn(): Promise<void> {
    return new Promise((resolve) => {
      this.pendingPageReadResolvers.push(resolve);
      if (this.pendingPageReadResolvers.length >= 2) {
        this.releasePendingPageReads();
        return;
      }
      if (!this.pageReadReleaseScheduled) {
        this.pageReadReleaseScheduled = true;
        setTimeout(() => this.releasePendingPageReads(), 0);
      }
    });
  }

  private releasePendingPageReads(): void {
    const resolvers = this.pendingPageReadResolvers.splice(0);
    this.pageReadReleaseScheduled = false;
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

function cloneBlobEntry(entry: VideoScreenshotCacheBlobEntry): VideoScreenshotCacheBlobEntry {
  return {
    ...entry,
    blob: entry.blob.slice(0, entry.blob.size, entry.blob.type)
  };
}

function toMetadata(entry: VideoScreenshotCacheBlobEntry) {
  const { blob, ...metadata } = entry;
  void blob;
  return metadata;
}

function createStructuredRepository(
  blobStore: VideoScreenshotCacheBlobStore,
  legacyArea?: StorageAreaService,
  options: Parameters<typeof createVideoScreenshotCacheRepository>[1] = {}
) {
  return createVideoScreenshotCacheRepository(
    {
      blobStore,
      legacyArea
    },
    options
  );
}

function requireSaved(
  result: Awaited<ReturnType<ReturnType<typeof createVideoScreenshotCacheRepository>['save']>>,
  label = 'expected save result'
): VideoScreenshotCacheRef {
  if (result.status !== 'saved') {
    throw new Error(label);
  }
  return result.ref;
}

function createScreenshot(
  id: string,
  content: string,
  capturedAt = BASE_TIME
): VideoCaptureScreenshot {
  const blob = new Blob([content], { type: 'image/jpeg' });
  return {
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    capturedAt,
    content: {
      kind: 'blob',
      blob,
      byteLength: blob.size
    }
  };
}

function createDataUrlOnlyScreenshot(id: string, capturedAt = BASE_TIME): VideoCaptureScreenshot {
  return {
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    capturedAt,
    dataUrl: 'data:image/jpeg;base64,ZmFrZS1sZWdhY3k='
  };
}

function createMalformedMetadataScreenshot(): VideoCaptureScreenshot {
  const screenshot = createScreenshot('shot-invalid-metadata', 'frame-invalid-metadata');
  Object.defineProperty(screenshot, 'mimeType', {
    value: 'image/png',
    configurable: true
  });
  return screenshot;
}

function createDeclaredByteLengthScreenshot(
  id: string,
  content: string,
  declaredByteLength: number,
  capturedAt = BASE_TIME
): VideoCaptureScreenshot {
  const screenshot = createScreenshot(id, content, capturedAt);
  if (!screenshot.content) {
    throw new Error('expected blob screenshot content');
  }
  return {
    ...screenshot,
    content: {
      kind: 'blob',
      blob: screenshot.content.blob,
      byteLength: declaredByteLength
    }
  };
}

async function readLegacyIndex(area: Pick<StorageAreaService, 'get'>) {
  return normalizeVideoScreenshotCacheIndex(await area.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY));
}

async function expectLegacyRemoved(
  area: Pick<StorageAreaService, 'get'>,
  ref: VideoScreenshotCacheRef
): Promise<void> {
  expect(await area.get(ref.key)).toBeUndefined();
  const index = await readLegacyIndex(area);
  expect(index?.entries.find((entry) => entry.key === ref.key)).toBeUndefined();
}

async function expectLoadedText(
  screenshot: VideoCaptureScreenshot | null,
  expectedText: string
): Promise<void> {
  expect(screenshot).not.toBeNull();
  if (!screenshot?.content) {
    throw new Error('expected loaded screenshot content');
  }
  await expect(screenshot.content.blob.text()).resolves.toBe(expectedText);
}

describe('videoScreenshotCacheRepository', () => {
  it('structured save writes blobStore only and returns metadata-only ref', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME,
      ttlMs: 100
    });

    const ref = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'frame-a')
      })
    );

    const refValues = Object.values(ref);
    expect(ref).not.toHaveProperty('content');
    expect(ref).not.toHaveProperty('dataUrl');
    expect(ref.expiresAt).toBe(BASE_TIME + 100);
    expect(refValues.some((value) => value instanceof Blob)).toBe(false);
    expect(
      refValues.some((value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    ).toBe(false);

    const storedEntry = blobStore.peek(ref.key);
    expect(storedEntry).toMatchObject({
      key: ref.key,
      pageKey: 'page-a',
      captureId: 'capture-a',
      id: 'shot-a',
      fileName: 'shot-a.jpg',
      mimeType: 'image/jpeg',
      byteLength: 7,
      capturedAt: BASE_TIME,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      expiresAt: BASE_TIME + 100
    });
    await expect(storedEntry?.blob.text()).resolves.toBe('frame-a');
    expect(await legacyArea.get(ref.key)).toBeUndefined();
  });

  it('structured save does not write new base64 storage rows or the legacy index key', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const ref = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-no-legacy', 'frame-no-legacy')
      })
    );

    expect(blobStore.peek(ref.key)).not.toBeNull();
    expect(await legacyArea.get(ref.key)).toBeUndefined();
    expect(await legacyArea.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY)).toBeUndefined();
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('skips oversized blob screenshots on the structured save path', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      maxContentBytes: 4
    });

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createScreenshot('shot-big', '12345')
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: 5,
      maxContentBytes: 4
    });
    expect(blobStore.snapshotKeys()).toEqual([]);
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('accepts full screenshot cache caps from the shared storage policy', async () => {
    const blobStore = new MemoryBlobStore();
    const storagePolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        ttlMs: 77,
        maxGlobalEntries: 2,
        maxPageEntries: 1,
        maxContentBytes: 8
      }
    });
    let nowMs = BASE_TIME;
    const repository = createStructuredRepository(blobStore, undefined, {
      ...storagePolicy.videoScreenshotCache,
      now: () => nowMs
    });

    const firstRef = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', '12345678', nowMs)
      })
    );
    nowMs += 1;
    const secondRef = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-b',
        screenshot: createScreenshot('shot-b', '12345678', nowMs)
      })
    );

    expect(firstRef.expiresAt).toBe(BASE_TIME + 77);
    expect(secondRef.expiresAt).toBe(BASE_TIME + 78);
    expect(blobStore.snapshotMetadataIds()).toEqual(['shot-b']);
    await expect(repository.load(firstRef)).resolves.toBeNull();

    await expect(
      repository.save({
        pageKey: 'page-b',
        captureId: 'capture-c',
        screenshot: createScreenshot('shot-c', '123456789', nowMs)
      })
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: 9,
      maxContentBytes: 8
    });
  });

  it('structured save returns a typed serialize-failed skip for invalid screenshot metadata', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createMalformedMetadataScreenshot()
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED'
    });
    expect(blobStore.snapshotKeys()).toEqual([]);
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('skips missing blob screenshots on the structured save path', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createDataUrlOnlyScreenshot('shot-no-blob')
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'missing-blob-content'
    });
    expect(blobStore.snapshotKeys()).toEqual([]);
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('skips invalid page keys on the structured save path', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const result = await repository.save({
      pageKey: 'https://video.example/watch?v=private-token',
      captureId: 'capture-a',
      screenshot: createScreenshot('shot-invalid-page', 'frame-invalid-page')
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'invalid-metadata',
      field: 'pageKey'
    });
    expect(blobStore.snapshotKeys()).toEqual([]);
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('legacy compatibility save preserves capture time ahead of the repository clock', async () => {
    const area = new MemoryStorageArea();
    const repository = createVideoScreenshotCacheRepository(area, {
      now: () => BASE_TIME,
      ttlMs: 100
    });

    const saved = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createScreenshot('shot-clock', 'frame-clock', BASE_TIME + 10)
    });

    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') {
      throw new Error('expected saved result');
    }

    const entry = normalizeVideoScreenshotCacheEntry(await area.get(saved.ref.key));
    expect(entry).toMatchObject({
      capturedAt: BASE_TIME + 10,
      createdAt: BASE_TIME + 10,
      updatedAt: BASE_TIME + 10,
      expiresAt: BASE_TIME + 110
    });
  });

  it('legacy compatibility save returns a technical code when blob serialization fails', async () => {
    const area = new MemoryStorageArea();
    const repository = createVideoScreenshotCacheRepository(area, {
      now: () => BASE_TIME
    });
    const brokenBlob = {
      arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new Error('blob exploded'));
      },
      size: 1,
      type: 'image/jpeg'
    } as unknown as Blob;

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: {
        id: 'shot-broken',
        fileName: 'shot-broken.jpg',
        mimeType: 'image/jpeg',
        capturedAt: BASE_TIME,
        content: {
          kind: 'blob',
          blob: brokenBlob,
          byteLength: 1
        }
      }
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED'
    });
    expect(area.snapshotKeys()).toEqual([]);
  });

  it('loads a screenshot directly from the blob store', async () => {
    const blobStore = new MemoryBlobStore();
    const repository = createStructuredRepository(blobStore, undefined, {
      now: () => BASE_TIME
    });

    const ref = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-hit', 'frame-hit')
      })
    );

    const loaded = await repository.load(ref);
    expect(loaded).toMatchObject({
      id: 'shot-hit',
      fileName: 'shot-hit.jpg',
      mimeType: 'image/jpeg',
      capturedAt: BASE_TIME,
      content: {
        kind: 'blob',
        byteLength: 9
      }
    });
    await expectLoadedText(loaded, 'frame-hit');
  });

  it('loads a valid legacy storage entry, migrates it into the blob store, and removes the legacy key', async () => {
    const legacyArea = new MemoryStorageArea();
    const legacyRepository = createVideoScreenshotCacheRepository(legacyArea, {
      now: () => BASE_TIME
    });
    const legacyRef = requireSaved(
      await legacyRepository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-legacy', 'frame-legacy')
      })
    );

    const blobStore = new MemoryBlobStore();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const loaded = await repository.load(legacyRef);
    await expectLoadedText(loaded, 'frame-legacy');
    expect(blobStore.peek(legacyRef.key)).toMatchObject({
      key: legacyRef.key,
      pageKey: 'page-a',
      captureId: 'capture-a',
      id: 'shot-legacy',
      byteLength: legacyRef.byteLength
    });
    await expectLegacyRemoved(legacyArea, legacyRef);

    const loadedAgain = await repository.load(legacyRef);
    await expectLoadedText(loadedAgain, 'frame-legacy');
  });

  it('returns null and removes invalid, corrupt, or expired legacy entries', async () => {
    const scenarios = [
      {
        label: 'invalid',
        ttlMs: 100,
        advanceMs: 0,
        mutate: async (area: MemoryStorageArea, ref: VideoScreenshotCacheRef) => {
          await area.set(ref.key, { invalid: true });
        }
      },
      {
        label: 'corrupt',
        ttlMs: 100,
        advanceMs: 0,
        mutate: async (area: MemoryStorageArea, ref: VideoScreenshotCacheRef) => {
          const entry = normalizeVideoScreenshotCacheEntry(await area.get(ref.key));
          if (!entry) {
            throw new Error('expected corrupt legacy entry fixture');
          }
          await area.set(ref.key, {
            ...entry,
            content: {
              ...entry.content,
              data: '*** not base64 ***'
            }
          });
        }
      },
      {
        label: 'expired',
        ttlMs: 20,
        advanceMs: 25,
        mutate: () => Promise.resolve(undefined)
      }
    ] satisfies ReadonlyArray<{
      label: string;
      ttlMs: number;
      advanceMs: number;
      mutate: (area: MemoryStorageArea, ref: VideoScreenshotCacheRef) => Promise<void>;
    }>;

    for (const scenario of scenarios) {
      const legacyArea = new MemoryStorageArea();
      let nowMs = BASE_TIME;
      const legacyRepository = createVideoScreenshotCacheRepository(legacyArea, {
        now: () => nowMs,
        ttlMs: scenario.ttlMs
      });
      const legacyRef = requireSaved(
        await legacyRepository.save({
          pageKey: 'page-a',
          captureId: `capture-${scenario.label}`,
          screenshot: createScreenshot(`shot-${scenario.label}`, `frame-${scenario.label}`)
        }),
        `expected legacy save for ${scenario.label}`
      );

      await scenario.mutate(legacyArea, legacyRef);
      nowMs += scenario.advanceMs;

      const repository = createStructuredRepository(new MemoryBlobStore(), legacyArea, {
        now: () => nowMs,
        ttlMs: scenario.ttlMs
      });

      await expect(repository.load(legacyRef)).resolves.toBeNull();
      await expectLegacyRemoved(legacyArea, legacyRef);
    }
  });

  it('returns null when both blob store and legacy storage miss the ref', async () => {
    const seedRepository = createStructuredRepository(new MemoryBlobStore(), undefined, {
      now: () => BASE_TIME
    });
    const ref = requireSaved(
      await seedRepository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-missing', 'frame-missing')
      })
    );

    const emptyRepository = createStructuredRepository(new MemoryBlobStore(), undefined, {
      now: () => BASE_TIME
    });

    await expect(emptyRepository.load(ref)).resolves.toBeNull();
  });

  it('preserves blob store metadata for concurrent structured saves with different captures', async () => {
    const blobStore = new MemoryBlobStore({ delayPageReads: true });
    const repository = createStructuredRepository(blobStore, undefined, {
      now: () => BASE_TIME
    });

    const [first, second] = await Promise.all([
      repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'frame-a')
      }),
      repository.save({
        pageKey: 'page-a',
        captureId: 'capture-b',
        screenshot: createScreenshot('shot-b', 'frame-b', BASE_TIME + 1)
      })
    ]);

    expect(first.status).toBe('saved');
    expect(second.status).toBe('saved');
    expect(blobStore.snapshotMetadataIds().sort()).toEqual(['shot-a', 'shot-b']);
  });

  it('serializes concurrent structured saves so same-capture replacements do not leave duplicate blob metadata', async () => {
    const blobStore = new MemoryBlobStore({ delayPageReads: true });
    const repository = createStructuredRepository(blobStore, undefined, {
      now: () => BASE_TIME
    });

    const [first, second] = await Promise.all([
      repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'frame-a')
      }),
      repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-b', 'frame-b', BASE_TIME + 1)
      })
    ]);

    const firstRef = requireSaved(first, 'expected first concurrent save');
    const secondRef = requireSaved(second, 'expected second concurrent save');

    expect(blobStore.snapshotMetadataIds()).toEqual(['shot-b']);
    await expect(repository.load(firstRef)).resolves.toBeNull();
    await expectLoadedText(await repository.load(secondRef), 'frame-b');
  });

  it('prunes the oldest blob-store entries per page when a lower per-page limit is applied', async () => {
    const blobStore = new MemoryBlobStore();
    let nowMs = BASE_TIME;
    const writer = createStructuredRepository(blobStore, undefined, {
      now: () => nowMs,
      maxPageEntries: 10,
      maxGlobalEntries: 10
    });

    for (const shotId of ['shot-1', 'shot-2', 'shot-3']) {
      requireSaved(
        await writer.save({
          pageKey: 'page-a',
          captureId: `capture-${shotId}`,
          screenshot: createScreenshot(shotId, `frame-${shotId}`, nowMs)
        }),
        `expected save for ${shotId}`
      );
      nowMs += 1;
    }

    const limiter = createStructuredRepository(blobStore, undefined, {
      now: () => nowMs,
      maxPageEntries: 2,
      maxGlobalEntries: 10
    });

    await limiter.pruneToLimits();
    expect(blobStore.snapshotMetadataIds()).toEqual(['shot-3', 'shot-2']);
  });

  it('prunes the oldest blob-store entries globally when a lower global limit is applied', async () => {
    const blobStore = new MemoryBlobStore();
    let nowMs = BASE_TIME;
    const writer = createStructuredRepository(blobStore, undefined, {
      now: () => nowMs,
      maxPageEntries: 10,
      maxGlobalEntries: 10
    });

    const globalPruneCases = [
      ['page-a', 'shot-1'],
      ['page-b', 'shot-2'],
      ['page-c', 'shot-3'],
      ['page-d', 'shot-4']
    ] satisfies ReadonlyArray<readonly [string, string]>;
    for (const [pageKey, shotId] of globalPruneCases) {
      requireSaved(
        await writer.save({
          pageKey,
          captureId: `capture-${shotId}`,
          screenshot: createScreenshot(shotId, `frame-${shotId}`, nowMs)
        }),
        `expected save for ${shotId}`
      );
      nowMs += 1;
    }

    const limiter = createStructuredRepository(blobStore, undefined, {
      now: () => nowMs,
      maxPageEntries: 10,
      maxGlobalEntries: 3
    });

    await limiter.pruneToLimits();
    expect(blobStore.snapshotMetadataIds()).toEqual(['shot-4', 'shot-3', 'shot-2']);
  });

  it('removeMany deletes both blob-store and legacy storage keys', async () => {
    const legacyArea = new MemoryStorageArea();
    const compatibilityRepository = createVideoScreenshotCacheRepository(legacyArea, {
      now: () => BASE_TIME
    });
    const blobStore = new MemoryBlobStore();
    const repository = createStructuredRepository(blobStore, legacyArea, {
      now: () => BASE_TIME
    });

    const refs: VideoScreenshotCacheRef[] = [];
    for (const shotId of ['shot-1', 'shot-2']) {
      const input = {
        pageKey: 'page-a',
        captureId: `capture-${shotId}`,
        screenshot: createScreenshot(shotId, `frame-${shotId}`)
      };
      const legacyRef = requireSaved(
        await compatibilityRepository.save(input),
        `expected compatibility save for ${shotId}`
      );
      const structuredRef = requireSaved(
        await repository.save(input),
        `expected structured save for ${shotId}`
      );
      expect(structuredRef.key).toBe(legacyRef.key);
      refs.push(structuredRef);
    }

    expect(blobStore.snapshotKeys()).toHaveLength(2);
    expect(legacyArea.snapshotKeys()).toEqual([
      VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
      refs[0]?.key,
      refs[1]?.key
    ]);

    await repository.removeMany(refs);

    expect(blobStore.snapshotKeys()).toEqual([]);
    for (const ref of refs) {
      expect(await legacyArea.get(ref.key)).toBeUndefined();
    }
    expect((await readLegacyIndex(legacyArea))?.entries).toEqual([]);
  });

  it('keeps the legacy storage-area constructor path for background compatibility until P03', async () => {
    const legacyArea = new MemoryStorageArea();
    const repository = createVideoScreenshotCacheRepository(legacyArea, {
      now: () => BASE_TIME
    });

    const ref = requireSaved(
      await repository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-compat', 'frame-compat')
      })
    );

    const storedEntry = normalizeVideoScreenshotCacheEntry(await legacyArea.get(ref.key));
    expect(storedEntry).not.toBeNull();
    expect(storedEntry?.content.data).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect((await readLegacyIndex(legacyArea))?.entries.map((entry) => entry.key)).toEqual([
      ref.key
    ]);

    const loaded = await repository.load(ref);
    await expectLoadedText(loaded, 'frame-compat');
  });

  it('legacy compatibility save returns a typed serialize-failed skip for invalid screenshot metadata', async () => {
    const legacyArea = new MemoryStorageArea();
    const repository = createVideoScreenshotCacheRepository(legacyArea, {
      now: () => BASE_TIME
    });

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createMalformedMetadataScreenshot()
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED'
    });
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });

  it('legacy compatibility save enforces the declared byteLength before serialization', async () => {
    const legacyArea = new MemoryStorageArea();
    const repository = createVideoScreenshotCacheRepository(legacyArea, {
      maxContentBytes: 5,
      now: () => BASE_TIME
    });

    const result = await repository.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createDeclaredByteLengthScreenshot('shot-declared-big', '1234', 6)
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: 6,
      maxContentBytes: 5
    });
    expect(legacyArea.snapshotKeys()).toEqual([]);
  });
});
