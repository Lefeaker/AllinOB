import type { RestoreStoragePressureMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import type { StorageEstimateService, StorageEstimateSnapshot } from './storageEstimateService';

export interface RestoreStoragePressureRemovedCounts {
  expiredScreenshots: number;
  orphanScreenshots: number;
  expiredDrafts: number;
  excessDrafts: number;
  newlyOrphanedScreenshots: number;
}

export interface RestoreStoragePressureResult extends RestoreStoragePressureMessageResult {
  initialEstimate: StorageEstimateSnapshot;
  finalEstimate: StorageEstimateSnapshot;
  removed: RestoreStoragePressureRemovedCounts;
}

export function hasUsableStorageEstimate(
  snapshot: StorageEstimateSnapshot
): snapshot is StorageEstimateSnapshot & { usage: number; quota: number; available: number } {
  return (
    snapshot.supported &&
    typeof snapshot.usage === 'number' &&
    Number.isFinite(snapshot.usage) &&
    snapshot.usage >= 0 &&
    typeof snapshot.quota === 'number' &&
    Number.isFinite(snapshot.quota) &&
    snapshot.quota > 0 &&
    typeof snapshot.available === 'number' &&
    Number.isFinite(snapshot.available) &&
    snapshot.available >= 0
  );
}

export async function readStorageEstimate(
  service: StorageEstimateService
): Promise<StorageEstimateSnapshot> {
  try {
    return await service.getSnapshot();
  } catch {
    return { usage: null, quota: null, available: null, supported: true };
  }
}

export function createEmptyRemovedCounts(): RestoreStoragePressureRemovedCounts {
  return {
    expiredScreenshots: 0,
    orphanScreenshots: 0,
    expiredDrafts: 0,
    excessDrafts: 0,
    newlyOrphanedScreenshots: 0
  };
}

export function createRestoreStoragePressureResult(
  triggered: boolean,
  reason: RestoreStoragePressureResult['reason'],
  initialEstimate: StorageEstimateSnapshot,
  finalEstimate: StorageEstimateSnapshot,
  removed: RestoreStoragePressureRemovedCounts
): RestoreStoragePressureResult {
  return { triggered, reason, initialEstimate, finalEstimate, removed: { ...removed } };
}
