import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoScreenshotCacheBlobMaintenanceStore } from '../../content/video/videoScreenshotCacheStore';
import type { LocalRestoreDataClearMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import {
  createClearingRestoreStorageBarrier,
  createReadyRestoreStorageBarrier,
  readRestoreStorageBarrier,
  RESTORE_STORAGE_BARRIER_KEY,
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  type RestoreStorageClearingBarrier
} from './restoreStorageEpochStore';
import {
  createRestoreStorageClearPlan,
  listRestoreStorageClearReceipts,
  readRestoreStorageClearReceipt,
  transitionRestoreStorageClearReceipt,
  type RestoreStorageClearReceipt
} from './restoreStorageClearPlanStore';
import { planRestoreStorageLocalClear } from './restoreStorageClearTargets';
import { runRestoreStorageClear, withRestoreStorageClearLock } from './restoreStorageClearLock';
import { assertRestoreStorageClearOperationAvailable } from './restoreStorageClearOperationGuard';
import { retireExpiredRestoreStorageClearReceipts } from './restoreStorageClearReceiptMaintenance';

export interface RestoreStorageClearOwner {
  clear(operationId: string): Promise<LocalRestoreDataClearMessageResult>;
  recover(): Promise<void>;
  getReadyEpoch(): Promise<number>;
}

export function createRestoreStorageClearOwner(dependencies: {
  local: StorageAreaService;
  getScreenshots(): VideoScreenshotCacheBlobMaintenanceStore;
  getFallbackEpoch(): number | Promise<number>;
  now?: () => number;
}): RestoreStorageClearOwner {
  const readBarrier = async () =>
    readRestoreStorageBarrier(dependencies.local, await dependencies.getFallbackEpoch());

  async function getReadyEpoch(): Promise<number> {
    const barrier = await readBarrier();
    if (barrier.state !== 'ready') throw invalid();
    return barrier.epoch;
  }

  async function recover(): Promise<void> {
    const rawBarrier = await dependencies.local.get(RESTORE_STORAGE_BARRIER_KEY);
    let barrier = await readBarrier();
    let receipts = await listRestoreStorageClearReceipts(dependencies.local);
    receipts = await retireExpiredRestoreStorageClearReceipts(
      dependencies.local,
      barrier,
      receipts,
      dependencies.now?.() ?? Date.now()
    );
    const pending = receipts.filter((receipt) => receipt.state !== 'committed');
    if (barrier.state === 'ready') {
      const ahead = pending.filter((receipt) => receipt.epoch === barrier.epoch + 1);
      if (pending.length === 0) {
        if (rawBarrier === undefined) {
          await dependencies.local.set(
            RESTORE_STORAGE_BARRIER_KEY,
            createReadyRestoreStorageBarrier(barrier.epoch)
          );
        }
        return;
      }
      if (ahead.length !== 1 || pending.length !== 1 || ahead[0]?.state !== 'planned') {
        throw invalid();
      }
      barrier = createClearingRestoreStorageBarrier(ahead[0].epoch, ahead[0].operationId, 'local');
      await dependencies.local.set(RESTORE_STORAGE_BARRIER_KEY, barrier);
    }
    const receipt = receipts.find((entry) => entry.operationId === barrier.operationId);
    if (!receipt || receipt.epoch !== barrier.epoch) throw invalid();
    if (pending.some((entry) => entry.operationId !== barrier.operationId)) throw invalid();
    await converge(barrier, receipt);
  }

  async function clear(operationId: string): Promise<LocalRestoreDataClearMessageResult> {
    const existing = await readRestoreStorageClearReceipt(dependencies.local, operationId);
    if (existing === 'invalid') throw invalid();
    const pending = (await listRestoreStorageClearReceipts(dependencies.local)).filter(
      (receipt) => receipt.state !== 'committed'
    );
    if (pending.some((receipt) => receipt.operationId !== operationId)) throw invalid();
    let barrier = await readBarrier();
    if (existing?.state === 'committed') {
      if (
        barrier.state === 'clearing' &&
        barrier.operationId === operationId &&
        barrier.epoch === existing.epoch
      ) {
        await recover();
        barrier = await readBarrier();
      }
      if (barrier.state !== 'ready' || barrier.epoch < existing.epoch) throw invalid();
      if (existing.expiresAt <= (dependencies.now?.() ?? Date.now())) {
        await retireExpiredRestoreStorageClearReceipts(
          dependencies.local,
          barrier,
          [existing],
          dependencies.now?.() ?? Date.now()
        );
        throw invalid();
      }
      return toResult(existing);
    }
    if (existing) {
      await recover();
      const completed = await readRestoreStorageClearReceipt(dependencies.local, operationId);
      if (!completed || completed === 'invalid' || completed.state !== 'committed') throw invalid();
      return toResult(completed);
    }
    if (pending.length > 0) throw invalid();
    await assertRestoreStorageClearOperationAvailable(
      dependencies.local,
      operationId,
      dependencies.now?.() ?? Date.now()
    );
    await recover();
    barrier = await readBarrier();
    if (barrier.state !== 'ready' || barrier.epoch === Number.MAX_SAFE_INTEGER) throw invalid();
    const epoch = barrier.epoch + 1;
    const receipt = await createRestoreStorageClearPlan(
      dependencies.local,
      operationId,
      epoch,
      planRestoreStorageLocalClear(await dependencies.local.getAll()),
      dependencies.now?.() ?? Date.now()
    );
    barrier = createClearingRestoreStorageBarrier(epoch, operationId, 'local');
    await dependencies.local.set(RESTORE_STORAGE_BARRIER_KEY, barrier);
    return converge(barrier, receipt);
  }

  async function converge(
    barrier: RestoreStorageClearingBarrier,
    initialReceipt: RestoreStorageClearReceipt
  ): Promise<LocalRestoreDataClearMessageResult> {
    let receipt = initialReceipt;
    let currentBarrier = barrier;
    if (currentBarrier.phase === 'local') {
      if (receipt.state === 'planned') {
        const remaining = planRestoreStorageLocalClear(
          await dependencies.local.getAll()
        ).targetKeys;
        if (remaining.length > 0) await dependencies.local.remove(remaining);
        const screenshotEntriesPlanned = await countScreenshots(dependencies.getScreenshots());
        const localReceipt: RestoreStorageClearReceipt = {
          ...receipt,
          state: 'local',
          screenshotEntriesPlanned
        };
        receipt = await transitionRestoreStorageClearReceipt(
          dependencies.local,
          receipt,
          localReceipt
        );
      }
      if (receipt.state !== 'local') throw invalid();
      currentBarrier = createClearingRestoreStorageBarrier(
        currentBarrier.epoch,
        currentBarrier.operationId,
        'idb'
      );
      await dependencies.local.set(RESTORE_STORAGE_BARRIER_KEY, currentBarrier);
    }
    if (receipt.state === 'local') {
      const deleted = await dependencies.getScreenshots().deleteAll();
      if (deleted !== receipt.screenshotEntriesPlanned && deleted !== 0) throw invalid();
      const idbReceipt: RestoreStorageClearReceipt = {
        ...receipt,
        state: 'idb',
        screenshotEntriesRemoved: receipt.screenshotEntriesPlanned
      };
      receipt = await transitionRestoreStorageClearReceipt(dependencies.local, receipt, idbReceipt);
    }
    if (receipt.state === 'idb') {
      const committed: RestoreStorageClearReceipt = { ...receipt, state: 'committed' };
      receipt = await transitionRestoreStorageClearReceipt(dependencies.local, receipt, committed);
    }
    if (receipt.state !== 'committed') throw invalid();
    await dependencies.local.set(
      RESTORE_STORAGE_BARRIER_KEY,
      createReadyRestoreStorageBarrier(receipt.epoch)
    );
    return toResult(receipt);
  }

  return {
    clear: (operationId) =>
      runRestoreStorageClear(dependencies.local, operationId, () => clear(operationId)),
    recover: () => withRestoreStorageClearLock(dependencies.local, recover),
    getReadyEpoch
  };
}

async function countScreenshots(store: VideoScreenshotCacheBlobMaintenanceStore): Promise<number> {
  if (store.countAll) return store.countAll();
  const listed = await store.listAllMetadata();
  return listed.entries.length + listed.invalidKeys.length;
}

function toResult(receipt: RestoreStorageClearReceipt): LocalRestoreDataClearMessageResult {
  if (receipt.state !== 'committed' || receipt.screenshotEntriesRemoved === null) throw invalid();
  return {
    draftKeysRemoved: receipt.draftKeysRemoved,
    screenshotEntriesRemoved: receipt.screenshotEntriesRemoved,
    legacyScreenshotKeysRemoved: receipt.legacyScreenshotKeysRemoved
  };
}

function invalid(): Error {
  return new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}
