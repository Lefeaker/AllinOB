/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import {
  RESTORE_STORAGE_LEASE_PREFIX,
  RESTORE_STORAGE_LEASE_TTL_MS,
  type RestoreStorageLease
} from '../../../src/background/services/restoreStorageLeaseStore';
import {
  SESSION_DRAFT_JOURNAL_TTL_MS,
  createSessionDraftPendingStorageKey,
  type SessionDraftSaveJournal
} from '../../../src/background/services/sessionDraftSaveJournal';
import { createRestoreStorageOperationQueue } from '../../../src/background/services/restoreStorageOperationQueue';
import { buildRestoreStorageProtectionInventory } from '../../../src/background/services/restoreStorageProtectionInventory';
import { createRestoreStorageScreenshotDeletionOwner } from '../../../src/background/services/restoreStorageScreenshotDeletionOwner';

const NOW = 2_000_000_000_000;
const PAGE_URL = 'https://video.example/watch?v=protected';
const FINGERPRINT = 'a'.repeat(64);

function ref(id: string): VideoScreenshotCacheRef {
  const pageKey = 'page-protected';
  const captureId = `capture-${id}`;
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({ pageKey, captureId, screenshotId: id }),
    pageKey,
    captureId,
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 7,
    capturedAt: NOW - 1_000,
    expiresAt: NOW + 60_000
  };
}

function draft(
  value: VideoScreenshotCacheRef,
  options: { draftId?: string; expiresAt?: number } = {}
) {
  return createVideoSessionDraftEnvelope({
    draftId: options.draftId ?? `draft-${value.id}`,
    pageUrl: PAGE_URL,
    pageTitle: 'Protected draft',
    createdAt: NOW - 2_000,
    updatedAt: NOW - 500,
    expiresAt: options.expiresAt ?? NOW + 60_000,
    status: 'restorable',
    payload: buildVideoSessionDraftPayload({
      captures: [
        {
          kind: 'timestamp',
          id: value.captureId,
          timeSec: 1,
          url: PAGE_URL,
          comment: '',
          createdAt: NOW - 1_000,
          screenshotRequested: true,
          screenshotRef: value
        }
      ],
      commentDrafts: {},
      platform: 'youtube',
      videoId: 'protected',
      videoUrl: PAGE_URL,
      canonicalUrl: PAGE_URL,
      videoTitle: 'Protected draft'
    })
  });
}

function draftKey(envelope: ReturnType<typeof draft>): string {
  return createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    draftId: envelope.draftId
  });
}

function lease(
  operationId: string,
  screenshotKey: string,
  options: { epoch?: number; createdAt?: number; expiresAt?: number } = {}
): RestoreStorageLease {
  const createdAt = options.createdAt ?? NOW - 100;
  return {
    schemaVersion: 1,
    operationId,
    epoch: options.epoch ?? 7,
    draftKey: 'aiob.sessionDraft.v1.video.page-protected.draft-lease',
    baseRevision: 0,
    draftRevision: 1,
    screenshotKeys: [screenshotKey],
    screenshotFingerprints: { [screenshotKey]: FINGERPRINT },
    createdAt,
    expiresAt: options.expiresAt ?? createdAt + RESTORE_STORAGE_LEASE_TTL_MS
  };
}

function pendingJournal(operationId: string, key: string): SessionDraftSaveJournal {
  return {
    schemaVersion: 1,
    state: 'pending',
    operationId,
    context: {
      operationId,
      epoch: 7,
      draftKey: key,
      baseRevision: 0,
      nextRevision: 1
    },
    requestFingerprint: FINGERPRINT,
    desiredEnvelopeFingerprint: FINGERPRINT,
    previousEnvelopeFingerprint: null,
    createdAt: NOW - 100,
    expiresAt: NOW - 100 + SESSION_DRAFT_JOURNAL_TTL_MS
  };
}

function ownerHarness() {
  const local = createMemoryStorageArea();
  const deleted = vi.fn<(keys: readonly string[]) => Promise<void>>(() => Promise.resolve());
  const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
    local,
    screenshots: { deleteMany: deleted },
    operationQueue: createRestoreStorageOperationQueue(),
    getCurrentEpoch: () => 7,
    now: () => NOW
  });
  return { local, deleted, owner };
}

describe('restore storage screenshot deletion owner', () => {
  it('protects valid retained draft refs and deletes an orphan', async () => {
    const harness = ownerHarness();
    const protectedRef = ref('draft');
    const orphan = ref('orphan');
    const envelope = draft(protectedRef);
    await harness.local.set(draftKey(envelope), envelope);

    await expect(harness.owner.deleteCandidates([protectedRef.key, orphan.key])).resolves.toEqual({
      deletedKeys: [orphan.key],
      protectedKeys: [protectedRef.key],
      rejectedKeys: []
    });
    expect(harness.deleted).toHaveBeenCalledWith([orphan.key]);
  });

  it('protects a live lease after owner restart', async () => {
    const harness = ownerHarness();
    const protectedRef = ref('lease');
    const operationId = 'operation-lease';
    await harness.local.set(
      `${RESTORE_STORAGE_LEASE_PREFIX}${encodeURIComponent(operationId)}`,
      lease(operationId, protectedRef.key)
    );
    const { queuedOwner: restarted } = createRestoreStorageScreenshotDeletionOwner({
      local: harness.local,
      screenshots: { deleteMany: harness.deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });

    await expect(restarted.deleteCandidates([protectedRef.key])).resolves.toEqual({
      deletedKeys: [],
      protectedKeys: [protectedRef.key],
      rejectedKeys: []
    });
    expect(harness.deleted).not.toHaveBeenCalled();
  });

  it('protects current refs re-read from a live pending journal draft', async () => {
    const harness = ownerHarness();
    const protectedRef = ref('pending');
    const envelope = draft(protectedRef, { expiresAt: NOW - 1 });
    const key = draftKey(envelope);
    const journal = pendingJournal('operation-pending', key);
    await harness.local.setMany({
      [key]: envelope,
      [createSessionDraftPendingStorageKey(journal.operationId)]: journal
    });

    const inventory = await buildRestoreStorageProtectionInventory(harness.local, {
      now: NOW,
      currentEpoch: 7
    });
    expect(inventory.pendingDraftKeys).toEqual([key]);
    expect(inventory.screenshotKeys).toContain(protectedRef.key);
    await expect(harness.owner.deleteCandidates([protectedRef.key])).resolves.toMatchObject({
      deletedKeys: [],
      protectedKeys: [protectedRef.key]
    });
  });

  it('reclaims expired and stale-epoch leases instead of protecting them', async () => {
    const harness = ownerHarness();
    const expiredRef = ref('expired-lease');
    const staleRef = ref('stale-lease');
    await harness.local.setMany({
      [`${RESTORE_STORAGE_LEASE_PREFIX}expired`]: lease('expired', expiredRef.key, {
        createdAt: NOW - RESTORE_STORAGE_LEASE_TTL_MS,
        expiresAt: NOW
      }),
      [`${RESTORE_STORAGE_LEASE_PREFIX}stale`]: lease('stale', staleRef.key, { epoch: 6 })
    });

    await expect(harness.owner.deleteCandidates([expiredRef.key, staleRef.key])).resolves.toEqual({
      deletedKeys: [expiredRef.key, staleRef.key].sort(),
      protectedKeys: [],
      rejectedKeys: []
    });
    expect(
      Object.keys(await harness.local.getAll()).filter((key) =>
        key.startsWith(RESTORE_STORAGE_LEASE_PREFIX)
      )
    ).toEqual([]);
  });

  it('keeps inventory read-only for malformed, future, expired, and stale authority', async () => {
    const local = createMemoryStorageArea();
    const futureRef = ref('future-authority');
    const staleRef = ref('stale-authority');
    const key = draftKey(draft(ref('journal-authority'), { expiresAt: NOW - 1 }));
    const futureJournal = {
      ...pendingJournal('future-journal', key),
      createdAt: NOW + 1,
      expiresAt: NOW + 1 + SESSION_DRAFT_JOURNAL_TTL_MS
    };
    const expiredJournal = {
      ...pendingJournal('expired-journal', key),
      createdAt: NOW - SESSION_DRAFT_JOURNAL_TTL_MS,
      expiresAt: NOW
    };
    const staleJournal = pendingJournal('stale-journal', key);
    staleJournal.context.epoch = 6;
    const malformedJournalKey = createSessionDraftPendingStorageKey('malformed-journal');
    const futureJournalKey = createSessionDraftPendingStorageKey(futureJournal.operationId);
    const expiredJournalKey = createSessionDraftPendingStorageKey(expiredJournal.operationId);
    const staleJournalKey = createSessionDraftPendingStorageKey(staleJournal.operationId);
    await local.setMany({
      [`${RESTORE_STORAGE_LEASE_PREFIX}malformed`]: { malformed: true },
      [`${RESTORE_STORAGE_LEASE_PREFIX}future`]: lease('future', futureRef.key, {
        createdAt: NOW + 1,
        expiresAt: NOW + 1 + RESTORE_STORAGE_LEASE_TTL_MS
      }),
      [`${RESTORE_STORAGE_LEASE_PREFIX}wrong-storage-key`]: lease(
        'mismatched-operation',
        futureRef.key
      ),
      [`${RESTORE_STORAGE_LEASE_PREFIX}stale-authority`]: lease('stale-authority', staleRef.key, {
        epoch: 6
      }),
      [malformedJournalKey]: { malformed: true },
      [futureJournalKey]: futureJournal,
      [expiredJournalKey]: expiredJournal,
      [staleJournalKey]: staleJournal
    });
    const before = await local.getAll();

    const inventory = await buildRestoreStorageProtectionInventory(local, {
      now: NOW,
      currentEpoch: 7
    });

    expect(inventory).toEqual({ screenshotKeys: [], pendingDraftKeys: [] });
    expect(await local.getAll()).toEqual(before);

    const deleted = vi.fn<(keys: readonly string[]) => Promise<void>>(() => Promise.resolve());
    const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
      local,
      screenshots: { deleteMany: deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    await expect(owner.deleteCandidates([futureRef.key, staleRef.key])).resolves.toMatchObject({
      deletedKeys: [futureRef.key, staleRef.key].sort(),
      protectedKeys: []
    });
    expect(
      Object.keys(await local.getAll()).filter((key) =>
        key.startsWith(RESTORE_STORAGE_LEASE_PREFIX)
      )
    ).toEqual([]);
    await expect(local.get(malformedJournalKey)).resolves.toBeUndefined();
    await expect(local.get(futureJournalKey)).resolves.toBeUndefined();
    await expect(local.get(expiredJournalKey)).resolves.toEqual(expiredJournal);
    await expect(local.get(staleJournalKey)).resolves.toEqual(staleJournal);
    await expect(
      buildRestoreStorageProtectionInventory(local, { now: NOW, currentEpoch: 7 })
    ).resolves.toEqual({ screenshotKeys: [], pendingDraftKeys: [] });
  });

  it('dedupes duplicate candidates and rejects foreign keys', async () => {
    const harness = ownerHarness();
    const duplicate = ref('duplicate').key;
    await expect(
      harness.owner.deleteCandidates([duplicate, duplicate, 'foreign.storage.key'])
    ).resolves.toEqual({
      deletedKeys: [duplicate],
      protectedKeys: [],
      rejectedKeys: ['foreign.storage.key']
    });
    expect(harness.deleted).toHaveBeenCalledWith([duplicate]);
  });

  it('catches draft protection added after candidate selection at the final read', async () => {
    const local = createMemoryStorageArea();
    const protectedRef = ref('late');
    const selected = await buildRestoreStorageProtectionInventory(local, {
      now: NOW,
      currentEpoch: 7
    });
    expect(selected.screenshotKeys).not.toContain(protectedRef.key);
    let getAllCalls = 0;
    let signalFinalRead!: () => void;
    let releaseFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    const finalReadGate = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    const gatedLocal = {
      ...local,
      async getAll() {
        getAllCalls += 1;
        if (getAllCalls === 3) {
          signalFinalRead();
          await finalReadGate;
        }
        return local.getAll();
      }
    };
    const deleted = vi.fn<(keys: readonly string[]) => Promise<void>>(() => Promise.resolve());
    const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
      local: gatedLocal,
      screenshots: { deleteMany: deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    const deletion = owner.deleteCandidates([protectedRef.key]);
    await finalReadStarted;
    const envelope = draft(protectedRef);
    await local.set(draftKey(envelope), envelope);
    releaseFinalRead();

    await expect(deletion).resolves.toEqual({
      deletedKeys: [],
      protectedKeys: [protectedRef.key],
      rejectedKeys: []
    });
    expect(deleted).not.toHaveBeenCalled();
  });

  it('catches pending-journal authority added after candidate selection', async () => {
    const local = createMemoryStorageArea();
    const protectedRef = ref('late-pending');
    const envelope = draft(protectedRef, { expiresAt: NOW - 1 });
    const key = draftKey(envelope);
    const journal = pendingJournal('late-pending-operation', key);
    const selected = await buildRestoreStorageProtectionInventory(local, {
      now: NOW,
      currentEpoch: 7
    });
    expect(selected.screenshotKeys).not.toContain(protectedRef.key);
    let getAllCalls = 0;
    let signalFinalRead!: () => void;
    let releaseFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    const finalReadGate = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    const gatedLocal = {
      ...local,
      async getAll() {
        getAllCalls += 1;
        if (getAllCalls === 3) {
          signalFinalRead();
          await finalReadGate;
        }
        return local.getAll();
      }
    };
    const deleted = vi.fn<(keys: readonly string[]) => Promise<void>>(() => Promise.resolve());
    const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
      local: gatedLocal,
      screenshots: { deleteMany: deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    const deletion = owner.deleteCandidates([protectedRef.key]);
    await finalReadStarted;
    await local.setMany({
      [key]: envelope,
      [createSessionDraftPendingStorageKey(journal.operationId)]: journal
    });
    releaseFinalRead();

    await expect(deletion).resolves.toMatchObject({
      deletedKeys: [],
      protectedKeys: [protectedRef.key]
    });
    expect(deleted).not.toHaveBeenCalled();
  });

  it('catches a live lease added before the final inventory snapshot', async () => {
    const local = createMemoryStorageArea();
    const protectedRef = ref('late-lease');
    const selected = await buildRestoreStorageProtectionInventory(local, {
      now: NOW,
      currentEpoch: 7
    });
    expect(selected.screenshotKeys).not.toContain(protectedRef.key);
    let getAllCalls = 0;
    let signalFinalRead!: () => void;
    let releaseFinalRead!: () => void;
    const finalReadStarted = new Promise<void>((resolve) => {
      signalFinalRead = resolve;
    });
    const finalReadGate = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    const gatedLocal = {
      ...local,
      async getAll() {
        getAllCalls += 1;
        if (getAllCalls === 3) {
          signalFinalRead();
          await finalReadGate;
        }
        return local.getAll();
      }
    };
    const deleted = vi.fn<(keys: readonly string[]) => Promise<void>>(() => Promise.resolve());
    const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
      local: gatedLocal,
      screenshots: { deleteMany: deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    const deletion = owner.deleteCandidates([protectedRef.key]);
    await finalReadStarted;
    const operationId = 'late-lease-operation';
    await local.set(
      `${RESTORE_STORAGE_LEASE_PREFIX}${encodeURIComponent(operationId)}`,
      lease(operationId, protectedRef.key)
    );
    releaseFinalRead();

    await expect(deletion).resolves.toMatchObject({
      deletedKeys: [],
      protectedKeys: [protectedRef.key]
    });
    expect(deleted).not.toHaveBeenCalled();
  });

  it('propagates physical deletion failure without claiming deleted keys', async () => {
    const local = createMemoryStorageArea();
    const failure = new Error('physical delete failed');
    const deleted = vi.fn(() => Promise.reject(failure));
    const { queuedOwner: owner } = createRestoreStorageScreenshotDeletionOwner({
      local,
      screenshots: { deleteMany: deleted },
      operationQueue: createRestoreStorageOperationQueue(),
      getCurrentEpoch: () => 7,
      now: () => NOW
    });
    const orphan = ref('failure').key;

    await expect(owner.deleteCandidates([orphan])).rejects.toBe(failure);
    expect(deleted).toHaveBeenCalledWith([orphan]);
  });
});
