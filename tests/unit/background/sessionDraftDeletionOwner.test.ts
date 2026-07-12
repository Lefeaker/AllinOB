/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import { buildSessionDraftReferenceIndexSnapshot } from '@content/sessionDrafts/sessionDraftReferenceIndex';
import type { ReaderSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import { prepareSessionDraftOperation } from '../../../src/background/services/sessionDraftOperationPreparation';
import {
  createSessionDraftDeletionOwner,
  type SessionDraftDeletionRequest
} from '../../../src/background/services/sessionDraftDeletionOwner';
import {
  createSessionDraftTombstoneStorageKey,
  normalizeSessionDraftDeletionOutcome,
  normalizeSessionDraftTombstone
} from '../../../src/background/services/sessionDraftDeletionStore';
import {
  createSessionDraftCursorStorageKey,
  type SessionDraftCursor
} from '../../../src/background/services/sessionDraftSaveJournal';
import { createRestoreStorageOperationQueue } from '../../../src/background/services/restoreStorageOperationQueue';

const NOW = 2_000_000_000_000;
const FINGERPRINT = 'a'.repeat(64);

function envelope(id = 'draft-delete'): ReaderSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: id,
    mode: 'reader',
    pageKey: 'page-delete',
    pageUrl: 'https://example.com/delete',
    pageTitle: 'delete',
    createdAt: NOW - 100,
    updatedAt: NOW - 50,
    expiresAt: NOW + 100_000,
    status: 'restorable',
    payload: { highlights: [] }
  };
}

function draftKey(value = envelope()): string {
  return createSessionDraftStorageKey(value);
}

function request(operationId: string, keys = [draftKey()]): SessionDraftDeletionRequest {
  return { operationId, requestFingerprint: FINGERPRINT, candidateKeys: keys };
}

function owner(local: ReturnType<typeof createMemoryStorageArea>) {
  return createSessionDraftDeletionOwner({
    local,
    operationQueue: createRestoreStorageOperationQueue(),
    getCurrentEpoch: () => 7,
    now: () => NOW
  }).queuedOwner;
}

function preparationDependencies(local: ReturnType<typeof createMemoryStorageArea>) {
  return {
    local,
    screenshots: { get: () => Promise.resolve({ status: 'missing' as const }) },
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
  };
}

async function seedPresent(
  local: ReturnType<typeof createMemoryStorageArea>,
  value = envelope()
): Promise<void> {
  const key = draftKey(value);
  await local.setMany({
    [key]: value,
    [createSessionDraftCursorStorageKey(key)]: {
      schemaVersion: 1,
      epoch: 7,
      state: 'present',
      draftKey: key,
      revision: 1,
      lastOperationId: 'save-one'
    } satisfies SessionDraftCursor
  });
}

describe('session draft deletion owner', () => {
  it('rejects a same-operation provisional save lease before writing deletion authority', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'same-operation-lease';
    await local.set(`aiob.restoreStorage.lease.v1.${encodeURIComponent(operationId)}`, {
      schemaVersion: 1,
      operationId,
      epoch: 7,
      draftKey: draftKey(),
      baseRevision: 0,
      draftRevision: 1,
      screenshotKeys: [],
      screenshotFingerprints: {},
      createdAt: NOW,
      expiresAt: NOW + 15 * 60 * 1_000
    });
    const before = await local.getAll();

    await expect(owner(local).execute(request(operationId, []))).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('rejects quarantined same-operation authority before reusing a deletion id', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'same-operation-quarantine';
    await local.set('aiob.restoreStorage.corruption.v1', {
      schemaVersion: 1,
      recoveryRequiredUntil: null,
      entries: [
        {
          sourceKey: `aiob.restoreStorage.lease.v1.${encodeURIComponent(operationId)}`,
          quarantinedAt: NOW
        }
      ]
    });
    const before = await local.getAll();

    await expect(owner(local).execute(request(operationId, []))).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('rejects preparing a lease for an operation retained only by quarantine', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'quarantined-lease-prepare';
    await local.set('aiob.restoreStorage.corruption.v1', {
      schemaVersion: 1,
      recoveryRequiredUntil: null,
      entries: [
        {
          sourceKey: `aiob.restoreStorage.lease.v1.${encodeURIComponent(operationId)}`,
          quarantinedAt: Date.now()
        }
      ]
    });
    const before = await local.getAll();

    await expect(
      prepareSessionDraftOperation(
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'prepareSessionDraftOperation',
          operationId,
          draftKey: draftKey()
        },
        preparationDependencies(local)
      )
    ).rejects.toThrow();
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('rejects a save operation retained only by a quarantined numeric deletion chunk', async () => {
    const local = createMemoryStorageArea();
    const operationId = 'quarantined-delete-chunk';
    await local.set('aiob.restoreStorage.corruption.v1', {
      schemaVersion: 1,
      recoveryRequiredUntil: null,
      entries: [
        {
          sourceKey: `aiob.restoreStorage.deleteChunk.v1.${encodeURIComponent(operationId)}.9`,
          quarantinedAt: Date.now()
        }
      ]
    });
    const before = await local.getAll();

    await expect(
      prepareSessionDraftOperation(
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'prepareSessionDraftOperation',
          operationId,
          draftKey: draftKey()
        },
        preparationDependencies(local)
      )
    ).rejects.toThrow('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('tombstones before physical removal and fresh preparation continues the revision', async () => {
    const local = createMemoryStorageArea();
    await seedPresent(local);
    const deletionOwner = owner(local);

    await expect(deletionOwner.execute(request('delete-once'))).resolves.toEqual({
      epoch: 7,
      revisions: [{ draftKey: draftKey(), revision: 2 }],
      protectedKeys: [],
      replayed: false
    });
    await expect(local.get(draftKey())).resolves.toBeUndefined();
    await expect(local.get(createSessionDraftCursorStorageKey(draftKey()))).resolves.toMatchObject({
      epoch: 7,
      state: 'deleted',
      revision: 2,
      lastOperationId: 'delete-once'
    });
    expect(
      normalizeSessionDraftTombstone(
        await local.get(createSessionDraftTombstoneStorageKey(draftKey()))
      )
    ).toMatchObject({ epoch: 7, state: 'deleted', revision: 2 });

    await expect(
      prepareSessionDraftOperation(
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'prepareSessionDraftOperation',
          operationId: 'fresh-save',
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
    ).resolves.toMatchObject({ context: { baseRevision: 2, nextRevision: 3, epoch: 7 } });
  });

  it('replays the same delete operation without advancing or deleting twice', async () => {
    const local = createMemoryStorageArea();
    await seedPresent(local);
    const remove = vi.spyOn(local, 'remove');
    const deletionOwner = owner(local);
    const first = await deletionOwner.execute(request('delete-replay'));
    const removeCalls = remove.mock.calls.length;

    await expect(deletionOwner.execute(request('delete-replay'))).resolves.toEqual({
      ...first,
      replayed: true
    });
    expect(remove).toHaveBeenCalledTimes(removeCalls);
  });

  it('keeps a retained envelope invisible after physical failure and converges on retry', async () => {
    const memory = createMemoryStorageArea();
    await seedPresent(memory);
    let failPhysical = true;
    const local = {
      ...memory,
      async remove(keys: string | string[]) {
        if (failPhysical && (Array.isArray(keys) ? keys : [keys]).includes(draftKey())) {
          failPhysical = false;
          throw new Error('simulated physical failure');
        }
        await memory.remove(keys);
      }
    };
    const deletionOwner = createSessionDraftDeletionOwner({
      local,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    }).queuedOwner;

    await expect(deletionOwner.execute(request('delete-recover'))).rejects.toThrow(
      'simulated physical failure'
    );
    expect(buildSessionDraftReferenceIndexSnapshot(await memory.getAll()).drafts).toEqual([]);
    await expect(deletionOwner.execute(request('delete-recover'))).resolves.toMatchObject({
      revisions: [{ draftKey: draftKey(), revision: 2 }],
      replayed: true
    });
    await expect(memory.get(draftKey())).resolves.toBeUndefined();
  });

  it('does not tombstone a draft protected by a live save journal', async () => {
    const local = createMemoryStorageArea();
    await seedPresent(local);
    await local.set('aiob.restoreStorage.pending.v1.pending-save', {
      schemaVersion: 1,
      state: 'pending',
      operationId: 'pending-save',
      context: {
        operationId: 'pending-save',
        epoch: 7,
        draftKey: draftKey(),
        baseRevision: 1,
        nextRevision: 2
      },
      requestFingerprint: FINGERPRINT,
      desiredEnvelopeFingerprint: 'b'.repeat(64),
      previousEnvelopeFingerprint: 'c'.repeat(64),
      createdAt: NOW - 100,
      expiresAt: NOW - 100 + 15 * 60 * 1_000
    });
    const deletionOwner = owner(local);

    await expect(deletionOwner.execute(request('delete-protected'))).resolves.toEqual({
      epoch: 7,
      revisions: [],
      protectedKeys: [draftKey()],
      replayed: false
    });
    await expect(local.get(draftKey())).resolves.toEqual(envelope());
  });

  it('protects a valid save WAL that appears after the selected receipt', async () => {
    const memory = createMemoryStorageArea();
    await seedPresent(memory);
    let injected = false;
    const local = {
      ...memory,
      async set(key: string, value: unknown) {
        if (!injected && key.startsWith('aiob.restoreStorage.delete.v1.')) {
          injected = true;
          await memory.set('aiob.restoreStorage.pending.v1.late-save', {
            schemaVersion: 1,
            state: 'pending',
            operationId: 'late-save',
            context: {
              operationId: 'late-save',
              epoch: 7,
              draftKey: draftKey(),
              baseRevision: 1,
              nextRevision: 2
            },
            requestFingerprint: FINGERPRINT,
            desiredEnvelopeFingerprint: 'b'.repeat(64),
            previousEnvelopeFingerprint: 'c'.repeat(64),
            createdAt: NOW,
            expiresAt: NOW + 15 * 60 * 1_000
          });
        }
        await memory.set(key, value);
      }
    };
    const deletionOwner = createSessionDraftDeletionOwner({
      local,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    }).queuedOwner;

    await expect(deletionOwner.execute(request('delete-late-wal'))).resolves.toMatchObject({
      revisions: [],
      protectedKeys: [draftKey()]
    });
    await expect(memory.get(draftKey())).resolves.toEqual(envelope());
  });

  it('does not physically remove when the authority setMany write fails', async () => {
    const memory = createMemoryStorageArea();
    await seedPresent(memory);
    const remove = vi.spyOn(memory, 'remove');
    const local = {
      ...memory,
      setMany: () => Promise.reject(new Error('authority write failed'))
    };
    const deletionOwner = createSessionDraftDeletionOwner({
      local,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    }).queuedOwner;

    await expect(deletionOwner.execute(request('delete-authority-fail'))).rejects.toThrow(
      'authority write failed'
    );
    expect(remove).not.toHaveBeenCalled();
    await expect(memory.get(draftKey())).resolves.toEqual(envelope());
  });

  it('rejects a changed tail after a chunk was persisted before the manifest', async () => {
    const memory = createMemoryStorageArea();
    const firstKeys = ['a', 'b', 'c'].map((id) => draftKey(envelope(`partial-${id}`)));
    let failSecondChunk = true;
    const local = {
      ...memory,
      async set(key: string, value: unknown) {
        if (failSecondChunk && key.endsWith('.1')) throw new Error('partial chunk failure');
        await memory.set(key, value);
      }
    };
    const deletionOwner = createSessionDraftDeletionOwner({
      local,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    }).queuedOwner;
    await expect(deletionOwner.execute(request('delete-partial', firstKeys))).rejects.toThrow(
      'partial chunk failure'
    );
    failSecondChunk = false;
    const before = await memory.getAll();
    const changed = [...firstKeys.slice(0, 2), draftKey(envelope('partial-d'))];

    await expect(deletionOwner.execute(request('delete-partial', changed))).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(memory.getAll()).resolves.toEqual(before);
  });

  it('classifies present, missing, deleted, and protected candidates exactly', async () => {
    const local = createMemoryStorageArea();
    const present = envelope('mixed-present');
    const missingKey = draftKey(envelope('mixed-missing'));
    const deletedKey = draftKey(envelope('mixed-deleted'));
    const protectedDraft = envelope('mixed-protected');
    await seedPresent(local, present);
    await seedPresent(local, protectedDraft);
    await local.setMany({
      [createSessionDraftCursorStorageKey(deletedKey)]: {
        schemaVersion: 1,
        epoch: 7,
        state: 'deleted',
        draftKey: deletedKey,
        revision: 5,
        lastOperationId: 'delete-prior'
      } satisfies SessionDraftCursor,
      [createSessionDraftTombstoneStorageKey(deletedKey)]: {
        schemaVersion: 1,
        epoch: 7,
        state: 'deleted',
        draftKey: deletedKey,
        revision: 5,
        operationId: 'delete-prior'
      },
      'aiob.restoreStorage.pending.v1.mixed-save': {
        schemaVersion: 1,
        state: 'pending',
        operationId: 'mixed-save',
        context: {
          operationId: 'mixed-save',
          epoch: 7,
          draftKey: draftKey(protectedDraft),
          baseRevision: 1,
          nextRevision: 2
        },
        requestFingerprint: FINGERPRINT,
        desiredEnvelopeFingerprint: 'b'.repeat(64),
        previousEnvelopeFingerprint: 'c'.repeat(64),
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    });

    await expect(
      owner(local).execute(
        request('delete-mixed', [
          draftKey(present),
          missingKey,
          deletedKey,
          draftKey(protectedDraft)
        ])
      )
    ).resolves.toEqual({
      epoch: 7,
      revisions: [
        { draftKey: deletedKey, revision: 5 },
        { draftKey: missingKey, revision: 1 },
        { draftKey: draftKey(present), revision: 2 }
      ].sort((left, right) => left.draftKey.localeCompare(right.draftKey)),
      protectedKeys: [draftKey(protectedDraft)],
      replayed: false
    });
  });

  it('strictly rejects malformed tombstones/outcomes and extra authority fields', () => {
    expect(
      normalizeSessionDraftTombstone({
        schemaVersion: 1,
        epoch: 7,
        state: 'deleted',
        draftKey: draftKey(),
        revision: 2,
        operationId: 'delete',
        extra: true
      })
    ).toBeNull();
    expect(
      normalizeSessionDraftDeletionOutcome({
        schemaVersion: 1,
        kind: 'save',
        operationId: 'delete',
        epoch: 7,
        requestFingerprint: FINGERPRINT,
        revisions: [],
        protectedKeys: []
      })
    ).toBeNull();
  });

  it('chunks a 130-key bulk deterministically and replays it after owner restart', async () => {
    const local = createMemoryStorageArea();
    const values = Array.from({ length: 130 }, (_, index) => envelope(`bulk-${index}`));
    for (const value of values) await seedPresent(local, value);
    const keys = values.map(draftKey).reverse();
    const firstOwner = owner(local);

    const first = await firstOwner.execute(request('delete-bulk', [...keys, keys[0] ?? '']));
    expect(first.revisions).toHaveLength(130);
    expect(first.revisions.map(({ draftKey }) => draftKey)).toEqual([...new Set(keys)].sort());
    const remove = vi.spyOn(local, 'remove');
    const calls = remove.mock.calls.length;
    const restarted = owner(local);
    await expect(restarted.execute(request('delete-bulk', keys))).resolves.toEqual({
      ...first,
      replayed: true
    });
    expect(remove).toHaveBeenCalledTimes(calls);
  });

  it('cross-binds operation fingerprint and exact sorted candidates', async () => {
    const local = createMemoryStorageArea();
    await seedPresent(local);
    const deletionOwner = owner(local);
    await deletionOwner.execute(request('delete-bound'));

    await expect(
      deletionOwner.execute({
        ...request('delete-bound'),
        requestFingerprint: 'b'.repeat(64)
      })
    ).rejects.toThrow('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    await expect(
      deletionOwner.execute(request('delete-bound', [draftKey(envelope('other'))]))
    ).rejects.toThrow('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
  });

  it('bounds multibyte maximum-length keys before writing and replays the bulk', async () => {
    const local = createMemoryStorageArea();
    const prefix = 'aiob.sessionDraft.v1.reader.';
    const keys = Array.from(
      { length: 12 },
      (_, index) => `${prefix}${String(index).padStart(2, '0')}${'界'.repeat(480)}`
    );
    const deletionOwner = owner(local);

    const first = await deletionOwner.execute(request('delete-multibyte', keys));
    expect(first.revisions).toHaveLength(keys.length);
    await expect(owner(local).execute(request('delete-multibyte', keys))).resolves.toEqual({
      ...first,
      replayed: true
    });
  });

  it('rejects a maximum-safe revision before writing any deletion receipt', async () => {
    const local = createMemoryStorageArea();
    const key = draftKey();
    await local.set(createSessionDraftCursorStorageKey(key), {
      schemaVersion: 1,
      epoch: 7,
      state: 'present',
      draftKey: key,
      revision: Number.MAX_SAFE_INTEGER,
      lastOperationId: 'save-max-safe'
    } satisfies SessionDraftCursor);
    const before = await local.getAll();

    await expect(owner(local).execute(request('delete-max-safe'))).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('rejects preparing past a maximum-safe revision without writing a lease', async () => {
    const local = createMemoryStorageArea();
    const key = draftKey();
    await local.set(createSessionDraftCursorStorageKey(key), {
      schemaVersion: 1,
      epoch: 7,
      state: 'present',
      draftKey: key,
      revision: Number.MAX_SAFE_INTEGER,
      lastOperationId: 'save-max-safe'
    } satisfies SessionDraftCursor);
    const before = await local.getAll();

    await expect(
      prepareSessionDraftOperation(
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'prepareSessionDraftOperation',
          operationId: 'prepare-max-safe',
          draftKey: key
        },
        preparationDependencies(local)
      )
    ).rejects.toThrow('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    await expect(local.getAll()).resolves.toEqual(before);
  });

  it('rejects oversized candidate keys before writing protocol authority', async () => {
    const local = createMemoryStorageArea();
    const deletionOwner = owner(local);
    const oversized = `aiob.sessionDraft.v1.reader.${'x'.repeat(600)}.draft`;

    await expect(deletionOwner.execute(request('delete-oversized', [oversized]))).rejects.toThrow(
      'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    );
    await expect(local.getAll()).resolves.toEqual({});
  });

  it('does not advance or persist a global epoch barrier', async () => {
    const local = createMemoryStorageArea();
    await seedPresent(local);
    const getCurrentEpoch = vi.fn(() => 7);
    const deletionOwner = createSessionDraftDeletionOwner({
      local,
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch,
      now: () => NOW
    }).queuedOwner;

    await deletionOwner.execute(request('delete-no-barrier'));
    expect(getCurrentEpoch).toHaveBeenCalled();
    await expect(local.get('aiob.restoreStorage.barrier.v1')).resolves.toBeUndefined();
  });
});
