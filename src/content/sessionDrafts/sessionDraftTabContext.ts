import type { SessionDraftEnvelope, SessionDraftOwnerContext } from './sessionDraftTypes';
import type { RuntimeMessageSender } from '@platform/interfaces/runtime';
import { readExactOwnDataRecord, readOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';

export const SESSION_DRAFT_TAB_CONTEXT_MESSAGE_TYPE = 'AIIOB_GET_TAB_CONTEXT';
export const SESSION_DRAFT_OWNER_CONTEXT_ACTIVE_MESSAGE_TYPE = 'AIIOB_IS_TAB_CONTEXT_ACTIVE';

export interface SessionDraftTabContextRequest {
  type: typeof SESSION_DRAFT_TAB_CONTEXT_MESSAGE_TYPE;
}

export interface SessionDraftOwnerContextActiveRequest {
  type: typeof SESSION_DRAFT_OWNER_CONTEXT_ACTIVE_MESSAGE_TYPE;
  ownerContext: SessionDraftOwnerContext;
}

export interface SessionDraftTabContextResponse extends SessionDraftOwnerContext {
  success: true;
}

export interface SessionDraftOwnerContextActiveResponse {
  success: true;
  active: boolean;
}

let runtimeMessageSender: RuntimeMessageSender | null = null;

export function configureSessionDraftRuntimeMessenger(sender: RuntimeMessageSender | null): void {
  runtimeMessageSender = sender;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function getRuntimeSendMessage(): RuntimeMessageSender | null {
  return runtimeMessageSender;
}

export function normalizeSessionDraftOwnerContext(value: unknown): SessionDraftOwnerContext | null {
  const snapshot = readOwnDataRecord(value);
  if (!snapshot) {
    return null;
  }
  const keys = Object.keys(snapshot);
  const allowedKeys = new Set(['tabId', 'windowId', 'frameId']);
  if (
    keys.length === 0 ||
    keys.some((key) => !allowedKeys.has(key)) ||
    keys.some((key) => !isNonNegativeInteger(snapshot[key]))
  ) {
    return null;
  }

  const ownerContext: SessionDraftOwnerContext = {};
  if (isNonNegativeInteger(snapshot.tabId)) {
    ownerContext.tabId = snapshot.tabId;
  }
  if (isNonNegativeInteger(snapshot.windowId)) {
    ownerContext.windowId = snapshot.windowId;
  }
  if (isNonNegativeInteger(snapshot.frameId)) {
    ownerContext.frameId = snapshot.frameId;
  }

  return ownerContext;
}

export function getSessionDraftEnvelopeOwnerContext(
  envelope: Pick<SessionDraftEnvelope, 'payload'>
): SessionDraftOwnerContext | null {
  return normalizeSessionDraftOwnerContext(envelope.payload.ownerContext);
}

export function isSameSessionDraftOwnerContext(
  left: SessionDraftOwnerContext | null | undefined,
  right: SessionDraftOwnerContext | null | undefined
): boolean {
  const normalizedLeft = normalizeSessionDraftOwnerContext(left);
  const normalizedRight = normalizeSessionDraftOwnerContext(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  let comparedField = false;
  for (const key of ['tabId', 'windowId', 'frameId'] as const) {
    const leftValue = normalizedLeft[key];
    const rightValue = normalizedRight[key];
    if (leftValue === undefined && rightValue === undefined) {
      continue;
    }
    comparedField = true;
    if (leftValue !== rightValue) {
      return false;
    }
  }

  return comparedField;
}

export function getCurrentSessionDraftOwnerContext():
  | SessionDraftOwnerContext
  | Promise<SessionDraftOwnerContext | null>
  | null {
  const sendMessage = getRuntimeSendMessage();
  if (!sendMessage) {
    return null;
  }

  return sendMessage({
    type: SESSION_DRAFT_TAB_CONTEXT_MESSAGE_TYPE
  } satisfies SessionDraftTabContextRequest)
    .then((response) => {
      const snapshot = readOwnDataRecord(response);
      if (
        !snapshot ||
        snapshot.success !== true ||
        Object.keys(snapshot).some(
          (key) => !['success', 'tabId', 'windowId', 'frameId'].includes(key)
        )
      ) {
        return null;
      }
      const ownerContext = {
        ...('tabId' in snapshot ? { tabId: snapshot.tabId } : {}),
        ...('windowId' in snapshot ? { windowId: snapshot.windowId } : {}),
        ...('frameId' in snapshot ? { frameId: snapshot.frameId } : {})
      };
      return normalizeSessionDraftOwnerContext(ownerContext);
    })
    .catch(() => null);
}

export function isSessionDraftOwnerContextActive(
  ownerContext: SessionDraftOwnerContext
): Promise<boolean> {
  const normalizedOwnerContext = normalizeSessionDraftOwnerContext(ownerContext);
  if (!normalizedOwnerContext) {
    return Promise.resolve(false);
  }

  const sendMessage = getRuntimeSendMessage();
  if (!sendMessage) {
    return Promise.resolve(false);
  }

  return sendMessage({
    type: SESSION_DRAFT_OWNER_CONTEXT_ACTIVE_MESSAGE_TYPE,
    ownerContext: normalizedOwnerContext
  } satisfies SessionDraftOwnerContextActiveRequest)
    .then((response) => {
      const snapshot = readExactOwnDataRecord(response, ['success', 'active']);
      if (!snapshot || snapshot.success !== true) {
        return false;
      }
      return snapshot.active === true;
    })
    .catch(() => false);
}
