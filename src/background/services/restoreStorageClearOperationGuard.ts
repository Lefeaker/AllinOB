import type { StorageAreaService } from '../../platform/interfaces/storage';
import { getSessionDraftProtocolQuarantineCollisionStatus } from './sessionDraftProtocolCorruption';
import { normalizeSessionDraftRetiredOperation } from './sessionDraftRetiredOperationStore';

export async function assertRestoreStorageClearOperationAvailable(
  area: Pick<StorageAreaService, 'get' | 'getAll' | 'remove'>,
  operationId: string,
  now: number
): Promise<void> {
  const values = await area.getAll();
  const encoded = encodeURIComponent(operationId);
  const collisionKeys = [
    `aiob.restoreStorage.lease.v1.${encoded}`,
    `aiob.restoreStorage.pending.v1.${encoded}`,
    `aiob.restoreStorage.outcome.v1.${encoded}`,
    `aiob.restoreStorage.delete.v1.${encoded}`
  ];
  const retiredKey = `aiob.restoreStorage.retiredOperation.v1.${encoded}`;
  const chunkPrefix = `aiob.restoreStorage.deleteChunk.v1.${encoded}.`;
  const chunkCollision = Object.keys(values).some(
    (key) => key.startsWith(chunkPrefix) && /^\d+$/u.test(key.slice(chunkPrefix.length))
  );
  if (collisionKeys.some((key) => key in values) || chunkCollision) {
    throw new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
  }
  const quarantine = await getSessionDraftProtocolQuarantineCollisionStatus(
    area,
    {
      exactSourceKeys: [...collisionKeys, retiredKey],
      numericSourcePrefix: chunkPrefix
    },
    now
  );
  if (quarantine !== 'none') throw new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
  if (retiredKey in values) {
    const retired = normalizeSessionDraftRetiredOperation(values[retiredKey]);
    if (!retired || retired.operationId !== operationId || retired.expiresAt > now) {
      throw new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    }
    await area.remove(retiredKey);
  }
}
