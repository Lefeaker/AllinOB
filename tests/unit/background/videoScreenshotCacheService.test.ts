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
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobStore
} from '../../../src/content/video/videoScreenshotCacheStore';
import {
  pruneVideoScreenshotCacheBlobMetadataEntries,
  sortVideoScreenshotCacheBlobMetadataNewestFirst
} from '../../../src/content/video/videoScreenshotCacheStore';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../../src/content/video/videoScreenshotCacheMessages';
import type { BackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import type { RestoreCapabilityPolicyProvider } from '../../../src/shared/capabilities/capabilityPolicy';

const BASE_TIME = 2_000_000_000_000;
const PAGE_KEY = createSessionDraftPageKey('video', 'https://example.com/watch?v=video-1');

class MemoryBlobStore implements VideoScreenshotCacheBlobStore {
  private readonly values = new Map<string, VideoScreenshotCacheBlobEntry>();

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    this.values.set(entry.key, cloneBlobEntry(entry));
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

  deleteAll(): Promise<number> {
    const count = this.values.size;
    this.values.clear();
    return Promise.resolve(count);
  }

  listByPageKey(pageKey: string): Promise<VideoScreenshotCacheBlobEntry[]> {
    return Promise.resolve(this.sortedEntries().filter((entry) => entry.pageKey === pageKey));
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
  }
) {
  const blob = new Blob([options.content], { type: 'image/jpeg' });
  return handler({
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'save',
    input: {
      pageKey: PAGE_KEY,
      captureId: options.captureId ?? options.id,
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

function createNoopBlobStore(): VideoScreenshotCacheBlobStore {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
    deleteAll: () => Promise.resolve(0),
    listByPageKey: () => Promise.resolve([]),
    listAllMetadata: () => Promise.resolve([]),
    prune: () =>
      Promise.resolve({
        entries: [] satisfies VideoScreenshotCacheBlobMetadata[],
        removedKeys: [],
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

  it('uses the current restore policy for screenshot cache limit pruning after startup', async () => {
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

    expect(blobStore.snapshotIds()).toEqual(['newest']);
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
        operation: 'clearAllRestoreData'
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
      operation: 'clearAllRestoreData'
    });
    await Promise.resolve();
    expect(events).toEqual(['save:start']);
    releasePut?.();
    await Promise.all([save, clear]);
    expect(events).toEqual(['save:start', 'save:end', 'clear']);
    expect(blobStore.snapshotIds()).toEqual([]);
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
