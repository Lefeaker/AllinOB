/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey
} from '@content/sessionDrafts/sessionDraftKeys';
import type { ReaderSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import type { VideoScreenshotCacheBlobMaintenanceStore } from '@content/video/videoScreenshotCacheStore';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import { createSessionDraftClientRepository } from '@content/sessionDrafts/sessionDraftClientRepository';
import {
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from '@content/sessionDrafts/sessionDraftSchemas';
import { SESSION_DRAFT_INDEX_KEY } from '@content/sessionDrafts/sessionDraftKeys';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts/sessionDraftStoragePolicy';

const NOW = 2_000_000_000_000;
const PAGE_URL = 'https://example.com/versioned-delete';

function envelope(updatedAt = NOW): ReaderSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: 'draft-versioned-delete',
    mode: 'reader',
    pageKey: createSessionDraftPageKey('reader', PAGE_URL),
    pageUrl: PAGE_URL,
    pageTitle: 'versioned delete',
    createdAt: NOW - 1,
    updatedAt,
    expiresAt: NOW + 100_000,
    status: 'restorable',
    payload: { highlights: [] }
  };
}

function blobStore(): VideoScreenshotCacheBlobMaintenanceStore {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve({ status: 'missing' }),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
    deleteAll: () => Promise.resolve(0),
    listByPageKey: () => Promise.resolve({ entries: [], invalidKeys: [] }),
    listAllMetadata: () => Promise.resolve({ entries: [], invalidKeys: [] }),
    prune: () => Promise.resolve({ entries: [], candidateKeys: [], invalidKeys: [], dirty: false })
  };
}

describe('production versioned session draft deletion', () => {
  it('rejects a stale prepared save, replays delete, and lets a fresh save continue', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {},
      { blobStore: blobStore(), getEpoch: () => 7 }
    );
    const key = createSessionDraftStorageKey(envelope());
    const firstPrepare = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'save-first',
      draftKey: key
    });
    if (!firstPrepare || !('context' in firstPrepare)) throw new Error('expected context');
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context: firstPrepare.context,
        envelope: envelope()
      })
    ).resolves.toMatchObject({ success: true, revision: 1 });

    const stalePrepare = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'save-stale',
      draftKey: key,
      expectedEpoch: 7,
      expectedRevision: 1
    });
    if (!stalePrepare || !('context' in stalePrepare)) throw new Error('expected stale context');
    const removeMessage = {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'removeSessionDraft' as const,
      operationId: 'delete-versioned',
      target: { key }
    };
    const removed = await handler(removeMessage);
    expect(removed).toMatchObject({
      success: true,
      result: { epoch: 7, revisions: [{ draftKey: key, revision: 2 }], replayed: false }
    });
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context: stalePrepare.context,
        envelope: envelope(NOW + 1)
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_REVISION_CONFLICT' });
    await expect(handler(removeMessage)).resolves.toMatchObject({
      success: true,
      result: { revisions: [{ draftKey: key, revision: 2 }], replayed: true }
    });

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId: 'save-explicit-stale-zero',
        draftKey: key,
        expectedEpoch: 7,
        expectedRevision: 0
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_REVISION_CONFLICT' });

    const fresh = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'save-fresh',
      draftKey: key
    });
    if (!fresh || !('context' in fresh)) throw new Error('expected fresh context');
    expect(fresh.context).toMatchObject({ epoch: 7, baseRevision: 2, nextRevision: 3 });
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context: fresh.context,
        envelope: envelope(NOW + 2)
      })
    ).resolves.toMatchObject({ success: true, revision: 3 });
    await expect(local.get(key)).resolves.toEqual(envelope(NOW + 2));
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
    ).resolves.toMatchObject({ epoch: 7, state: 'present', revision: 3 });
  });

  it('reuses the exact remove operation after a lost response and learns the deleted cursor', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {},
      { blobStore: blobStore(), getEpoch: () => 7 }
    );
    let sequence = 0;
    let loseRemove = true;
    const removeOperationIds: string[] = [];
    const client = createSessionDraftClientRepository(
      {
        async send(message) {
          const response = await handler(message);
          if (message.operation === 'removeSessionDraft') {
            removeOperationIds.push(message.operationId);
            if (loseRemove) {
              loseRemove = false;
              throw new Error('lost remove response');
            }
          }
          return response;
        }
      },
      { createOperationId: () => `client-operation-${sequence++}` }
    );
    await client.save(envelope());
    const key = createSessionDraftStorageKey(envelope());

    await expect(client.remove({ key })).rejects.toThrow('lost remove response');
    await expect(client.remove({ key })).resolves.toBeUndefined();
    expect(removeOperationIds).toEqual([removeOperationIds[0], removeOperationIds[0]]);
    await client.save(envelope(NOW + 3));
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
    ).resolves.toMatchObject({ epoch: 7, state: 'present', revision: 3 });
  });

  it('routes pressure-expired drafts through the versioned deletion owner', async () => {
    const local = createMemoryStorageArea();
    const expired = {
      ...envelope(1),
      draftId: 'draft-pressure-expired',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2
    };
    const key = createSessionDraftStorageKey(expired);
    await local.setMany({
      [key]: expired,
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([createSessionDraftIndexEntry(expired)])
    });
    const policy = createSessionDraftStoragePolicy({
      retentionPolicy: { retentionMs: 1, maxRestorablePages: null, maxItemsPerPage: null }
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { getCurrentPolicy: () => policy },
      {
        blobStore: blobStore(),
        getEpoch: () => 7,
        storageEstimate: {
          getSnapshot: () =>
            Promise.resolve({ usage: 950, quota: 1_000, available: 50, supported: true })
        }
      }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'runStoragePressureCleanup'
      })
    ).resolves.toMatchObject({
      success: true,
      result: { removed: { expiredDrafts: 1 } }
    });
    await expect(local.get(key)).resolves.toBeUndefined();
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
    ).resolves.toMatchObject({ epoch: 7, state: 'deleted', revision: 1 });
    await expect(
      local.get(`aiob.restoreStorage.tombstone.v1.${encodeURIComponent(key)}`)
    ).resolves.toMatchObject({ epoch: 7, state: 'deleted', revision: 1 });
    await expect(local.get('aiob.restoreStorage.barrier.v1')).resolves.toEqual({
      schemaVersion: 1,
      epoch: 7,
      state: 'ready'
    });
  });

  it('invalidates a stale client cursor after pressure deletion and recovers on the next save', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const policy = createSessionDraftStoragePolicy({
        retentionPolicy: { retentionMs: 1, maxRestorablePages: null, maxItemsPerPage: null }
      });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { getCurrentPolicy: () => policy },
        {
          blobStore: blobStore(),
          getEpoch: () => 7,
          storageEstimate: {
            getSnapshot: () =>
              Promise.resolve({ usage: 950, quota: 1_000, available: 50, supported: true })
          }
        }
      );
      let sequence = 0;
      const client = createSessionDraftClientRepository(
        { send: (message) => handler(message) },
        { createOperationId: () => `pressure-client-${sequence++}` }
      );
      await client.save(envelope());
      const key = createSessionDraftStorageKey(envelope());
      vi.setSystemTime(NOW + 10);

      await expect(
        handler({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'runStoragePressureCleanup'
        })
      ).resolves.toMatchObject({ result: { removed: { expiredDrafts: 1 } } });
      await expect(
        local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
      ).resolves.toMatchObject({ state: 'deleted', revision: 2 });
      await expect(client.save(envelope(NOW + 20))).rejects.toThrow(
        'RESTORE_STORAGE_REVISION_CONFLICT'
      );
      await expect(client.save(envelope(NOW + 20))).resolves.toBeUndefined();
      await expect(
        local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
      ).resolves.toMatchObject({ state: 'present', revision: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes explicit prune through the versioned owner and replays it', async () => {
    const local = createMemoryStorageArea();
    const expired = { ...envelope(1), createdAt: 1, updatedAt: 1, expiresAt: 2 };
    const key = createSessionDraftStorageKey(expired);
    await local.setMany({
      [key]: expired,
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([createSessionDraftIndexEntry(expired)])
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {},
      { blobStore: blobStore(), getEpoch: () => 7 }
    );
    const message = {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'pruneExpiredSessionDrafts' as const,
      operationId: 'prune-versioned',
      now: NOW
    };

    await expect(handler(message)).resolves.toMatchObject({
      success: true,
      result: { revisions: [{ draftKey: key, revision: 1 }], replayed: false }
    });
    await expect(handler(message)).resolves.toMatchObject({
      success: true,
      result: { revisions: [{ draftKey: key, revision: 1 }], replayed: true }
    });
  });

  it('routes string draft-id removal across pages through one replayable owner operation', async () => {
    const local = createMemoryStorageArea();
    const draftId = 'shared-draft-id';
    const firstUrl = 'https://example.com/remove-by-id/first';
    const secondUrl = 'https://example.com/remove-by-id/second';
    const first = {
      ...envelope(NOW),
      draftId,
      pageUrl: firstUrl,
      pageKey: createSessionDraftPageKey('reader', firstUrl)
    };
    const second = {
      ...envelope(NOW + 1),
      draftId,
      pageUrl: secondUrl,
      pageKey: createSessionDraftPageKey('reader', secondUrl)
    };
    const firstKey = createSessionDraftStorageKey(first);
    const secondKey = createSessionDraftStorageKey(second);
    const keys = [firstKey, secondKey].sort();
    await local.setMany({
      [firstKey]: first,
      [secondKey]: second,
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([
        createSessionDraftIndexEntry(first),
        createSessionDraftIndexEntry(second)
      ])
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {},
      { blobStore: blobStore(), getEpoch: () => 7 }
    );
    const message = {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'removeSessionDraft' as const,
      operationId: 'remove-shared-draft-id',
      target: draftId
    };
    const expectedRevisions = keys.map((draftKey) => ({ draftKey, revision: 1 }));

    await expect(handler(message)).resolves.toEqual({
      success: true,
      operation: 'removeSessionDraft',
      result: {
        epoch: 7,
        revisions: expectedRevisions,
        protectedKeys: [],
        replayed: false
      }
    });
    for (const key of keys) {
      await expect(
        local.get(`aiob.restoreStorage.tombstone.v1.${encodeURIComponent(key)}`)
      ).resolves.toMatchObject({ state: 'deleted', revision: 1 });
    }
    await expect(handler(message)).resolves.toEqual({
      success: true,
      operation: 'removeSessionDraft',
      result: {
        epoch: 7,
        revisions: expectedRevisions,
        protectedKeys: [],
        replayed: true
      }
    });
  });

  it('routes save-retention eviction through the versioned owner', async () => {
    const local = createMemoryStorageArea();
    const policy = createSessionDraftStoragePolicy({ maxDraftEntries: 1 });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { getCurrentPolicy: () => policy },
      { blobStore: blobStore(), getEpoch: () => 7 }
    );
    const client = createSessionDraftClientRepository({ send: (message) => handler(message) });
    const first = { ...envelope(NOW), draftId: 'retention-first' };
    const second = { ...envelope(NOW + 1), draftId: 'retention-second' };
    const firstKey = createSessionDraftStorageKey(first);
    await client.save(first);
    await client.save(second);

    await expect(local.get(firstKey)).resolves.toBeUndefined();
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(firstKey)}`)
    ).resolves.toMatchObject({ state: 'deleted', revision: 2 });
  });

  it('routes malformed-envelope index repair through the versioned owner', async () => {
    const local = createMemoryStorageArea();
    const key = createSessionDraftStorageKey(envelope());
    await local.set(key, { schemaVersion: 99, malformed: true });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {},
      { blobStore: blobStore(), getEpoch: () => 7 }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'loadLatestSessionDraft',
        mode: 'reader',
        pageUrl: PAGE_URL
      })
    ).resolves.toMatchObject({ success: true, result: { envelope: null } });
    await expect(local.get(key)).resolves.toBeUndefined();
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(key)}`)
    ).resolves.toMatchObject({ state: 'deleted', revision: 1 });
  });
});
