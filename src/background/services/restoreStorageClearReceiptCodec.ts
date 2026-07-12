import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';

export const RESTORE_STORAGE_CLEAR_TTL_MS = 15 * 60 * 1_000;

export interface RestoreStorageClearReceipt {
  schemaVersion: 1;
  kind: 'clear';
  state: 'planned' | 'local' | 'idb' | 'committed';
  operationId: string;
  epoch: number;
  planFingerprint: string;
  recordFingerprint: string;
  targetCount: number;
  draftKeysRemoved: number;
  legacyScreenshotKeysRemoved: number;
  screenshotEntriesPlanned: number | null;
  screenshotEntriesRemoved: number | null;
  createdAt: number;
  expiresAt: number;
}

export async function signRestoreStorageClearReceipt(
  value: Omit<RestoreStorageClearReceipt, 'recordFingerprint'> | RestoreStorageClearReceipt
): Promise<RestoreStorageClearReceipt> {
  const { recordFingerprint: ignored, ...record } = {
    ...value,
    recordFingerprint: 'recordFingerprint' in value ? value.recordFingerprint : ''
  };
  void ignored;
  return {
    ...record,
    recordFingerprint: await createSessionDraftProtocolFingerprint(record)
  };
}

export async function verifyRestoreStorageClearReceipt<Value>(
  value: Value
): Promise<RestoreStorageClearReceipt | null> {
  const receipt = normalizeRestoreStorageClearReceipt(value);
  if (!receipt) return null;
  const signed = await signRestoreStorageClearReceipt(receipt);
  return signed.recordFingerprint === receipt.recordFingerprint ? receipt : null;
}

export function normalizeRestoreStorageClearReceipt<Value>(
  value: Value
): RestoreStorageClearReceipt | null {
  const receipt = readExactOwnDataRecord(value, [
    'schemaVersion',
    'kind',
    'state',
    'operationId',
    'epoch',
    'planFingerprint',
    'recordFingerprint',
    'targetCount',
    'draftKeysRemoved',
    'legacyScreenshotKeysRemoved',
    'screenshotEntriesPlanned',
    'screenshotEntriesRemoved',
    'createdAt',
    'expiresAt'
  ]);
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'clear' ||
    !isState(receipt.state) ||
    !isBoundedString(receipt.operationId, 128) ||
    !isPositiveSafe(receipt.epoch) ||
    !isFingerprint(receipt.planFingerprint) ||
    !isFingerprint(receipt.recordFingerprint) ||
    !isSafe(receipt.targetCount) ||
    !isSafe(receipt.draftKeysRemoved) ||
    !isSafe(receipt.legacyScreenshotKeysRemoved) ||
    receipt.draftKeysRemoved + receipt.legacyScreenshotKeysRemoved > receipt.targetCount ||
    !isNullableSafe(receipt.screenshotEntriesPlanned) ||
    !isNullableSafe(receipt.screenshotEntriesRemoved) ||
    !isSafe(receipt.createdAt) ||
    !isSafe(receipt.expiresAt) ||
    receipt.createdAt > Number.MAX_SAFE_INTEGER - RESTORE_STORAGE_CLEAR_TTL_MS ||
    receipt.expiresAt !== receipt.createdAt + RESTORE_STORAGE_CLEAR_TTL_MS ||
    !hasStateCounts(
      receipt.state,
      receipt.screenshotEntriesPlanned,
      receipt.screenshotEntriesRemoved
    )
  )
    return null;
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    state: receipt.state,
    operationId: receipt.operationId,
    epoch: receipt.epoch,
    planFingerprint: receipt.planFingerprint,
    recordFingerprint: receipt.recordFingerprint,
    targetCount: receipt.targetCount,
    draftKeysRemoved: receipt.draftKeysRemoved,
    legacyScreenshotKeysRemoved: receipt.legacyScreenshotKeysRemoved,
    screenshotEntriesPlanned: receipt.screenshotEntriesPlanned,
    screenshotEntriesRemoved: receipt.screenshotEntriesRemoved,
    createdAt: receipt.createdAt,
    expiresAt: receipt.expiresAt
  };
}

function hasStateCounts(state: string, planned: number | null, removed: number | null): boolean {
  if (state === 'planned') return planned === null && removed === null;
  if (state === 'local') return planned !== null && removed === null;
  return planned !== null && removed === planned;
}
function isState(value: RuntimePropertyValue): value is RestoreStorageClearReceipt['state'] {
  return value === 'planned' || value === 'local' || value === 'idb' || value === 'committed';
}
function isSafe(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveSafe(value: RuntimePropertyValue): value is number {
  return isSafe(value) && value >= 1;
}
function isNullableSafe(value: RuntimePropertyValue): value is number | null {
  return value === null || isSafe(value);
}
function isFingerprint(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function isBoundedString(value: RuntimePropertyValue, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
