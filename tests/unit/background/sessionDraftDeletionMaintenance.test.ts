/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import type { ReaderSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import { createRestoreStorageOperationQueue } from '../../../src/background/services/restoreStorageOperationQueue';
import {
  createSessionDraftDeletionChunkStorageKey,
  createSessionDraftDeletionManifestStorageKey
} from '../../../src/background/services/sessionDraftDeletionRecordAccess';
import { createSessionDraftDeletionOwner } from '../../../src/background/services/sessionDraftDeletionOwner';
import {
  SESSION_DRAFT_DELETE_RECEIPT_TTL_MS,
  type SessionDraftDeletionChunk
} from '../../../src/background/services/sessionDraftDeletionStore';
import { prepareSessionDraftOperation } from '../../../src/background/services/sessionDraftOperationPreparation';
import { SESSION_DRAFT_RETIRED_OPERATION_PREFIX } from '../../../src/background/services/sessionDraftRetiredOperationStore';
import { createSessionDraftCursorStorageKey } from '../../../src/background/services/sessionDraftSaveJournal';

const NOW = 2_000_000_000_000;
const CURSOR_KEY = 'aiob.restoreStorage.deleteGcCursor.v1';
const CORRUPTION_KEY = 'aiob.restoreStorage.corruption.v1';
const FINGERPRINT = 'a'.repeat(64);

function draftKey(): string {
  const envelope: ReaderSessionDraftEnvelope = {
    schemaVersion: 1,
    draftId: 'draft-gc',
    mode: 'reader',
    pageKey: 'page-gc',
    pageUrl: 'https://example.com/gc',
    pageTitle: 'gc',
    createdAt: NOW - 100,
    updatedAt: NOW - 50,
    expiresAt: NOW + 100_000,
    status: 'restorable',
    payload: { highlights: [] }
  };
  return createSessionDraftStorageKey(envelope);
}

function chunk(operationId: string, createdAt: number, chunkIndex = 0): SessionDraftDeletionChunk {
  return {
    schemaVersion: 1,
    kind: 'delete',
    state: 'selected',
    operationId,
    epoch: 7,
    chunkIndex,
    requestFingerprint: FINGERPRINT,
    candidateFingerprint: 'b'.repeat(64),
    candidateCount: 1,
    candidateKeys: [draftKey()],
    revisions: [],
    existingRevisions: [],
    protectedKeys: [],
    createdAt,
    expiresAt: createdAt + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
  };
}

function owner(local: ReturnType<typeof createMemoryStorageArea>) {
  return createSessionDraftDeletionOwner({
    local,
    operationQueue: createRestoreStorageOperationQueue(),
    getCurrentEpoch: () => 7,
    now: () => NOW
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session draft deletion receipt maintenance', () => {
  it('continues a greater-than-64 record scan from the persisted cursor after owner restart', async () => {
    const local = createMemoryStorageArea();
    const operationIds = Array.from(
      { length: 65 },
      (_, index) => `gc-${String(index).padStart(3, '0')}`
    );
    for (const operationId of operationIds) {
      await local.set(
        createSessionDraftDeletionChunkStorageKey(operationId, 0),
        chunk(operationId, NOW - 1)
      );
    }

    await owner(local).withinOperationMaintenance();

    await expect(local.get(CURSOR_KEY)).resolves.toBe(
      createSessionDraftDeletionChunkStorageKey(operationIds[63] ?? '', 0)
    );

    await owner(local).withinOperationMaintenance();

    await expect(local.get(CURSOR_KEY)).resolves.toBeUndefined();
    await expect(
      local.get(createSessionDraftDeletionChunkStorageKey('gc-064', 0))
    ).resolves.toEqual(chunk('gc-064', NOW - 1));
  });

  it('retires and removes an expired orphan chunk', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'expired-orphan';
    const chunkKey = createSessionDraftDeletionChunkStorageKey(operationId, 0);
    await local.set(chunkKey, chunk(operationId, NOW - SESSION_DRAFT_DELETE_RECEIPT_TTL_MS));

    await owner(local).withinOperationMaintenance();

    await expect(local.get(chunkKey)).resolves.toBeUndefined();
    await expect(
      local.get(`${SESSION_DRAFT_RETIRED_OPERATION_PREFIX}${encodeURIComponent(operationId)}`)
    ).resolves.toEqual({
      schemaVersion: 1,
      operationId,
      retiredAt: NOW,
      expiresAt: NOW + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
    });
  });

  it('quarantines a malformed orphan chunk 1 and rejects the same save operation for 15 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const operationId = 'malformed-orphan';
    const chunkKey = createSessionDraftDeletionChunkStorageKey(operationId, 1);
    const manifestKey = createSessionDraftDeletionManifestStorageKey(operationId);
    await local.set(chunkKey, { schemaVersion: 99, operationId });

    await expect(owner(local).withinOperationMaintenance()).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(local.get(chunkKey)).resolves.toBeUndefined();
    const corruption = await local.get<{
      entries: Array<{ sourceKey: string; quarantinedAt: number }>;
    }>(CORRUPTION_KEY);
    expect(corruption?.entries).toEqual(
      expect.arrayContaining([
        { sourceKey: chunkKey, quarantinedAt: NOW },
        { sourceKey: manifestKey, quarantinedAt: NOW }
      ])
    );

    vi.setSystemTime(NOW + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS - 1);
    await expect(
      prepareSessionDraftOperation(
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'prepareSessionDraftOperation',
          operationId,
          draftKey: draftKey()
        },
        {
          local,
          screenshots: { get: () => Promise.resolve({ status: 'missing' }) },
          getStoragePolicy: () => ({
            retentionPolicy: { retentionMs: 1, maxRestorablePages: null, maxItemsPerPage: null },
            maxDraftEntries: 1,
            maxEnvelopeBytes: 1024,
            videoScreenshotCache: {
              ttlMs: 1,
              maxGlobalEntries: 1,
              maxPageEntries: 1,
              maxContentBytes: 1024
            }
          }),
          getEpoch: () => 7,
          deleteDraftCandidates: () => Promise.reject(new Error('unexpected deletion')),
          replayDraftDeletion: () => Promise.resolve(null)
        }
      )
    ).rejects.toThrow('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
  });

  it('quarantines and removes a malformed persisted GC cursor', async () => {
    const local = createMemoryStorageArea();
    await local.set(CURSOR_KEY, 64);

    await expect(owner(local).withinOperationMaintenance()).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );

    await expect(local.get(CURSOR_KEY)).resolves.toBeUndefined();
    await expect(local.get(CORRUPTION_KEY)).resolves.toMatchObject({
      schemaVersion: 1,
      recoveryRequiredUntil: null,
      entries: [{ sourceKey: CURSOR_KEY, quarantinedAt: NOW }]
    });
  });

  it('resumes a pending deletion receipt during unrelated maintenance', async () => {
    const memory = createMemoryStorageArea();
    const key = draftKey();
    await memory.setMany({
      [key]: { retained: true },
      [createSessionDraftCursorStorageKey(key)]: {
        schemaVersion: 1,
        epoch: 7,
        state: 'present',
        draftKey: key,
        revision: 1,
        lastOperationId: 'save-before-resume'
      }
    });
    let failRemove = true;
    const failing = {
      ...memory,
      async remove(keys: string | string[]) {
        if (failRemove && (Array.isArray(keys) ? keys : [keys]).includes(key)) {
          failRemove = false;
          throw new Error('lost physical completion');
        }
        await memory.remove(keys);
      }
    };
    const interrupted = createSessionDraftDeletionOwner({
      local: failing,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    await expect(
      interrupted.queuedOwner.execute({
        operationId: 'pending-resume',
        requestFingerprint: FINGERPRINT,
        candidateKeys: [key]
      })
    ).rejects.toThrow('lost physical completion');

    await owner(memory).withinOperationMaintenance();

    await expect(memory.get(key)).resolves.toBeUndefined();
    await expect(
      memory.get(createSessionDraftDeletionManifestStorageKey('pending-resume'))
    ).resolves.toMatchObject({ state: 'committed' });
  });

  it('fails closed when pending delete and save authorities share an operation id', async () => {
    const memory = createMemoryStorageArea();
    const key = draftKey();
    await memory.setMany({
      [key]: { retained: true },
      [createSessionDraftCursorStorageKey(key)]: {
        schemaVersion: 1,
        epoch: 7,
        state: 'present',
        draftKey: key,
        revision: 1,
        lastOperationId: 'save-before-collision'
      }
    });
    let failRemove = true;
    const failing = {
      ...memory,
      async remove(keys: string | string[]) {
        if (failRemove && (Array.isArray(keys) ? keys : [keys]).includes(key)) {
          failRemove = false;
          throw new Error('leave pending receipt');
        }
        await memory.remove(keys);
      }
    };
    const interrupted = createSessionDraftDeletionOwner({
      local: failing,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    await expect(
      interrupted.queuedOwner.execute({
        operationId: 'dual-authority',
        requestFingerprint: FINGERPRINT,
        candidateKeys: [key]
      })
    ).rejects.toThrow('leave pending receipt');
    await memory.set('aiob.restoreStorage.pending.v1.dual-authority', {
      schemaVersion: 1,
      state: 'pending',
      operationId: 'dual-authority',
      context: {
        operationId: 'dual-authority',
        epoch: 7,
        draftKey: key,
        baseRevision: 2,
        nextRevision: 3
      },
      requestFingerprint: FINGERPRINT,
      desiredEnvelopeFingerprint: 'b'.repeat(64),
      previousEnvelopeFingerprint: 'c'.repeat(64),
      createdAt: NOW,
      expiresAt: NOW + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
    });
    const before = await memory.getAll();

    await expect(owner(memory).withinOperationMaintenance()).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(memory.getAll()).resolves.toEqual(before);
  });
});
