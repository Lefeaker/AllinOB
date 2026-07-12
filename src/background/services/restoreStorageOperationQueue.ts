export interface RestoreStorageOperationQueue {
  enqueue<Result>(operation: () => Promise<Result>): Promise<Result>;
}

const sharedTails = new WeakMap<object, Promise<void>>();

export function createRestoreStorageOperationQueue(
  sharedIdentity?: object
): RestoreStorageOperationQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(operation) {
      const previous = sharedIdentity
        ? (sharedTails.get(sharedIdentity) ?? Promise.resolve())
        : tail;
      const run = previous.then(operation, operation);
      const next = run.then(
        () => undefined,
        () => undefined
      );
      if (sharedIdentity) sharedTails.set(sharedIdentity, next);
      else tail = next;
      return run;
    }
  };
}
