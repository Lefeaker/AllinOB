import type { StorageAreaService } from '../../platform/interfaces/storage';
import { getSessionDraftProtocolKeyQuarantineStatus } from './sessionDraftProtocolCorruption';

export function createRestoreStorageLeaseKey(operationId: string): string {
  return `aiob.restoreStorage.lease.v1.${encodeURIComponent(operationId)}`;
}

export async function assertRestoreStorageLeaseKeyAvailable(
  area: Pick<StorageAreaService, 'get'>,
  key: string,
  errorCode: string
): Promise<void> {
  if ((await getSessionDraftProtocolKeyQuarantineStatus(area, key)) !== 'none') {
    throw new Error(errorCode);
  }
}

export async function isRestoreStorageLeaseKeyQuarantined(
  area: Pick<StorageAreaService, 'get'>,
  key: string
): Promise<boolean> {
  return (await getSessionDraftProtocolKeyQuarantineStatus(area, key)) !== 'none';
}
