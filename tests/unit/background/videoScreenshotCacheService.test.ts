/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import type {
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobStore
} from '../../../src/content/video/videoScreenshotCacheStore';

function createNoopBlobStore(): VideoScreenshotCacheBlobStore {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
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

    createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 2 * 1024 * 1024 }
    );

    expect(createVideoScreenshotCacheIndexedDbStore).toHaveBeenCalledWith({
      indexedDb: undefined,
      maxContentBytes: 2 * 1024 * 1024
    });
  });
});
