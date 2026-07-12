import type { StorageAreaService } from '../../platform/interfaces/storage';
import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';

export const RESTORE_STORAGE_BARRIER_KEY = 'aiob.restoreStorage.barrier.v1';
export const RESTORE_STORAGE_PROTOCOL_STATE_INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';

export interface RestoreStorageReadyBarrier {
  schemaVersion: 1;
  epoch: number;
  state: 'ready';
}

export interface RestoreStorageClearingBarrier {
  schemaVersion: 1;
  epoch: number;
  state: 'clearing';
  operationId: string;
  phase: 'local' | 'idb';
}

export type RestoreStorageBarrier = RestoreStorageReadyBarrier | RestoreStorageClearingBarrier;

export function normalizeRestoreStorageBarrier<Value>(value: Value): RestoreStorageBarrier | null {
  const ready = readExactOwnDataRecord(value, ['schemaVersion', 'epoch', 'state']);
  if (ready?.schemaVersion === 1 && ready.state === 'ready' && isEpoch(ready.epoch)) {
    return { schemaVersion: 1, epoch: ready.epoch, state: 'ready' };
  }
  const clearing = readExactOwnDataRecord(value, [
    'schemaVersion',
    'epoch',
    'state',
    'operationId',
    'phase'
  ]);
  if (
    clearing?.schemaVersion === 1 &&
    clearing.state === 'clearing' &&
    isEpoch(clearing.epoch) &&
    isOperationId(clearing.operationId) &&
    (clearing.phase === 'local' || clearing.phase === 'idb')
  ) {
    return {
      schemaVersion: 1,
      epoch: clearing.epoch,
      state: 'clearing',
      operationId: clearing.operationId,
      phase: clearing.phase
    };
  }
  return null;
}

export async function readRestoreStorageBarrier(
  area: Pick<StorageAreaService, 'get'>,
  fallbackEpoch: number
): Promise<RestoreStorageBarrier> {
  const raw = await area.get(RESTORE_STORAGE_BARRIER_KEY);
  if (raw === undefined) {
    if (!isEpoch(fallbackEpoch)) throw invalid();
    return { schemaVersion: 1, epoch: fallbackEpoch, state: 'ready' };
  }
  const barrier = normalizeRestoreStorageBarrier(raw);
  if (!barrier) throw invalid();
  return barrier;
}

export function createClearingRestoreStorageBarrier(
  epoch: number,
  operationId: string,
  phase: 'local' | 'idb'
): RestoreStorageClearingBarrier {
  const barrier = { schemaVersion: 1, epoch, state: 'clearing', operationId, phase } as const;
  if (!normalizeRestoreStorageBarrier(barrier)) throw invalid();
  return barrier;
}

export function createReadyRestoreStorageBarrier(epoch: number): RestoreStorageReadyBarrier {
  const barrier = { schemaVersion: 1, epoch, state: 'ready' } as const;
  if (!normalizeRestoreStorageBarrier(barrier)) throw invalid();
  return barrier;
}

function isEpoch(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isOperationId(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function invalid(): Error {
  return new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}
