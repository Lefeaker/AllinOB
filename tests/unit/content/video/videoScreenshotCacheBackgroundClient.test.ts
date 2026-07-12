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
  type VideoScreenshotCacheBlobReadResult,
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
  normalizeVideoScreenshotCacheMessage,
  type SerializedVideoScreenshotCacheScreenshot,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from '@content/video/videoScreenshotCacheMessages';
import {
  createBackgroundVideoScreenshotCacheHandler,
  type BackgroundVideoScreenshotCacheHandler
} from '../../../../src/background/services/videoScreenshotCacheService';
import type { SessionDraftRepositoryResponse } from '@content/sessionDrafts/sessionDraftRepositoryMessages';
import { asType } from '../../../utils/typeHelpers';

const BASE_TIME = 2_000_000_000_000;
let authorizedSaveSequence = 0;

type StoredValue = unknown;

function castStoredValue<T>(value: StoredValue): T | undefined {
  return value as T | undefined;
}

function castMessageResult<TResult>(
  value: VideoScreenshotCacheResponse | SessionDraftRepositoryResponse | undefined
): TResult {
  return value as TResult;
}

class MemoryStorageArea implements StorageAreaService {
  private readonly values = new Map<string, StoredValue>();

  get<T = StoredValue>(key: string): Promise<T | undefined> {
    return Promise.resolve(castStoredValue<T>(this.values.get(key)));
  }

  getAll(): Promise<Record<string, StoredValue>> {
    return Promise.resolve(Object.fromEntries(this.values));
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

  snapshot(): Record<string, StoredValue> {
    return Object.fromEntries(this.values);
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

  get(key: string): ReturnType<VideoScreenshotCacheBlobStore['get']> {
    const entry = this.values.get(key);
    return Promise.resolve(
      entry ? { status: 'found', entry: cloneBlobEntry(entry) } : { status: 'missing' }
    );
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

  deleteAll(): Promise<number> {
    const count = this.values.size;
    this.values.clear();
    return Promise.resolve(count);
  }

  async listByPageKey(pageKey: string): ReturnType<VideoScreenshotCacheBlobStore['listByPageKey']> {
    if (this.delayPageReads) {
      await this.waitForPageReadTurn();
    }
    return {
      entries: this.sortedEntries().filter((entry) => entry.pageKey === pageKey),
      invalidKeys: []
    };
  }

  listAllMetadata(): ReturnType<VideoScreenshotCacheBlobStore['listAllMetadata']> {
    return Promise.resolve({ entries: this.sortedEntries().map(toMetadata), invalidKeys: [] });
  }

  async prune(options: Parameters<VideoScreenshotCacheBlobStore['prune']>[0]) {
    const result = pruneVideoScreenshotCacheBlobMetadataEntries(
      (await this.listAllMetadata()).entries,
      options
    );
    return {
      entries: result.entries,
      candidateKeys: result.removedKeys,
      invalidKeys: [],
      dirty: result.dirty
    };
  }

  peek(key: string): VideoScreenshotCacheBlobReadResult {
    const entry = this.values.get(key);
    return entry ? { status: 'found', entry: cloneBlobEntry(entry) } : { status: 'missing' };
  }

  peekEntry(key: string): VideoScreenshotCacheBlobEntry | null {
    const result = this.peek(key);
    return result.status === 'found' ? result.entry : null;
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

  override get(key: string): ReturnType<VideoScreenshotCacheBlobStore['get']> {
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
      const parsed = normalizeVideoScreenshotCacheMessage(message, {
        maxContentBytes: Number.MAX_SAFE_INTEGER
      });
      if (parsed?.operation === 'save' && !parsed.input.operationContext) {
        authorizedSaveSequence += 1;
        const operationId = `test-client-save-${authorizedSaveSequence}`;
        const draftKey = `aiob.sessionDraft.v1.video.${parsed.input.pageKey}.test-${authorizedSaveSequence}`;
        const prepared = await handleMessage({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'prepareSessionDraftOperation',
          operationId,
          draftKey
        });
        if (!prepared || prepared.success !== true) {
          return castMessageResult<TResult>(prepared);
        }
        const context = {
          operationId,
          epoch: 1,
          draftKey,
          baseRevision: 0,
          nextRevision: 1
        };
        const response = await handleMessage({
          ...parsed,
          input: {
            ...parsed.input,
            operationContext: context
          }
        });
        await handleMessage({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'cancelSessionDraftOperation',
          context
        });
        return castMessageResult<TResult>(response);
      }
      return castMessageResult<TResult>(await handleMessage(parsed ?? message));
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
  expect(area.snapshot()).toEqual({
    'aiob.restoreStorage.barrier.v1': {
      schemaVersion: 1,
      epoch: 1,
      state: 'ready'
    }
  });
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
      operationContext: {
        operationId: 'test-direct-save-message',
        epoch: 1,
        draftKey: 'aiob.sessionDraft.v1.video.page-a.test-direct',
        baseRevision: 0,
        nextRevision: 1
      },
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
  it('forwards the complete authoritative operation context on a provisional save', async () => {
    let sentMessage: object | null = null;
    const ref = { ...createRef(), byteLength: 7 };
    const client = createVideoScreenshotCacheClientRepository({
      messaging: {
        send<TResult>(message: Parameters<MessagingService['send']>[0]): Promise<TResult> {
          if (typeof message !== 'object' || message === null) {
            throw new Error('expected object message');
          }
          sentMessage = message;
          return Promise.resolve(
            castMessageResult<TResult>({
              success: true,
              operation: 'save',
              result: { status: 'saved', ref }
            })
          );
        }
      }
    });
    const context = {
      operationId: 'operation-context-forwarding',
      epoch: 7,
      draftKey: 'aiob.sessionDraft.v1.video.page-a.draft-a',
      baseRevision: 11,
      nextRevision: 12
    };

    await expect(
      client.saveProvisional(
        {
          pageKey: 'page-a',
          captureId: 'capture-a',
          screenshot: createScreenshot('shot-a', 'frame-a')
        },
        context
      )
    ).resolves.toEqual({ status: 'saved', ref });
    expect(sentMessage).toMatchObject({
      operation: 'save',
      input: { operationContext: context }
    });
  });

  it('replays a lost provisional response without a second blob write', async () => {
    let putCount = 0;
    class CountingBlobStore extends MemoryBlobStore {
      override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        putCount += 1;
        return super.put(entry);
      }
    }
    const local = new MemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: new CountingBlobStore() }
    );
    const context = {
      operationId: 'operation-lost-provisional-response',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-a.draft-a',
      baseRevision: 0,
      nextRevision: 1
    };
    await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: context.operationId,
      draftKey: context.draftKey
    });
    let loseResponse = true;
    const client = createVideoScreenshotCacheClientRepository({
      messaging: {
        async send<TResult>(message: Parameters<MessagingService['send']>[0]): Promise<TResult> {
          const response = await handler(message);
          if (
            typeof message === 'object' &&
            message !== null &&
            'operation' in message &&
            message.operation === 'save' &&
            loseResponse
          ) {
            loseResponse = false;
            throw new Error('simulated lost provisional response');
          }
          return castMessageResult<TResult>(response);
        }
      }
    });
    const input = {
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshot: createScreenshot('shot-a', 'frame-a')
    };

    await expect(client.saveProvisional(input, context)).rejects.toThrow(
      'simulated lost provisional response'
    );
    await expect(client.saveProvisional(input, context)).resolves.toMatchObject({
      status: 'saved'
    });
    expect(putCount).toBe(1);
  });

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
    expect(blobStore.peekEntry(firstRef.key)).toMatchObject({ expiresAt: BASE_TIME + 20 });
    expect(blobStore.peekEntry(secondRef.key)).toMatchObject({ expiresAt: BASE_TIME + 20 });
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
    expect(blobStore.peekEntry(ref.key)).toMatchObject({ expiresAt: BASE_TIME + 123_456 });
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
    expect(blobStore.peekEntry(ref.key)?.blob.size).toBe(
      VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
    );
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

    expect(blobStore.peekEntry(ref.key)).not.toBeNull();
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
    expect(blobStore.peekEntry(legacyRef.key)).not.toBeNull();
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

    expect(blobStore.peekEntry(ref.key)).not.toBeNull();
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

    expect(blobStore.peekEntry(ref.key)).not.toBeNull();
    const loaded = await client.load(ref);
    await expect(loaded?.content?.blob.text()).resolves.toBe('firefox');
    expectNoLegacyScreenshotCacheWrites(legacyArea);
  });

  it('serializes explicit removal and prune deletion through the background owner', async () => {
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

    expect(blobStore.peekEntry(firstRef.key)).toBeNull();
    expect(blobStore.peekEntry(secondRef.key)).toBeNull();
    expect(blobStore.snapshotKeys()).toEqual([]);
    await expect(
      blobStore.prune({
        now: nowMs,
        maxGlobalEntries: 100,
        maxPageEntries: 20,
        applyLimits: false
      })
    ).resolves.toMatchObject({ candidateKeys: [], invalidKeys: [] });
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

    await handleMessage({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'test-direct-save-message',
      draftKey: 'aiob.sessionDraft.v1.video.page-a.test-direct'
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

    await expect(client.pruneExpired()).rejects.toThrow('VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE');
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

  it('rejects extra keys at every provisional screenshot request boundary', async () => {
    const message = await createSaveMessage(createScreenshot('strict-shot', 'strict-frame'));
    expect(normalizeVideoScreenshotCacheMessage({ ...message, unexpected: true })).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage({
        ...message,
        input: { ...message.input, unexpected: true }
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage({
        ...message,
        input: {
          ...message.input,
          screenshot: {
            ...message.input.screenshot,
            content: { ...message.input.screenshot.content, unexpected: true }
          }
        }
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage({
        ...message,
        input: {
          ...message.input,
          screenshot: { ...message.input.screenshot, unexpected: true }
        }
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'pruneExpired',
        unexpected: true
      })
    ).toBeNull();
  });

  it('rejects invalid or length-mismatched serialized screenshot binary content', async () => {
    const message = await createSaveMessage(createScreenshot('strict-binary', 'strict-frame'));
    const withContent = (content: unknown) => ({
      ...message,
      input: {
        ...message.input,
        screenshot: { ...message.input.screenshot, content }
      }
    });

    expect(
      normalizeVideoScreenshotCacheMessage(
        withContent({
          encoding: 'base64',
          data: '!!!',
          byteLength: 3
        })
      )
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage(
        withContent({
          encoding: 'base64',
          data: 'YQ==',
          byteLength: 2
        })
      )
    ).toBeNull();
  });

  it('rejects invalid, empty, or oversized legacy screenshot data URLs', async () => {
    const message = await createSaveMessage(createScreenshot('strict-data-url', 'strict-frame'));
    const withDataUrl = (dataUrl: string) => ({
      ...message,
      input: {
        ...message.input,
        screenshot: { ...message.input.screenshot, content: undefined, dataUrl }
      }
    });

    expect(
      normalizeVideoScreenshotCacheMessage(withDataUrl('data:image/jpeg;base64,!!!'))
    ).toBeNull();
    expect(normalizeVideoScreenshotCacheMessage(withDataUrl('data:image/jpeg;base64,'))).toBeNull();
    expect(
      normalizeVideoScreenshotCacheMessage(withDataUrl('data:image/jpeg;base64,YWI='), {
        maxContentBytes: 1
      })
    ).toBeNull();
  });

  it('does not accept a malformed saved ref from a matching-operation response', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: asType<Pick<MessagingService, 'send'>>({
        send: () =>
          Promise.resolve({
            success: true,
            operation: 'save',
            result: { status: 'saved', ref: { garbage: true } },
            unexpected: true
          })
      })
    });

    await expect(
      client.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('strict-response', 'strict-response-frame')
      })
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE'
    });
  });

  it('rejects a valid saved ref bound to a different request identity', async () => {
    const wrongRef = {
      ...createRef(),
      pageKey: 'page-b',
      key: createVideoScreenshotCacheStorageKey({
        pageKey: 'page-b',
        captureId: 'capture-a',
        screenshotId: 'shot-a'
      })
    };
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({
        success: true,
        operation: 'save',
        result: { status: 'saved', ref: wrongRef }
      })
    });

    await expect(
      client.save({
        pageKey: 'page-a',
        captureId: 'capture-a',
        screenshot: createScreenshot('shot-a', 'a')
      })
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE'
    });
  });

  it('rejects a valid loaded screenshot bound to a different ref identity', async () => {
    const client = createVideoScreenshotCacheClientRepository({
      messaging: createStaticMessaging({
        success: true,
        operation: 'load',
        status: 'loaded',
        screenshot: {
          id: 'shot-b',
          fileName: 'shot-b.jpg',
          mimeType: 'image/jpeg',
          capturedAt: BASE_TIME,
          content: { encoding: 'base64', data: 'YQ==', byteLength: 1 }
        }
      })
    });

    await expect(client.load(createRef())).resolves.toBeNull();
  });
});
