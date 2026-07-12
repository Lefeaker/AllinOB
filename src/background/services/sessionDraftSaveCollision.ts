import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  hasAnySessionDraftDeletionRecord,
  readSessionDraftDeletionChunk,
  readSessionDraftDeletionManifest
} from './sessionDraftDeletionRecordAccess';
import { RESTORE_STORAGE_PROTOCOL_STATE_INVALID } from './sessionDraftRepositoryServiceTypes';
import { hasAnyRestoreStorageClearRecord } from './restoreStorageClearPlanStore';

export async function assertNoSessionDraftDeletionCollision(
  area: StorageAreaService,
  operationId: string
): Promise<void> {
  const [manifest, chunk, anyRecord, clearRecord] = await Promise.all([
    readSessionDraftDeletionManifest(area, operationId),
    readSessionDraftDeletionChunk(area, operationId, 0),
    hasAnySessionDraftDeletionRecord(area, operationId),
    hasAnyRestoreStorageClearRecord(area, operationId)
  ]);
  if (manifest || chunk || anyRecord || clearRecord) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
}
