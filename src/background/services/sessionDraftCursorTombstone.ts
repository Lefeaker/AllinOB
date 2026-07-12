import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  createSessionDraftTombstoneStorageKey,
  normalizeSessionDraftTombstone
} from '../../content/sessionDrafts/sessionDraftLifecycleRecords';
import type { SessionDraftCursor } from './sessionDraftSaveJournal';
import { RESTORE_STORAGE_PROTOCOL_STATE_INVALID } from './sessionDraftRepositoryServiceTypes';

export async function assertSessionDraftCursorTombstone(
  area: Pick<StorageAreaService, 'get'>,
  cursor: SessionDraftCursor | null,
  draftKey: string,
  epoch: number
): Promise<void> {
  if (cursor?.state !== 'deleted') return;
  const tombstone = normalizeSessionDraftTombstone(
    await area.get(createSessionDraftTombstoneStorageKey(draftKey))
  );
  if (
    !tombstone ||
    tombstone.draftKey !== draftKey ||
    tombstone.epoch !== epoch ||
    tombstone.revision !== cursor.revision ||
    tombstone.operationId !== cursor.lastOperationId
  )
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}
