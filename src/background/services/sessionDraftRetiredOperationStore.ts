import type { StorageAreaService } from '../../platform/interfaces/storage';
import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import { getSessionDraftProtocolKeyQuarantineStatus } from './sessionDraftProtocolCorruption';
import { RESTORE_STORAGE_PROTOCOL_STATE_INVALID } from './sessionDraftRepositoryServiceTypes';

export const SESSION_DRAFT_RETIRED_OPERATION_PREFIX = 'aiob.restoreStorage.retiredOperation.v1.';
export const SESSION_DRAFT_RETIRED_OPERATION_TTL_MS = 15 * 60 * 1_000;

export interface SessionDraftRetiredOperation {
  schemaVersion: 1;
  operationId: string;
  retiredAt: number;
  expiresAt: number;
}

export function retireSessionDraftOperation(
  area: Pick<StorageAreaService, 'set'>,
  operationId: string,
  now = Date.now()
): Promise<void> {
  return area.set(`${SESSION_DRAFT_RETIRED_OPERATION_PREFIX}${encodeURIComponent(operationId)}`, {
    schemaVersion: 1,
    operationId,
    retiredAt: now,
    expiresAt: now + SESSION_DRAFT_RETIRED_OPERATION_TTL_MS
  });
}

export async function isSessionDraftOperationRetired(
  area: Pick<StorageAreaService, 'get' | 'remove'>,
  operationId: string,
  now = Date.now()
): Promise<boolean> {
  const key = `${SESSION_DRAFT_RETIRED_OPERATION_PREFIX}${encodeURIComponent(operationId)}`;
  const quarantine = await getSessionDraftProtocolKeyQuarantineStatus(area, key);
  if (quarantine === 'global') throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  if (quarantine === 'key') return true;
  const value = await area.get(key);
  if (value === undefined) return false;
  const retired = normalizeSessionDraftRetiredOperation(value);
  if (!retired || retired.operationId !== operationId) return true;
  if (retired.expiresAt <= now) {
    await area.remove(key);
    return false;
  }
  return true;
}

export function normalizeSessionDraftRetiredOperation<Value>(
  value: Value
): SessionDraftRetiredOperation | null {
  const retired = readExactOwnDataRecord(value, [
    'schemaVersion',
    'operationId',
    'retiredAt',
    'expiresAt'
  ]);
  return retired &&
    retired.schemaVersion === 1 &&
    typeof retired.operationId === 'string' &&
    retired.operationId.length > 0 &&
    typeof retired.retiredAt === 'number' &&
    Number.isInteger(retired.retiredAt) &&
    retired.retiredAt >= 0 &&
    typeof retired.expiresAt === 'number' &&
    Number.isInteger(retired.expiresAt) &&
    retired.expiresAt - retired.retiredAt === SESSION_DRAFT_RETIRED_OPERATION_TTL_MS
    ? {
        schemaVersion: 1,
        operationId: retired.operationId,
        retiredAt: retired.retiredAt,
        expiresAt: retired.expiresAt
      }
    : null;
}
