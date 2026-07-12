import {
  repairSessionDraftIndex,
  repairSessionDraftStorage
} from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey
} from '../../content/sessionDrafts/sessionDraftKeys';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import { consumeRestoreStorageLease } from './restoreStorageLeaseStore';
import {
  cleanupJournal,
  finalizeJournal,
  createSessionDraftPendingStorageKey,
  readCursorState,
  readOutcomeState,
  SESSION_DRAFT_OUTCOME_TTL_MS,
  type SessionDraftCursor,
  type SessionDraftOutcome,
  type SessionDraftSaveJournal
} from './sessionDraftSaveJournal';
import { createEnvelopeFingerprint, createRequestFingerprint } from './sessionDraftFingerprint';
import { readSessionDraftJournalInventory } from './sessionDraftSaveJournalMaintenance';
import { readStoredSessionDraftEnvelope } from './sessionDraftSaveReferences';
import { createProtectedSessionDraftStorageArea } from './sessionDraftProtectedStorage';
import { quarantineMalformedSessionDraftProtocolRecords } from './sessionDraftProtocolCorruption';
import {
  readSessionDraftEpoch,
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REVISION_CONFLICT,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';
import { retireSessionDraftOperation } from './sessionDraftRetiredOperationStore';
import { executeImplicitSessionDraftDeletion } from './sessionDraftImplicitDeletion';

export async function recoverBlockingSessionDraftJournals(
  dependencies: SessionDraftRepositoryServiceDependencies,
  currentOperationId: string,
  currentDraftKey: string,
  now: number
): Promise<Set<string>> {
  const inventory = await readSessionDraftJournalInventory(dependencies.local, now);
  if (inventory.invalid) throw invalidState();
  if (inventory.quarantinedKeys.includes(createSessionDraftPendingStorageKey(currentOperationId))) {
    throw invalidState();
  }
  const protectedDraftKeys = new Set(inventory.journals.map((journal) => journal.context.draftKey));
  const currentEpoch = await readSessionDraftEpoch(dependencies);
  for (const journal of inventory.journals) {
    if (journal.context.epoch !== currentEpoch) {
      if (journal.operationId === currentOperationId) {
        await quarantineMalformedSessionDraftProtocolRecords(
          dependencies.local,
          [createSessionDraftPendingStorageKey(journal.operationId)],
          now
        );
        throw invalidState();
      }
      await consumeRestoreStorageLease(dependencies.local, journal.operationId);
      await cleanupJournal(dependencies.local, journal.operationId);
      continue;
    }
    if (journal.operationId === currentOperationId) {
      continue;
    }
    if (journal.context.draftKey !== currentDraftKey && journal.expiresAt > now) continue;
    await recoverOrBlockJournal(journal, dependencies, protectedDraftKeys, now);
  }
  return protectedDraftKeys;
}

async function recoverOrBlockJournal(
  journal: SessionDraftSaveJournal,
  dependencies: SessionDraftRepositoryServiceDependencies,
  protectedDraftKeys: ReadonlySet<string>,
  now: number
): Promise<void> {
  const draftKey = await validateJournal(journal, dependencies);
  const [cursorState, outcomeState, stored] = await Promise.all([
    readCursorState(dependencies.local, draftKey),
    readOutcomeState(dependencies.local, journal.operationId),
    readStoredSessionDraftEnvelope(dependencies.local, draftKey)
  ]);
  if (cursorState.kind === 'invalid' || outcomeState.kind === 'invalid') throw invalidState();
  const cursor = cursorState.kind === 'valid' ? cursorState.value : null;
  const outcome = outcomeState.kind === 'valid' ? outcomeState.value : null;
  validatePartialRecords(journal, cursor, outcome, draftKey);
  const storedFingerprint = stored ? await createEnvelopeFingerprint(stored) : null;
  const desiredFingerprint = journal.desiredEnvelopeFingerprint;

  if (storedFingerprint === desiredFingerprint) {
    if (!stored || !(await isRecoveredDesiredIdentityValid(journal, stored, draftKey))) {
      throw invalidState();
    }
    await repairSessionDraftStorage(
      createProtectedSessionDraftStorageArea(dependencies.local, protectedDraftKeys),
      dependencies.getStoragePolicy(),
      now,
      (keys) =>
        executeImplicitSessionDraftDeletion(
          dependencies,
          keys,
          'pending-recovery-repair',
          journal.operationId
        )
    );
    await repairSessionDraftIndex(dependencies.local, (keys) =>
      executeImplicitSessionDraftDeletion(
        dependencies,
        keys,
        'pending-recovery-index-repair',
        journal.operationId
      )
    );
    await finalizeRecoveredJournal(journal, outcome, draftKey, dependencies, now);
    return;
  }
  if (storedFingerprint !== journal.previousEnvelopeFingerprint || journal.state === 'committed') {
    throw invalidState();
  }
  if (cursor?.revision === journal.context.nextRevision || outcome) throw invalidState();
  if (journal.expiresAt > now) throw new Error(RESTORE_STORAGE_REVISION_CONFLICT);
  await consumeRestoreStorageLease(dependencies.local, journal.operationId);
  await retireSessionDraftOperation(dependencies.local, journal.operationId, now);
  await cleanupJournal(dependencies.local, journal.operationId);
}

async function isRecoveredDesiredIdentityValid(
  journal: SessionDraftSaveJournal,
  stored: SessionDraftEnvelope,
  draftKey: string
): Promise<boolean> {
  const pageKey = createSessionDraftPageKey(stored.mode, stored.pageUrl);
  const canonicalKey = createSessionDraftStorageKey({
    mode: stored.mode,
    pageKey,
    draftId: stored.draftId
  });
  return (
    stored.pageKey === pageKey &&
    canonicalKey === draftKey &&
    (await createRequestFingerprint(journal.context, stored)) === journal.requestFingerprint
  );
}

async function validateJournal(
  journal: SessionDraftSaveJournal,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<string> {
  const draftKey = journal.context.draftKey;
  if (
    journal.operationId !== journal.context.operationId ||
    journal.context.nextRevision !== journal.context.baseRevision + 1 ||
    journal.context.epoch !== (await readSessionDraftEpoch(dependencies))
  ) {
    throw invalidState();
  }
  return draftKey;
}

function validatePartialRecords(
  journal: SessionDraftSaveJournal,
  cursor: SessionDraftCursor | null,
  outcome: SessionDraftOutcome | null,
  draftKey: string
): void {
  if (
    cursor &&
    (cursor.draftKey !== draftKey ||
      (cursor.revision !== journal.context.baseRevision &&
        (cursor.revision !== journal.context.nextRevision ||
          cursor.lastOperationId !== journal.operationId)))
  ) {
    throw invalidState();
  }
  if (
    outcome &&
    (outcome.operationId !== journal.operationId ||
      outcome.draftKey !== draftKey ||
      outcome.revision !== journal.context.nextRevision ||
      outcome.requestFingerprint !== journal.requestFingerprint)
  ) {
    throw invalidState();
  }
}

async function finalizeRecoveredJournal(
  journal: SessionDraftSaveJournal,
  existingOutcome: SessionDraftOutcome | null,
  draftKey: string,
  dependencies: SessionDraftRepositoryServiceDependencies,
  now: number
): Promise<void> {
  const cursor: SessionDraftCursor = {
    schemaVersion: 1,
    epoch: journal.context.epoch,
    state: 'present',
    draftKey,
    revision: journal.context.nextRevision,
    lastOperationId: journal.operationId
  };
  const outcome: SessionDraftOutcome = existingOutcome ?? {
    schemaVersion: 1,
    kind: 'save',
    operationId: journal.operationId,
    draftKey,
    revision: journal.context.nextRevision,
    requestFingerprint: journal.requestFingerprint,
    createdAt: now,
    expiresAt: now + SESSION_DRAFT_OUTCOME_TTL_MS
  };
  await finalizeJournal(dependencies.local, journal, cursor, outcome);
  await consumeRestoreStorageLease(dependencies.local, journal.operationId);
  await cleanupJournal(dependencies.local, journal.operationId);
}

function invalidState(): Error {
  return new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}
