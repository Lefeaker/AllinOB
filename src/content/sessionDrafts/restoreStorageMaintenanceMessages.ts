export type RestoreStorageMaintenanceOperation =
  | 'clearAllRestoreData'
  | 'inspectStoragePressure'
  | 'runStoragePressureCleanup';

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

export interface RestoreStorageMaintenanceMessage {
  type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
  operation: RestoreStorageMaintenanceOperation;
}

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

export function isRestoreStorageMaintenanceMessage(value: {
  type: string;
  operation: string;
}): value is RestoreStorageMaintenanceMessage {
  return (
    value.type === 'AIIOB_VIDEO_SCREENSHOT_CACHE' &&
    isRestoreStorageMaintenanceOperation(value.operation)
  );
}
import type { RuntimePropertyValue } from '../../shared/guards/object';
