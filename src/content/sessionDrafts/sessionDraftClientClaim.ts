import type { SessionDraftEnvelope } from './sessionDraftTypes';
import type {
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from './sessionDraftRepositoryMessages';
import {
  deriveSessionDraftKey,
  SessionDraftAcknowledgedError,
  type SessionDraftClientCursor,
  SESSION_DRAFT_REPOSITORY_REQUEST_FAILED
} from './sessionDraftClientSupport';

interface PendingClaim {
  operationId: string;
  epoch: number;
  revision: number;
}

export function createSessionDraftClaim(args: {
  cursors: Map<string, SessionDraftClientCursor>;
  pendingClaims: Map<string, PendingClaim>;
  enqueueWrite: <Result>(key: string, task: () => Promise<Result>) => Promise<Result>;
  send: (
    message: SessionDraftRepositoryMessage
  ) => Promise<Extract<SessionDraftRepositoryResponse, { success: true }>>;
  getCurrentEpoch: () => number | null;
  createOperationId: () => string;
}): (envelope: SessionDraftEnvelope) => Promise<void> {
  return (envelope) => {
    const key = deriveSessionDraftKey(envelope);
    return args.enqueueWrite(key, async () => {
      const cursor = args.cursors.get(key);
      const currentEpoch = args.getCurrentEpoch();
      if (!cursor || currentEpoch === null) {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      const pending = args.pendingClaims.get(key) ?? {
        operationId: args.createOperationId(),
        epoch: currentEpoch,
        revision: cursor.revision
      };
      args.pendingClaims.set(key, pending);
      let response: Extract<SessionDraftRepositoryResponse, { success: true }>;
      try {
        response = await args.send({
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'claimSessionDraft',
          operationId: pending.operationId,
          draftKey: key,
          expectedEpoch: pending.epoch,
          expectedRevision: pending.revision
        });
      } catch (error) {
        if (error instanceof SessionDraftAcknowledgedError) args.pendingClaims.delete(key);
        throw error;
      }
      if (
        response.operation !== 'claimSessionDraft' ||
        response.context.operationId !== pending.operationId ||
        response.context.draftKey !== key ||
        response.context.epoch !== pending.epoch ||
        response.context.baseRevision !== pending.revision ||
        response.context.nextRevision !== pending.revision + 1 ||
        response.revision !== pending.revision + 1
      ) {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      args.cursors.set(key, { epoch: pending.epoch, revision: response.revision });
      args.pendingClaims.delete(key);
    });
  };
}
