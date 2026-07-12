import type { StorageAreaService } from '../../platform/interfaces/storage';
import { getSessionDraftProtocolQuarantineCollisionStatus } from './sessionDraftProtocolCorruption';
import { hasAnyRestoreStorageClearRecord } from './restoreStorageClearPlanStore';
import { readJournalState, readOutcomeState } from './sessionDraftSaveJournal';
import { isSessionDraftOperationRetired } from './sessionDraftRetiredOperationStore';

const INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';

export async function assertNoSaveOperationCollision(
  area: StorageAreaService,
  operationId: string,
  now: number
): Promise<void> {
  const encoded = encodeURIComponent(operationId);
  const leaseKey = `aiob.restoreStorage.lease.v1.${encoded}`;
  const pendingKey = `aiob.restoreStorage.pending.v1.${encoded}`;
  const outcomeKey = `aiob.restoreStorage.outcome.v1.${encoded}`;
  const retiredKey = `aiob.restoreStorage.retiredOperation.v1.${encoded}`;
  const clearKey = `aiob.restoreStorage.clear.v1.${encoded}`;
  const deleteKey = `aiob.restoreStorage.delete.v1.${encoded}`;
  const deleteChunkPrefix = `aiob.restoreStorage.deleteChunk.v1.${encoded}.`;
  const [lease, journal, outcome, retired, clearRecord, quarantine] = await Promise.all([
    area.get(leaseKey),
    readJournalState(area, operationId),
    readOutcomeState(area, operationId),
    isSessionDraftOperationRetired(area, operationId),
    hasAnyRestoreStorageClearRecord(area, operationId),
    getSessionDraftProtocolQuarantineCollisionStatus(
      area,
      {
        exactSourceKeys: [leaseKey, pendingKey, outcomeKey, retiredKey, clearKey, deleteKey],
        numericSourcePrefix: deleteChunkPrefix
      },
      now
    )
  ]);
  if (
    lease !== undefined ||
    journal.kind !== 'missing' ||
    outcome.kind !== 'missing' ||
    retired ||
    clearRecord ||
    quarantine !== 'none'
  ) {
    throw new Error(INVALID);
  }
}
