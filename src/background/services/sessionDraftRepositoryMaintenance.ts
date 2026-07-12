import type { StorageAreaService } from '../../platform/interfaces/storage';
import { createSessionDraftStorageKey } from '../../content/sessionDrafts/sessionDraftKeys';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import { createProtectedSessionDraftStorageArea } from './sessionDraftProtectedStorage';
import { readCursorState } from './sessionDraftSaveJournal';
import {
  pruneCommittedSessionDraftJournals,
  pruneSessionDraftOutcomes,
  readSessionDraftJournalInventory
} from './sessionDraftSaveJournalMaintenance';
import { recoverBlockingSessionDraftJournals } from './sessionDraftPendingRecovery';
import { recoverMalformedSessionDraftCorruptionLedger } from './sessionDraftProtocolCorruption';
import { pruneRestoreStorageLeases } from './restoreStorageLeaseMaintenance';
import { pruneSessionDraftRetiredOperations } from './sessionDraftRetiredOperationMaintenance';
import {
  readSessionDraftEpoch,
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';

export async function readSessionDraftSelectionProtection(
  dependencies: SessionDraftRepositoryServiceDependencies
) {
  const policy = dependencies.getStoragePolicy();
  const now = Date.now();
  const epoch = await readSessionDraftEpoch(dependencies);
  const inventory = await readSessionDraftJournalInventory(dependencies.local, now);
  if (inventory.invalid) throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  const protectedKeys = new Set(
    inventory.journals
      .filter((journal) => journal.context.epoch === epoch && journal.expiresAt > now)
      .map((journal) => journal.context.draftKey)
  );
  return {
    local: createProtectedSessionDraftStorageArea(dependencies.local, protectedKeys),
    policy: {
      ...policy,
      maxDraftEntries: policy.maxDraftEntries + protectedKeys.size,
      retentionPolicy: { ...policy.retentionPolicy, maxRestorablePages: null }
    }
  };
}

export async function maintainSessionDraftProtocol(
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<void> {
  const now = Date.now();
  if (await recoverMalformedSessionDraftCorruptionLedger(dependencies.local, now)) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  await pruneRestoreStorageLeases(
    dependencies.local,
    now,
    await readSessionDraftEpoch(dependencies)
  );
  await pruneSessionDraftRetiredOperations(dependencies.local, now);
  await recoverBlockingSessionDraftJournals(
    dependencies,
    `maintenance-${globalThis.crypto.randomUUID()}`,
    '',
    now
  );
  await pruneCommittedSessionDraftJournals(dependencies.local);
  await pruneSessionDraftOutcomes(dependencies.local, now);
}

export async function readSessionDraftEnvelopeRevision(
  area: Pick<StorageAreaService, 'get'>,
  envelope: SessionDraftEnvelope
): Promise<number> {
  const state = await readCursorState(
    area,
    createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    })
  );
  if (state.kind === 'invalid') throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  return state.kind === 'valid' ? state.value.revision : 0;
}
