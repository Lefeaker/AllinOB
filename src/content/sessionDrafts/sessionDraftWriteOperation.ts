import type { SessionDraftEnvelope, SessionDraftRepository } from './sessionDraftTypes';
import type { SessionDraftOperationContext } from './sessionDraftRepositoryMessages';

export interface SessionDraftWriteOperation {
  context: SessionDraftOperationContext;
  commit(envelope: SessionDraftEnvelope): Promise<void>;
}

export class SessionDraftTransportUnknownError extends Error {}

export interface VersionedSessionDraftRepository extends SessionDraftRepository {
  claim(envelope: SessionDraftEnvelope): Promise<void>;
  runWriteOperation<Result>(
    draftKey: string,
    task: (operation: SessionDraftWriteOperation) => Promise<Result>
  ): Promise<Result>;
}

export function createSessionDraftWriteQueue() {
  const tails = new Map<string, Promise<void>>();
  return function enqueue<Result>(draftKey: string, task: () => Promise<Result>): Promise<Result> {
    const previous = tails.get(draftKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    tails.set(draftKey, tail);
    void tail.finally(() => {
      if (tails.get(draftKey) === tail) tails.delete(draftKey);
    });
    return result;
  };
}
