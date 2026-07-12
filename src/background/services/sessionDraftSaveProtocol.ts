import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import type { SessionDraftOperationContext } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  cleanupJournal,
  finalizeJournal,
  SESSION_DRAFT_JOURNAL_TTL_MS,
  SESSION_DRAFT_OUTCOME_TTL_MS,
  type SessionDraftCursor,
  type SessionDraftOutcome,
  type SessionDraftSaveJournal
} from './sessionDraftSaveJournal';
import { createEnvelopeFingerprint, createRequestFingerprint } from './sessionDraftFingerprint';
import { consumeRestoreStorageLease } from './restoreStorageLeaseStore';
import {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';

export async function resolveSessionDraftSaveJournal(
  retry: SessionDraftSaveJournal | null,
  context: SessionDraftOperationContext,
  envelope: SessionDraftEnvelope,
  previous: SessionDraftEnvelope | null,
  requestFingerprint: string,
  now: number
): Promise<SessionDraftSaveJournal> {
  return (
    retry ?? {
      schemaVersion: 1,
      state: 'pending',
      operationId: context.operationId,
      context,
      requestFingerprint,
      desiredEnvelopeFingerprint: await createEnvelopeFingerprint(envelope),
      createdAt: now,
      expiresAt: now + SESSION_DRAFT_JOURNAL_TTL_MS,
      previousEnvelopeFingerprint: previous ? await createEnvelopeFingerprint(previous) : null
    }
  );
}

export async function isSessionDraftAlreadyWritten(
  journal: SessionDraftSaveJournal,
  stored: SessionDraftEnvelope | null
): Promise<boolean> {
  const storedFingerprint = stored ? await createEnvelopeFingerprint(stored) : null;
  if (storedFingerprint === journal.desiredEnvelopeFingerprint) return true;
  if (storedFingerprint !== journal.previousEnvelopeFingerprint) throw invalidState();
  return false;
}

export async function finalizeRecoveredSessionDraftSave(
  journal: SessionDraftSaveJournal,
  existingOutcome: SessionDraftOutcome | null,
  context: SessionDraftOperationContext,
  draftKey: string,
  requestFingerprint: string,
  now: number,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<void> {
  const cursor: SessionDraftCursor = {
    schemaVersion: 1,
    epoch: context.epoch,
    state: 'present',
    draftKey,
    revision: context.nextRevision,
    lastOperationId: context.operationId
  };
  const outcome: SessionDraftOutcome = existingOutcome ?? {
    schemaVersion: 1,
    kind: 'save',
    operationId: context.operationId,
    draftKey,
    revision: context.nextRevision,
    requestFingerprint,
    createdAt: now,
    expiresAt: now + SESSION_DRAFT_OUTCOME_TTL_MS
  };
  await finalizeJournal(dependencies.local, journal, cursor, outcome);
  await consumeRestoreStorageLease(dependencies.local, context.operationId);
  await cleanupJournal(dependencies.local, context.operationId).catch(() => undefined);
}

export function isSessionDraftCursorIdentityValid(
  cursor: SessionDraftCursor | null,
  draftKey: string
): boolean {
  return !cursor || cursor.draftKey === draftKey;
}

export function isSessionDraftOutcomeIdentityValid(
  outcome: SessionDraftOutcome,
  context: SessionDraftOperationContext,
  draftKey: string
): boolean {
  return (
    outcome.operationId === context.operationId &&
    outcome.draftKey === draftKey &&
    outcome.revision === context.nextRevision
  );
}

export async function validateSessionDraftJournalIdentity(
  journal: SessionDraftSaveJournal,
  context: SessionDraftOperationContext,
  envelope: SessionDraftEnvelope,
  draftKey: string,
  requestFingerprint: string
): Promise<'match' | 'conflict'> {
  if (
    journal.operationId !== journal.context.operationId ||
    journal.context.nextRevision !== journal.context.baseRevision + 1 ||
    journal.context.draftKey !== draftKey ||
    (await createEnvelopeFingerprint(envelope)) !== journal.desiredEnvelopeFingerprint ||
    (await createRequestFingerprint(journal.context, envelope)) !== journal.requestFingerprint
  ) {
    throw invalidState();
  }
  if (
    journal.operationId !== context.operationId ||
    journal.context.epoch !== context.epoch ||
    journal.context.draftKey !== draftKey ||
    journal.context.baseRevision !== context.baseRevision ||
    journal.context.nextRevision !== context.nextRevision ||
    journal.requestFingerprint !== requestFingerprint
  ) {
    return 'conflict';
  }
  return 'match';
}

function invalidState(): Error {
  return new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}
