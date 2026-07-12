import { repairSessionDraftStorage } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import type {
  SessionDraftOperationContext,
  SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  consumeMatchingRestoreStorageLease,
  consumeRestoreStorageLease,
  readLiveRestoreStorageLease
} from './restoreStorageLeaseStore';
import {
  cleanupJournal,
  createSessionDraftOutcomeStorageKey,
  readCursorState,
  readJournalState,
  readOutcomeState,
  writePendingJournal
} from './sessionDraftSaveJournal';
import {
  pruneCommittedSessionDraftJournals,
  pruneSessionDraftOutcomes
} from './sessionDraftSaveJournalMaintenance';
import { recoverMalformedSessionDraftCorruptionLedger } from './sessionDraftProtocolCorruption';
import { recoverBlockingSessionDraftJournals } from './sessionDraftPendingRecovery';
import { createProtectedSessionDraftStorageArea } from './sessionDraftProtectedStorage';
import {
  finalizeRecoveredSessionDraftSave,
  isSessionDraftAlreadyWritten,
  isSessionDraftCursorIdentityValid,
  isSessionDraftOutcomeIdentityValid,
  resolveSessionDraftSaveJournal,
  validateSessionDraftJournalIdentity
} from './sessionDraftSaveProtocol';
import {
  readStoredSessionDraftEnvelope,
  validateNewSessionDraftReferences
} from './sessionDraftSaveReferences';
import { prepareSessionDraftSaveRequest } from './sessionDraftSaveRequest';
import { type SessionDraftRepositoryServiceDependencies } from './sessionDraftRepositoryServiceTypes';
import {
  isSessionDraftOperationRetired,
  retireSessionDraftOperation
} from './sessionDraftRetiredOperationStore';
import { commitSessionDraftSave } from './sessionDraftSaveCommit';
import {
  executeImplicitSessionDraftDeletion,
  repairSessionDraftIndexWithDeletionOwner
} from './sessionDraftImplicitDeletion';
import { assertNoSessionDraftDeletionCollision } from './sessionDraftSaveCollision';
import { assertSessionDraftCursorTombstone } from './sessionDraftCursorTombstone';
import { conflict, invalidState, saveSuccess } from './sessionDraftSaveResult';

export {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED,
  RESTORE_STORAGE_REVISION_CONFLICT
} from './sessionDraftRepositoryServiceTypes';

export async function saveSessionDraft(
  context: SessionDraftOperationContext,
  envelope: SessionDraftEnvelope,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<SessionDraftRepositoryResponse> {
  await assertNoSessionDraftDeletionCollision(dependencies.local, context.operationId);
  const prepared = await prepareSessionDraftSaveRequest(context, envelope, dependencies);
  if (!prepared) return conflict();
  if (await isSessionDraftOperationRetired(dependencies.local, context.operationId)) {
    return conflict();
  }
  const { policy, derivedDraftKey, normalizedEnvelope, requestFingerprint } = prepared;
  const operationTime = Date.now();
  if (await recoverMalformedSessionDraftCorruptionLedger(dependencies.local)) {
    throw invalidState();
  }
  const protectedDraftKeys = await recoverBlockingSessionDraftJournals(
    dependencies,
    context.operationId,
    derivedDraftKey,
    operationTime
  );
  const protectedLocal = createProtectedSessionDraftStorageArea(
    dependencies.local,
    protectedDraftKeys
  );
  await repairSessionDraftIndexWithDeletionOwner(
    dependencies,
    context.operationId,
    'save-index-repair'
  );
  await pruneCommittedSessionDraftJournals(dependencies.local);
  const quarantinedOutcomeKeys = await pruneSessionDraftOutcomes(dependencies.local, operationTime);
  if (quarantinedOutcomeKeys.includes(createSessionDraftOutcomeStorageKey(context.operationId))) {
    throw invalidState();
  }
  const outcomeState = await readOutcomeState(dependencies.local, context.operationId);
  if (outcomeState.kind === 'invalid') throw invalidState();
  const cursorState = await readCursorState(dependencies.local, derivedDraftKey);
  if (cursorState.kind === 'invalid') throw invalidState();
  const journalState = await readJournalState(dependencies.local, context.operationId);
  if (journalState.kind === 'invalid') throw invalidState();
  const outcome = outcomeState.kind === 'valid' ? outcomeState.value : null;
  const cursor = cursorState.kind === 'valid' ? cursorState.value : null;
  const retryJournal = journalState.kind === 'valid' ? journalState.value : null;
  if (!isSessionDraftCursorIdentityValid(cursor, derivedDraftKey)) throw invalidState();
  if (cursor && cursor.epoch !== context.epoch) throw invalidState();
  await assertSessionDraftCursorTombstone(
    dependencies.local,
    cursor,
    derivedDraftKey,
    context.epoch
  );
  if (outcome) {
    if (outcome.operationId !== context.operationId) throw invalidState();
    if (outcome.requestFingerprint !== requestFingerprint) return conflict();
    if (!isSessionDraftOutcomeIdentityValid(outcome, context, derivedDraftKey)) {
      throw invalidState();
    }
  }
  if (cursor?.revision === context.nextRevision && cursor.lastOperationId !== context.operationId) {
    if (cursor.state === 'deleted') return conflict();
    throw invalidState();
  }
  if (retryJournal) {
    const journalIdentity = await validateSessionDraftJournalIdentity(
      retryJournal,
      context,
      normalizedEnvelope,
      derivedDraftKey,
      requestFingerprint
    );
    if (journalIdentity === 'conflict') return conflict();
  }
  if (!retryJournal && outcome) {
    if (
      !cursor ||
      cursor.revision !== context.nextRevision ||
      cursor.lastOperationId !== context.operationId
    ) {
      throw invalidState();
    }
    await consumeRestoreStorageLease(dependencies.local, context.operationId);
    await cleanupJournal(dependencies.local, context.operationId).catch(() => undefined);
    return saveSuccess(outcome.revision, true);
  }
  if (!retryJournal && cursor?.revision === context.nextRevision) throw invalidState();

  const previousEnvelope = await readStoredSessionDraftEnvelope(
    dependencies.local,
    derivedDraftKey
  );
  const retryDraftAlreadyWritten = retryJournal
    ? await isSessionDraftAlreadyWritten(retryJournal, previousEnvelope)
    : false;
  if (retryJournal && retryDraftAlreadyWritten) {
    await repairSessionDraftStorage(protectedLocal, policy, operationTime, (keys) =>
      executeImplicitSessionDraftDeletion(
        dependencies,
        keys,
        'save-recovery-repair',
        context.operationId
      )
    );
    await repairSessionDraftIndexWithDeletionOwner(
      dependencies,
      context.operationId,
      'save-index-repair'
    );
    await finalizeRecoveredSessionDraftSave(
      retryJournal,
      outcome,
      context,
      derivedDraftKey,
      requestFingerprint,
      operationTime,
      dependencies
    );
    return saveSuccess(context.nextRevision, true);
  }
  if (retryJournal && retryJournal.expiresAt <= operationTime) {
    await repairSessionDraftIndexWithDeletionOwner(
      dependencies,
      context.operationId,
      'save-index-repair'
    );
    await consumeRestoreStorageLease(dependencies.local, context.operationId);
    await retireSessionDraftOperation(dependencies.local, context.operationId, operationTime);
    await cleanupJournal(dependencies.local, context.operationId);
    return conflict();
  }
  if (outcome || cursor?.revision === context.nextRevision) throw invalidState();
  const currentRevision = cursor?.revision ?? 0;
  if (currentRevision !== context.baseRevision) return conflict();
  if (!retryJournal) {
    const lease = await readLiveRestoreStorageLease(
      dependencies.local,
      context.operationId,
      operationTime
    );
    if (
      !lease ||
      lease.epoch !== context.epoch ||
      lease.draftKey !== context.draftKey ||
      lease.baseRevision !== context.baseRevision ||
      lease.draftRevision !== context.nextRevision
    ) {
      throw new Error('RESTORE_STORAGE_PREPARE_REQUIRED');
    }
  }
  await validateNewSessionDraftReferences(
    previousEnvelope,
    normalizedEnvelope,
    context,
    dependencies
  );
  const journal = await resolveSessionDraftSaveJournal(
    retryJournal,
    context,
    normalizedEnvelope,
    previousEnvelope,
    requestFingerprint,
    operationTime
  );
  if (!retryJournal) {
    try {
      await writePendingJournal(dependencies.local, journal);
    } catch (error) {
      await consumeMatchingRestoreStorageLease(dependencies.local, context);
      throw error;
    }
  }
  return commitSessionDraftSave({
    context,
    normalizedEnvelope,
    protectedLocal,
    policy,
    journal,
    derivedDraftKey,
    requestFingerprint,
    operationTime,
    dependencies,
    replayed: retryJournal !== null
  });
}
