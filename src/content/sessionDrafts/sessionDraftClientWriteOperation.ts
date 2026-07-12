import type { SessionDraftEnvelope } from './sessionDraftTypes';
import type { SessionDraftOperationContext } from './sessionDraftRepositoryMessages';
import {
  SessionDraftTransportUnknownError,
  type SessionDraftWriteOperation
} from './sessionDraftWriteOperation';
import { SESSION_DRAFT_REPOSITORY_REQUEST_FAILED } from './sessionDraftClientSupport';

export function createSessionDraftRunWriteOperation(args: {
  enqueueWrite: <Result>(key: string, task: () => Promise<Result>) => Promise<Result>;
  getPendingContext: (key: string) => SessionDraftOperationContext | undefined;
  prepareContext: (key: string) => Promise<SessionDraftOperationContext>;
  saveWithContext: (
    envelope: SessionDraftEnvelope,
    context: SessionDraftOperationContext
  ) => Promise<void>;
  cancelPreparation: (key: string, context: SessionDraftOperationContext) => Promise<void>;
}) {
  return function runWriteOperation<Result>(
    key: string,
    task: (operation: SessionDraftWriteOperation) => Promise<Result>
  ): Promise<Result> {
    return args.enqueueWrite(key, async () => {
      const context = args.getPendingContext(key) ?? (await args.prepareContext(key));
      let commitAttempted = false;
      let active = true;
      const commitState: { promise: Promise<void> | null } = { promise: null };
      try {
        const result = await task({
          context,
          commit: (envelope) => {
            if (!active) {
              return Promise.reject(new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED));
            }
            commitAttempted = true;
            commitState.promise ??= args.saveWithContext(envelope, context);
            return commitState.promise;
          }
        });
        if (commitState.promise) await commitState.promise;
        if (!commitAttempted) await args.cancelPreparation(key, context);
        return result;
      } catch (error) {
        if (commitState.promise) await commitState.promise.catch(() => undefined);
        if (!commitAttempted && !(error instanceof SessionDraftTransportUnknownError)) {
          await args.cancelPreparation(key, context);
        }
        throw error;
      } finally {
        active = false;
      }
    });
  };
}
