import type {
  SessionDraftEnvelope,
  SessionDraftPersister,
  SessionDraftPersisterOptions
} from './sessionDraftTypes';

interface Deferred {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

export function createSessionDraftPersister<TEnvelope extends SessionDraftEnvelope>({
  repository,
  buildEnvelope,
  delayMs = 150
}: SessionDraftPersisterOptions<TEnvelope>): SessionDraftPersister {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Deferred | null = null;
  let writeChain = Promise.resolve();

  function ensurePending(): Deferred {
    pending ??= createDeferred();
    return pending;
  }

  async function flushPending(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const deferred = pending;
    if (!deferred) {
      await writeChain;
      return;
    }

    pending = null;
    const run = async (): Promise<void> => {
      const envelope = await buildEnvelope();
      if (envelope) {
        await repository.save(envelope);
      }
    };

    const completion = (writeChain = writeChain.then(run, run));
    try {
      await completion;
      deferred.resolve();
    } catch (error) {
      deferred.reject(error);
      throw error;
    }
  }

  return {
    scheduleSave(): Promise<void> {
      if (disposed) {
        return Promise.reject(new Error('Session draft persister has been disposed.'));
      }
      const deferred = ensurePending();
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void flushPending().catch(() => undefined);
      }, delayMs);
      return deferred.promise;
    },

    cancelPending(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending?.resolve();
      pending = null;
    },

    flushNow(): Promise<void> {
      return flushPending();
    },

    async dispose(options = {}): Promise<void> {
      disposed = true;
      if (timer && options.flush) {
        await flushPending();
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending?.resolve();
      pending = null;
      await writeChain;
    }
  };
}
