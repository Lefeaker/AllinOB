import { readExactOwnDataRecord, readOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { ObjectRecord } from '../../shared/guards/object';
import {
  hasOwnProtocolKey as hasOwn,
  isNonEmptyProtocolString as isNonEmptyString,
  isNonNegativeSafeInteger as isNonNegativeInteger,
  isProtocolFingerprint as isFingerprint,
  readProtocolDataArray
} from './sessionDraftProtocolValueGuards';
import { RESTORE_STORAGE_LEASE_TTL_MS, type RestoreStorageLease } from './restoreStorageLeaseTypes';

const LEASE_BASE_KEYS = [
  'schemaVersion',
  'operationId',
  'epoch',
  'draftKey',
  'baseRevision',
  'draftRevision',
  'createdAt',
  'expiresAt'
] as const;

export function normalizeRestoreStorageLease<Value>(value: Value): RestoreStorageLease | null {
  const snapshot = readOwnDataRecord(value);
  if (!snapshot) return null;
  const keyField = hasOwn(snapshot, 'screenshotKeys') ? 'screenshotKeys' : 'screenshotKey';
  const lease = readExactOwnDataRecord(snapshot, [
    ...LEASE_BASE_KEYS,
    keyField,
    ...(hasOwn(snapshot, 'screenshotFingerprints') ? ['screenshotFingerprints'] : [])
  ]);
  if (!lease) return null;
  const screenshotKeys = normalizeScreenshotKeys(lease);
  const screenshotFingerprints = normalizeScreenshotFingerprints(lease);
  return lease.schemaVersion === 1 &&
    isNonEmptyString(lease.operationId) &&
    isNonNegativeInteger(lease.epoch) &&
    isNonEmptyString(lease.draftKey) &&
    isNonNegativeInteger(lease.baseRevision) &&
    isNonNegativeInteger(lease.draftRevision) &&
    screenshotKeys !== null &&
    screenshotFingerprints !== null &&
    isNonNegativeInteger(lease.createdAt) &&
    isNonNegativeInteger(lease.expiresAt) &&
    lease.expiresAt - lease.createdAt === RESTORE_STORAGE_LEASE_TTL_MS
    ? {
        schemaVersion: 1,
        operationId: lease.operationId,
        epoch: lease.epoch,
        draftKey: lease.draftKey,
        baseRevision: lease.baseRevision,
        draftRevision: lease.draftRevision,
        screenshotKeys,
        screenshotFingerprints,
        createdAt: lease.createdAt,
        expiresAt: lease.expiresAt
      }
    : null;
}

function normalizeScreenshotFingerprints(value: ObjectRecord): Record<string, string> | null {
  if (!hasOwn(value, 'screenshotFingerprints')) return {};
  const fingerprints = readOwnDataRecord(value.screenshotFingerprints);
  if (!fingerprints) return null;
  const normalized: Record<string, string> = {};
  for (const [key, fingerprint] of Object.entries(fingerprints)) {
    if (!isNonEmptyString(key) || !isFingerprint(fingerprint)) return null;
    normalized[key] = fingerprint;
  }
  return normalized;
}

function normalizeScreenshotKeys(value: ObjectRecord): string[] | null {
  const current = readProtocolDataArray(value.screenshotKeys);
  const raw = current ?? (isNonEmptyString(value.screenshotKey) ? [value.screenshotKey] : null);
  return raw && raw.every(isNonEmptyString) ? Array.from(new Set(raw)).sort() : null;
}
