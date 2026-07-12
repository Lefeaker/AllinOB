/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { serializeBlobAttachmentContent } from '@shared/attachments/clipAttachmentBinary';
import {
  createSessionDraftPageKey,
  createSessionDraftStoragePolicy,
  type SessionDraftStoragePolicy
} from '@content/sessionDrafts';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobStore
} from '../../../src/content/video/videoScreenshotCacheStore';
import {
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst
} from '../../../src/content/video/videoScreenshotCacheStore';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../../src/content/video/videoScreenshotCacheMessages';
import type { BackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import {
  prepareRestoreStorageLease,
  persistRestoreStorageLease,
  rollbackRestoreStorageLeaseKey
} from '../../../src/background/services/restoreStorageLeaseStore';
import type { RestoreCapabilityPolicyProvider } from '../../../src/shared/capabilities/capabilityPolicy';

const BASE_TIME = 2_000_000_000_000;
const PAGE_KEY = createSessionDraftPageKey('video', 'https://example.com/watch?v=video-1');

class MemoryBlobStore implements VideoScreenshotCacheBlobStore {
  private readonly values = new Map<string, VideoScreenshotCacheBlobEntry>();

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    this.values.set(entry.key, cloneBlobEntry(entry));
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

  listByPageKey(pageKey: string): ReturnType<VideoScreenshotCacheBlobStore['listByPageKey']> {
    return Promise.resolve({
      entries: this.sortedEntries().filter((entry) => entry.pageKey === pageKey),
      invalidKeys: []
    });
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

  snapshotIds(): string[] {
    return this.sortedEntries().map((entry) => entry.id);
  }

  private sortedEntries(): VideoScreenshotCacheBlobEntry[] {
    return sortVideoScreenshotCacheBlobMetadataNewestFirst(
      [...this.values.values()].map(cloneBlobEntry)
    );
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

function createPolicyProvider(
  getPolicy: () => SessionDraftStoragePolicy
): RestoreCapabilityPolicyProvider {
  return {
    getCurrentPolicy: getPolicy
  };
}

async function saveScreenshot(
  handler: BackgroundVideoScreenshotCacheHandler,
  options: {
    id: string;
    captureId?: string;
    content: string;
    capturedAt?: number;
    operationContext?: {
      operationId: string;
      epoch: number;
      draftKey: string;
      baseRevision: number;
      nextRevision: number;
    };
  }
) {
  const blob = new Blob([options.content], { type: 'image/jpeg' });
  const operationContext = options.operationContext ?? {
    operationId: `test-screenshot-${options.id}`,
    epoch: 1,
    draftKey: `aiob.sessionDraft.v1.video.${PAGE_KEY}.test-${options.id}`,
    baseRevision: 0,
    nextRevision: 1
  };
  if (!options.operationContext) {
    await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: operationContext.operationId,
      draftKey: operationContext.draftKey
    });
  }
  return handler({
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'save',
    input: {
      pageKey: PAGE_KEY,
      captureId: options.captureId ?? options.id,
      operationContext,
      screenshot: {
        id: options.id,
        fileName: `${options.id}.jpg`,
        mimeType: 'image/jpeg',
        capturedAt: options.capturedAt ?? BASE_TIME,
        content: await serializeBlobAttachmentContent(blob)
      }
    }
  });
}

function createNoopBlobStore(): VideoScreenshotCacheBlobMaintenanceStore {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve({ status: 'missing' }),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
    deleteAll: () => Promise.resolve(0),
    listByPageKey: () => Promise.resolve({ entries: [], invalidKeys: [] }),
    listAllMetadata: () => Promise.resolve({ entries: [], invalidKeys: [] }),
    prune: () =>
      Promise.resolve({
        entries: [] satisfies VideoScreenshotCacheBlobMetadata[],
        candidateKeys: [],
        invalidKeys: [],
        dirty: false
      })
  };
}

describe('videoScreenshotCacheService', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/background/services/videoScreenshotCacheIndexedDbStore');
    vi.resetModules();
  });

  it('passes the repository content byte cap to the default IndexedDB blob store', async () => {
    const blobStore = createNoopBlobStore();
    const createVideoScreenshotCacheIndexedDbStore = vi.fn(() => blobStore);
    vi.doMock('../../../src/background/services/videoScreenshotCacheIndexedDbStore', () => ({
      createVideoScreenshotCacheIndexedDbStore
    }));

    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');

    await createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 2 * 1024 * 1024 }
    )({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'pruneExpired'
    });

    expect(createVideoScreenshotCacheIndexedDbStore).toHaveBeenCalledWith({
      indexedDb: undefined,
      maxContentBytes: 2 * 1024 * 1024
    });
  });

  it('uses the current restore policy for screenshot cache saves after startup', async () => {
    let currentPolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        maxContentBytes: 4
      }
    });
    const blobStore = new MemoryBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      createPolicyProvider(() => currentPolicy),
      { blobStore }
    );

    const rejected = await saveScreenshot(handler, {
      id: 'large-before-refresh',
      content: '12345'
    });

    expect(rejected).toBeUndefined();
    expect(blobStore.snapshotIds()).toEqual([]);

    currentPolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        maxContentBytes: 16
      }
    });

    const accepted = await saveScreenshot(handler, {
      id: 'large-after-refresh',
      content: '12345'
    });

    expect(accepted).toMatchObject({
      success: true,
      operation: 'save',
      result: {
        status: 'saved'
      }
    });
    expect(blobStore.snapshotIds()).toEqual(['large-after-refresh']);
  });

  it('uses the current restore policy for non-deleting cache candidate selection after startup', async () => {
    let currentPolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        maxGlobalEntries: 5,
        maxPageEntries: 5,
        maxContentBytes: 64
      }
    });
    const blobStore = new MemoryBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      createPolicyProvider(() => currentPolicy),
      { blobStore }
    );

    await saveScreenshot(handler, { id: 'oldest', content: 'a', capturedAt: BASE_TIME });
    await saveScreenshot(handler, { id: 'middle', content: 'b', capturedAt: BASE_TIME + 1 });
    await saveScreenshot(handler, { id: 'newest', content: 'c', capturedAt: BASE_TIME + 2 });
    expect(blobStore.snapshotIds()).toEqual(['newest', 'middle', 'oldest']);

    currentPolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        maxGlobalEntries: 1,
        maxPageEntries: 5,
        maxContentBytes: 64
      }
    });

    await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'pruneToLimits'
    });

    expect(blobStore.snapshotIds()).toEqual(['newest', 'middle', 'oldest']);
    await expect(
      blobStore.prune({
        now: Date.now(),
        maxGlobalEntries: 1,
        maxPageEntries: 5,
        maxContentBytes: 64,
        applyLimits: true
      })
    ).resolves.toMatchObject({
      candidateKeys: [expect.stringContaining('middle'), expect.stringContaining('oldest')],
      invalidKeys: []
    });
  });

  it('schema-validates clearAllRestoreData and removes only restore storage', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new MemoryBlobStore();
    const draftKey = 'aiob.sessionDraft.v1.reader.page-a.draft-a';
    await local.setMany({
      [draftKey]: { malformed: true },
      ordinary: { keep: true }
    });
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    await saveScreenshot(handler, { id: 'clear-me', content: 'frame' });

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'clearAllRestoreData',
        operationId: 'clear-schema'
      })
    ).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 1,
        screenshotEntriesRemoved: 1,
        legacyScreenshotKeysRemoved: 0
      }
    });
    expect(blobStore.snapshotIds()).toEqual([]);
    await expect(local.get('ordinary')).resolves.toEqual({ keep: true });
    await expect(
      handler({ type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: 'clearRestoreData' })
    ).resolves.toBeUndefined();
  });

  it('serializes clear after an in-flight screenshot save', async () => {
    const events: string[] = [];
    let releasePut: (() => void) | undefined;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    class OrderedBlobStore extends MemoryBlobStore {
      override async put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        events.push('save:start');
        await putGate;
        await super.put(entry);
        events.push('save:end');
      }

      override async deleteAll(): Promise<number> {
        events.push('clear');
        return super.deleteAll();
      }
    }
    const blobStore = new OrderedBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore }
    );

    const save = saveScreenshot(handler, { id: 'ordered', content: 'frame' });
    await vi.waitFor(() => expect(events).toEqual(['save:start']));
    const clear = handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: 'clear-after-save'
    });
    await Promise.resolve();
    expect(events).toEqual(['save:start']);
    releasePut?.();
    await Promise.all([save, clear]);
    expect(events).toEqual(['save:start', 'save:end', 'clear']);
    expect(blobStore.snapshotIds()).toEqual([]);
  });

  it('persists the provisional lease before making a screenshot blob visible', async () => {
    const events: string[] = [];
    const memoryLocal = createMemoryStorageArea();
    const local = {
      ...memoryLocal,
      set<Value>(key: string, value: Value) {
        if (key.startsWith('aiob.restoreStorage.lease.v1.')) {
          events.push('lease:set');
        }
        return memoryLocal.set(key, value);
      }
    };
    class OrderedBlobStore extends MemoryBlobStore {
      override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        events.push('blob:put');
        return super.put(entry);
      }
    }
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: new OrderedBlobStore() }
    );
    const context = {
      operationId: 'operation-leased-before-visible',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    await prepareRestoreStorageLease(local, context);
    events.length = 0;

    await saveScreenshot(handler, {
      id: 'leased-before-visible',
      content: 'frame',
      operationContext: context
    });

    expect(events.slice(0, 2)).toEqual(['lease:set', 'blob:put']);
    const lease = await local.get<{
      schemaVersion: number;
      operationId: string;
      epoch: number;
      draftKey: string;
      baseRevision: number;
      draftRevision: number;
      createdAt: number;
      expiresAt: number;
    }>('aiob.restoreStorage.lease.v1.operation-leased-before-visible');
    expect(lease).toMatchObject({
      schemaVersion: 1,
      operationId: 'operation-leased-before-visible',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      draftRevision: 1
    });
    expect(lease ? lease.expiresAt - lease.createdAt : null).toBe(15 * 60 * 1_000);
  });

  it('rejects a provisional screenshot without prepare authority before blob visibility', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new MemoryBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );

    await expect(
      saveScreenshot(handler, {
        id: 'missing-prepare',
        content: 'frame',
        operationContext: {
          operationId: 'operation-missing-prepare',
          epoch: 1,
          draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
          baseRevision: 0,
          nextRevision: 1
        }
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_LEASE_CONFLICT' });
    expect(blobStore.snapshotIds()).toEqual([]);
    await expect(local.getAll()).resolves.toEqual({
      'aiob.restoreStorage.barrier.v1': {
        schemaVersion: 1,
        epoch: 1,
        state: 'ready'
      }
    });
  });

  it('uses one injected epoch authority for draft preparation and screenshot deletion', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new MemoryBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore, getEpoch: () => 7 }
    );
    const draftKey = 'aiob.sessionDraft.v1.video.page-epoch.draft-epoch';
    const prepared = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'operation-epoch-seven',
      draftKey
    });
    expect(prepared).toMatchObject({
      success: true,
      operation: 'prepareSessionDraftOperation',
      context: { epoch: 7, draftKey }
    });
    if (!prepared || !('context' in prepared)) throw new Error('expected prepared context');

    const saved = await saveScreenshot(handler, {
      id: 'epoch-seven',
      content: 'frame',
      operationContext: prepared.context
    });
    expect(saved).toMatchObject({
      success: true,
      operation: 'save',
      result: { status: 'saved' }
    });
    if (
      !saved ||
      !('result' in saved) ||
      !saved.result ||
      !('status' in saved.result) ||
      saved.result.status !== 'saved'
    ) {
      throw new Error('expected saved screenshot');
    }

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'remove',
        ref: saved.result.ref
      })
    ).resolves.toEqual({ success: true, operation: 'remove' });
    expect(blobStore.snapshotIds()).toEqual(['epoch-seven']);
  });

  it('keeps the original empty prepared lease and ttl after a provisional blob failure', async () => {
    const local = createMemoryStorageArea();
    let failPut = true;
    class FailingOnceBlobStore extends MemoryBlobStore {
      override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        if (failPut) {
          failPut = false;
          return Promise.reject(new Error('simulated first provisional failure'));
        }
        return super.put(entry);
      }
    }
    const blobStore = new FailingOnceBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    const context = {
      operationId: 'operation-provisional-retry-ttl',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    const leaseKey = `aiob.restoreStorage.lease.v1.${context.operationId}`;
    await prepareRestoreStorageLease(local, context);
    const prepared = await local.get<{ createdAt: number; expiresAt: number }>(leaseKey);

    await saveScreenshot(handler, {
      id: 'provisional-retry',
      content: 'first',
      operationContext: context
    });
    await expect(local.get(leaseKey)).resolves.toMatchObject({ screenshotKeys: [] });
    await saveScreenshot(handler, {
      id: 'provisional-retry',
      content: 'second',
      operationContext: context
    });
    await expect(local.get(leaseKey)).resolves.toMatchObject({
      createdAt: prepared?.createdAt,
      expiresAt: prepared?.expiresAt
    });
  });

  it('never overwrites an existing same-key blob and replays only an exact fingerprint', async () => {
    const local = createMemoryStorageArea();
    let putCount = 0;
    class CountingBlobStore extends MemoryBlobStore {
      override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        putCount += 1;
        return super.put(entry);
      }
    }
    const blobStore = new CountingBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    const baseContext = {
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    const firstContext = { ...baseContext, operationId: 'same-key-first' };
    await prepareRestoreStorageLease(local, firstContext);
    const first = await saveScreenshot(handler, {
      id: 'same-key',
      content: 'first',
      operationContext: firstContext
    });
    if (
      !first ||
      !('operation' in first) ||
      first.operation !== 'save' ||
      !('result' in first) ||
      first.result.status !== 'saved'
    ) {
      throw new Error('expected first screenshot save');
    }

    const replayContext = { ...baseContext, operationId: 'same-key-replay' };
    await prepareRestoreStorageLease(local, replayContext);
    await expect(
      saveScreenshot(handler, {
        id: 'same-key',
        content: 'first',
        operationContext: replayContext
      })
    ).resolves.toMatchObject({ success: true, result: { status: 'saved' } });
    expect(putCount).toBe(1);

    const conflictContext = { ...baseContext, operationId: 'same-key-conflict' };
    await prepareRestoreStorageLease(local, conflictContext);
    await expect(
      saveScreenshot(handler, {
        id: 'same-key',
        content: 'second',
        operationContext: conflictContext
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_LEASE_CONFLICT' });
    expect(putCount).toBe(1);
    const stored = await blobStore.get(first.result.ref.key);
    expect(stored.status).toBe('found');
    if (stored.status !== 'found') throw new Error('expected retained first screenshot');
    await expect(stored.entry.blob.text()).resolves.toBe('first');
    await expect(
      local.get('aiob.restoreStorage.lease.v1.same-key-conflict')
    ).resolves.toMatchObject({ screenshotKeys: [], screenshotFingerprints: {} });
  });

  it('unions same-context lease keys without extending TTL and rejects operation collisions', async () => {
    const local = createMemoryStorageArea();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: new MemoryBlobStore() }
    );
    const context = {
      operationId: 'operation-lease-union',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    await prepareRestoreStorageLease(local, context);
    await saveScreenshot(handler, { id: 'lease-a', content: 'a', operationContext: context });
    const key = 'aiob.restoreStorage.lease.v1.operation-lease-union';
    const first = await local.get<{
      createdAt: number;
      expiresAt: number;
      screenshotKeys: string[];
    }>(key);
    await saveScreenshot(handler, { id: 'lease-b', content: 'b', operationContext: context });
    const union = await local.get<{
      createdAt: number;
      expiresAt: number;
      screenshotKeys: string[];
    }>(key);

    expect(union?.screenshotKeys).toHaveLength(2);
    expect(union?.createdAt).toBe(first?.createdAt);
    expect(union?.expiresAt).toBe(first?.expiresAt);
    await expect(
      saveScreenshot(handler, {
        id: 'lease-collision',
        content: 'c',
        operationContext: { ...context, draftKey: `${context.draftKey}-other` }
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_LEASE_CONFLICT' });
    await expect(local.get(key)).resolves.toEqual(union);
  });

  it('rejects reuse of an expired lease operation without renewing it', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-expired-lease-reuse';
    const leaseKey = `aiob.restoreStorage.lease.v1.${operationId}`;
    const expiredLease = {
      schemaVersion: 1,
      operationId,
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['expired-key'],
      createdAt: 1,
      expiresAt: 2
    };
    await local.set(leaseKey, expiredLease);
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: new MemoryBlobStore() }
    );

    await expect(
      saveScreenshot(handler, {
        id: 'expired-reuse',
        content: 'frame',
        operationContext: {
          operationId,
          epoch: 1,
          draftKey: expiredLease.draftKey,
          baseRevision: 0,
          nextRevision: 1
        }
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_LEASE_CONFLICT' });
    await expect(local.get(leaseKey)).resolves.toEqual(expiredLease);
  });

  it('rejects lease-key payload operation mismatches on persist and rollback', async () => {
    const local = createMemoryStorageArea();
    const context = {
      operationId: 'operation-lease-payload-binding',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    const leaseKey = `aiob.restoreStorage.lease.v1.${context.operationId}`;
    const createdAt = Date.now() - 1;
    const mismatched = {
      schemaVersion: 1,
      operationId: 'operation-other-payload',
      epoch: 1,
      draftKey: context.draftKey,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['existing-key'],
      createdAt,
      expiresAt: createdAt + 15 * 60 * 1_000
    };
    await local.set(leaseKey, mismatched);

    await expect(persistRestoreStorageLease(local, context, 'new-key')).rejects.toThrow(
      'RESTORE_STORAGE_LEASE_CONFLICT'
    );
    await expect(rollbackRestoreStorageLeaseKey(local, context, 'existing-key')).rejects.toThrow(
      'RESTORE_STORAGE_LEASE_CONFLICT'
    );
    await expect(local.get(leaseKey)).resolves.toEqual(mismatched);
  });

  it('rolls back only the failed screenshot key from a multi-key lease', async () => {
    const local = createMemoryStorageArea();
    class FailingSecondBlobStore extends MemoryBlobStore {
      override put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
        return entry.id === 'lease-failed'
          ? Promise.reject(new Error('simulated blob failure'))
          : super.put(entry);
      }
    }
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: new FailingSecondBlobStore() }
    );
    const context = {
      operationId: 'operation-partial-lease-rollback',
      epoch: 1,
      draftKey: 'aiob.sessionDraft.v1.video.page-lease.draft-lease',
      baseRevision: 0,
      nextRevision: 1
    };
    await prepareRestoreStorageLease(local, context);
    await saveScreenshot(handler, { id: 'lease-kept', content: 'kept', operationContext: context });
    const leaseKey = `aiob.restoreStorage.lease.v1.${context.operationId}`;
    const before = await local.get<{ screenshotKeys: string[] }>(leaseKey);
    await saveScreenshot(handler, {
      id: 'lease-failed',
      content: 'failed',
      operationContext: context
    });
    const after = await local.get<{ screenshotKeys: string[] }>(leaseKey);

    expect(before?.screenshotKeys).toHaveLength(1);
    expect(after?.screenshotKeys).toEqual(before?.screenshotKeys);
  });

  it('serializes clear after an in-flight screenshot prune', async () => {
    const events: string[] = [];
    let releasePrune: (() => void) | undefined;
    const pruneGate = new Promise<void>((resolve) => {
      releasePrune = resolve;
    });
    class OrderedBlobStore extends MemoryBlobStore {
      override async prune(options: Parameters<VideoScreenshotCacheBlobStore['prune']>[0]) {
        events.push('prune:start');
        await pruneGate;
        const result = await super.prune(options);
        events.push('prune:end');
        return result;
      }

      override async deleteAll(): Promise<number> {
        events.push('clear');
        return super.deleteAll();
      }
    }
    const blobStore = new OrderedBlobStore();
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore }
    );

    const prune = handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'pruneExpired'
    });
    await vi.waitFor(() => expect(events).toEqual(['prune:start']));
    const clear = handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: 'clear-after-prune'
    });
    await Promise.resolve();
    expect(events).toEqual(['prune:start']);
    releasePrune?.();
    await Promise.all([prune, clear]);
    expect(events).toEqual(['prune:start', 'prune:end', 'clear']);
  });

  it('routes sanitized pressure inspection and cleanup through the serialized owner', async () => {
    const blobStore = new MemoryBlobStore();
    const getSnapshot = vi.fn(() =>
      Promise.resolve({ usage: 950, quota: 1_000, available: 50, supported: true })
    );
    const { createBackgroundVideoScreenshotCacheHandler } =
      await import('../../../src/background/services/videoScreenshotCacheService');
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore, storageEstimate: { getSnapshot } }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'inspectStoragePressure'
      })
    ).resolves.toMatchObject({
      success: true,
      operation: 'inspectStoragePressure',
      result: { triggered: true, reason: 'pressure-detected' }
    });
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'runStoragePressureCleanup'
      })
    ).resolves.toMatchObject({
      success: true,
      operation: 'runStoragePressureCleanup',
      result: { triggered: true, reason: 'cleanup-exhausted' }
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });
});
