/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { serializeBlobAttachmentContent } from '@shared/attachments/clipAttachmentBinary';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey
} from '@content/sessionDrafts/sessionDraftKeys';
import type { VideoSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobStore
} from '@content/video/videoScreenshotCacheStore';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import {
  prepareRestoreStorageLease,
  persistRestoreStorageLease
} from '../../../src/background/services/restoreStorageLeaseStore';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';

const NOW = Date.now();
const PAGE_URL = 'https://video.example/watch?v=race';

function ref(id: string): VideoScreenshotCacheRef {
  const pageKey = `page-${id}`;
  const captureId = `capture-${id}`;
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({ pageKey, captureId, screenshotId: id }),
    pageKey,
    captureId,
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 5,
    capturedAt: NOW - 1_000,
    expiresAt: NOW + 100_000
  };
}

function metadata(value: VideoScreenshotCacheRef): VideoScreenshotCacheBlobMetadata {
  return {
    ...value,
    createdAt: NOW - 900,
    updatedAt: NOW - 800,
    lastAccessedAt: NOW - 700
  };
}

function draft(value: VideoScreenshotCacheRef): VideoSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: 'draft-race',
    mode: 'video',
    pageKey: createSessionDraftPageKey('video', PAGE_URL),
    pageUrl: PAGE_URL,
    pageTitle: 'race',
    createdAt: NOW - 100,
    updatedAt: NOW - 50,
    expiresAt: NOW + 100_000,
    status: 'restorable',
    payload: {
      captures: [
        {
          kind: 'timestamp',
          id: value.captureId,
          timeSec: 1,
          url: 'https://video.example/watch?v=race',
          comment: '',
          createdAt: NOW - 50,
          screenshotRequested: true,
          screenshotRef: value
        }
      ]
    }
  };
}

class MemoryBlobStore implements VideoScreenshotCacheBlobStore {
  readonly values = new Map<string, VideoScreenshotCacheBlobEntry>();
  readonly deleteMany = vi.fn((keys: readonly string[]) => {
    keys.forEach((key) => this.values.delete(key));
    return Promise.resolve();
  });

  constructor(
    value: VideoScreenshotCacheRef,
    private readonly onListAllMetadata?: () => void
  ) {
    this.values.set(value.key, {
      ...metadata(value),
      blob: new Blob(['frame'], { type: value.mimeType })
    });
  }

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    this.values.set(entry.key, entry);
    return Promise.resolve();
  }
  get(key: string): ReturnType<VideoScreenshotCacheBlobStore['get']> {
    const entry = this.values.get(key);
    return Promise.resolve(entry ? { status: 'found', entry } : { status: 'missing' });
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  deleteAll(): Promise<number> {
    const count = this.values.size;
    this.values.clear();
    return Promise.resolve(count);
  }
  listByPageKey(pageKey: string): ReturnType<VideoScreenshotCacheBlobStore['listByPageKey']> {
    return Promise.resolve({
      entries: [...this.values.values()].filter((entry) => entry.pageKey === pageKey),
      invalidKeys: []
    });
  }
  listAllMetadata(): ReturnType<VideoScreenshotCacheBlobStore['listAllMetadata']> {
    this.onListAllMetadata?.();
    return Promise.resolve({ entries: [...this.values.values()].map(toMetadata), invalidKeys: [] });
  }
  prune(): ReturnType<VideoScreenshotCacheBlobStore['prune']> {
    return Promise.resolve({
      entries: [...this.values.values()].map(toMetadata),
      candidateKeys: [],
      invalidKeys: [],
      dirty: false
    });
  }
}

function toMetadata(entry: VideoScreenshotCacheBlobEntry): VideoScreenshotCacheBlobMetadata {
  const { blob, ...value } = entry;
  void blob;
  return value;
}

function pressureEstimate() {
  return {
    getSnapshot: vi
      .fn()
      .mockResolvedValueOnce({ usage: 950, quota: 1_000, available: 50, supported: true })
      .mockResolvedValue({ usage: 700, quota: 1_000, available: 300, supported: true })
  };
}

describe('restore storage production concurrency composition', () => {
  it('policy prune final owner read protects a ref committed after orphan selection', async () => {
    const memory = createMemoryStorageArea();
    const screenshotRef = ref('policy-prune-late-ref');
    const draftKey = createSessionDraftStorageKey(draft(screenshotRef));
    let candidateSelected = false;
    let postSelectionReads = 0;
    let signalStaleJournalRead!: () => void;
    let releaseStaleJournalRead!: () => void;
    const staleJournalReadStarted = new Promise<void>((resolve) => {
      signalStaleJournalRead = resolve;
    });
    const staleJournalReadGate = new Promise<void>((resolve) => {
      releaseStaleJournalRead = resolve;
    });
    const pruneLocal = {
      ...memory,
      async getAll() {
        if (!candidateSelected) return memory.getAll();
        postSelectionReads += 1;
        if (postSelectionReads !== 2) return memory.getAll();
        const staleSnapshot = await memory.getAll();
        signalStaleJournalRead();
        await staleJournalReadGate;
        return staleSnapshot;
      }
    };
    const blobStore = new MemoryBlobStore(screenshotRef, () => {
      candidateSelected = true;
    });
    const pruneHandler = createBackgroundVideoScreenshotCacheHandler(
      { local: pruneLocal },
      {},
      { blobStore, getEpoch: () => 7 }
    );

    const pruning = pruneHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'pruneRestoreDataToCurrentPolicy',
      operationId: 'policy-prune-late-ref'
    });
    await staleJournalReadStarted;
    expect(blobStore.deleteMany).not.toHaveBeenCalled();

    const writerHandler = createBackgroundVideoScreenshotCacheHandler(
      { local: memory },
      {},
      { blobStore, getEpoch: () => 7 }
    );
    const prepared = await writerHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'policy-prune-late-writer',
      draftKey
    });
    if (!prepared || !('context' in prepared)) throw new Error('expected prepared context');
    const saved = await writerHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'save',
      input: {
        pageKey: screenshotRef.pageKey,
        captureId: screenshotRef.captureId,
        operationContext: prepared.context,
        screenshot: {
          id: screenshotRef.id,
          fileName: screenshotRef.fileName,
          mimeType: screenshotRef.mimeType,
          capturedAt: screenshotRef.capturedAt,
          content: await serializeBlobAttachmentContent(
            new Blob(['frame'], { type: screenshotRef.mimeType })
          )
        }
      }
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
      writerHandler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context: prepared.context,
        envelope: draft(saved.result.ref)
      })
    ).resolves.toMatchObject({ success: true });
    releaseStaleJournalRead();

    await expect(pruning).resolves.toMatchObject({
      success: true,
      operation: 'pruneRestoreDataToCurrentPolicy',
      result: { newlyOrphanedScreenshots: 0 }
    });
    expect(postSelectionReads).toBe(3);
    expect(blobStore.values.has(screenshotRef.key)).toBe(true);
    expect(blobStore.deleteMany).not.toHaveBeenCalled();
  });

  it('re-reads protection after pressure selection and keeps late durable draft authority', async () => {
    const memory = createMemoryStorageArea();
    const screenshotRef = ref('queue');
    const key = createSessionDraftStorageKey(draft(screenshotRef));
    let getAllCalls = 0;
    let signalFinalInventory!: () => void;
    let releaseFinalInventory!: () => void;
    const finalInventoryStarted = new Promise<void>((resolve) => {
      signalFinalInventory = resolve;
    });
    const finalInventoryGate = new Promise<void>((resolve) => {
      releaseFinalInventory = resolve;
    });
    const pressureLocal = {
      ...memory,
      async getAll() {
        getAllCalls += 1;
        if (getAllCalls === 4) {
          signalFinalInventory();
          await finalInventoryGate;
        }
        return memory.getAll();
      }
    };
    const blobStore = new MemoryBlobStore(screenshotRef);
    const pressureHandler = createBackgroundVideoScreenshotCacheHandler(
      { local: pressureLocal },
      { maxContentBytes: 64 },
      { blobStore, getEpoch: () => 7, storageEstimate: pressureEstimate() }
    );

    const cleanup = pressureHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'runStoragePressureCleanup'
    });
    await finalInventoryStarted;
    expect(blobStore.deleteMany).not.toHaveBeenCalled();

    const writerHandler = createBackgroundVideoScreenshotCacheHandler(
      { local: memory },
      { maxContentBytes: 64 },
      { blobStore, getEpoch: () => 7 }
    );
    const prepared = await writerHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'operation-late-authority',
      draftKey: key
    });
    if (!prepared || !('context' in prepared)) throw new Error('expected prepared context');
    const saved = await writerHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'save',
      input: {
        pageKey: screenshotRef.pageKey,
        captureId: screenshotRef.captureId,
        operationContext: prepared.context,
        screenshot: {
          id: screenshotRef.id,
          fileName: screenshotRef.fileName,
          mimeType: screenshotRef.mimeType,
          capturedAt: screenshotRef.capturedAt,
          content: await serializeBlobAttachmentContent(
            new Blob(['frame'], { type: screenshotRef.mimeType })
          )
        }
      }
    });
    expect(saved).toMatchObject({ success: true, result: { status: 'saved' } });
    if (
      !saved ||
      !('result' in saved) ||
      !saved.result ||
      !('status' in saved.result) ||
      saved.result.status !== 'saved'
    ) {
      throw new Error('expected saved screenshot');
    }
    const committed = await writerHandler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'saveSessionDraft',
      context: prepared.context,
      envelope: draft(saved.result.ref)
    });
    expect(committed).toEqual({
      success: true,
      operation: 'saveSessionDraft',
      revision: 1,
      replayed: false
    });
    releaseFinalInventory();

    await expect(cleanup).resolves.toMatchObject({ success: true });
    expect(blobStore.values.has(screenshotRef.key)).toBe(true);
    expect(blobStore.deleteMany).not.toHaveBeenCalled();
  });

  it('protects a live same-epoch lease after rebuilding the production handler', async () => {
    const local = createMemoryStorageArea();
    const screenshotRef = ref('restart');
    const context = {
      operationId: 'operation-restart',
      epoch: 7,
      draftKey: 'aiob.sessionDraft.v1.video.page-restart.draft-restart',
      baseRevision: 0,
      nextRevision: 1
    };
    await prepareRestoreStorageLease(local, context, NOW - 10);
    await persistRestoreStorageLease(local, context, screenshotRef.key, undefined, NOW - 9);
    const blobStore = new MemoryBlobStore(screenshotRef);
    const restartedHandler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore, getEpoch: () => 7, storageEstimate: pressureEstimate() }
    );

    await expect(
      restartedHandler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'runStoragePressureCleanup'
      })
    ).resolves.toMatchObject({ success: true });
    expect(blobStore.values.has(screenshotRef.key)).toBe(true);
    expect(blobStore.deleteMany).not.toHaveBeenCalled();
  });
});
