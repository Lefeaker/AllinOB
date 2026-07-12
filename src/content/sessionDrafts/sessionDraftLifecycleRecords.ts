import type { StorageRecord } from '../../platform/interfaces/storage';
import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { isSessionDraftStorageKey } from './sessionDraftKeys';
import { SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH } from './sessionDraftRepositoryProtocol';

const CURSOR_PREFIX = 'aiob.restoreStorage.cursor.v1.';
const TOMBSTONE_PREFIX = 'aiob.restoreStorage.tombstone.v1.';

export interface SessionDraftCursor {
  schemaVersion: 1;
  epoch: number;
  state: 'present' | 'deleted';
  draftKey: string;
  revision: number;
  lastOperationId: string;
}

export interface SessionDraftTombstone {
  schemaVersion: 1;
  epoch: number;
  state: 'deleted';
  draftKey: string;
  revision: number;
  operationId: string;
}

export type SessionDraftLifecycleRecordStatus = 'none' | 'present' | 'deleted' | 'invalid';

export function createSessionDraftCursorStorageKey(draftKey: string): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(draftKey)}`;
}

export function createSessionDraftTombstoneStorageKey(draftKey: string): string {
  return `${TOMBSTONE_PREFIX}${encodeURIComponent(draftKey)}`;
}

export function normalizeSessionDraftCursor<Value>(value: Value): SessionDraftCursor | null {
  const current = readExactOwnDataRecord(value, [
    'schemaVersion',
    'epoch',
    'state',
    'draftKey',
    'revision',
    'lastOperationId'
  ]);
  const legacy = readExactOwnDataRecord(value, [
    'schemaVersion',
    'draftKey',
    'revision',
    'lastOperationId'
  ]);
  const record = current ?? legacy;
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !isBoundedSessionDraftStorageKey(record.draftKey) ||
    !isNonNegativeInteger(record.revision) ||
    !isBoundedOperationId(record.lastOperationId) ||
    (current &&
      (!isNonNegativeInteger(current.epoch) ||
        (current.state !== 'present' && current.state !== 'deleted')))
  )
    return null;
  return {
    schemaVersion: 1,
    epoch: current && isNonNegativeInteger(current.epoch) ? current.epoch : 1,
    state:
      current && (current.state === 'present' || current.state === 'deleted')
        ? current.state
        : 'present',
    draftKey: record.draftKey,
    revision: record.revision,
    lastOperationId: record.lastOperationId
  };
}

export function normalizeSessionDraftTombstone<Value>(value: Value): SessionDraftTombstone | null {
  const record = readExactOwnDataRecord(value, [
    'schemaVersion',
    'epoch',
    'state',
    'draftKey',
    'revision',
    'operationId'
  ]);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.state !== 'deleted' ||
    !isNonNegativeInteger(record.epoch) ||
    !isBoundedSessionDraftStorageKey(record.draftKey) ||
    !isNonNegativeInteger(record.revision) ||
    !isBoundedOperationId(record.operationId)
  )
    return null;
  return {
    schemaVersion: 1,
    epoch: record.epoch,
    state: 'deleted',
    draftKey: record.draftKey,
    revision: record.revision,
    operationId: record.operationId
  };
}

export function hasActiveSessionDraftTombstone(values: StorageRecord, draftKey: string): boolean {
  return getSessionDraftLifecycleRecordStatus(values, draftKey) === 'deleted';
}

export function getSessionDraftLifecycleRecordStatus(
  values: StorageRecord,
  draftKey: string
): SessionDraftLifecycleRecordStatus {
  const rawCursor = values[createSessionDraftCursorStorageKey(draftKey)];
  const rawTombstone = values[createSessionDraftTombstoneStorageKey(draftKey)];
  if (rawCursor === undefined && rawTombstone === undefined) return 'none';
  const cursor = rawCursor === undefined ? null : normalizeSessionDraftCursor(rawCursor);
  const tombstone =
    rawTombstone === undefined ? null : normalizeSessionDraftTombstone(rawTombstone);
  if (
    (rawCursor !== undefined && (!cursor || cursor.draftKey !== draftKey)) ||
    (rawTombstone !== undefined && (!tombstone || tombstone.draftKey !== draftKey))
  ) {
    return 'invalid';
  }
  if (cursor?.state === 'present' && rawTombstone === undefined) return 'present';
  if (
    cursor?.state === 'deleted' &&
    tombstone &&
    cursor.epoch === tombstone.epoch &&
    cursor.revision === tombstone.revision &&
    cursor.lastOperationId === tombstone.operationId
  ) {
    return 'deleted';
  }
  return 'invalid';
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isBoundedOperationId(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
export function isBoundedSessionDraftStorageKey(value: RuntimePropertyValue): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH &&
    isSessionDraftStorageKey(value)
  );
}
