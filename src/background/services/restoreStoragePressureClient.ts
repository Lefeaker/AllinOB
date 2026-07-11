import type { MessagingService } from '../../platform/interfaces/messaging';
import { isObjectRecord } from '../../shared/guards/object';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../content/video/videoScreenshotCacheMessages';
import type {
  RestoreStoragePressureMessageResult,
  StorageEstimateMessageSnapshot
} from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';

export const RESTORE_STORAGE_PRESSURE_FAILED = 'RESTORE_STORAGE_PRESSURE_FAILED';

export interface RestoreStoragePressureClient {
  inspect(): Promise<RestoreStoragePressureMessageResult>;
  runCleanup(): Promise<RestoreStoragePressureMessageResult>;
}

export function createRestoreStoragePressureClient(
  messaging: Pick<MessagingService, 'send'>
): RestoreStoragePressureClient {
  const send = async (
    operation: 'inspectStoragePressure' | 'runStoragePressureCleanup'
  ): Promise<RestoreStoragePressureMessageResult> => {
    const response = await messaging.send({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation
    });
    if (
      !isObjectRecord(response) ||
      response.success !== true ||
      response.operation !== operation ||
      !isRestoreStoragePressureResult(response.result)
    ) {
      throw new Error(RESTORE_STORAGE_PRESSURE_FAILED);
    }
    return response.result;
  };
  return {
    inspect: () => send('inspectStoragePressure'),
    runCleanup: () => send('runStoragePressureCleanup')
  };
}

function isRestoreStoragePressureResult(
  value: RuntimePropertyValue
): value is RestoreStoragePressureMessageResult {
  if (!isObjectRecord(value) || typeof value.triggered !== 'boolean') return false;
  if (!isRestoreStoragePressureReason(value.reason)) {
    return false;
  }
  return (
    isEstimateSnapshot(value.initialEstimate) &&
    isEstimateSnapshot(value.finalEstimate) &&
    isObjectRecord(value.removed) &&
    [
      value.removed.expiredScreenshots,
      value.removed.orphanScreenshots,
      value.removed.expiredDrafts,
      value.removed.excessDrafts,
      value.removed.newlyOrphanedScreenshots
    ].every(isNonNegativeInteger)
  );
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

function isEstimateSnapshot(value: RuntimePropertyValue): value is StorageEstimateMessageSnapshot {
  if (!isObjectRecord(value) || typeof value.supported !== 'boolean') return false;
  return ['usage', 'quota', 'available'].every((key) => {
    const current = value[key];
    return (
      current === null || (typeof current === 'number' && Number.isFinite(current) && current >= 0)
    );
  });
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
