import { normalizeSessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftEnvelopeCodec';
import {
  getSessionDraftEnvelopeOwnerContext,
  isSameSessionDraftOwnerContext
} from '../../content/sessionDrafts/sessionDraftTabContext';
import type {
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import { readCursorState } from './sessionDraftSaveJournal';
import { saveSessionDraft } from './sessionDraftSaveService';
import { prepareSessionDraftOperation } from './sessionDraftOperationPreparation';
import {
  readSessionDraftEpoch,
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REVISION_CONFLICT,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';

type ClaimMessage = Extract<SessionDraftRepositoryMessage, { operation: 'claimSessionDraft' }>;

export async function claimSessionDraft(
  message: ClaimMessage,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<SessionDraftRepositoryResponse> {
  const owner = dependencies.requestOwnerContext;
  if (!owner || owner.tabId === undefined) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  const epoch = await readSessionDraftEpoch(dependencies);
  const cursorState = await readCursorState(dependencies.local, message.draftKey);
  if (cursorState.kind === 'invalid') throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  const revision = cursorState.kind === 'valid' ? cursorState.value.revision : 0;
  const envelope = normalizeSessionDraftEnvelope(await dependencies.local.get(message.draftKey));
  if (!envelope) throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  const previousOwner = getSessionDraftEnvelopeOwnerContext(envelope);
  if (
    previousOwner &&
    !isSameSessionDraftOwnerContext(previousOwner, owner) &&
    (await dependencies.isOwnerContextActive?.(previousOwner)) !== false
  ) {
    throw new Error(RESTORE_STORAGE_REVISION_CONFLICT);
  }
  const context = {
    operationId: message.operationId,
    epoch,
    draftKey: message.draftKey,
    baseRevision: message.expectedRevision,
    nextRevision: message.expectedRevision + 1
  };
  const replaying =
    cursorState.kind === 'valid' &&
    cursorState.value.lastOperationId === message.operationId &&
    revision === message.expectedRevision + 1;
  if (message.expectedEpoch !== epoch || (!replaying && message.expectedRevision !== revision)) {
    throw new Error(RESTORE_STORAGE_REVISION_CONFLICT);
  }
  if (!replaying) {
    const prepared = await prepareSessionDraftOperation(
      {
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'prepareSessionDraftOperation',
        operationId: context.operationId,
        draftKey: context.draftKey,
        expectedEpoch: context.epoch,
        expectedRevision: context.baseRevision
      },
      dependencies
    );
    if (
      prepared.success !== true ||
      prepared.operation !== 'prepareSessionDraftOperation' ||
      prepared.context.operationId !== context.operationId ||
      prepared.context.epoch !== context.epoch ||
      prepared.context.draftKey !== context.draftKey ||
      prepared.context.baseRevision !== context.baseRevision ||
      prepared.context.nextRevision !== context.nextRevision
    ) {
      throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
    }
  }
  const response = await saveSessionDraft(
    context,
    { ...envelope, payload: { ...envelope.payload, ownerContext: owner } },
    previousOwner && !isSameSessionDraftOwnerContext(previousOwner, owner)
      ? {
          ...dependencies,
          claimTransfer: {
            operationId: message.operationId,
            draftKey: message.draftKey,
            previousOwner,
            nextOwner: owner
          }
        }
      : dependencies
  );
  if (response.success !== true) return response;
  if (response.operation !== 'saveSessionDraft') {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  return {
    success: true,
    operation: 'claimSessionDraft',
    context,
    revision: response.revision,
    replayed: response.replayed
  };
}
