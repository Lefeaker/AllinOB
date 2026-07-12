import type { RuntimePropertyValue } from '../../shared/guards/object';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';
import type { SessionDraftEnvelope } from './sessionDraftTypes';
import {
  type SessionDraftOperationContext,
  type SessionDraftRepositoryMessage,
  type SessionDraftRepositoryResponse
} from './sessionDraftRepositoryMessages';
import {
  createSessionDraftWriteQueue,
  type VersionedSessionDraftRepository
} from './sessionDraftWriteOperation';
import {
  createSessionDraftSender,
  deriveSessionDraftKey,
  SessionDraftAcknowledgedError,
  type SessionDraftClientCursor,
  type SessionDraftPendingPreparation,
  type SessionDraftPendingSave,
  SESSION_DRAFT_OPERATION_ALREADY_COMPLETED,
  SESSION_DRAFT_REPOSITORY_REQUEST_FAILED,
  sessionDraftContextsEqual
} from './sessionDraftClientSupport';
import { createSessionDraftClientReadMethods } from './sessionDraftClientReadMethods';
import { RESTORE_STORAGE_REVISION_CONFLICT } from './sessionDraftProtocolErrors';
import { createSessionDraftClaim } from './sessionDraftClientClaim';
import { createSessionDraftRunWriteOperation } from './sessionDraftClientWriteOperation';

export type {
  SessionDraftWriteOperation,
  VersionedSessionDraftRepository
} from './sessionDraftWriteOperation';

export {
  isSessionDraftAcknowledgedError,
  SESSION_DRAFT_OPERATION_ALREADY_COMPLETED,
  SESSION_DRAFT_REPOSITORY_REQUEST_FAILED
} from './sessionDraftClientSupport';

export interface SessionDraftClientRepositoryOptions {
  createOperationId?: () => string;
}

export interface SessionDraftRepositoryMessaging {
  send(message: SessionDraftRepositoryMessage): Promise<RuntimePropertyValue>;
}

export function createSessionDraftClientRepository(
  messaging: SessionDraftRepositoryMessaging,
  options: SessionDraftClientRepositoryOptions = {}
): VersionedSessionDraftRepository {
  const cursors = new Map<string, SessionDraftClientCursor>();
  const pendingSaves = new Map<string, SessionDraftPendingSave>();
  const pendingPreparations = new Map<string, SessionDraftPendingPreparation>();
  const pendingClaims = new Map<string, { operationId: string; epoch: number; revision: number }>();
  const enqueueWrite = createSessionDraftWriteQueue();
  let currentEpoch: number | null = null;

  const send = createSessionDraftSender(messaging);

  function remember(envelope: SessionDraftEnvelope, cursor: SessionDraftClientCursor): void {
    cursors.set(deriveSessionDraftKey(envelope), cursor);
  }

  function createOperationId(): string {
    return options.createOperationId?.() ?? globalThis.crypto.randomUUID();
  }

  async function prepareContext(key: string): Promise<SessionDraftOperationContext> {
    const existing = pendingPreparations.get(key);
    if (existing?.canceling && existing.context) {
      await cancelPreparation(key, existing.context);
      return prepareContext(key);
    }
    if (existing?.context) return existing.context;
    const preparation = existing ?? { operationId: createOperationId() };
    pendingPreparations.set(key, preparation);
    const cursor = cursors.get(key);
    const expectedEpoch = currentEpoch;
    const expectedRevision = expectedEpoch === null ? null : (cursor?.revision ?? null);
    let response: Extract<SessionDraftRepositoryResponse, { success: true }>;
    try {
      response = await send({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'prepareSessionDraftOperation',
        operationId: preparation.operationId,
        draftKey: key,
        ...(expectedEpoch === null ? {} : { expectedEpoch }),
        ...(expectedRevision === null ? {} : { expectedRevision })
      });
    } catch (error) {
      if (error instanceof SessionDraftAcknowledgedError) {
        pendingPreparations.delete(key);
        if (error.message === RESTORE_STORAGE_REVISION_CONFLICT) cursors.delete(key);
      }
      throw error;
    }
    if (response.operation !== 'prepareSessionDraftOperation') {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    if (
      response.context.operationId !== preparation.operationId ||
      response.context.draftKey !== key ||
      (expectedEpoch !== null && response.context.epoch !== expectedEpoch) ||
      (expectedRevision !== null && response.context.baseRevision !== expectedRevision)
    ) {
      pendingPreparations.delete(key);
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    if (response.status === 'completed') {
      pendingPreparations.delete(key);
      throw new SessionDraftAcknowledgedError(SESSION_DRAFT_OPERATION_ALREADY_COMPLETED);
    }
    acceptEpoch(response.context.epoch);
    cursors.set(key, {
      epoch: response.context.epoch,
      revision: response.context.baseRevision
    });
    preparation.context = response.context;
    pendingPreparations.set(key, preparation);
    return response.context;
  }

  async function cancelPreparation(
    key: string,
    context: SessionDraftOperationContext
  ): Promise<void> {
    const preparation = pendingPreparations.get(key);
    if (preparation) preparation.canceling = true;
    const response = await send({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'cancelSessionDraftOperation',
      context
    });
    if (response.operation !== 'cancelSessionDraftOperation') {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    if (!sessionDraftContextsEqual(response.context, context)) {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    pendingPreparations.delete(key);
    pendingSaves.delete(key);
  }

  async function saveWithContext(
    envelope: SessionDraftEnvelope,
    reservedContext?: SessionDraftOperationContext
  ): Promise<void> {
    const key = deriveSessionDraftKey(envelope);
    const context = reservedContext ?? (await prepareContext(key));
    if (context.draftKey !== key) {
      await cancelPreparation(context.draftKey, context);
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    const cursor = { epoch: context.epoch, revision: context.baseRevision };
    const requestIdentity = canonicalJsonStringify(envelope);
    const existingPending = pendingSaves.get(key);
    if (
      (existingPending && existingPending.requestIdentity !== requestIdentity) ||
      (existingPending && !sessionDraftContextsEqual(existingPending.context, context))
    ) {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    const pending = existingPending ?? {
      requestIdentity,
      context
    };
    pendingSaves.set(key, pending);
    let response: Extract<SessionDraftRepositoryResponse, { success: true }>;
    try {
      response = await send({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'saveSessionDraft',
        context: pending.context,
        envelope
      });
    } catch (error) {
      if (error instanceof SessionDraftAcknowledgedError) {
        pendingSaves.delete(key);
        await cancelPreparation(key, context);
      }
      throw error;
    }
    if (response.operation !== 'saveSessionDraft') {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    if (response.revision !== context.nextRevision) {
      throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
    }
    cursors.set(key, { epoch: cursor.epoch, revision: response.revision });
    pendingSaves.delete(key);
    pendingPreparations.delete(key);
  }

  function acceptEpoch(epoch: number): void {
    if (currentEpoch !== null && currentEpoch !== epoch) {
      cursors.clear();
      pendingSaves.clear();
      pendingPreparations.clear();
      pendingClaims.clear();
    }
    currentEpoch = epoch;
  }

  const clear = () => {
    cursors.clear();
    pendingSaves.clear();
    pendingPreparations.clear();
    pendingClaims.clear();
  };
  const reads = createSessionDraftClientReadMethods({
    send,
    acceptEpoch,
    remember: (envelope, epoch, revision) => remember(envelope, { epoch, revision }),
    rememberDeletion: (draftKey, epoch, revision) => cursors.set(draftKey, { epoch, revision }),
    createOperationId,
    clear
  });
  const claim = createSessionDraftClaim({
    cursors,
    pendingClaims,
    enqueueWrite,
    send,
    getCurrentEpoch: () => currentEpoch,
    createOperationId
  });
  const runWriteOperation = createSessionDraftRunWriteOperation({
    enqueueWrite,
    getPendingContext: (key) => pendingSaves.get(key)?.context,
    prepareContext,
    saveWithContext: (envelope, context) => saveWithContext(envelope, context),
    cancelPreparation
  });

  return {
    ...reads,
    claim,
    save(envelope) {
      const key = deriveSessionDraftKey(envelope);
      return enqueueWrite(key, () => saveWithContext(envelope));
    },
    runWriteOperation
  };
}
