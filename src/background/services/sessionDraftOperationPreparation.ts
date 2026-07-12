import type {
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import { prepareRestoreStorageLease } from './restoreStorageLeaseStore';
import { readCursorState, readJournalState, readOutcomeState } from './sessionDraftSaveJournal';
import {
  readSessionDraftEpoch,
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REVISION_CONFLICT,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';
import { isSessionDraftOperationRetired } from './sessionDraftRetiredOperationStore';
import {
  readSessionDraftDeletionChunk,
  readSessionDraftDeletionManifest,
  hasAnySessionDraftDeletionRecord
} from './sessionDraftDeletionRecordAccess';
import { hasAnyRestoreStorageClearRecord } from './restoreStorageClearPlanStore';
import { assertSessionDraftCursorTombstone } from './sessionDraftCursorTombstone';

type PrepareMessage = Extract<
  SessionDraftRepositoryMessage,
  { operation: 'prepareSessionDraftOperation' }
>;

export async function prepareSessionDraftOperation(
  message: PrepareMessage,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<SessionDraftRepositoryResponse> {
  const epoch = await readSessionDraftEpoch(dependencies);
  if (await isSessionDraftOperationRetired(dependencies.local, message.operationId)) {
    throw new Error(RESTORE_STORAGE_REVISION_CONFLICT);
  }
  const cursorState = await readCursorState(dependencies.local, message.draftKey);
  const [deleteManifest, deleteChunk, anyDeleteRecord, clearRecord] = await Promise.all([
    readSessionDraftDeletionManifest(dependencies.local, message.operationId),
    readSessionDraftDeletionChunk(dependencies.local, message.operationId, 0),
    hasAnySessionDraftDeletionRecord(dependencies.local, message.operationId),
    hasAnyRestoreStorageClearRecord(dependencies.local, message.operationId)
  ]);
  const journalState = await readJournalState(dependencies.local, message.operationId);
  const outcomeState = await readOutcomeState(dependencies.local, message.operationId);
  if (
    cursorState.kind === 'invalid' ||
    journalState.kind === 'invalid' ||
    outcomeState.kind === 'invalid' ||
    deleteManifest === 'invalid' ||
    deleteChunk === 'invalid'
  ) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  if (deleteManifest || deleteChunk || anyDeleteRecord || clearRecord) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  const revision = cursorState.kind === 'valid' ? cursorState.value.revision : 0;
  const cursor = cursorState.kind === 'valid' ? cursorState.value : null;
  if (cursor && (cursor.draftKey !== message.draftKey || cursor.epoch !== epoch)) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  await assertSessionDraftCursorTombstone(dependencies.local, cursor, message.draftKey, epoch);
  const journal = journalState.kind === 'valid' ? journalState.value : null;
  const outcome = outcomeState.kind === 'valid' ? outcomeState.value : null;
  if (outcome) {
    if (
      outcome.operationId !== message.operationId ||
      outcome.draftKey !== message.draftKey ||
      cursor?.lastOperationId !== message.operationId ||
      cursor.revision !== outcome.revision ||
      (journal !== null && journal.context.draftKey !== message.draftKey)
    ) {
      throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
    }
    return {
      success: true,
      operation: message.operation,
      context: journal?.context ?? {
        operationId: message.operationId,
        epoch,
        draftKey: message.draftKey,
        baseRevision: Math.max(0, outcome.revision - 1),
        nextRevision: outcome.revision
      },
      replayed: true,
      status: 'completed'
    };
  }
  if (cursor?.lastOperationId === message.operationId) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  if (
    journal &&
    (journal.operationId !== message.operationId ||
      journal.context.draftKey !== message.draftKey ||
      journal.context.epoch !== epoch ||
      journal.context.baseRevision !== revision)
  ) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  if (
    (message.expectedEpoch !== undefined && message.expectedEpoch !== epoch) ||
    (message.expectedRevision !== undefined && message.expectedRevision !== revision)
  ) {
    throw new Error(RESTORE_STORAGE_REVISION_CONFLICT);
  }
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  const context = journal?.context ?? {
    operationId: message.operationId,
    epoch,
    draftKey: message.draftKey,
    baseRevision: revision,
    nextRevision: revision + 1
  };
  const replayed = await prepareRestoreStorageLease(dependencies.local, context);
  return {
    success: true,
    operation: message.operation,
    context,
    replayed,
    status: 'prepared'
  };
}
