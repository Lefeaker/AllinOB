/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { serializeBlobAttachmentContent } from '@shared/attachments/clipAttachmentBinary';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts';
import { createVideoScreenshotCacheClientRepository } from '@content/video/videoScreenshotCacheClientRepository';
import { createVideoScreenshotCacheRepository } from '@content/video/videoScreenshotCacheRepository';
import {
  normalizeVideoScreenshotCacheBlobEntry,
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobMetadata,
  type VideoScreenshotCacheBlobStore
} from '@content/video/videoScreenshotCacheStore';
import type { VideoCaptureScreenshot } from '@content/video/types';
import type { MessagingService } from '@platform/interfaces/messaging';
import type { StorageAreaService } from '@platform/interfaces/storage';
import {
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import {
  VIDEO_SCREENSHOT_CACHE_MESSAGE,
  type SerializedVideoScreenshotCacheScreenshot,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from '@content/video/videoScreenshotCacheMessages';
import {
  createBackgroundVideoScreenshotCacheHandler,
  type BackgroundVideoScreenshotCacheHandler
} from '../../../../src/background/services/videoScreenshotCacheService';

const BASE_TIME = 2_000_000_000_000;

type StoredValue = unknown;

function castStoredValue<T>(value: StoredValue): T | undefined {
  return value as T | undefined;
}

function castMessageResult<TResult>(value: VideoScreenshotCacheResponse | undefined): TResult {
  return value as TResult;
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
  private readonly maxContentBytes: number | undefined;
  private pendingPageReadResolvers: Array<() => void> = [];
  private pageReadReleaseScheduled = false;

  constructor(options: { delayPageReads?: boolean; maxContentBytes?: number } = {}) {
    this.delayPageReads = options.delayPageReads === true;
    this.maxContentBytes = options.maxContentBytes;
  }

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    const normalizedEntry = normalizeVideoScreenshotCacheBlobEntry(entry, {
      maxContentBytes: this.maxContentBytes
    });
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

  listAllMetadata(): Promise<VideoScreenshotCacheBlobMetadata[]> {
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

class RejectingBlobStore extends MemoryBlobStore {
  constructor(
    private readonly failures: {
      put?: string;
      get?: string;
      deleteMany?: string;
      prune?: string;
    } = {}
  ) {
    super();
  }

  override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    if (this.failures.put) {
      return Promise.reject(new Error(this.failures.put));
    }
    return super.put(entry);
  }

  override get(key: string): Promise<VideoScreenshotCacheBlobEntry | null> {
    if (this.failures.get) {
      return Promise.reject(new Error(this.failures.get));
    }
    return super.get(key);
  }

  override deleteMany(keys: readonly string[]): Promise<void> {
    if (this.failures.deleteMany) {
      return Promise.reject(new Error(this.failures.deleteMany));
    }
    return super.deleteMany(keys);
  }

  override prune(options: Parameters<VideoScreenshotCacheBlobStore['prune']>[0]) {
    if (this.failures.prune) {
      return Promise.reject(new Error(this.failures.prune));
    }
    return super.prune(options);
  }
}

function cloneBlobEntry(entry: VideoScreenshotCacheBlobEntry): VideoScreenshotCacheBlobEntry {
  return {
    ...entry,
    blob: entry.blob.slice(0, entry.blob.size, entry.blob.type)
  };
}

function toMetadata(entry: VideoScreenshotCacheBlobEntry): VideoScreenshotCacheBlobMetadata {
  const { blob, ...metadata } = entry;
  void blob;
  return metadata;
}

function createScreenshot(
  id: string,
  content: BlobPart,
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

function createThrowingBlob(): Blob {
  const blob = new Blob(['firefox'], { type: 'image/jpeg' });
  Object.defineProperty(blob, 'arrayBuffer', {
    configurable: true,
    value: () => Promise.reject(new Error('Permission denied to access property "constructor"'))
  });
  return blob;
}

function requireSavedRef(
  result: Awaited<ReturnType<ReturnType<typeof createVideoScreenshotCacheRepository>['save']>>,
  label = 'expected screenshot cache save to succeed'
): VideoScreenshotCacheRef {
  expect(result.status).toBe('saved');
  if (result.status !== 'saved') {
    throw new Error(label);
  }
  return result.ref;
}

function createClientMessaging(
  handleMessage: BackgroundVideoScreenshotCacheHandler
): Pick<MessagingService, 'send'> {
  return {
    async send<TResult>(message: Parameters<MessagingService['send']>[0]): Promise<TResult> {
      return castMessageResult<TResult>(await handleMessage(message));
    }
  };
}

function createStaticMessaging(
  response: VideoScreenshotCacheResponse
): Pick<MessagingService, 'send'> {
  return {
    send<TResult>(): Promise<TResult> {
      return Promise.resolve(castMessageResult<TResult>(response));
    }
  };
}

function createRef(): VideoScreenshotCacheRef {
  return {
    schemaVersion: 1,
    pageKey: 'page-a',
    captureId: 'capture-a',
    id: 'shot-a',
    key: createVideoScreenshotCacheStorageKey({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshotId: 'shot-a'
    }),
    fileName: 'shot-a.jpg',
    mimeType: 'image/jpeg',
    byteLength: 1,
    capturedAt: BASE_TIME,
    expiresAt: BASE_TIME + 1_000
  };
}

function expectNoLegacyScreenshotCacheWrites(area: MemoryStorageArea): void {
  expect(area.snapshotKeys()).toEqual([]);
}

function expectNoLegacyPayloadRows(area: MemoryStorageArea): void {
  expect(
    area
      .snapshotKeys()
      .filter(
        (key) =>
          key !== VIDEO_SCREENSHOT_CACHE_INDEX_KEY && key.startsWith('aiob.videoScreenshotCache.')
      )
  ).toEqual([]);
}

async function createSaveMessage(
  screenshot: VideoCaptureScreenshot,
  pageKey = 'page-a',
  captureId = 'capture-a'
): Promise<Extract<VideoScreenshotCacheMessage, { operation: 'save' }>> {
  if (screenshot.content?.kind !== 'blob') {
    throw new Error('createSaveMessage requires blob-backed screenshot content.');
  }

  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'save',
    input: {
      pageKey,
      captureId,
      screenshot: await serializeMessageScreenshot(screenshot)
    }
  };
}

async function serializeMessageScreenshot(
  screenshot: VideoCaptureScreenshot
): Promise<SerializedVideoScreenshotCacheScreenshot> {
  if (screenshot.content?.kind !== 'blob') {
    throw new Error('serializeMessageScreenshot requires blob-backed screenshot content.');
  }

  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content: await serializeBlobAttachmentContent(screenshot.content.blob)
  };
}

describe('background-owned video screenshot cache client', () => {
  it('serializes concurrent saves from separate content clients through one background owner and keeps storage.local empty', async () => {
    const blobStore = new MemoryBlobStore({ delayPageReads: true });
    const legacyArea = new MemoryStorageArea();
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: legacyArea },
      {
        now: () => BASE_TIME,
        ttlMs: 20
      },
      { blobStore }
    );
    const firstClient = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });
    const secondClient = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    const [first, second] = await Promise.all([
      firstClient.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'frame-a')
      }),
      secondClient.save({
        pageKey: 'page-a',
        captureId: 'capture-b',
        screenshot: createScreenshot('shot-b', 'frame-b')
      })
    ]);

    const firstRef = requireSavedRef(first);
    const secondRef = requireSavedRef(second);
    expect(firstRef.expiresAt).toBe(BASE_TIME + 20);
    expect(secondRef.expiresAt).toBe(BASE_TIME + 20);
    expect(blobStore.snapshotMetadataIds().sort()).toEqual(['shot-a', 'shot-b']);
    expect(blobStore.peek(firstRef.key)).toMatchObject({ expiresAt: BASE_TIME + 20 });
    expect(blobStore.peek(secondRef.key)).toMatchObject({ expiresAt: BASE_TIME + 20 });
    expect(await legacyArea.get(firstRef.key)).toBeUndefined();
    expect(await legacyArea.get(secondRef.key)).toBeUndefined();
    expect(await legacyArea.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY)).toBeUndefined();
    expectNoLegacyScreenshotCacheWrites(legacyArea);
  });

  it('uses the injected generic storage policy ttl for background-owned cache refs', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const storagePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 123_456,
        maxRestorablePages: null,
        maxItemsPerPage: null
      }
    });
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: legacyArea },
      {
        now: () => BASE_TIME,
        ttlMs: storagePolicy.videoScreenshotCache.ttlMs
      },
      { blobStore }
    );
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    const saved = await client.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createScreenshot('policy-shot', 'policy-frame')
    });

    const ref = requireSavedRef(saved);
    expect(ref.expiresAt).toBe(BASE_TIME + 123_456);
    expect(blobStore.peek(ref.key)).toMatchObject({ expiresAt: BASE_TIME + 123_456 });
    expect(await legacyArea.get(ref.key)).toBeUndefined();
    expect(await legacyArea.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY)).toBeUndefined();
    expectNoLegacyScreenshotCacheWrites(legacyArea);
  });

  it('saves and loads runtime-message screenshots above the Free default when policy raises the cap', async () => {
    const maxContentBytes = VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 2_048;
    const content = new Uint8Array(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    const blobStore = new MemoryBlobStore({ maxContentBytes });
    const legacyArea = new MemoryStorageArea();
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: legacyArea },
      {
        now: () => BASE_TIME,
        maxContentBytes
      },
      { blobStore }
    );
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    const saved = await client.save({
      pageKey: 'page-a',
      captureId: 'capture-large',
      screenshot: createScreenshot('policy-large-shot', content)
    });

    const ref = requireSavedRef(saved);
    expect(ref.byteLength).toBe(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    expect(blobStore.peek(ref.key)?.blob.size).toBe(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    const loaded = await client.load(ref);
    expect(loaded?.content?.byteLength).toBe(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    expect(loaded?.content?.blob.size).toBe(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    expectNoLegacyScreenshotCacheWrites(legacyArea);
  });

  it('loads screenshots through JSON-safe runtime messages while the durable bytes stay in the blob store', async () => {
    const blobStore = new MemoryBlobStore();
    const legacyArea = new MemoryStorageArea();
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: legacyArea },
      { now: () => BASE_TIME },
      { blobStore }
    );
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    const saved = await client.save({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createScreenshot('shot-a', 'frame-a')
    });
    const ref = requireSavedRef(saved);

    expect(blobStore.peek(ref.key)).not.toBeNull();
    expect(await legacyArea.get(ref.key)).toBeUndefined();
    expect(await legacyArea.get(VIDEO_SCREENSHOT_CACHE_INDEX_KEY)).toBeUndefined();
    expectNoLegacyScreenshotCacheWrites(legacyArea);

    const response = await handleMessage({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'load',
      ref
    });

    expect(response).toMatchObject({
      success: true,
      operation: 'load',
      status: 'loaded'
    });
    if (
      !response ||
      response.success !== true ||
      response.operation !== 'load' ||
      response.status !== 'loaded'
    ) {
      throw new Error('expected load response to include serialized screenshot content');
    }
    expect(response.screenshot.content).toEqual({
      encoding: 'base64',
      data: 'ZnJhbWUtYQ==',
      byteLength: 7
    });
    const responseValues = Object.values(response.screenshot);
    expect(responseValues.some((value) => value instanceof Blob)).toBe(false);
    expect(
      responseValues.some((value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    ).toBe(false);

    const loaded = await client.load(ref);
    expect(loaded).toMatchObject({
      id: 'shot-a',
      fileName: 'shot-a.jpg',
      mimeType: 'image/jpeg',
      capturedAt: BASE_TIME
    });
    await expect(loaded?.content?.blob.text()).resolves.toBe('frame-a');
  });

  it('migrates a valid legacy storage.local cache entry into the blob store on background load', async () => {
    const legacyArea = new MemoryStorageArea();
    const legacyRepository = createVideoScreenshotCacheRepository(legacyArea, {
      now: () => BASE_TIME
    });
    const legacyRef = requireSavedRef(
      await legacyRepository.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('legacy-shot', 'legacy-frame')
      })
    );

    const blobStore = new MemoryBlobStore();
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(
        createBackgroundVideoScreenshotCacheHandler(
          { local: legacyArea },
          { now: () => BASE_TIME },
          { blobStore }
        )
      )
    });

    const loaded = await client.load(legacyRef);

    expect(loaded).toMatchObject({
      id: 'legacy-shot',
      fileName: 'legacy-shot.jpg',
      mimeType: 'image/jpeg',
      capturedAt: BASE_TIME
    });
    await expect(loaded?.content?.blob.text()).resolves.toBe('legacy-frame');
    expect(blobStore.peek(legacyRef.key)).not.toBeNull();
    expect(await legacyArea.get(legacyRef.key)).toBeUndefined();
    expectNoLegacyPayloadRows(legacyArea);
  });

  it('saves dataUrl-only screenshots through the background cache owner', async () => {
    const legacyArea = new MemoryStorageArea();
    const blobStore = new MemoryBlobStore();
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(
        createBackgroundVideoScreenshotCacheHandler(
          { local: legacyArea },
          { now: () => BASE_TIME },
          { blobStore }
        )
      )
    });

    const saved = await client.save({
      pageKey: 'page-firefox',
      captureId: 'capture-firefox',
      screenshot: {
        id: 'shot-firefox',
        fileName: 'shot-firefox.jpg',
        mimeType: 'image/jpeg',
        capturedAt: BASE_TIME,
        dataUrl: 'data:image/jpeg;base64,ZmlyZWZveA=='
      }
    });
    const ref = requireSavedRef(saved);

    expect(blobStore.peek(ref.key)).not.toBeNull();
    const loaded = await client.load(ref);
    expect(loaded).toMatchObject({
      id: 'shot-firefox',
      fileName: 'shot-firefox.jpg',
      mimeType: 'image/jpeg',
      capturedAt: BASE_TIME
    });
    await expect(loaded?.content?.blob.text()).resolves.toBe('firefox');
  });

  it('saves the dataUrl fallback when Firefox blocks blob serialization in the content client', async () => {
    const legacyArea = new MemoryStorageArea();
    const blobStore = new MemoryBlobStore();
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(
        createBackgroundVideoScreenshotCacheHandler(
          { local: legacyArea },
          { now: () => BASE_TIME },
          { blobStore }
        )
      )
    });

    const saved = await client.save({
      pageKey: 'page-firefox',
      captureId: 'capture-firefox',
      screenshot: {
        id: 'shot-firefox-fallback',
        fileName: 'shot-firefox-fallback.jpg',
        mimeType: 'image/jpeg',
        capturedAt: BASE_TIME,
        dataUrl: 'data:image/jpeg;base64,ZmlyZWZveA==',
        content: {
          kind: 'blob',
          blob: createThrowingBlob(),
          byteLength: 7
        }
      }
    });
    const ref = requireSavedRef(saved);

    expect(blobStore.peek(ref.key)).not.toBeNull();
    const loaded = await client.load(ref);
    await expect(loaded?.content?.blob.text()).resolves.toBe('firefox');
    expectNoLegacyScreenshotCacheWrites(legacyArea);
  });

  it('serializes removeMany and prune operations through the background owner and deletes blob entries', async () => {
    let nowMs = BASE_TIME;
    const blobStore = new MemoryBlobStore({ delayPageReads: true });
    const legacyArea = new MemoryStorageArea();
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: legacyArea },
      {
        now: () => nowMs,
        ttlMs: 20
      },
      { blobStore }
    );
    const firstClient = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });
    const secondClient = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    const firstRef = requireSavedRef(
      await firstClient.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'frame-a')
      })
    );
    const secondRef = requireSavedRef(
      await secondClient.save({
        pageKey: 'page-a',
        captureId: 'capture-b',
        screenshot: createScreenshot('shot-b', 'frame-b')
      })
    );

    nowMs += 25;

    await Promise.all([firstClient.removeMany([firstRef]), secondClient.pruneExpired()]);

    expect(blobStore.peek(firstRef.key)).toBeNull();
    expect(blobStore.peek(secondRef.key)).toBeNull();
    expect(blobStore.snapshotKeys()).toEqual([]);
    expect(await legacyArea.get(firstRef.key)).toBeUndefined();
    expect(await legacyArea.get(secondRef.key)).toBeUndefined();
    expectNoLegacyPayloadRows(legacyArea);
  });

  it('returns a typed save skip when blob-store writes fail instead of rejecting the runtime message', async () => {
    const screenshot = createScreenshot('shot-a', 'frame-a');
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: new MemoryStorageArea() },
      { now: () => BASE_TIME },
      {
        blobStore: new RejectingBlobStore({
          put: 'Failed to write video screenshot cache blob entry.'
        })
      }
    );
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    await expect(
      client.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot
      })
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'Failed to write video screenshot cache blob entry.'
    });

    await expect(handleMessage(await createSaveMessage(screenshot))).resolves.toEqual({
      success: true,
      operation: 'save',
      result: {
        status: 'skipped',
        reason: 'serialize-failed',
        error: 'Failed to write video screenshot cache blob entry.'
      }
    });
  });

  it('returns a controlled missing load response when blob-store reads fail', async () => {
    const ref = createRef();
    const handleMessage = createBackgroundVideoScreenshotCacheHandler(
      { local: new MemoryStorageArea() },
      { now: () => BASE_TIME },
      {
        blobStore: new RejectingBlobStore({
          get: 'Failed to read video screenshot cache blob entry.'
        })
      }
    );
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createClientMessaging(handleMessage)
    });

    await expect(
      handleMessage({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'load',
        ref
      })
    ).resolves.toEqual({
      success: true,
      operation: 'load',
      status: 'missing'
    });
    await expect(client.load(ref)).resolves.toBeNull();
  });

  it('rejects removeMany when the background mutation response fails', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({
        success: false,
        error: 'background cleanup failed'
      })
    });

    await expect(client.removeMany([createRef()])).rejects.toThrow('background cleanup failed');
  });

  it('returns a technical save error code when the background response shape is invalid', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({} as VideoScreenshotCacheResponse)
    });

    await expect(
      client.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-invalid', 'frame-invalid')
      })
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE'
    });
  });

  it('rejects pruneExpired when the background mutation operation mismatches', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({
        success: true,
        operation: 'pruneToLimits'
      })
    });

    await expect(client.pruneExpired()).rejects.toThrow('Unexpected pruneExpired response.');
  });

  it('resolves mutation requests only after a matching background response', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({
        success: true,
        operation: 'removeMany'
      })
    });

    await expect(client.removeMany([createRef()])).resolves.toBeUndefined();
  });
});
