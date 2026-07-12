import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { RestoreStorageBarrier } from './restoreStorageEpochStore';
import {
  createRestoreStorageClearReceiptKey,
  type RestoreStorageClearReceipt
} from './restoreStorageClearPlanStore';
import { retireSessionDraftOperation } from './sessionDraftRetiredOperationStore';

export async function retireExpiredRestoreStorageClearReceipts(
  area: Pick<StorageAreaService, 'get' | 'set' | 'remove'>,
  barrier: RestoreStorageBarrier,
  receipts: RestoreStorageClearReceipt[],
  now: number
): Promise<RestoreStorageClearReceipt[]> {
  if (barrier.state !== 'ready') return receipts;
  const retained: RestoreStorageClearReceipt[] = [];
  for (const receipt of receipts) {
    if (
      receipt.state === 'committed' &&
      receipt.expiresAt <= now &&
      barrier.epoch >= receipt.epoch
    ) {
      await retireSessionDraftOperation(area, receipt.operationId, now);
      await area.remove(createRestoreStorageClearReceiptKey(receipt.operationId));
    } else {
      retained.push(receipt);
    }
  }
  return retained;
}
