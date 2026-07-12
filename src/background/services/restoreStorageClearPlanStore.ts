import type { StorageAreaService } from '../../platform/interfaces/storage';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import type { RestoreStorageLocalClearPlan } from './restoreStorageClearTargets';
import {
  normalizeRestoreStorageClearReceipt,
  RESTORE_STORAGE_CLEAR_TTL_MS,
  signRestoreStorageClearReceipt,
  verifyRestoreStorageClearReceipt,
  type RestoreStorageClearReceipt
} from './restoreStorageClearReceiptCodec';

export { normalizeRestoreStorageClearReceipt, RESTORE_STORAGE_CLEAR_TTL_MS };
export type { RestoreStorageClearReceipt };
export const RESTORE_STORAGE_CLEAR_PREFIX = 'aiob.restoreStorage.clear.v1.';

export function createRestoreStorageClearReceiptKey(operationId: string): string {
  return `${RESTORE_STORAGE_CLEAR_PREFIX}${encodeURIComponent(operationId)}`;
}

export async function createRestoreStorageClearPlan(
  area: Pick<StorageAreaService, 'set'>,
  operationId: string,
  epoch: number,
  plan: RestoreStorageLocalClearPlan,
  now: number
): Promise<RestoreStorageClearReceipt> {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - RESTORE_STORAGE_CLEAR_TTL_MS
  )
    throw invalid();
  const expiresAt = now + RESTORE_STORAGE_CLEAR_TTL_MS;
  const planFingerprint = await createSessionDraftProtocolFingerprint({
    operationId,
    epoch,
    targetCount: plan.targetKeys.length,
    draftKeysRemoved: plan.draftKeysRemoved,
    legacyScreenshotKeysRemoved: plan.legacyScreenshotKeysRemoved,
    createdAt: now,
    expiresAt
  });
  const receipt = await signRestoreStorageClearReceipt({
    schemaVersion: 1,
    kind: 'clear',
    state: 'planned',
    operationId,
    epoch,
    planFingerprint,
    targetCount: plan.targetKeys.length,
    draftKeysRemoved: plan.draftKeysRemoved,
    legacyScreenshotKeysRemoved: plan.legacyScreenshotKeysRemoved,
    screenshotEntriesPlanned: null,
    screenshotEntriesRemoved: null,
    createdAt: now,
    expiresAt
  });
  if (!normalizeRestoreStorageClearReceipt(receipt)) throw invalid();
  await area.set(createRestoreStorageClearReceiptKey(operationId), receipt);
  return receipt;
}

export async function readRestoreStorageClearReceipt(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string
): Promise<RestoreStorageClearReceipt | null | 'invalid'> {
  const raw = await area.get(createRestoreStorageClearReceiptKey(operationId));
  if (raw === undefined) return null;
  const receipt = await verifyRestoreStorageClearReceipt(raw);
  return receipt?.operationId === operationId ? receipt : 'invalid';
}

export async function transitionRestoreStorageClearReceipt(
  area: Pick<StorageAreaService, 'get' | 'set'>,
  current: RestoreStorageClearReceipt,
  next: RestoreStorageClearReceipt
): Promise<RestoreStorageClearReceipt> {
  const stored = await readRestoreStorageClearReceipt(area, current.operationId);
  if (stored === 'invalid' || !stored || !sameReceipt(stored, current)) throw invalid();
  const signed = await signRestoreStorageClearReceipt(next);
  if (!isAllowedTransition(current, signed) || !normalizeRestoreStorageClearReceipt(signed)) {
    throw invalid();
  }
  await area.set(createRestoreStorageClearReceiptKey(signed.operationId), signed);
  return signed;
}

export async function hasAnyRestoreStorageClearRecord(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string
): Promise<boolean> {
  return (await area.get(createRestoreStorageClearReceiptKey(operationId))) !== undefined;
}

export async function listRestoreStorageClearReceipts(
  area: Pick<StorageAreaService, 'getAll'>
): Promise<RestoreStorageClearReceipt[]> {
  const values = await area.getAll();
  const receipts: RestoreStorageClearReceipt[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(RESTORE_STORAGE_CLEAR_PREFIX)) continue;
    const receipt = await verifyRestoreStorageClearReceipt(raw);
    if (!receipt || key !== createRestoreStorageClearReceiptKey(receipt.operationId))
      throw invalid();
    receipts.push(receipt);
  }
  return receipts;
}

function isAllowedTransition(
  current: RestoreStorageClearReceipt,
  next: RestoreStorageClearReceipt
) {
  if (!sameIdentity(current, next)) return false;
  return (
    (current.state === 'planned' && next.state === 'local') ||
    (current.state === 'local' && next.state === 'idb') ||
    (current.state === 'idb' && next.state === 'committed')
  );
}
function sameIdentity(left: RestoreStorageClearReceipt, right: RestoreStorageClearReceipt) {
  return (
    left.operationId === right.operationId &&
    left.epoch === right.epoch &&
    left.planFingerprint === right.planFingerprint &&
    left.targetCount === right.targetCount &&
    left.draftKeysRemoved === right.draftKeysRemoved &&
    left.legacyScreenshotKeysRemoved === right.legacyScreenshotKeysRemoved &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  );
}
function sameReceipt(left: RestoreStorageClearReceipt, right: RestoreStorageClearReceipt) {
  return (
    sameIdentity(left, right) &&
    left.state === right.state &&
    left.recordFingerprint === right.recordFingerprint &&
    left.screenshotEntriesPlanned === right.screenshotEntriesPlanned &&
    left.screenshotEntriesRemoved === right.screenshotEntriesRemoved
  );
}
function invalid(): Error {
  return new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
}
