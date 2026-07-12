import {
  readExactOwnDataRecord,
  readOwnDataRecord,
  readOwnJsonDataValue
} from '../../shared/guards/exactOwnDataRecord';
import { type ObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import { isSessionDraftStorageKey } from './sessionDraftKeys';
import { normalizeSessionDraftEnvelope } from './sessionDraftEnvelopeCodec';
import type { SessionDraftRemovalTarget, SessionDraftSelectionOptions } from './sessionDraftTypes';
import {
  SESSION_DRAFT_OPERATION_ID_MAX_LENGTH,
  SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH,
  type SessionDraftOperationContext,
  type SessionDraftRepositoryMessage
} from './sessionDraftRepositoryProtocol';
import { normalizeSessionDraftOwnerContext } from './sessionDraftTabContext';

export * from './sessionDraftRepositoryProtocol';

export function normalizeSessionDraftRepositoryMessage<Value>(
  value: Value
): SessionDraftRepositoryMessage | null {
  const message = readOwnDataRecord(value);
  if (!message || message.type !== 'AIIOB_VIDEO_SCREENSHOT_CACHE') return null;
  if (message.operation === 'prepareSessionDraftOperation') {
    if (
      !hasOnlyKeys(message, [
        'type',
        'operation',
        'operationId',
        'draftKey',
        'expectedEpoch',
        'expectedRevision'
      ]) ||
      !isBoundedNonEmptyString(message.operationId, SESSION_DRAFT_OPERATION_ID_MAX_LENGTH) ||
      !isBoundedNonEmptyString(message.draftKey, SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH) ||
      !isSessionDraftStorageKey(message.draftKey) ||
      ('expectedEpoch' in message && !isNonNegativeInteger(message.expectedEpoch)) ||
      ('expectedRevision' in message && !isNonNegativeInteger(message.expectedRevision))
    ) {
      return null;
    }
    const expectedEpoch = isNonNegativeInteger(message.expectedEpoch)
      ? message.expectedEpoch
      : undefined;
    const expectedRevision = isNonNegativeInteger(message.expectedRevision)
      ? message.expectedRevision
      : undefined;
    return {
      type: message.type,
      operation: message.operation,
      operationId: message.operationId,
      draftKey: message.draftKey,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    };
  }
  if (message.operation === 'cancelSessionDraftOperation') {
    const context = normalizeSessionDraftOperationContext(message.context);
    return hasOnlyKeys(message, ['type', 'operation', 'context']) && context
      ? { type: message.type, operation: message.operation, context }
      : null;
  }
  if (message.operation === 'claimSessionDraft') {
    return hasOnlyKeys(message, [
      'type',
      'operation',
      'operationId',
      'draftKey',
      'expectedEpoch',
      'expectedRevision'
    ]) &&
      isBoundedNonEmptyString(message.operationId, SESSION_DRAFT_OPERATION_ID_MAX_LENGTH) &&
      isBoundedNonEmptyString(message.draftKey, SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH) &&
      isSessionDraftStorageKey(message.draftKey) &&
      isNonNegativeInteger(message.expectedEpoch) &&
      isNonNegativeInteger(message.expectedRevision)
      ? {
          type: message.type,
          operation: message.operation,
          operationId: message.operationId,
          draftKey: message.draftKey,
          expectedEpoch: message.expectedEpoch,
          expectedRevision: message.expectedRevision
        }
      : null;
  }
  if (message.operation === 'saveSessionDraft') {
    const context = normalizeSessionDraftOperationContext(message.context);
    const envelope = normalizeSessionDraftEnvelope(message.envelope);
    return hasOnlyKeys(message, ['type', 'operation', 'context', 'envelope']) && context && envelope
      ? {
          type: message.type,
          operation: message.operation,
          context,
          envelope
        }
      : null;
  }
  if (
    message.operation === 'loadLatestSessionDraft' ||
    message.operation === 'listSessionDraftCandidates'
  ) {
    if (
      !hasOnlyKeys(message, ['type', 'operation', 'mode', 'pageUrl', 'now', 'options']) ||
      (message.mode !== 'reader' && message.mode !== 'video') ||
      !isNonEmptyString(message.pageUrl)
    )
      return null;
    let now: number | undefined;
    if ('now' in message) {
      if (!isTimestamp(message.now)) return null;
      now = message.now;
    }
    const options = 'options' in message ? normalizeSelectionOptions(message.options) : undefined;
    if ('options' in message && options === null) return null;
    return {
      type: message.type,
      operation: message.operation,
      mode: message.mode,
      pageUrl: message.pageUrl,
      ...(now === undefined ? {} : { now }),
      ...(options ? { options } : {})
    };
  }
  if (
    message.operation === 'removeSessionDraft' &&
    hasOnlyKeys(message, ['type', 'operation', 'operationId', 'target']) &&
    isBoundedNonEmptyString(message.operationId, SESSION_DRAFT_OPERATION_ID_MAX_LENGTH)
  ) {
    const target = normalizeRemovalTarget(message.target);
    if (!target) return null;
    return {
      type: message.type,
      operation: message.operation,
      operationId: message.operationId,
      target
    };
  }
  if (message.operation === 'pruneExpiredSessionDrafts') {
    if (
      !hasOnlyKeys(message, ['type', 'operation', 'operationId', 'now']) ||
      !isBoundedNonEmptyString(message.operationId, SESSION_DRAFT_OPERATION_ID_MAX_LENGTH)
    )
      return null;
    let now: number | undefined;
    if ('now' in message) {
      if (!isTimestamp(message.now)) return null;
      now = message.now;
    }
    return {
      type: message.type,
      operation: message.operation,
      operationId: message.operationId,
      ...(now === undefined ? {} : { now })
    };
  }
  return null;
}

export function normalizeNonCanonicalSessionDraftSaveContext<Value>(
  value: Value
): SessionDraftOperationContext | null {
  const message = readExactOwnDataRecord(value, ['type', 'operation', 'context', 'envelope']);
  if (
    !message ||
    message.type !== 'AIIOB_VIDEO_SCREENSHOT_CACHE' ||
    message.operation !== 'saveSessionDraft' ||
    readOwnJsonDataValue(message.envelope) !== undefined
  ) {
    return null;
  }
  return normalizeSessionDraftOperationContext(message.context);
}

export function normalizeSessionDraftOperationContext<Value>(
  value: Value
): SessionDraftOperationContext | null {
  const context = readExactOwnDataRecord(value, [
    'operationId',
    'epoch',
    'draftKey',
    'baseRevision',
    'nextRevision'
  ]);
  return context &&
    isBoundedNonEmptyString(context.operationId, SESSION_DRAFT_OPERATION_ID_MAX_LENGTH) &&
    isBoundedNonEmptyString(context.draftKey, SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH) &&
    isSessionDraftStorageKey(context.draftKey) &&
    isNonNegativeInteger(context.epoch) &&
    isNonNegativeInteger(context.baseRevision) &&
    isNonNegativeInteger(context.nextRevision) &&
    context.nextRevision === context.baseRevision + 1
    ? {
        operationId: context.operationId,
        epoch: context.epoch,
        draftKey: context.draftKey,
        baseRevision: context.baseRevision,
        nextRevision: context.nextRevision
      }
    : null;
}

function isBoundedNonEmptyString(value: RuntimePropertyValue, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function normalizeSelectionOptions(
  value: RuntimePropertyValue
): SessionDraftSelectionOptions | null {
  const options = readOwnDataRecord(value);
  if (!options || !hasOnlyKeys(options, ['ownerContext'])) return null;
  if (!('ownerContext' in options)) return {};
  if (options.ownerContext === null) return { ownerContext: null };
  const ownerContext = normalizeSessionDraftOwnerContext(options.ownerContext);
  if (!ownerContext) return null;
  return { ownerContext };
}

function normalizeRemovalTarget(value: RuntimePropertyValue): SessionDraftRemovalTarget | null {
  if (isNonEmptyString(value)) return value;
  const target = readExactOwnDataRecord(value, ['key']);
  return target && isNonEmptyString(target.key) && isSessionDraftStorageKey(target.key)
    ? { key: target.key }
    : null;
}

function hasOnlyKeys(value: ObjectRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return isTimestamp(value) && Number.isSafeInteger(value);
}

function isNonEmptyString(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0;
}
