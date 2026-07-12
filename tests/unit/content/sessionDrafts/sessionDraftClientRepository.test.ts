/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from '@content/sessionDrafts/sessionDraftKeys';
import {
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from '@content/sessionDrafts/sessionDraftSchemas';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts/sessionDraftStoragePolicy';
import { createSessionDraftClientRepository } from '@content/sessionDrafts/sessionDraftClientRepository';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import type { SessionDraftRepositoryMessaging } from '@content/sessionDrafts/sessionDraftClientRepository';
import { normalizeSessionDraftRepositoryMessage } from '@content/sessionDrafts/sessionDraftRepositoryMessages';
import type { VideoSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobMetadata
} from '@content/video/videoScreenshotCacheStore';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import { createBackgroundVideoScreenshotCacheHandler as createRawBackgroundVideoScreenshotCacheHandler } from '../../../../src/background/services/videoScreenshotCacheService';
import {
  writePendingJournal,
  finalizeJournal,
  type SessionDraftSaveJournal
} from '../../../../src/background/services/sessionDraftSaveJournal';
import {
  createEnvelopeFingerprint,
  createRequestFingerprint
} from '../../../../src/background/services/sessionDraftFingerprint';
import { pruneRestoreStorageLeases } from '../../../../src/background/services/restoreStorageLeaseMaintenance';
import { pruneSessionDraftRetiredOperations } from '../../../../src/background/services/sessionDraftRetiredOperationMaintenance';
import { createVideoScreenshotRequestFingerprint } from '../../../../src/background/services/videoScreenshotCacheFingerprint';
import { serializeVideoScreenshot } from '../../../../src/background/services/videoScreenshotCacheSerialization';

const NOW = 2_000_000_000_000;
const PAGE_URL = 'https://video.example/client';
const PAGE_KEY = createSessionDraftPageKey('video', PAGE_URL);
const DRAFT_KEY = createSessionDraftStorageKey({
  mode: 'video',
  pageKey: PAGE_KEY,
  draftId: 'draft-client'
});

function screenshotRef(): VideoScreenshotCacheRef {
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({
      pageKey: 'page-client',
      captureId: 'capture-client',
      screenshotId: 'shot-client'
    }),
    pageKey: 'page-client',
    captureId: 'capture-client',
    id: 'shot-client',
    fileName: 'shot-client.jpg',
    mimeType: 'image/jpeg',
    byteLength: 5,
    capturedAt: NOW,
    expiresAt: NOW + 100_000
  };
}

function envelope(ref: VideoScreenshotCacheRef): VideoSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: 'draft-client',
    mode: 'video',
    pageKey: PAGE_KEY,
    pageUrl: PAGE_URL,
    pageTitle: 'client',
    createdAt: NOW,
    updatedAt: NOW + 1,
    expiresAt: NOW + 100_000,
    status: 'active',
    payload: {
      captures: [
        {
          kind: 'timestamp',
          id: 'capture-client',
          timeSec: 1,
          url: 'https://video.example/client',
          comment: '',
          createdAt: NOW,
          screenshotRequested: true,
          screenshotRef: ref
        }
      ]
    }
  };
}

function createBlobStore(
  entry: VideoScreenshotCacheBlobEntry | null
): VideoScreenshotCacheBlobMaintenanceStore {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(entry ? { status: 'found', entry } : { status: 'missing' }),
    delete: () => Promise.resolve(),
    deleteMany: () => Promise.resolve(),
    deleteAll: () => Promise.resolve(entry ? 1 : 0),
    listByPageKey: () => Promise.resolve({ entries: entry ? [entry] : [], invalidKeys: [] }),
    listAllMetadata: () => Promise.resolve({ entries: entry ? [entry] : [], invalidKeys: [] }),
    prune: () =>
      Promise.resolve({
        entries: (entry ? [entry] : []) satisfies VideoScreenshotCacheBlobMetadata[],
        candidateKeys: [],
        invalidKeys: [],
        dirty: false
      })
  };
}

function blobEntry(ref: VideoScreenshotCacheRef): VideoScreenshotCacheBlobEntry {
  return {
    ...ref,
    createdAt: NOW,
    updatedAt: NOW,
    blob: new Blob(['frame'], { type: ref.mimeType })
  };
}

function saveMessage(
  draftEnvelope: VideoSessionDraftEnvelope,
  operationId: string,
  baseRevision: number,
  nextRevision: number
) {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'saveSessionDraft',
    context: {
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision,
      nextRevision
    },
    envelope: draftEnvelope
  };
}

function handlerMessaging(
  handler: ReturnType<typeof createBackgroundVideoScreenshotCacheHandler>
): SessionDraftRepositoryMessaging {
  return {
    async send(message) {
      return handler(message);
    }
  };
}

function staticMessaging(response: object): SessionDraftRepositoryMessaging {
  return {
    send() {
      return Promise.resolve(response);
    }
  };
}

function createBackgroundVideoScreenshotCacheHandler(
  ...args: Parameters<typeof createRawBackgroundVideoScreenshotCacheHandler>
): ReturnType<typeof createRawBackgroundVideoScreenshotCacheHandler> {
  const handler = createRawBackgroundVideoScreenshotCacheHandler(...args);
  return async (rawMessage) => {
    const message = normalizeSessionDraftRepositoryMessage(rawMessage);
    if (message?.operation === 'saveSessionDraft') {
      await handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId: message.context.operationId,
        draftKey: message.context.draftKey
      });
    }
    return handler(rawMessage);
  };
}

describe('background session draft client repository protocol', () => {
  it('rejects a newly introduced ref without a matching live lease and blob', async () => {
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(saveMessage(envelope(screenshotRef()), 'operation-missing-ref', 0, 1))
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED'
    });
  });

  it('rejects a delayed lower revision after a newer revision commits', async () => {
    const local = createMemoryStorageArea();
    const blobStore = createBlobStore(null);
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    const withoutRefs = { ...envelope(screenshotRef()), payload: { captures: [] } };

    await expect(handler(saveMessage(withoutRefs, 'operation-first', 0, 1))).resolves.toMatchObject(
      { success: true, operation: 'saveSessionDraft', revision: 1 }
    );
    await expect(
      handler(saveMessage({ ...withoutRefs, updatedAt: NOW + 2 }, 'operation-newer', 1, 2))
    ).resolves.toMatchObject({ success: true, operation: 'saveSessionDraft', revision: 2 });
    await expect(
      handler(saveMessage({ ...withoutRefs, updatedAt: NOW }, 'operation-older', 0, 1))
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
  });

  it('replays the same operation id across handler restart without a second draft write', async () => {
    const local = createMemoryStorageArea();
    const setMany = vi.spyOn(local, 'setMany');
    const set = vi.spyOn(local, 'set');
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      'operation-replay',
      0,
      1
    );
    const firstHandler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const first = await firstHandler(message);
    const setCallsAfterCommit = set.mock.calls.length;
    const restartedHandler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const replay = await restartedHandler(message);

    expect(first).toMatchObject({ success: true, replayed: false, revision: 1 });
    expect(replay).toMatchObject({ success: true, replayed: true, revision: 1 });
    expect(setMany.mock.calls.filter(([entries]) => DRAFT_KEY in entries)).toHaveLength(1);
    expect(set).toHaveBeenCalledTimes(setCallsAfterCommit);
    await expect(
      local.get('aiob.restoreStorage.pending.v1.operation-replay')
    ).resolves.toBeUndefined();
    const replayOutcome = await local.get<{ requestFingerprint: string }>(
      'aiob.restoreStorage.outcome.v1.operation-replay'
    );
    expect(replayOutcome?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('fails replay closed when the cursor is cross-bound to another operation', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-replay-cross-bound';
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      operationId,
      0,
      1
    );
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(handler(message)).resolves.toMatchObject({ success: true, revision: 1 });
    const cursorKey = `aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`;
    const cursor = await local.get<Record<string, string | number>>(cursorKey);
    if (!cursor) throw new Error('expected cursor');
    await local.set(cursorKey, { ...cursor, lastOperationId: 'operation-other' });

    await expect(handler(message)).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it('does not overwrite a cross-bound cursor while recovering a desired-written journal', async () => {
    const memory = createMemoryStorageArea();
    let failAfterDraftWrite = true;
    const local = {
      ...memory,
      async setMany<Value>(entries: Record<string, Value>) {
        if (failAfterDraftWrite && DRAFT_KEY in entries) {
          failAfterDraftWrite = false;
          await memory.set(DRAFT_KEY, entries[DRAFT_KEY]);
          throw new Error('simulated desired-only crash before cursor');
        }
        await memory.setMany(entries);
      }
    };
    const operationId = 'operation-cross-bound-recovery';
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      operationId,
      0,
      1
    );
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(handler(message)).resolves.toEqual({
      success: false,
      error: 'simulated desired-only crash before cursor'
    });
    await local.set(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`, {
      schemaVersion: 1,
      draftKey: DRAFT_KEY,
      revision: 1,
      lastOperationId: 'operation-other'
    });

    await expect(handler(message)).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it('retains every unexpired outcome needed by the 15-minute replay window', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-replay-with-129-outcomes';
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      operationId,
      0,
      1
    );
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(handler(message)).resolves.toMatchObject({ success: true, revision: 1 });
    const outcomeBase = Date.now() - 1_000;
    await local.setMany(
      Object.fromEntries(
        Array.from({ length: 128 }, (_, index) => {
          const dummyOperation = `operation-unexpired-${index}`;
          return [
            `aiob.restoreStorage.outcome.v1.${dummyOperation}`,
            {
              schemaVersion: 1,
              operationId: dummyOperation,
              draftKey: `${DRAFT_KEY}-dummy-${index}`,
              revision: 1,
              requestFingerprint: '0'.repeat(64),
              createdAt: outcomeBase + index,
              expiresAt: outcomeBase + index + 15 * 60 * 1_000
            }
          ];
        })
      )
    );

    await expect(handler(message)).resolves.toMatchObject({
      success: true,
      replayed: true,
      revision: 1
    });
    await expect(local.get(`aiob.restoreStorage.outcome.v1.${operationId}`)).resolves.toBeDefined();
  });

  it('rejects reuse of an operation id for a different draft key', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const first = {
      ...envelope(screenshotRef()),
      payload: { captures: [] }
    };
    const second = {
      ...first,
      draftId: 'draft-client-other'
    };
    const operationId = 'operation-reused';

    await expect(handler(saveMessage(first, operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      replayed: false
    });
    await expect(
      handler({
        ...saveMessage(second, operationId, 0, 1),
        context: {
          ...saveMessage(second, operationId, 0, 1).context,
          draftKey: createSessionDraftStorageKey({
            mode: 'video',
            pageKey: PAGE_KEY,
            draftId: 'draft-client-other'
          })
        }
      })
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
  });

  it('recovers a pending save after finalization fails without writing the draft twice', async () => {
    const memory = createMemoryStorageArea();
    const draftKey = DRAFT_KEY;
    const events: string[] = [];
    let setManyCount = 0;
    let failFinalization = true;
    const local = {
      ...memory,
      set<Value>(key: string, value: Value) {
        if (key.startsWith('aiob.restoreStorage.pending.v1.')) {
          events.push('pending:set');
        }
        return memory.set(key, value);
      },
      setMany<Value>(entries: Record<string, Value>) {
        setManyCount += 1;
        events.push(draftKey in entries ? 'draft:setMany' : 'finalize:setMany');
        if (setManyCount === 2 && failFinalization) {
          failFinalization = false;
          return Promise.reject(new Error('simulated finalize crash'));
        }
        return memory.setMany(entries);
      }
    };
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      'operation-finalize-recovery',
      0,
      1
    );
    const firstHandler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(firstHandler(message)).resolves.toEqual({
      success: false,
      error: 'simulated finalize crash'
    });
    expect(events).toEqual(['pending:set', 'draft:setMany', 'finalize:setMany']);

    const restartedHandler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(restartedHandler(message)).resolves.toMatchObject({
      success: true,
      replayed: true,
      revision: 1
    });
    expect(events.filter((event) => event === 'draft:setMany')).toHaveLength(1);
  });

  it('rejects replay of an operation id with a different payload', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const first = { ...envelope(screenshotRef()), payload: { captures: [] } };
    const changed = { ...first, pageTitle: 'changed payload' };
    const operationId = 'operation-payload-conflict';

    await expect(handler(saveMessage(first, operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      replayed: false
    });
    await expect(handler(saveMessage(changed, operationId, 0, 1))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
  });

  it('replays semantically identical envelopes with different property insertion order', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const first = {
      ...envelope(screenshotRef()),
      payload: { captures: [], alpha: 1, beta: 2 }
    };
    const reordered = {
      ...first,
      payload: { beta: 2, alpha: 1, captures: [] }
    };
    const operationId = 'operation-canonical-replay';

    await expect(handler(saveMessage(first, operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      replayed: false
    });
    await expect(handler(saveMessage(reordered, operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      replayed: true
    });
  });

  it('reuses client pending identity for reordered JSON-safe envelope properties', async () => {
    let loseFirstResponse = true;
    const sentOperations: string[] = [];
    const messaging: SessionDraftRepositoryMessaging = {
      send(message) {
        if (message.operation === 'loadLatestSessionDraft') {
          return Promise.resolve({
            success: true,
            operation: message.operation,
            result: { envelope: null, epoch: 1, revision: 0 }
          });
        }
        if (message.operation === 'prepareSessionDraftOperation') {
          return Promise.resolve({
            success: true,
            operation: message.operation,
            context: {
              operationId: message.operationId,
              epoch: 1,
              draftKey: message.draftKey,
              baseRevision: 0,
              nextRevision: 1
            },
            replayed: false,
            status: 'prepared'
          });
        }
        if (message.operation === 'saveSessionDraft') {
          sentOperations.push(message.context.operationId);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            return Promise.reject(new Error('lost canonical response'));
          }
          return Promise.resolve({
            success: true,
            operation: message.operation,
            revision: 1,
            replayed: true
          });
        }
        return Promise.reject(new Error('unexpected operation'));
      }
    };
    const client = createSessionDraftClientRepository(messaging, {
      createOperationId: () => 'operation-client-canonical'
    });
    const first = {
      ...envelope(screenshotRef()),
      payload: { captures: [], alpha: 1, beta: 2 }
    };
    const reordered = { ...first, payload: { beta: 2, alpha: 1, captures: [] } };
    await client.loadLatest('video', PAGE_URL, NOW);

    await expect(client.save(first)).rejects.toThrow('lost canonical response');
    await expect(client.save(reordered)).resolves.toBeUndefined();
    expect(sentOperations).toEqual(['operation-client-canonical', 'operation-client-canonical']);
  });

  it('prepares authoritative version state for a first save without a prior load', async () => {
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const client = createSessionDraftClientRepository(handlerMessaging(handler), {
      createOperationId: () => 'operation-first-save-without-load'
    });

    await expect(
      client.save({ ...envelope(screenshotRef()), payload: { captures: [] } })
    ).resolves.toBeUndefined();
    await expect(client.loadLatest('video', PAGE_URL)).resolves.toMatchObject({
      draftId: 'draft-client'
    });
  });

  it('rejects a stale client before its provisional write task can run', async () => {
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let firstOperation = 0;
    const first = createSessionDraftClientRepository(handlerMessaging(handler), {
      createOperationId: () => `operation-authoritative-first-${firstOperation++}`
    });
    const stale = createSessionDraftClientRepository(handlerMessaging(handler), {
      createOperationId: () => 'operation-authoritative-stale'
    });
    await first.save({ ...envelope(screenshotRef()), payload: { captures: [] } });
    await first.loadLatest('video', PAGE_URL);
    await stale.loadLatest('video', PAGE_URL);
    await first.save({
      ...envelope(screenshotRef()),
      updatedAt: NOW + 1,
      payload: { captures: [] }
    });
    let provisionalWrites = 0;

    await expect(
      stale.runWriteOperation(DRAFT_KEY, async (operation) => {
        provisionalWrites += 1;
        await operation.commit({
          ...envelope(screenshotRef()),
          updatedAt: NOW + 2,
          payload: { captures: [] }
        });
      })
    ).rejects.toThrow('RESTORE_STORAGE_REVISION_CONFLICT');
    expect(provisionalWrites).toBe(0);
  });

  it('replays an authoritative prepare after its response is lost', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let losePrepareResponse = true;
    const operationIds = vi.fn(() => 'operation-lost-prepare');
    const client = createSessionDraftClientRepository(
      {
        async send(message) {
          const response = await handler(message);
          if (message.operation === 'prepareSessionDraftOperation' && losePrepareResponse) {
            losePrepareResponse = false;
            throw new Error('simulated lost prepare response');
          }
          return response;
        }
      },
      { createOperationId: operationIds }
    );
    const draft = { ...envelope(screenshotRef()), payload: { captures: [] } };

    await expect(client.save(draft)).rejects.toThrow('simulated lost prepare response');
    await expect(client.save(draft)).resolves.toBeUndefined();
    expect(operationIds).toHaveBeenCalledTimes(1);
  });

  it('reports a completed operation replay without creating a new lease', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const operationId = 'operation-completed-prepare-reuse';
    const draft = { ...envelope(screenshotRef()), payload: { captures: [] } };
    await expect(handler(saveMessage(draft, operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      revision: 1
    });

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId,
        draftKey: DRAFT_KEY
      })
    ).resolves.toMatchObject({
      success: true,
      operation: 'prepareSessionDraftOperation',
      replayed: true,
      status: 'completed'
    });
    await expect(local.get(`aiob.restoreStorage.lease.v1.${operationId}`)).resolves.toBeUndefined();
  });

  it('replays an exact pending prepare and rejects a cross-draft operation collision', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const operationId = 'operation-prepare-collision';
    const prepare = {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId,
      draftKey: DRAFT_KEY
    };
    const otherKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: PAGE_KEY,
      draftId: 'other-draft'
    });

    await expect(handler(prepare)).resolves.toMatchObject({
      success: true,
      replayed: false,
      status: 'prepared'
    });
    await expect(handler(prepare)).resolves.toMatchObject({
      success: true,
      replayed: true,
      status: 'prepared'
    });
    await expect(handler({ ...prepare, draftKey: otherKey })).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_LEASE_CONFLICT'
    });
    await expect(local.get(`aiob.restoreStorage.lease.v1.${operationId}`)).resolves.toMatchObject({
      draftKey: DRAFT_KEY,
      screenshotKeys: []
    });
  });

  it('cancels an uncommitted task and starts a fresh operation after the lease window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      const local = createMemoryStorageArea();
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      const operationIds = ['operation-aborted-task', 'operation-after-abort'];
      const client = createSessionDraftClientRepository(handlerMessaging(handler), {
        createOperationId: () => operationIds.shift() ?? 'unexpected-operation'
      });
      await client.runWriteOperation(DRAFT_KEY, () => Promise.resolve());
      await expect(
        local.get('aiob.restoreStorage.lease.v1.operation-aborted-task')
      ).resolves.toBeUndefined();
      vi.setSystemTime(new Date(NOW + 15 * 60 * 1_000 + 1));

      await expect(
        client.runWriteOperation(DRAFT_KEY, (operation) =>
          operation.commit({
            ...envelope(screenshotRef()),
            updatedAt: NOW + 15 * 60 * 1_000 + 1,
            expiresAt: NOW + 60 * 60 * 1_000,
            payload: { captures: [] }
          })
        )
      ).resolves.toBeUndefined();
      await expect(local.get(DRAFT_KEY)).resolves.toMatchObject({ draftId: 'draft-client' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a delayed no-ref commit after its prepared operation was cancelled', async () => {
    const local = createMemoryStorageArea();
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const operationId = 'operation-cancelled-delayed-commit';
    const context = {
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      nextRevision: 1
    };
    await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId,
      draftKey: DRAFT_KEY
    });
    await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'cancelSessionDraftOperation',
      context
    });

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context,
        envelope: { ...envelope(screenshotRef()), payload: { captures: [] } }
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_PREPARE_REQUIRED' });
    await expect(local.get(DRAFT_KEY)).resolves.toBeUndefined();
  });

  it('removes an exact-ttl expired empty prepared lease during an unrelated prepare', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      const local = createMemoryStorageArea();
      const operationId = 'operation-expired-empty-lease';
      const leaseKey = `aiob.restoreStorage.lease.v1.${operationId}`;
      await local.set(leaseKey, {
        schemaVersion: 1,
        operationId,
        epoch: 1,
        draftKey: DRAFT_KEY,
        baseRevision: 0,
        draftRevision: 1,
        screenshotKeys: [],
        screenshotFingerprints: {},
        createdAt: NOW - 15 * 60 * 1_000,
        expiresAt: NOW
      });
      const handler = createRawBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );

      await expect(
        handler({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'prepareSessionDraftOperation',
          operationId: 'operation-unrelated-lease-gc',
          draftKey: createSessionDraftStorageKey({
            mode: 'video',
            pageKey: PAGE_KEY,
            draftId: 'unrelated-lease-gc'
          })
        })
      ).resolves.toMatchObject({ success: true, status: 'prepared' });
      await expect(local.get(leaseKey)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues bounded lease gc across restarts without evicting more than 128 live leases', async () => {
    const local = createMemoryStorageArea();
    const now = Date.now();
    const entries: Record<string, object> = {};
    for (let index = 0; index < 70; index += 1) {
      const operationId = `a-expired-${String(index).padStart(3, '0')}`;
      entries[`aiob.restoreStorage.lease.v1.${operationId}`] = {
        schemaVersion: 1,
        operationId,
        epoch: 1,
        draftKey: DRAFT_KEY,
        baseRevision: 0,
        draftRevision: 1,
        screenshotKeys: [],
        screenshotFingerprints: {},
        createdAt: now - 15 * 60 * 1_000,
        expiresAt: now
      };
    }
    for (let index = 0; index < 130; index += 1) {
      const operationId = `z-live-${String(index).padStart(3, '0')}`;
      entries[`aiob.restoreStorage.lease.v1.${operationId}`] = {
        schemaVersion: 1,
        operationId,
        epoch: 1,
        draftKey: DRAFT_KEY,
        baseRevision: 0,
        draftRevision: 1,
        screenshotKeys: [],
        screenshotFingerprints: {},
        createdAt: now,
        expiresAt: now + 15 * 60 * 1_000
      };
    }
    await local.setMany(entries);

    await pruneRestoreStorageLeases(local, now, 1);
    expect(
      Object.keys(await local.getAll()).filter((key) => key.includes('a-expired-'))
    ).toHaveLength(6);
    await pruneRestoreStorageLeases(local, now, 1);
    await pruneRestoreStorageLeases(local, now, 1);
    await pruneRestoreStorageLeases(local, now, 1);
    const remaining = Object.keys(await local.getAll());
    expect(remaining.filter((key) => key.includes('a-expired-'))).toEqual([]);
    expect(remaining.filter((key) => key.includes('z-live-'))).toHaveLength(130);
    await expect(local.get('aiob.restoreStorage.leaseGcCursor.v1')).resolves.toBeUndefined();
  });

  it('continues bounded retired-operation gc across restarts while retaining live tombstones', async () => {
    const local = createMemoryStorageArea();
    const now = Date.now();
    const entries: Record<string, object> = {};
    for (let index = 0; index < 70; index += 1) {
      const operationId = `a-retired-expired-${String(index).padStart(3, '0')}`;
      entries[`aiob.restoreStorage.retiredOperation.v1.${operationId}`] = {
        schemaVersion: 1,
        operationId,
        retiredAt: now - 15 * 60 * 1_000,
        expiresAt: now
      };
    }
    for (let index = 0; index < 70; index += 1) {
      const operationId = `z-retired-live-${String(index).padStart(3, '0')}`;
      entries[`aiob.restoreStorage.retiredOperation.v1.${operationId}`] = {
        schemaVersion: 1,
        operationId,
        retiredAt: now,
        expiresAt: now + 15 * 60 * 1_000
      };
    }
    await local.setMany(entries);

    await pruneSessionDraftRetiredOperations(local, now);
    expect(
      Object.keys(await local.getAll()).filter((key) => key.includes('a-retired-expired-'))
    ).toHaveLength(6);
    await pruneSessionDraftRetiredOperations(local, now);
    await pruneSessionDraftRetiredOperations(local, now);
    const remaining = Object.keys(await local.getAll());
    expect(remaining.filter((key) => key.includes('a-retired-expired-'))).toEqual([]);
    expect(remaining.filter((key) => key.includes('z-retired-live-'))).toHaveLength(70);
    await expect(
      local.get('aiob.restoreStorage.retiredOperationGcCursor.v1')
    ).resolves.toBeUndefined();
  });

  it('keeps a malformed retired-operation id fail-closed through quarantine', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-malformed-retired';
    await local.set(`aiob.restoreStorage.retiredOperation.v1.${operationId}`, {
      schemaVersion: 1,
      operationId,
      retiredAt: Date.now() - 1,
      expiresAt: Date.now() + 1
    });
    await pruneSessionDraftRetiredOperations(local);
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId,
        draftKey: DRAFT_KEY
      })
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_REVISION_CONFLICT' });
  });

  it('reuses one operation context when a commit response is lost', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let loseSaveResponse = true;
    const seenContexts: string[] = [];
    const client = createSessionDraftClientRepository(
      {
        async send(message) {
          const response = await handler(message);
          if (message.operation === 'saveSessionDraft') {
            seenContexts.push(message.context.operationId);
            if (loseSaveResponse) {
              loseSaveResponse = false;
              throw new Error('simulated lost coordinated commit response');
            }
          }
          return response;
        }
      },
      { createOperationId: () => 'operation-coordinated-transport-loss' }
    );
    const commit = (operation: { commit(envelope: VideoSessionDraftEnvelope): Promise<void> }) =>
      operation.commit({ ...envelope(screenshotRef()), payload: { captures: [] } });

    await expect(client.runWriteOperation(DRAFT_KEY, commit)).rejects.toThrow(
      'simulated lost coordinated commit response'
    );
    await expect(client.runWriteOperation(DRAFT_KEY, commit)).resolves.toBeUndefined();
    expect(seenContexts).toEqual([
      'operation-coordinated-transport-loss',
      'operation-coordinated-transport-loss'
    ]);
  });

  it('retries a lost cancel acknowledgement with the same exact context before a fresh prepare', async () => {
    const local = createMemoryStorageArea();
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let loseCancelResponse = true;
    const cancelIds: string[] = [];
    const prepareIds: string[] = [];
    const client = createSessionDraftClientRepository({
      async send(message) {
        const response = await handler(message);
        if (message.operation === 'prepareSessionDraftOperation') {
          prepareIds.push(message.operationId);
        }
        if (message.operation === 'cancelSessionDraftOperation') {
          cancelIds.push(message.context.operationId);
          if (loseCancelResponse) {
            loseCancelResponse = false;
            throw new Error('simulated lost cancel response');
          }
        }
        return response;
      }
    });

    await expect(client.runWriteOperation(DRAFT_KEY, () => Promise.resolve())).rejects.toThrow(
      'simulated lost cancel response'
    );
    await client.runWriteOperation(DRAFT_KEY, (operation) =>
      operation.commit({ ...envelope(screenshotRef()), payload: { captures: [] } })
    );
    expect(cancelIds).toEqual([cancelIds[0], cancelIds[0]]);
    expect(prepareIds).toHaveLength(2);
    expect(prepareIds[0]).not.toBe(prepareIds[1]);
  });

  it('does not authorize a save with a lease payload bound to another operation id', async () => {
    const local = createMemoryStorageArea();
    const ref = screenshotRef();
    const operationId = 'operation-lease-key-binding';
    const leaseCreatedAt = Date.now() - 1;
    await local.set(`aiob.restoreStorage.lease.v1.${operationId}`, {
      schemaVersion: 1,
      operationId: 'operation-other-payload',
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: [ref.key],
      createdAt: leaseCreatedAt,
      expiresAt: leaseCreatedAt + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(blobEntry(ref)) }
    );

    await expect(handler(saveMessage(envelope(ref), operationId, 0, 1))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PREPARE_REQUIRED'
    });
  });

  it('revalidates a same-key screenshot ref when its normalized metadata changes', async () => {
    const local = createMemoryStorageArea();
    const ref = screenshotRef();
    const operationId = 'operation-initial-ref';
    const leaseCreatedAt = Date.now() - 1;
    const storedBlob = blobEntry(ref);
    const screenshotFingerprint = await createVideoScreenshotRequestFingerprint(
      await serializeVideoScreenshot({
        id: storedBlob.id,
        fileName: storedBlob.fileName,
        mimeType: storedBlob.mimeType,
        capturedAt: storedBlob.capturedAt,
        content: {
          kind: 'blob',
          blob: storedBlob.blob,
          byteLength: storedBlob.byteLength
        }
      })
    );
    await local.set(`aiob.restoreStorage.lease.v1.${operationId}`, {
      schemaVersion: 1,
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: [ref.key],
      screenshotFingerprints: { [ref.key]: screenshotFingerprint },
      createdAt: leaseCreatedAt,
      expiresAt: leaseCreatedAt + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(storedBlob) }
    );
    await expect(handler(saveMessage(envelope(ref), operationId, 0, 1))).resolves.toMatchObject({
      success: true,
      revision: 1
    });
    const changedRef = { ...ref, fileName: 'changed-name.jpg' };

    await expect(
      handler(
        saveMessage({ ...envelope(changedRef), updatedAt: NOW + 2 }, 'operation-changed-ref', 1, 2)
      )
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED'
    });
  });

  it('rejects a non-canonical object removal target without touching ordinary storage', async () => {
    const local = createMemoryStorageArea();
    await local.set('ordinaryOptions', { theme: 'dark' });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'removeSessionDraft',
        target: { key: 'ordinaryOptions' }
      })
    ).resolves.toBeUndefined();
    await expect(local.get('ordinaryOptions')).resolves.toEqual({ theme: 'dark' });
  });

  it('rejects a save whose page key and cursor key are not derived from the page URL', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const invalid = { ...envelope(screenshotRef()), pageKey: 'attacker-page-key' };
    const invalidDraftKey = createSessionDraftStorageKey({
      mode: invalid.mode,
      pageKey: invalid.pageKey,
      draftId: invalid.draftId
    });
    const message = saveMessage(invalid, 'operation-invalid-page-key', 0, 1);

    await expect(
      handler({ ...message, context: { ...message.context, draftKey: invalidDraftKey } })
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
  });

  it.each([
    ['cursor', `aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`],
    ['outcome', 'aiob.restoreStorage.outcome.v1.operation-malformed-state']
  ])('fails closed when persisted %s protocol state is malformed', async (_label, key) => {
    const local = createMemoryStorageArea();
    await local.set(key, { schemaVersion: 99, malformed: true });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-malformed-state',
          0,
          1
        )
      )
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it('does not let an unexpired pending journal block a different draft key', async () => {
    const memory = createMemoryStorageArea();
    let failFirstDraftWrite = true;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (failFirstDraftWrite && DRAFT_KEY in entries) {
          failFirstDraftWrite = false;
          return Promise.reject(new Error('simulated draft A pre-write crash'));
        }
        return memory.setMany(entries);
      }
    };
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const operationA = 'operation-pending-draft-a';
    const pendingAKey = `aiob.restoreStorage.pending.v1.${operationA}`;
    const leaseAKey = `aiob.restoreStorage.lease.v1.${operationA}`;
    await expect(
      handler(
        saveMessage({ ...envelope(screenshotRef()), payload: { captures: [] } }, operationA, 0, 1)
      )
    ).resolves.toEqual({ success: false, error: 'simulated draft A pre-write crash' });
    const leaseCreatedAt = Date.now() - 1;
    await local.set(leaseAKey, {
      schemaVersion: 1,
      operationId: operationA,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['draft-a-provisional-ref'],
      createdAt: leaseCreatedAt,
      expiresAt: leaseCreatedAt + 15 * 60 * 1_000
    });
    const draftB = {
      ...envelope(screenshotRef()),
      draftId: 'draft-client-b',
      payload: { captures: [] }
    };
    const draftBKey = createSessionDraftStorageKey({
      mode: draftB.mode,
      pageKey: draftB.pageKey,
      draftId: draftB.draftId
    });
    const messageB = saveMessage(draftB, 'operation-draft-b', 0, 1);

    await expect(
      handler({ ...messageB, context: { ...messageB.context, draftKey: draftBKey } })
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(pendingAKey)).resolves.toBeDefined();
    await expect(local.get(leaseAKey)).resolves.toMatchObject({
      operationId: operationA,
      screenshotKeys: ['draft-a-provisional-ref']
    });
  });

  it('repairs an index-only partial write while saving an unrelated draft', async () => {
    const memory = createMemoryStorageArea();
    let persistOnlyIndex = true;
    const local = {
      ...memory,
      async setMany<Value>(entries: Record<string, Value>) {
        if (persistOnlyIndex && DRAFT_KEY in entries) {
          persistOnlyIndex = false;
          const index = entries[SESSION_DRAFT_INDEX_KEY];
          if (index !== undefined) await memory.set(SESSION_DRAFT_INDEX_KEY, index);
          throw new Error('simulated index-only draft A crash');
        }
        await memory.setMany(entries);
      }
    };
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const operationA = 'operation-index-only-a';
    await expect(
      handler(
        saveMessage({ ...envelope(screenshotRef()), payload: { captures: [] } }, operationA, 0, 1)
      )
    ).resolves.toEqual({ success: false, error: 'simulated index-only draft A crash' });
    const pendingAKey = `aiob.restoreStorage.pending.v1.${operationA}`;
    const journal = await local.get<Record<string, object | string | number | null>>(pendingAKey);
    if (!journal) throw new Error('expected pending journal');
    await local.set(pendingAKey, {
      ...journal,
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });
    const draftB = {
      ...envelope(screenshotRef()),
      draftId: 'draft-after-index-only-a',
      payload: { captures: [] }
    };
    const draftBKey = createSessionDraftStorageKey({
      mode: draftB.mode,
      pageKey: draftB.pageKey,
      draftId: draftB.draftId
    });
    const messageB = saveMessage(draftB, 'operation-after-index-only-a', 0, 1);

    await expect(
      handler({ ...messageB, context: { ...messageB.context, draftKey: draftBKey } })
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [expect.objectContaining({ key: draftBKey })]
    });
    const index = await local.get<{ entries: Array<{ key: string }> }>(SESSION_DRAFT_INDEX_KEY);
    expect(index?.entries.some(({ key }) => key === DRAFT_KEY)).toBe(false);
  });

  it.each([
    ['pending', 'aiob.restoreStorage.pending.v1.malformed-unrelated'],
    ['outcome', 'aiob.restoreStorage.outcome.v1.malformed-unrelated']
  ])(
    'quarantines a malformed unrelated %s record without globally blocking saves',
    async (_kind, malformedKey) => {
      const local = createMemoryStorageArea();
      await local.set(malformedKey, { schemaVersion: 99, malformed: true });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );

      await expect(
        handler(
          saveMessage(
            { ...envelope(screenshotRef()), payload: { captures: [] } },
            `operation-after-malformed-${_kind}`,
            0,
            1
          )
        )
      ).resolves.toMatchObject({ success: true, revision: 1 });
      await expect(local.get(malformedKey)).resolves.toBeUndefined();
      const ledger = await local.get<{
        schemaVersion: number;
        entries: Array<{ sourceKey: string }>;
      }>('aiob.restoreStorage.corruption.v1');
      expect(ledger?.schemaVersion).toBe(1);
      expect(ledger?.entries.some(({ sourceKey }) => sourceKey === malformedKey)).toBe(true);
    }
  );

  it('keeps a quarantined operation identity fail-closed while unrelated work recovers', async () => {
    const local = createMemoryStorageArea();
    const malformedOperation = 'operation-quarantined-identity';
    const malformedKey = `aiob.restoreStorage.outcome.v1.${malformedOperation}`;
    await local.set(malformedKey, { schemaVersion: 99, malformed: true });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const draft = { ...envelope(screenshotRef()), payload: { captures: [] } };
    await expect(
      handler(saveMessage(draft, 'operation-quarantine-recovery', 0, 1))
    ).resolves.toMatchObject({ success: true, revision: 1 });

    await expect(
      handler(saveMessage({ ...draft, updatedAt: NOW + 2 }, malformedOperation, 1, 2))
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it('bounds the protocol corruption quarantine while reclaiming malformed outcomes', async () => {
    const local = createMemoryStorageArea();
    const malformedEntries = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [
        `aiob.restoreStorage.outcome.v1.malformed-${index}`,
        { schemaVersion: 99, malformed: true, index }
      ])
    );
    await local.setMany(malformedEntries);
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-after-many-malformed-outcomes',
          0,
          1
        )
      )
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    const quarantine = await local.get<{ entries: Array<{ sourceKey: string }> }>(
      'aiob.restoreStorage.corruption.v1'
    );
    expect(quarantine?.entries).toHaveLength(128);
    expect((await local.getAll())['aiob.restoreStorage.outcome.v1.malformed-0']).toBeUndefined();
  });

  it('fails cap-evicted malformed authority closed for the full 15-minute window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const operationId = 'operation-current-malformed-cap-edge';
      await local.setMany({
        [`aiob.restoreStorage.pending.v1.${operationId}`]: {
          schemaVersion: 99,
          malformed: true
        },
        ...Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [
            `aiob.restoreStorage.pending.v1.later-malformed-${index}`,
            { schemaVersion: 99, malformed: true, index }
          ])
        )
      });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      const message = saveMessage(
        { ...envelope(screenshotRef()), payload: { captures: [] } },
        operationId,
        0,
        1
      );

      await expect(handler(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(handler(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
      await expect(handler(message)).resolves.toMatchObject({
        success: true,
        replayed: false,
        revision: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a malformed corruption ledger with a bounded 15-minute recovery window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const malformedOutcomeKey = 'aiob.restoreStorage.outcome.v1.unrelated-after-bad-ledger';
      await local.set('aiob.restoreStorage.corruption.v1', {
        schemaVersion: 99,
        malformed: true
      });
      await local.set(malformedOutcomeKey, { schemaVersion: 99, malformed: true });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      const message = saveMessage(
        { ...envelope(screenshotRef()), payload: { captures: [] } },
        'operation-recover-bad-corruption-ledger',
        0,
        1
      );

      await expect(handler(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.get('aiob.restoreStorage.corruption.v1')).resolves.toMatchObject({
        schemaVersion: 1,
        recoveryRequiredUntil: NOW + 15 * 60 * 1_000
      });
      await expect(handler(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
      await expect(handler(message)).resolves.toMatchObject({
        success: true,
        replayed: false,
        revision: 1
      });
      await expect(local.get(malformedOutcomeKey)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds far-future corruption authority to a fresh 15-minute recovery window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      await local.set('aiob.restoreStorage.corruption.v1', {
        schemaVersion: 1,
        recoveryRequiredUntil: NOW + 100 * 15 * 60 * 1_000,
        entries: [
          {
            sourceKey: 'aiob.restoreStorage.outcome.v1.future-corruption-entry',
            quarantinedAt: NOW + 100 * 15 * 60 * 1_000
          }
        ]
      });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      const message = saveMessage(
        { ...envelope(screenshotRef()), payload: { captures: [] } },
        'operation-after-future-corruption-ledger',
        0,
        1
      );

      await expect(handler(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.get('aiob.restoreStorage.corruption.v1')).resolves.toEqual({
        schemaVersion: 1,
        recoveryRequiredUntil: NOW + 15 * 60 * 1_000,
        entries: []
      });
      vi.advanceTimersByTime(15 * 60 * 1_000 + 1);
      await expect(handler(message)).resolves.toMatchObject({
        success: true,
        replayed: false,
        revision: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { now: -1 },
    { options: null },
    { options: { unexpected: true } },
    { options: { ownerContext: { tabId: -1 } } },
    { options: { ownerContext: { windowId: 1.5 } } },
    { options: { ownerContext: {} } }
  ])(
    'rejects invalid optional load fields instead of silently dropping them: %j',
    async (extra) => {
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local: createMemoryStorageArea() },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );

      await expect(
        handler({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'loadLatestSessionDraft',
          mode: 'video',
          pageUrl: PAGE_URL,
          ...extra
        })
      ).resolves.toBeUndefined();
    }
  );

  it('fails a client request on a wrong operation or malformed envelope response', async () => {
    const context = () => ({
      operationId: 'unused',
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      nextRevision: 1
    });
    const wrongOperationClient = createSessionDraftClientRepository(
      staticMessaging({ success: true, operation: 'removeSessionDraft' }),
      { createOperationId: () => context().operationId }
    );
    const malformedEnvelopeClient = createSessionDraftClientRepository(
      staticMessaging({
        success: true,
        operation: 'loadLatestSessionDraft',
        result: { malformed: true }
      }),
      { createOperationId: () => context().operationId }
    );

    await expect(wrongOperationClient.loadLatest('video', PAGE_URL, NOW)).rejects.toThrow(
      'SESSION_DRAFT_REPOSITORY_REQUEST_FAILED'
    );
    await expect(malformedEnvelopeClient.loadLatest('video', PAGE_URL, NOW)).rejects.toThrow(
      'SESSION_DRAFT_REPOSITORY_REQUEST_FAILED'
    );
  });

  it('uses load metadata as the authoritative epoch and revision after client restart', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const firstClient = createSessionDraftClientRepository(handlerMessaging(handler), {
      createOperationId: () => 'operation-client-first'
    });
    await firstClient.loadLatest('video', PAGE_URL, NOW);
    await firstClient.save({ ...envelope(screenshotRef()), payload: { captures: [] } });

    const restartedClient = createSessionDraftClientRepository(handlerMessaging(handler), {
      createOperationId: () => 'operation-client-second'
    });
    const restored = await restartedClient.loadLatest('video', PAGE_URL, NOW);
    expect(restored).not.toBeNull();
    await expect(
      restartedClient.save({
        ...envelope(screenshotRef()),
        pageTitle: 'saved after restart',
        updatedAt: NOW + 2,
        payload: { captures: [] }
      })
    ).resolves.toBeUndefined();
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`)
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('returns authoritative epoch and revision metadata with load responses', async () => {
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local: createMemoryStorageArea() },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'loadLatestSessionDraft',
        mode: 'video',
        pageUrl: PAGE_URL,
        now: NOW
      })
    ).resolves.toMatchObject({
      success: true,
      operation: 'loadLatestSessionDraft',
      result: { envelope: null, epoch: 1, revision: 0 }
    });
  });

  it('keeps large-request outcomes bounded and removes the committed journal', async () => {
    const local = createMemoryStorageArea();
    const expiredOutcomeKey = 'aiob.restoreStorage.outcome.v1.operation-expired';
    await local.set(expiredOutcomeKey, {
      schemaVersion: 1,
      operationId: 'operation-expired',
      draftKey: DRAFT_KEY,
      revision: 1,
      requestFingerprint: '0'.repeat(64),
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const large = {
      ...envelope(screenshotRef()),
      payload: { captures: [], largeNote: 'x'.repeat(256 * 1_024) }
    };

    await expect(
      handler(saveMessage(large, 'operation-large-outcome', 0, 1))
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(expiredOutcomeKey)).resolves.toBeUndefined();
    await expect(
      local.get('aiob.restoreStorage.pending.v1.operation-large-outcome')
    ).resolves.toBeUndefined();
    const outcome = await local.get<{ requestFingerprint: string }>(
      'aiob.restoreStorage.outcome.v1.operation-large-outcome'
    );
    expect(outcome?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps the pending WAL compact for a large envelope and recovers the retry', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    const local = {
      ...memory,
      set<Value>(key: string, value: Value) {
        if (key.startsWith('aiob.restoreStorage.pending.v1.')) {
          const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (bytes > 2_048) return Promise.reject(new Error('pending WAL exceeded bound'));
        }
        return memory.set(key, value);
      },
      setMany<Value>(entries: Record<string, Value>) {
        if (failDraftWrite && DRAFT_KEY in entries) {
          failDraftWrite = false;
          return Promise.reject(new Error('simulated near-quota draft write'));
        }
        return memory.setMany(entries);
      }
    };
    const operationId = 'operation-compact-large-wal';
    const large = {
      ...envelope(screenshotRef()),
      payload: { captures: [], largeNote: 'x'.repeat(256 * 1_024) }
    };
    const message = saveMessage(large, operationId, 0, 1);
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(handler(message)).resolves.toEqual({
      success: false,
      error: 'simulated near-quota draft write'
    });
    const pending = await local.get<Record<string, object | string | number | boolean | null>>(
      `aiob.restoreStorage.pending.v1.${operationId}`
    );
    expect(pending).not.toHaveProperty('envelope');
    expect(new TextEncoder().encode(JSON.stringify(pending)).byteLength).toBeLessThan(2_048);
    await expect(handler(message)).resolves.toMatchObject({
      success: true,
      replayed: true,
      revision: 1
    });
  });

  it('quarantines far-future outcome authority instead of retaining it forever', async () => {
    const local = createMemoryStorageArea();
    const key = 'aiob.restoreStorage.outcome.v1.operation-future-authority';
    const createdAt = Date.now() + 60_000;
    await local.set(key, {
      schemaVersion: 1,
      operationId: 'operation-future-authority',
      draftKey: `${DRAFT_KEY}-future`,
      revision: 1,
      requestFingerprint: '0'.repeat(64),
      createdAt,
      expiresAt: createdAt + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-after-future-authority',
          0,
          1
        )
      )
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(key)).resolves.toBeUndefined();
  });

  it.each(['cursor', 'outcome', 'journal'])(
    'recovers when finalization only persists the %s record',
    async (persistedRecord) => {
      const memory = createMemoryStorageArea();
      let finalizationFailed = false;
      let draftWrites = 0;
      const local = {
        ...memory,
        async setMany<Value>(entries: Record<string, Value>) {
          if (DRAFT_KEY in entries) {
            draftWrites += 1;
            await memory.setMany(entries);
            return;
          }
          if (!finalizationFailed) {
            finalizationFailed = true;
            const prefix = `aiob.restoreStorage.${persistedRecord === 'journal' ? 'pending' : persistedRecord}.v1.`;
            const partial = Object.entries(entries).find(([key]) => key.startsWith(prefix));
            if (partial) await memory.set(partial[0], partial[1]);
            throw new Error(`simulated ${persistedRecord}-only finalization`);
          }
          await memory.setMany(entries);
        }
      };
      const message = saveMessage(
        { ...envelope(screenshotRef()), payload: { captures: [] } },
        `operation-partial-${persistedRecord}`,
        0,
        1
      );
      const first = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      await expect(first(message)).resolves.toEqual({
        success: false,
        error: `simulated ${persistedRecord}-only finalization`
      });

      const restarted = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      await expect(restarted(message)).resolves.toMatchObject({
        success: true,
        replayed: true,
        revision: 1
      });
      await expect(
        local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`)
      ).resolves.toMatchObject({ revision: 1 });
      await expect(
        local.get(`aiob.restoreStorage.outcome.v1.operation-partial-${persistedRecord}`)
      ).resolves.toMatchObject({
        operationId: `operation-partial-${persistedRecord}`,
        draftKey: DRAFT_KEY,
        revision: 1
      });
      await expect(
        local.get(`aiob.restoreStorage.pending.v1.operation-partial-${persistedRecord}`)
      ).resolves.toBeUndefined();
      expect(draftWrites).toBe(1);
    }
  );

  it('repairs a missing draft index after a draft-only partial write without rewriting the envelope', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    let draftWrites = 0;
    const local = {
      ...memory,
      async setMany<Value>(entries: Record<string, Value>) {
        if (DRAFT_KEY in entries) {
          draftWrites += 1;
          if (failDraftWrite) {
            failDraftWrite = false;
            await memory.set(DRAFT_KEY, entries[DRAFT_KEY]);
            throw new Error('simulated draft-only write');
          }
        }
        await memory.setMany(entries);
      }
    };
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      'operation-repair-index',
      0,
      1
    );
    const first = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(first(message)).resolves.toEqual({
      success: false,
      error: 'simulated draft-only write'
    });

    const restarted = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(restarted(message)).resolves.toMatchObject({ success: true, replayed: true });
    await expect(local.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [expect.objectContaining({ key: DRAFT_KEY })]
    });
    expect(draftWrites).toBe(1);
  });

  it('repairs deferred expired-draft removals after the envelope and index were written', async () => {
    const memory = createMemoryStorageArea();
    const oldEnvelope = {
      ...envelope(screenshotRef()),
      draftId: 'draft-expired-before-finalize',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
      payload: { captures: [] }
    };
    const oldKey = createSessionDraftStorageKey({
      mode: oldEnvelope.mode,
      pageKey: oldEnvelope.pageKey,
      draftId: oldEnvelope.draftId
    });
    await memory.setMany({
      [oldKey]: oldEnvelope,
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([
        createSessionDraftIndexEntry(oldEnvelope)
      ])
    });
    let failDeferredRemove = true;
    const local = {
      ...memory,
      remove(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        if (failDeferredRemove && keys.includes(oldKey)) {
          failDeferredRemove = false;
          return Promise.reject(new Error('simulated deferred removal crash'));
        }
        return memory.remove(key);
      }
    };
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      'operation-repair-removals',
      0,
      1
    );
    const first = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(first(message)).resolves.toEqual({
      success: false,
      error: 'simulated deferred removal crash'
    });

    const restarted = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(restarted(message)).resolves.toMatchObject({ success: true, replayed: true });
    await expect(local.get(oldKey)).resolves.toBeUndefined();
  });

  it('garbage-collects a committed full-envelope journal left by cleanup failure', async () => {
    const memory = createMemoryStorageArea();
    const strandedJournalKey = 'aiob.restoreStorage.pending.v1.operation-stranded-journal';
    let failCleanup = true;
    const local = {
      ...memory,
      remove(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        if (failCleanup && keys.includes(strandedJournalKey)) {
          failCleanup = false;
          return Promise.reject(new Error('simulated journal cleanup failure'));
        }
        return memory.remove(key);
      }
    };
    const first = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(
      first(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-stranded-journal',
          0,
          1
        )
      )
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(strandedJournalKey)).resolves.toMatchObject({ state: 'committed' });

    const restarted = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await restarted(
      saveMessage(
        {
          ...envelope(screenshotRef()),
          updatedAt: NOW + 2,
          payload: { captures: [] }
        },
        'operation-after-stranded-journal',
        1,
        2
      )
    );
    await expect(local.get(strandedJournalKey)).resolves.toBeUndefined();
  });

  it.each([
    ['operationId', 'tampered-operation'],
    ['draftKey', `${DRAFT_KEY}-tampered`],
    ['revision', 99]
  ])(
    'fails closed when durable outcome %s disagrees with its storage identity',
    async (field, value) => {
      const local = createMemoryStorageArea();
      const operationId = `operation-outcome-identity-${field}`;
      const message = saveMessage(
        { ...envelope(screenshotRef()), payload: { captures: [] } },
        operationId,
        0,
        1
      );
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      await handler(message);
      const outcomeKey = `aiob.restoreStorage.outcome.v1.${operationId}`;
      const outcome = await local.get<Record<string, string | number>>(outcomeKey);
      if (!outcome) throw new Error('expected outcome');
      await local.set(outcomeKey, { ...outcome, [field]: value });

      const restarted = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );
      await expect(restarted(message)).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
    }
  );

  it('expires a pending journal and lease when the draft still matches the previous state', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (failDraftWrite && DRAFT_KEY in entries) {
          failDraftWrite = false;
          return Promise.reject(new Error('simulated pre-draft crash'));
        }
        return memory.setMany(entries);
      }
    };
    const firstOperation = 'operation-expired-before-draft';
    const firstMessage = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      firstOperation,
      0,
      1
    );
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await handler(firstMessage);
    const journalKey = `aiob.restoreStorage.pending.v1.${firstOperation}`;
    const journal = await local.get<Record<string, object | string | number | null>>(journalKey);
    if (!journal) throw new Error('expected pending journal');
    await local.set(journalKey, {
      ...journal,
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });
    const leaseKey = `aiob.restoreStorage.lease.v1.${firstOperation}`;
    await local.set(leaseKey, {
      schemaVersion: 1,
      operationId: firstOperation,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['unused-key'],
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });

    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-after-expired-pending',
          0,
          1
        )
      )
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(journalKey)).resolves.toBeUndefined();
    await expect(local.get(leaseKey)).resolves.toBeUndefined();
  });

  it('terminates an expired current retry before it can write the draft', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (failDraftWrite && DRAFT_KEY in entries) {
          failDraftWrite = false;
          return Promise.reject(new Error('simulated expired-current pre-write crash'));
        }
        return memory.setMany(entries);
      }
    };
    const operationId = 'operation-expired-current-retry';
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      operationId,
      0,
      1
    );
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await handler(message);
    const journalKey = `aiob.restoreStorage.pending.v1.${operationId}`;
    const journal = await local.get<Record<string, object | string | number | null>>(journalKey);
    if (!journal) throw new Error('expected pending journal');
    await local.set(journalKey, {
      ...journal,
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });
    const leaseKey = `aiob.restoreStorage.lease.v1.${operationId}`;
    await local.set(leaseKey, {
      schemaVersion: 1,
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['provisional-expired-current'],
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });

    await expect(handler(message)).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
    await expect(local.get(DRAFT_KEY)).resolves.toBeUndefined();
    await expect(local.get(journalKey)).resolves.toBeUndefined();
    await expect(local.get(leaseKey)).resolves.toBeUndefined();
    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-after-expired-current',
          0,
          1
        )
      )
    ).resolves.toMatchObject({ success: true, revision: 1 });
  });

  it('protects another draft previous state from retention while its journal is live', async () => {
    const memory = createMemoryStorageArea();
    let draftAWrites = 0;
    let failBFinalization = true;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (DRAFT_KEY in entries) {
          draftAWrites += 1;
          if (draftAWrites === 2) {
            return Promise.reject(new Error('simulated A2 pre-write crash'));
          }
        }
        if (
          failBFinalization &&
          'aiob.restoreStorage.outcome.v1.operation-retention-b' in entries
        ) {
          failBFinalization = false;
          return Promise.reject(new Error('simulated B finalization crash'));
        }
        return memory.setMany(entries);
      }
    };
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      {
        getCurrentPolicy: () =>
          createSessionDraftStoragePolicy({
            maxDraftEntries: 1,
            videoScreenshotCache: { maxContentBytes: 64 }
          })
      },
      { blobStore: createBlobStore(null) }
    );
    const draftA1 = { ...envelope(screenshotRef()), payload: { captures: [] } };
    const draftA2 = { ...draftA1, updatedAt: NOW + 2 };
    await handler(saveMessage(draftA1, 'operation-retention-a1', 0, 1));
    const messageA2 = saveMessage(draftA2, 'operation-retention-a2', 1, 2);
    await expect(handler(messageA2)).resolves.toEqual({
      success: false,
      error: 'simulated A2 pre-write crash'
    });
    const draftB = {
      ...draftA1,
      draftId: 'draft-retention-b',
      updatedAt: NOW + 3
    };
    const draftBKey = createSessionDraftStorageKey({
      mode: draftB.mode,
      pageKey: draftB.pageKey,
      draftId: draftB.draftId
    });
    const messageB = saveMessage(draftB, 'operation-retention-b', 0, 1);

    await expect(
      handler({ ...messageB, context: { ...messageB.context, draftKey: draftBKey } })
    ).resolves.toEqual({ success: false, error: 'simulated B finalization crash' });
    await expect(
      handler({ ...messageB, context: { ...messageB.context, draftKey: draftBKey } })
    ).resolves.toMatchObject({ success: true, replayed: true, revision: 1 });
    await expect(local.get(DRAFT_KEY)).resolves.toEqual(draftA1);
    const protectedIndex = await local.get<{ entries: Array<{ key: string }> }>(
      SESSION_DRAFT_INDEX_KEY
    );
    expect(protectedIndex?.entries.map(({ key }) => key).sort()).toEqual(
      [DRAFT_KEY, draftBKey].sort()
    );
    const candidatesResponse = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'listSessionDraftCandidates',
      mode: 'video',
      pageUrl: PAGE_URL
    });
    if (
      !candidatesResponse ||
      candidatesResponse.success !== true ||
      candidatesResponse.operation !== 'listSessionDraftCandidates'
    ) {
      throw new Error('expected listSessionDraftCandidates success');
    }
    expect(
      candidatesResponse.result.candidates.some(
        (candidate) => candidate.envelope.draftId === draftA1.draftId
      )
    ).toBe(true);
    await expect(handler(messageA2)).resolves.toMatchObject({
      success: true,
      revision: 2
    });
  });

  it('rejects oversized protocol identity before creating a pending WAL record', async () => {
    const local = createMemoryStorageArea();
    const oversized = {
      ...envelope(screenshotRef()),
      draftId: 'x'.repeat(3_000),
      payload: { captures: [] }
    };
    const oversizedKey = createSessionDraftStorageKey({
      mode: oversized.mode,
      pageKey: oversized.pageKey,
      draftId: oversized.draftId
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const message = saveMessage(oversized, 'operation-oversized-identity', 0, 1);

    await expect(
      handler({ ...message, context: { ...message.context, draftKey: oversizedKey } })
    ).resolves.toBeUndefined();
    expect(
      Object.keys(await local.getAll()).some((key) => key.startsWith('aiob.restoreStorage.'))
    ).toBe(false);
  });

  it.each([
    ['oversized-envelope', { captures: [], note: 'x'.repeat(600 * 1_024) }],
    ['disallowed-data-image', { captures: [], note: 'data:image/png;base64,AAAA' }]
  ])('rejects %s before writing WAL authority', async (operationId, payload) => {
    const local = createMemoryStorageArea();
    const fullOperationId = `operation-${operationId}`;
    const leaseCreatedAt = Date.now() - 1;
    await local.set(`aiob.restoreStorage.lease.v1.${fullOperationId}`, {
      schemaVersion: 1,
      operationId: fullOperationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['orphan-after-invalid-draft'],
      createdAt: leaseCreatedAt,
      expiresAt: leaseCreatedAt + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(saveMessage({ ...envelope(screenshotRef()), payload }, fullOperationId, 0, 1))
    ).resolves.toMatchObject({ success: false });
    await expect(local.getAll()).resolves.toEqual({
      'aiob.restoreStorage.barrier.v1': {
        schemaVersion: 1,
        epoch: 1,
        state: 'ready'
      }
    });
  });

  it('consumes a matching lease when a structured-clone value is not canonical JSON', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-non-canonical-map';
    const leaseKey = `aiob.restoreStorage.lease.v1.${operationId}`;
    const leaseCreatedAt = Date.now() - 1;
    await local.set(leaseKey, {
      schemaVersion: 1,
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['orphan-after-non-canonical-draft'],
      createdAt: leaseCreatedAt,
      expiresAt: leaseCreatedAt + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const message = saveMessage(
      { ...envelope(screenshotRef()), payload: { captures: [] } },
      operationId,
      0,
      1
    );

    await expect(
      handler({
        ...message,
        envelope: {
          ...message.envelope,
          payload: { captures: [], opaque: new Map([['k', 'v']]) }
        }
      })
    ).resolves.toEqual({ success: false, error: 'CANONICAL_JSON_INVALID' });
    await expect(local.getAll()).resolves.toEqual({
      'aiob.restoreStorage.barrier.v1': {
        schemaVersion: 1,
        epoch: 1,
        state: 'ready'
      }
    });
  });

  it('enforces the compact WAL hard byte limit after bounded identity validation', async () => {
    const local = createMemoryStorageArea();
    const now = Date.now();
    const baseJournal: SessionDraftSaveJournal = {
      schemaVersion: 1,
      state: 'pending',
      operationId: 'o'.repeat(128),
      context: {
        operationId: 'o'.repeat(128),
        epoch: 1,
        draftKey: 'k'.repeat(512),
        baseRevision: 0,
        nextRevision: 1
      },
      requestFingerprint: '0'.repeat(64),
      desiredEnvelopeFingerprint: '1'.repeat(64),
      previousEnvelopeFingerprint: null,
      createdAt: now,
      expiresAt: now + 15 * 60 * 1_000
    };
    await expect(writePendingJournal(local, baseJournal)).resolves.toBeUndefined();
    const stored = await local.get(`aiob.restoreStorage.pending.v1.${'o'.repeat(128)}`);
    expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThan(2_048);
    await expect(
      finalizeJournal(
        local,
        baseJournal,
        {
          schemaVersion: 1,
          epoch: 1,
          state: 'present',
          draftKey: baseJournal.context.draftKey,
          revision: 1,
          lastOperationId: baseJournal.operationId
        },
        {
          schemaVersion: 1,
          kind: 'save',
          operationId: baseJournal.operationId,
          draftKey: baseJournal.context.draftKey,
          revision: 1,
          requestFingerprint: baseJournal.requestFingerprint,
          createdAt: now,
          expiresAt: now + 15 * 60 * 1_000
        }
      )
    ).resolves.toBeUndefined();

    const overflowLocal = createMemoryStorageArea();
    expect(() =>
      writePendingJournal(overflowLocal, {
        ...baseJournal,
        operationId: 'overflow-operation',
        context: {
          ...baseJournal.context,
          operationId: 'overflow-operation',
          draftKey: 'k'.repeat(3_000)
        }
      })
    ).toThrow('RESTORE_STORAGE_PENDING_WAL_TOO_LARGE');
    expect(() =>
      finalizeJournal(
        overflowLocal,
        {
          ...baseJournal,
          operationId: 'overflow-operation',
          context: {
            ...baseJournal.context,
            operationId: 'overflow-operation',
            draftKey: 'k'.repeat(3_000)
          }
        },
        {
          schemaVersion: 1,
          epoch: 1,
          state: 'present',
          draftKey: 'k'.repeat(3_000),
          revision: 1,
          lastOperationId: 'overflow-operation'
        },
        {
          schemaVersion: 1,
          kind: 'save',
          operationId: 'overflow-operation',
          draftKey: 'k'.repeat(3_000),
          revision: 1,
          requestFingerprint: baseJournal.requestFingerprint,
          createdAt: now,
          expiresAt: now + 15 * 60 * 1_000
        }
      )
    ).toThrow('RESTORE_STORAGE_PENDING_WAL_TOO_LARGE');
    await expect(overflowLocal.getAll()).resolves.toEqual({});
  });

  it('does not advance the cursor when compact recovery fingerprints are cross-bound', async () => {
    const memory = createMemoryStorageArea();
    let draftWrites = 0;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (DRAFT_KEY in entries) {
          draftWrites += 1;
        }
        if (DRAFT_KEY in entries && draftWrites === 2) {
          return Promise.reject(new Error('simulated cross-binding pre-write crash'));
        }
        return memory.setMany(entries);
      }
    };
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    const a1 = { ...envelope(screenshotRef()), payload: { captures: [] } };
    const a2 = { ...a1, updatedAt: NOW + 2 };
    await handler(saveMessage(a1, 'operation-cross-fingerprint-a1', 0, 1));
    await expect(handler(saveMessage(a2, 'operation-cross-fingerprint-a2', 1, 2))).resolves.toEqual(
      {
        success: false,
        error: 'simulated cross-binding pre-write crash'
      }
    );
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`)
    ).resolves.toMatchObject({ revision: 1, lastOperationId: 'operation-cross-fingerprint-a1' });
    const journalKey = 'aiob.restoreStorage.pending.v1.operation-cross-fingerprint-a2';
    const journal = await local.get<Record<string, object | string | number | null>>(journalKey);
    if (!journal) throw new Error('expected compact journal');
    const storedA1 = await local.get<VideoSessionDraftEnvelope>(DRAFT_KEY);
    if (!storedA1) throw new Error('expected stored A1');
    expect(
      await createRequestFingerprint(
        {
          operationId: 'operation-cross-fingerprint-a2',
          epoch: 1,
          draftKey: DRAFT_KEY,
          baseRevision: 1,
          nextRevision: 2
        },
        storedA1
      )
    ).not.toBe(journal.requestFingerprint);
    await local.set(journalKey, {
      ...journal,
      desiredEnvelopeFingerprint: await createEnvelopeFingerprint(a1)
    });

    await expect(
      handler(saveMessage({ ...a2, updatedAt: NOW + 3 }, 'operation-trigger-cross', 1, 2))
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(
      local.get(`aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`)
    ).resolves.toMatchObject({ revision: 1, lastOperationId: 'operation-cross-fingerprint-a1' });
  });

  it('finalizes an expired pending journal whose desired draft was written before a new revision', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    let draftWrites = 0;
    const local = {
      ...memory,
      async setMany<Value>(entries: Record<string, Value>) {
        if (DRAFT_KEY in entries) {
          draftWrites += 1;
          if (failDraftWrite) {
            failDraftWrite = false;
            await memory.set(DRAFT_KEY, entries[DRAFT_KEY]);
            throw new Error('simulated desired-only crash');
          }
        }
        await memory.setMany(entries);
      }
    };
    const firstOperation = 'operation-expired-desired';
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await handler(
      saveMessage({ ...envelope(screenshotRef()), payload: { captures: [] } }, firstOperation, 0, 1)
    );
    const journalKey = `aiob.restoreStorage.pending.v1.${firstOperation}`;
    const journal = await local.get<Record<string, object | string | number | null>>(journalKey);
    if (!journal) throw new Error('expected pending journal');
    await local.set(journalKey, {
      ...journal,
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });

    await expect(
      handler(
        saveMessage(
          {
            ...envelope(screenshotRef()),
            updatedAt: NOW + 2,
            payload: { captures: [] }
          },
          'operation-after-expired-desired',
          1,
          2
        )
      )
    ).resolves.toMatchObject({ success: true, revision: 2 });
    await expect(local.get(journalKey)).resolves.toBeUndefined();
    await expect(
      local.get(`aiob.restoreStorage.outcome.v1.${firstOperation}`)
    ).resolves.toMatchObject({ revision: 1 });
    expect(draftWrites).toBe(2);
  });

  it('fails closed when an expired pending journal draft matches neither previous nor desired', async () => {
    const memory = createMemoryStorageArea();
    let failDraftWrite = true;
    const local = {
      ...memory,
      setMany<Value>(entries: Record<string, Value>) {
        if (failDraftWrite && DRAFT_KEY in entries) {
          failDraftWrite = false;
          return Promise.reject(new Error('simulated pre-draft crash'));
        }
        return memory.setMany(entries);
      }
    };
    const firstOperation = 'operation-expired-diverged';
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await handler(
      saveMessage({ ...envelope(screenshotRef()), payload: { captures: [] } }, firstOperation, 0, 1)
    );
    const journalKey = `aiob.restoreStorage.pending.v1.${firstOperation}`;
    const journal = await local.get<Record<string, object | string | number | null>>(journalKey);
    if (!journal) throw new Error('expected pending journal');
    await local.set(journalKey, {
      ...journal,
      createdAt: 1,
      expiresAt: 1 + 15 * 60 * 1_000
    });
    await local.set(DRAFT_KEY, {
      ...envelope(screenshotRef()),
      pageTitle: 'diverged durable draft',
      payload: { captures: [] }
    });

    await expect(
      handler(
        saveMessage(
          { ...envelope(screenshotRef()), payload: { captures: [] } },
          'operation-blocked-by-diverged-pending',
          0,
          1
        )
      )
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.get(journalKey)).resolves.toBeDefined();
  });

  it('reuses the same pending operation after the transport loses a successful save response', async () => {
    const local = createMemoryStorageArea();
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let loseFirstSaveResponse = true;
    const messaging: SessionDraftRepositoryMessaging = {
      async send(message) {
        const response = await handler(message);
        if (message.operation === 'saveSessionDraft' && loseFirstSaveResponse) {
          loseFirstSaveResponse = false;
          throw new Error('simulated lost response');
        }
        return response;
      }
    };
    const createOperationId = vi
      .fn<() => string>()
      .mockReturnValueOnce('operation-lost-response')
      .mockReturnValueOnce('operation-must-not-be-used');
    const client = createSessionDraftClientRepository(messaging, { createOperationId });
    const draft = { ...envelope(screenshotRef()), payload: { captures: [] } };
    await client.loadLatest('video', PAGE_URL, NOW);

    await expect(client.save(draft)).rejects.toThrow('simulated lost response');
    await expect(client.save(draft)).resolves.toBeUndefined();
    expect(createOperationId).toHaveBeenCalledTimes(1);
    await expect(
      local.get('aiob.restoreStorage.outcome.v1.operation-lost-response')
    ).resolves.toMatchObject({ revision: 1 });
  });

  it('clears pending operation and cursor state when authoritative epoch changes', async () => {
    let epoch = 1;
    let loseResponse = true;
    const contexts: Array<{ operationId: string; epoch: number; baseRevision: number }> = [];
    const messaging: SessionDraftRepositoryMessaging = {
      send(message) {
        if (message.operation === 'loadLatestSessionDraft') {
          return Promise.resolve({
            success: true,
            operation: message.operation,
            result: { envelope: null, epoch, revision: 0 }
          });
        }
        if (message.operation === 'prepareSessionDraftOperation') {
          return Promise.resolve({
            success: true,
            operation: message.operation,
            context: {
              operationId: message.operationId,
              epoch,
              draftKey: message.draftKey,
              baseRevision: 0,
              nextRevision: 1
            },
            replayed: false,
            status: 'prepared'
          });
        }
        if (message.operation === 'saveSessionDraft') {
          contexts.push({
            operationId: message.context.operationId,
            epoch: message.context.epoch,
            baseRevision: message.context.baseRevision
          });
          if (loseResponse) {
            loseResponse = false;
            return Promise.reject(new Error('simulated epoch-transition loss'));
          }
          return Promise.resolve({
            success: true,
            operation: message.operation,
            revision: 1,
            replayed: false
          });
        }
        return Promise.resolve({ success: true, operation: message.operation });
      }
    };
    const operationIds = ['operation-epoch-1', 'operation-epoch-2'];
    const client = createSessionDraftClientRepository(messaging, {
      createOperationId: () => operationIds.shift() ?? 'unexpected-operation'
    });
    const draft = { ...envelope(screenshotRef()), payload: { captures: [] } };
    await client.loadLatest('video', PAGE_URL, NOW);
    await expect(client.save(draft)).rejects.toThrow('simulated epoch-transition loss');
    epoch = 2;
    await client.loadLatest('video', PAGE_URL, NOW);
    await client.save(draft);

    expect(contexts).toEqual([
      { operationId: 'operation-epoch-1', epoch: 1, baseRevision: 0 },
      { operationId: 'operation-epoch-2', epoch: 2, baseRevision: 0 }
    ]);
  });

  it.each(['loadLatestSessionDraft', 'listSessionDraftCandidates'] as const)(
    'fails closed instead of performing an unversioned owner claim during %s',
    async (operation) => {
      const local = createMemoryStorageArea();
      await createSessionDraftRepository(local, { resolveOwnerContext: () => null }).save({
        ...envelope(screenshotRef()),
        status: 'restorable',
        payload: { captures: [] }
      });
      const setMany = vi.spyOn(local, 'setMany');
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null) }
      );

      await expect(
        handler({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation,
          mode: 'video',
          pageUrl: PAGE_URL,
          now: NOW,
          options: { ownerContext: { tabId: 7 } }
        })
      ).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED'
      });
      expect(setMany).not.toHaveBeenCalled();
    }
  );

  it('claims from runtime sender identity and allows only one active competing owner', async () => {
    const local = createMemoryStorageArea();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      status: 'restorable',
      payload: { captures: [] }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      {
        blobStore: createBlobStore(null),
        isOwnerContextActive: (owner) => owner.tabId === 1
      }
    );
    const clientA = createSessionDraftClientRepository({
      send: (message) => handler(message, { tabId: 1, windowId: 4, frameId: 0 })
    });
    const clientB = createSessionDraftClientRepository({
      send: (message) => handler(message, { tabId: 2, windowId: 4, frameId: 0 })
    });
    const draftA = await clientA.loadLatest('video', PAGE_URL);
    const draftB = await clientB.loadLatest('video', PAGE_URL);
    if (!draftA || !draftB) throw new Error('expected competing restorable draft');

    await expect(clientA.claim(draftA)).resolves.toBeUndefined();
    await expect(clientB.claim(draftB)).rejects.toThrow('RESTORE_STORAGE_REVISION_CONFLICT');
    await expect(local.get<VideoSessionDraftEnvelope>(DRAFT_KEY)).resolves.toMatchObject({
      payload: { ownerContext: { tabId: 1, windowId: 4, frameId: 0 } }
    });
  });

  it('claims with the default background screenshot store composition', async () => {
    const local = createMemoryStorageArea();
    const currentTime = Date.now();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      createdAt: currentTime - 1,
      updatedAt: currentTime,
      expiresAt: currentTime + 60_000,
      status: 'restorable',
      payload: { captures: [] }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler({ local });
    const client = createSessionDraftClientRepository({
      send: (message) => handler(message, { tabId: 7, windowId: 3, frameId: 0 })
    });
    const draft = await client.loadLatest('video', PAGE_URL);
    if (!draft) throw new Error('expected default claim draft');

    await expect(client.claim(draft)).resolves.toBeUndefined();
  });

  it('does not write a claim lease when the operation id collides with authority', async () => {
    const cases = ['clear', 'delete', 'retired', 'quarantined-lease'];
    for (const authority of cases) {
      const local = createMemoryStorageArea();
      await createSessionDraftRepository(local).save({
        ...envelope(screenshotRef()),
        status: 'restorable',
        payload: { captures: [] }
      });
      const operationId = `operation-claim-${authority}`;
      const encoded = encodeURIComponent(operationId);
      const now = Date.now();
      if (authority === 'clear') {
        await local.set(`aiob.restoreStorage.clear.v1.${encoded}`, { collision: true });
      } else if (authority === 'delete') {
        await local.set(`aiob.restoreStorage.delete.v1.${encoded}`, { collision: true });
      } else if (authority === 'retired') {
        await local.set(`aiob.restoreStorage.retiredOperation.v1.${encoded}`, {
          schemaVersion: 1,
          operationId,
          retiredAt: now,
          expiresAt: now + 15 * 60 * 1_000
        });
      } else {
        await local.set('aiob.restoreStorage.corruption.v1', {
          schemaVersion: 1,
          recoveryRequiredUntil: null,
          entries: [
            {
              sourceKey: `aiob.restoreStorage.lease.v1.${encoded}`,
              quarantinedAt: now
            }
          ]
        });
      }
      const handler = createRawBackgroundVideoScreenshotCacheHandler(
        { local },
        { maxContentBytes: 64 },
        { blobStore: createBlobStore(null), isOwnerContextActive: () => false }
      );

      await expect(
        handler(
          {
            type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
            operation: 'claimSessionDraft',
            operationId,
            draftKey: DRAFT_KEY,
            expectedEpoch: 1,
            expectedRevision: 0
          },
          { tabId: 7 }
        )
      ).resolves.toMatchObject({ success: false });
      await expect(local.get(`aiob.restoreStorage.lease.v1.${encoded}`)).resolves.toBeUndefined();
    }
  });

  it('replays a lost claim response with the same operation id', async () => {
    const local = createMemoryStorageArea();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      status: 'restorable',
      payload: { captures: [] }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    let loseClaimResponse = true;
    const claimOperationIds: string[] = [];
    const client = createSessionDraftClientRepository({
      async send(message) {
        const response = await handler(message, { tabId: 9, windowId: 4, frameId: 0 });
        if (message.operation === 'claimSessionDraft') {
          claimOperationIds.push(message.operationId);
          if (loseClaimResponse) {
            loseClaimResponse = false;
            throw new Error('simulated lost claim response');
          }
        }
        return response;
      }
    });
    const draft = await client.loadLatest('video', PAGE_URL);
    if (!draft) throw new Error('expected claim replay draft');

    await expect(client.claim(draft)).rejects.toThrow('simulated lost claim response');
    await expect(client.claim(draft)).resolves.toBeUndefined();
    expect(claimOperationIds).toEqual([claimOperationIds[0], claimOperationIds[0]]);
  });

  it('allows an inactive owner takeover and persists only the runtime sender owner', async () => {
    const local = createMemoryStorageArea();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      status: 'restorable',
      payload: { captures: [], ownerContext: { tabId: 1, windowId: 4 } }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null), isOwnerContextActive: () => false }
    );
    const client = createSessionDraftClientRepository({
      send: (message) => handler(message, { tabId: 2, windowId: 4, frameId: 0 })
    });
    const draft = await client.loadLatest('video', PAGE_URL);
    if (!draft) throw new Error('expected inactive-owner draft');

    await expect(client.claim(draft)).resolves.toBeUndefined();
    expect((await local.get<VideoSessionDraftEnvelope>(DRAFT_KEY))?.payload.ownerContext).toEqual({
      tabId: 2,
      windowId: 4,
      frameId: 0
    });
  });

  it('fails closed when a claim has no sender tab identity', async () => {
    const local = createMemoryStorageArea();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      status: 'restorable',
      payload: { captures: [] }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );

    await expect(
      handler(
        {
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'claimSessionDraft',
          operationId: 'operation-no-tab-claim',
          draftKey: DRAFT_KEY,
          expectedEpoch: 1,
          expectedRevision: 0
        },
        { windowId: 4, frameId: 0 }
      )
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID' });
  });

  it('preserves claimed owner on normal saves and rejects a different unclaimed sender', async () => {
    const local = createMemoryStorageArea();
    await createSessionDraftRepository(local).save({
      ...envelope(screenshotRef()),
      status: 'restorable',
      payload: { captures: [] }
    });
    const handler = createRawBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null), isOwnerContextActive: () => true }
    );
    const clientA = createSessionDraftClientRepository({
      send: (message) => handler(message, { tabId: 1 })
    });
    const draft = await clientA.loadLatest('video', PAGE_URL);
    if (!draft) throw new Error('expected owner preservation draft');
    await clientA.claim(draft);
    await clientA.save({ ...draft, updatedAt: draft.updatedAt + 1, payload: { captures: [] } });
    const owned = await local.get<VideoSessionDraftEnvelope>(DRAFT_KEY);
    expect(owned?.payload.ownerContext).toEqual({ tabId: 1 });
    const nextRevision = 2;
    const intruderOperation = 'operation-unclaimed-intruder';
    const prepared = await handler(
      {
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId: intruderOperation,
        draftKey: DRAFT_KEY,
        expectedEpoch: 1,
        expectedRevision: nextRevision
      },
      { tabId: 2 }
    );
    if (
      !prepared ||
      prepared.success !== true ||
      prepared.operation !== 'prepareSessionDraftOperation'
    ) {
      throw new Error('expected intruder prepare context');
    }
    await expect(
      handler(
        {
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'saveSessionDraft',
          context: prepared.context,
          envelope: { ...draft, updatedAt: draft.updatedAt + 2, payload: { captures: [] } }
        },
        { tabId: 2 }
      )
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED'
    });
    expect((await local.get<VideoSessionDraftEnvelope>(DRAFT_KEY))?.payload.ownerContext).toEqual({
      tabId: 1
    });
  });

  it('consumes an operation lease after a no-reference WAL commit', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'operation-no-ref-lease';
    const leaseKey = `aiob.restoreStorage.lease.v1.${operationId}`;
    await local.set(leaseKey, {
      schemaVersion: 1,
      operationId,
      epoch: 1,
      draftKey: DRAFT_KEY,
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: ['unused-key'],
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1_000
    });
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore: createBlobStore(null) }
    );
    await expect(
      handler(
        saveMessage({ ...envelope(screenshotRef()), payload: { captures: [] } }, operationId, 0, 1)
      )
    ).resolves.toMatchObject({ success: true, revision: 1 });
    await expect(local.get(leaseKey)).resolves.toBeUndefined();
  });
});
