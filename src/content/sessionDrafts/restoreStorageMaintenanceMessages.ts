import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';

export type RestoreStorageMaintenanceOperation =
  | 'clearAllRestoreData'
  | 'inspectStoragePressure'
  | 'runStoragePressureCleanup';

export const LOCAL_RESTORE_DATA_CLEAR_FAILED = 'LOCAL_RESTORE_DATA_CLEAR_FAILED';

export interface LocalRestoreDataClearMessageResult {
  draftKeysRemoved: number;
  screenshotEntriesRemoved: number;
  legacyScreenshotKeysRemoved: number;
}

export interface StorageEstimateMessageSnapshot {
  usage: number | null;
  quota: number | null;
  available: number | null;
  supported: boolean;
}

export interface RestoreStoragePressureMessageResult {
  triggered: boolean;
  reason:
    | 'below-trigger'
    | 'estimate-unavailable'
    | 'pressure-detected'
    | 'target-reached'
    | 'cleanup-exhausted';
  initialEstimate: StorageEstimateMessageSnapshot;
  finalEstimate: StorageEstimateMessageSnapshot;
  removed: {
    expiredScreenshots: number;
    orphanScreenshots: number;
    expiredDrafts: number;
    excessDrafts: number;
    newlyOrphanedScreenshots: number;
  };
}

export type RestoreStorageMaintenanceMessage =
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'clearAllRestoreData';
      operationId: string;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'inspectStoragePressure' | 'runStoragePressureCleanup';
    };

export type RestoreStorageMaintenanceResponse =
  | {
      success: true;
      operation: 'clearAllRestoreData';
      result: LocalRestoreDataClearMessageResult;
    }
  | {
      success: true;
      operation: 'inspectStoragePressure' | 'runStoragePressureCleanup';
      result: RestoreStoragePressureMessageResult;
    };

export function isRestoreStorageMaintenanceOperation(
  value: RuntimePropertyValue
): value is RestoreStorageMaintenanceOperation {
  return (
    value === 'clearAllRestoreData' ||
    value === 'inspectStoragePressure' ||
    value === 'runStoragePressureCleanup'
  );
}

export function isRestoreStorageMaintenanceMessage<Value>(
  value: Value
): value is Value & RestoreStorageMaintenanceMessage {
  const clear = readExactOwnDataRecord(value, ['type', 'operation', 'operationId']);
  if (clear?.type === 'AIIOB_VIDEO_SCREENSHOT_CACHE' && clear.operation === 'clearAllRestoreData') {
    return isBoundedOperationId(clear.operationId);
  }
  const pressure = readExactOwnDataRecord(value, ['type', 'operation']);
  if (pressure?.type !== 'AIIOB_VIDEO_SCREENSHOT_CACHE') return false;
  return (
    pressure.operation === 'inspectStoragePressure' ||
    pressure.operation === 'runStoragePressureCleanup'
  );
}

export function normalizeRestoreStorageMaintenanceResponse<Value>(
  value: Value,
  expectedOperation: RestoreStorageMaintenanceOperation
): RestoreStorageMaintenanceResponse | null {
  const response = readExactOwnDataRecord(value, ['success', 'operation', 'result']);
  if (response?.success !== true || response.operation !== expectedOperation) return null;
  if (expectedOperation === 'clearAllRestoreData') {
    const result = normalizeLocalRestoreDataClearResult(response.result);
    return result ? { success: true, operation: expectedOperation, result } : null;
  }
  const result = normalizeRestoreStoragePressureResult(response.result);
  return result ? { success: true, operation: expectedOperation, result } : null;
}

function normalizeLocalRestoreDataClearResult(
  value: RuntimePropertyValue
): LocalRestoreDataClearMessageResult | null {
  const result = readExactOwnDataRecord(value, [
    'draftKeysRemoved',
    'screenshotEntriesRemoved',
    'legacyScreenshotKeysRemoved'
  ]);
  return result !== null &&
    isNonNegativeInteger(result.draftKeysRemoved) &&
    isNonNegativeInteger(result.screenshotEntriesRemoved) &&
    isNonNegativeInteger(result.legacyScreenshotKeysRemoved)
    ? {
        draftKeysRemoved: result.draftKeysRemoved,
        screenshotEntriesRemoved: result.screenshotEntriesRemoved,
        legacyScreenshotKeysRemoved: result.legacyScreenshotKeysRemoved
      }
    : null;
}

function normalizeRestoreStoragePressureResult(
  value: RuntimePropertyValue
): RestoreStoragePressureMessageResult | null {
  const result = readExactOwnDataRecord(value, [
    'triggered',
    'reason',
    'initialEstimate',
    'finalEstimate',
    'removed'
  ]);
  if (
    result === null ||
    typeof result.triggered !== 'boolean' ||
    !isRestoreStoragePressureReason(result.reason)
  )
    return null;
  const initialEstimate = normalizeEstimateSnapshot(result.initialEstimate);
  const finalEstimate = normalizeEstimateSnapshot(result.finalEstimate);
  const removed = normalizeRemovedCounts(result.removed);
  return initialEstimate && finalEstimate && removed
    ? {
        triggered: result.triggered,
        reason: result.reason,
        initialEstimate,
        finalEstimate,
        removed
      }
    : null;
}

function isRestoreStoragePressureReason(
  value: RuntimePropertyValue
): value is RestoreStoragePressureMessageResult['reason'] {
  return (
    value === 'below-trigger' ||
    value === 'estimate-unavailable' ||
    value === 'pressure-detected' ||
    value === 'target-reached' ||
    value === 'cleanup-exhausted'
  );
}

function normalizeEstimateSnapshot(
  value: RuntimePropertyValue
): StorageEstimateMessageSnapshot | null {
  const estimate = readExactOwnDataRecord(value, ['usage', 'quota', 'available', 'supported']);
  return estimate !== null &&
    typeof estimate.supported === 'boolean' &&
    isNullableNonNegativeFiniteNumber(estimate.usage) &&
    isNullableNonNegativeFiniteNumber(estimate.quota) &&
    isNullableNonNegativeFiniteNumber(estimate.available)
    ? {
        usage: estimate.usage,
        quota: estimate.quota,
        available: estimate.available,
        supported: estimate.supported
      }
    : null;
}

function normalizeRemovedCounts(
  value: RuntimePropertyValue
): RestoreStoragePressureMessageResult['removed'] | null {
  const removed = readExactOwnDataRecord(value, [
    'expiredScreenshots',
    'orphanScreenshots',
    'expiredDrafts',
    'excessDrafts',
    'newlyOrphanedScreenshots'
  ]);
  return removed !== null &&
    isNonNegativeInteger(removed.expiredScreenshots) &&
    isNonNegativeInteger(removed.orphanScreenshots) &&
    isNonNegativeInteger(removed.expiredDrafts) &&
    isNonNegativeInteger(removed.excessDrafts) &&
    isNonNegativeInteger(removed.newlyOrphanedScreenshots)
    ? {
        expiredScreenshots: removed.expiredScreenshots,
        orphanScreenshots: removed.orphanScreenshots,
        expiredDrafts: removed.expiredDrafts,
        excessDrafts: removed.excessDrafts,
        newlyOrphanedScreenshots: removed.newlyOrphanedScreenshots
      }
    : null;
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeFiniteNumber(value: RuntimePropertyValue): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isBoundedOperationId(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
