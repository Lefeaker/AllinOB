import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { SessionDraftOperationContext } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  assertRestoreStorageLeaseKeyAvailable,
  createRestoreStorageLeaseKey,
  isRestoreStorageLeaseKeyQuarantined
} from './restoreStorageLeaseAuthority';
import { normalizeRestoreStorageLease } from './restoreStorageLeaseCodec';
import { RESTORE_STORAGE_LEASE_TTL_MS, type RestoreStorageLease } from './restoreStorageLeaseTypes';

export { normalizeRestoreStorageLease } from './restoreStorageLeaseCodec';
export { RESTORE_STORAGE_LEASE_TTL_MS, type RestoreStorageLease } from './restoreStorageLeaseTypes';

export const RESTORE_STORAGE_LEASE_CONFLICT = 'RESTORE_STORAGE_LEASE_CONFLICT';
export const RESTORE_STORAGE_LEASE_PREFIX = 'aiob.restoreStorage.lease.v1.';

export async function prepareRestoreStorageLease(
  area: Pick<StorageAreaService, 'get' | 'set'>,
  context: SessionDraftOperationContext,
  now = Date.now()
): Promise<boolean> {
  const key = leaseKey(context.operationId);
  await assertRestoreStorageLeaseKeyAvailable(area, key, RESTORE_STORAGE_LEASE_CONFLICT);
  const raw = await area.get(key);
  const existing = raw === undefined ? null : normalizeRestoreStorageLease(raw);
  if (raw !== undefined && (!existing || !matchesContext(existing, context, now))) {
    throw new Error(RESTORE_STORAGE_LEASE_CONFLICT);
  }
  if (existing) return true;
  await area.set(key, {
    schemaVersion: 1,
    operationId: context.operationId,
    epoch: context.epoch,
    draftKey: context.draftKey,
    baseRevision: context.baseRevision,
    draftRevision: context.nextRevision,
    screenshotKeys: [],
    screenshotFingerprints: {},
    createdAt: now,
    expiresAt: now + RESTORE_STORAGE_LEASE_TTL_MS
  } satisfies RestoreStorageLease);
  return false;
}

export async function persistRestoreStorageLease(
  area: Pick<StorageAreaService, 'get' | 'set'>,
  context: SessionDraftOperationContext,
  screenshotKey: string,
  screenshotFingerprint?: string,
  now = Date.now()
): Promise<boolean> {
  const key = leaseKey(context.operationId);
  await assertRestoreStorageLeaseKeyAvailable(area, key, RESTORE_STORAGE_LEASE_CONFLICT);
  const raw = await area.get(key);
  const existing = raw === undefined ? null : normalizeRestoreStorageLease(raw);
  if (!existing || !matchesContext(existing, context, now)) {
    throw new Error(RESTORE_STORAGE_LEASE_CONFLICT);
  }
  const sameOperation =
    existing.epoch === context.epoch &&
    existing.draftKey === context.draftKey &&
    existing.baseRevision === context.baseRevision &&
    existing.draftRevision === context.nextRevision
      ? existing
      : null;
  const existingFingerprint = sameOperation?.screenshotFingerprints[screenshotKey];
  if (existingFingerprint && existingFingerprint !== screenshotFingerprint) {
    throw new Error(RESTORE_STORAGE_LEASE_CONFLICT);
  }
  const lease: RestoreStorageLease = {
    schemaVersion: 1,
    operationId: context.operationId,
    epoch: context.epoch,
    draftKey: context.draftKey,
    baseRevision: context.baseRevision,
    draftRevision: context.nextRevision,
    screenshotKeys: Array.from(
      new Set([...(sameOperation?.screenshotKeys ?? []), screenshotKey])
    ).sort(),
    screenshotFingerprints: {
      ...(sameOperation?.screenshotFingerprints ?? {}),
      ...(screenshotFingerprint ? { [screenshotKey]: screenshotFingerprint } : {})
    },
    createdAt: sameOperation?.createdAt ?? now,
    expiresAt: sameOperation?.expiresAt ?? now + RESTORE_STORAGE_LEASE_TTL_MS
  };
  await area.set(key, lease);
  return !sameOperation?.screenshotKeys.includes(screenshotKey);
}

function matchesContext(
  lease: RestoreStorageLease,
  context: SessionDraftOperationContext,
  now: number
): boolean {
  return (
    lease.operationId === context.operationId &&
    lease.createdAt <= now &&
    lease.expiresAt > now &&
    lease.epoch === context.epoch &&
    lease.draftKey === context.draftKey &&
    lease.baseRevision === context.baseRevision &&
    lease.draftRevision === context.nextRevision
  );
}

export async function readLiveRestoreStorageLease(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string,
  now = Date.now()
): Promise<RestoreStorageLease | null> {
  const key = leaseKey(operationId);
  if (await isRestoreStorageLeaseKeyQuarantined(area, key)) return null;
  const lease = normalizeRestoreStorageLease(await area.get(key));
  return lease &&
    lease.operationId === operationId &&
    lease.createdAt <= now &&
    lease.expiresAt > now
    ? lease
    : null;
}

export function consumeRestoreStorageLease(
  area: Pick<StorageAreaService, 'remove'>,
  operationId: string
): Promise<void> {
  return area.remove(leaseKey(operationId));
}

export async function consumeMatchingRestoreStorageLease(
  area: Pick<StorageAreaService, 'get' | 'remove'>,
  context: SessionDraftOperationContext
): Promise<void> {
  const lease = normalizeRestoreStorageLease(await area.get(leaseKey(context.operationId)));
  if (
    lease?.operationId === context.operationId &&
    lease.epoch === context.epoch &&
    lease.draftKey === context.draftKey &&
    lease.baseRevision === context.baseRevision &&
    lease.draftRevision === context.nextRevision
  ) {
    await area.remove(leaseKey(context.operationId));
  }
}

export async function rollbackRestoreStorageLeaseKey(
  area: Pick<StorageAreaService, 'get' | 'set' | 'remove'>,
  context: SessionDraftOperationContext,
  screenshotKey: string
): Promise<void> {
  const raw = await area.get(leaseKey(context.operationId));
  if (raw === undefined) return;
  const lease = normalizeRestoreStorageLease(raw);
  if (
    !lease ||
    lease.operationId !== context.operationId ||
    lease.createdAt > Date.now() ||
    lease.epoch !== context.epoch ||
    lease.draftKey !== context.draftKey ||
    lease.baseRevision !== context.baseRevision ||
    lease.draftRevision !== context.nextRevision
  ) {
    throw new Error(RESTORE_STORAGE_LEASE_CONFLICT);
  }
  const screenshotKeys = lease.screenshotKeys.filter((key) => key !== screenshotKey);
  const screenshotFingerprints = { ...lease.screenshotFingerprints };
  delete screenshotFingerprints[screenshotKey];
  await area.set(leaseKey(context.operationId), {
    ...lease,
    screenshotKeys,
    screenshotFingerprints
  });
}

function leaseKey(operationId: string): string {
  return createRestoreStorageLeaseKey(operationId);
}
