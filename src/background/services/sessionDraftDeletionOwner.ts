import type { StorageAreaService } from '../../platform/interfaces/storage';
import { isBoundedSessionDraftStorageKey } from '../../content/sessionDrafts/sessionDraftLifecycleRecords';
import type { RestoreStorageOperationQueue } from './restoreStorageOperationQueue';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import {
  createSessionDraftDeletionManifestStorageKey,
  readSessionDraftDeletionManifest
} from './sessionDraftDeletionRecordAccess';
import {
  assertSessionDraftDeletionRecordBounded,
  SESSION_DRAFT_DELETE_MAX_TARGETS,
  type SessionDraftDeletionManifest
} from './sessionDraftDeletionStore';
import { readCursorState } from './sessionDraftSaveJournal';
import { maintainSessionDraftDeletionReceipts } from './sessionDraftDeletionMaintenance';
import {
  collectSessionDraftDeletionResult,
  completeSessionDraftDeletionChunks,
  createSessionDraftDeletionManifest,
  readSessionDraftManifestCandidateKeys
} from './sessionDraftDeletionExecution';
import type {
  SessionDraftDeletionExecutor,
  SessionDraftDeletionReplay,
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionTypes';
import { assertNoSaveOperationCollision } from './sessionDraftDeletionCollision';

export type {
  SessionDraftDeletionExecutor,
  SessionDraftDeletionReplay,
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionTypes';

const INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';
const MAINTENANCE_CHUNK_BATCH_SIZE = 64;

interface DeletionDependencies {
  local: StorageAreaService;
  getCurrentEpoch(): number | Promise<number>;
  now?: () => number;
}

export function createSessionDraftDeletionOwner(
  dependencies: DeletionDependencies & { operationQueue: RestoreStorageOperationQueue }
): {
  queuedOwner: { execute: SessionDraftDeletionExecutor };
  withinOperationExecutor: SessionDraftDeletionExecutor;
  withinOperationReplay: SessionDraftDeletionReplay;
  withinOperationMaintenance(): Promise<void>;
} {
  const execute: SessionDraftDeletionExecutor = (request) => executeDeletion(request, dependencies);
  const maintain = () =>
    maintainSessionDraftDeletionReceipts(
      dependencies.local,
      dependencies.now?.() ?? Date.now(),
      (manifest) => resumeManifest(manifest, dependencies)
    );
  return {
    queuedOwner: {
      execute: (request) => dependencies.operationQueue.enqueue(() => execute(request))
    },
    withinOperationExecutor: execute,
    withinOperationReplay: (operationId, requestFingerprint) =>
      replayDeletion(operationId, requestFingerprint, dependencies),
    withinOperationMaintenance: maintain
  };
}

async function resumeManifest(
  manifest: SessionDraftDeletionManifest,
  dependencies: DeletionDependencies
): Promise<boolean> {
  await assertNoSaveOperationCollision(
    dependencies.local,
    manifest.operationId,
    dependencies.now?.() ?? Date.now()
  );
  const epoch = await dependencies.getCurrentEpoch();
  if (manifest.epoch !== epoch) throw new Error(INVALID);
  const candidateKeys = await readSessionDraftManifestCandidateKeys(dependencies.local, manifest);
  const fingerprint = await createSessionDraftProtocolFingerprint(candidateKeys);
  if (fingerprint !== manifest.candidateFingerprint) throw new Error(INVALID);
  const chunks = await completeSessionDraftDeletionChunks(
    dependencies.local,
    manifest,
    candidateKeys,
    dependencies.now?.() ?? Date.now(),
    MAINTENANCE_CHUNK_BATCH_SIZE
  );
  if (chunks.some((chunk) => chunk.state !== 'committed')) return false;
  const committed: SessionDraftDeletionManifest = {
    ...manifest,
    state: 'committed'
  };
  assertSessionDraftDeletionRecordBounded(committed);
  await dependencies.local.set(
    createSessionDraftDeletionManifestStorageKey(manifest.operationId),
    committed
  );
  return true;
}

async function replayDeletion(
  operationId: string,
  requestFingerprint: string,
  dependencies: DeletionDependencies
): Promise<SessionDraftDeletionResult | null> {
  await assertNoSaveOperationCollision(
    dependencies.local,
    operationId,
    dependencies.now?.() ?? Date.now()
  );
  const manifest = await readSessionDraftDeletionManifest(dependencies.local, operationId);
  if (manifest === 'invalid') throw new Error(INVALID);
  if (!manifest) return null;
  const epoch = await dependencies.getCurrentEpoch();
  if (manifest.requestFingerprint !== requestFingerprint || manifest.epoch !== epoch)
    throw new Error(INVALID);
  const candidateKeys = await readSessionDraftManifestCandidateKeys(dependencies.local, manifest);
  const fingerprint = await createSessionDraftProtocolFingerprint(candidateKeys);
  if (
    fingerprint !== manifest.candidateFingerprint ||
    candidateKeys.length !== manifest.candidateCount
  )
    throw new Error(INVALID);
  const chunks = await completeSessionDraftDeletionChunks(
    dependencies.local,
    manifest,
    candidateKeys,
    dependencies.now?.() ?? Date.now()
  );
  if (manifest.state !== 'committed') {
    const committed: SessionDraftDeletionManifest = {
      ...manifest,
      state: 'committed'
    };
    assertSessionDraftDeletionRecordBounded(committed);
    await dependencies.local.set(
      createSessionDraftDeletionManifestStorageKey(operationId),
      committed
    );
  }
  return collectSessionDraftDeletionResult(manifest, chunks, true);
}

async function executeDeletion(
  request: SessionDraftDeletionRequest,
  dependencies: DeletionDependencies
): Promise<SessionDraftDeletionResult> {
  const candidateKeys = normalizeRequest(request);
  const epoch = await dependencies.getCurrentEpoch();
  await assertNoSaveOperationCollision(
    dependencies.local,
    request.operationId,
    dependencies.now?.() ?? Date.now()
  );
  const candidateFingerprint = await createSessionDraftProtocolFingerprint(candidateKeys);
  const existing = await readSessionDraftDeletionManifest(dependencies.local, request.operationId);
  if (existing === 'invalid') throw new Error(INVALID);
  let manifest = existing;
  if (manifest) {
    assertManifestMatches(manifest, request, candidateFingerprint, candidateKeys.length, epoch);
  } else {
    await assertCandidateRevisionsCanAdvance(dependencies.local, candidateKeys, epoch);
    manifest = await createSessionDraftDeletionManifest(
      dependencies.local,
      request,
      candidateKeys,
      candidateFingerprint,
      epoch,
      dependencies.now?.() ?? Date.now()
    );
  }
  const chunks = await completeSessionDraftDeletionChunks(
    dependencies.local,
    manifest,
    candidateKeys,
    dependencies.now?.() ?? Date.now()
  );
  if (manifest.state !== 'committed') {
    manifest = { ...manifest, state: 'committed' };
    assertSessionDraftDeletionRecordBounded(manifest);
    await dependencies.local.set(
      createSessionDraftDeletionManifestStorageKey(manifest.operationId),
      manifest
    );
  }
  return collectSessionDraftDeletionResult(manifest, chunks, existing !== null);
}

async function assertCandidateRevisionsCanAdvance(
  area: StorageAreaService,
  candidateKeys: string[],
  epoch: number
): Promise<void> {
  for (const draftKey of candidateKeys) {
    const state = await readCursorState(area, draftKey);
    if (
      state.kind === 'invalid' ||
      (state.kind === 'valid' &&
        (state.value.draftKey !== draftKey ||
          state.value.epoch !== epoch ||
          state.value.revision === Number.MAX_SAFE_INTEGER))
    )
      throw new Error(INVALID);
  }
}

function normalizeRequest(request: SessionDraftDeletionRequest): string[] {
  if (
    request.operationId.length === 0 ||
    request.operationId.length > 128 ||
    !/^[0-9a-f]{64}$/u.test(request.requestFingerprint) ||
    request.candidateKeys.some((key) => !isBoundedSessionDraftStorageKey(key))
  )
    throw new Error(INVALID);
  const keys = [...new Set(request.candidateKeys)].sort();
  if (keys.length > SESSION_DRAFT_DELETE_MAX_TARGETS) {
    throw new Error('RESTORE_STORAGE_DELETE_RECORD_TOO_LARGE');
  }
  return keys;
}

function assertManifestMatches(
  manifest: SessionDraftDeletionManifest,
  request: SessionDraftDeletionRequest,
  candidateFingerprint: string,
  candidateCount: number,
  epoch: number
): void {
  if (
    manifest.operationId !== request.operationId ||
    manifest.requestFingerprint !== request.requestFingerprint ||
    manifest.candidateFingerprint !== candidateFingerprint ||
    manifest.candidateCount !== candidateCount ||
    manifest.epoch !== epoch
  )
    throw new Error(INVALID);
}
