import type { LocalRestoreDataClearMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';

const clearTails = new WeakMap<object, Promise<void>>();
const activeClears = new WeakMap<
  object,
  { operationId: string; promise: Promise<LocalRestoreDataClearMessageResult> }
>();

export function runRestoreStorageClear(
  identity: object,
  operationId: string,
  operation: () => Promise<LocalRestoreDataClearMessageResult>
): Promise<LocalRestoreDataClearMessageResult> {
  const active = activeClears.get(identity);
  if (active) {
    return active.operationId === operationId
      ? active.promise
      : Promise.reject(new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID'));
  }
  const promise = withRestoreStorageClearLock(identity, operation);
  activeClears.set(identity, { operationId, promise });
  void promise.then(
    () => clearActive(identity, promise),
    () => clearActive(identity, promise)
  );
  return promise;
}

export function withRestoreStorageClearLock<Result>(
  identity: object,
  operation: () => Promise<Result>
): Promise<Result> {
  const tail = clearTails.get(identity) ?? Promise.resolve();
  const run = tail.then(operation, operation);
  clearTails.set(
    identity,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function clearActive(identity: object, promise: Promise<LocalRestoreDataClearMessageResult>): void {
  if (activeClears.get(identity)?.promise === promise) activeClears.delete(identity);
}
