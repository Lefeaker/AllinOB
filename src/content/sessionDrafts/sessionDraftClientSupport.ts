import type { RuntimePropertyValue } from '../../shared/guards/object';
import { createSessionDraftPageKey, createSessionDraftStorageKey } from './sessionDraftKeys';
import type { SessionDraftEnvelope, SessionDraftSelectionOptions } from './sessionDraftTypes';
import type {
  SessionDraftOperationContext,
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from './sessionDraftRepositoryMessages';
import { normalizeSessionDraftRepositoryResponse } from './sessionDraftRepositoryResponses';

export const SESSION_DRAFT_REPOSITORY_REQUEST_FAILED = 'SESSION_DRAFT_REPOSITORY_REQUEST_FAILED';
export const SESSION_DRAFT_OPERATION_ALREADY_COMPLETED =
  'SESSION_DRAFT_OPERATION_ALREADY_COMPLETED';

export interface SessionDraftClientCursor {
  epoch: number;
  revision: number;
}

export interface SessionDraftPendingSave {
  context: SessionDraftOperationContext;
  requestIdentity: string;
}

export interface SessionDraftPendingPreparation {
  operationId: string;
  context?: SessionDraftOperationContext;
  canceling?: boolean;
}

export class SessionDraftAcknowledgedError extends Error {}

export function isSessionDraftAcknowledgedError(error: unknown): boolean {
  return error instanceof SessionDraftAcknowledgedError;
}

export function createSessionDraftSender(messaging: {
  send(message: SessionDraftRepositoryMessage): Promise<RuntimePropertyValue>;
}) {
  return async function send(
    message: SessionDraftRepositoryMessage
  ): Promise<Extract<SessionDraftRepositoryResponse, { success: true }>> {
    const raw = await messaging.send(message);
    const response = normalizeSessionDraftRepositoryResponse(raw, message.operation);
    if (!response) throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    if (response.success !== true) throw new SessionDraftAcknowledgedError(response.error);
    return response;
  };
}

export function sessionDraftSelectionFields(
  now: number | undefined,
  options: SessionDraftSelectionOptions | undefined
) {
  return {
    ...(now === undefined ? {} : { now }),
    ...(options === undefined ? {} : { options })
  };
}

export function deriveSessionDraftKey(envelope: SessionDraftEnvelope): string {
  const pageKey = createSessionDraftPageKey(envelope.mode, envelope.pageUrl);
  if (pageKey !== envelope.pageKey) {
    throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
  }
  return createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey,
    draftId: envelope.draftId
  });
}

export function sessionDraftContextsEqual(
  first: SessionDraftOperationContext,
  second: SessionDraftOperationContext
): boolean {
  return (
    first.operationId === second.operationId &&
    first.epoch === second.epoch &&
    first.draftKey === second.draftKey &&
    first.baseRevision === second.baseRevision &&
    first.nextRevision === second.nextRevision
  );
}
