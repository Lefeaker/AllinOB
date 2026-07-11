import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { RestoreStoragePressureMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import { getSessionDraftEffectiveExpiresAt } from '../../content/sessionDrafts/sessionDraftRetentionPolicy';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import {
  readSessionDraftReferenceIndex,
  removeSessionDraftStorageKeys
} from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type { VideoScreenshotCacheBlobMetadata } from '../../content/video/videoScreenshotCacheStore';
import type { StorageEstimateService, StorageEstimateSnapshot } from './storageEstimateService';
import {
  selectExcessDraftKeys,
  sortDraftsOldestFirst,
  sortScreenshotMetadataOldestFirst
} from './restoreStoragePressureSelectors';
export {
  createRestoreStoragePressureClient,
  RESTORE_STORAGE_PRESSURE_FAILED
} from './restoreStoragePressureClient';
export const PRIVATE_STORAGE_PRESSURE_POLICY = {
  triggerRatio: 0.9,
  targetRatio: 0.8,
  triggerAvailableFraction: 0.15,
  targetAvailableFraction: 0.2,
  absoluteTargetBytes: 512 * 1024 * 1024
};

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

export interface RestoreStoragePressureServiceDependencies {
  drafts: Pick<StorageAreaService, 'getAll' | 'remove' | 'set'>;
  screenshots: {
    listAllMetadata(): Promise<VideoScreenshotCacheBlobMetadata[]>;
    deleteMany(keys: readonly string[]): Promise<void>;
  };
  estimate: StorageEstimateService;
  getStoragePolicy(): SessionDraftStoragePolicy;
  now?: () => number;
}

export interface RestoreStoragePressureService {
  inspect(): Promise<RestoreStoragePressureResult>;
  runCleanup(): Promise<RestoreStoragePressureResult>;
}

export function isStoragePressureTriggered(snapshot: StorageEstimateSnapshot): boolean {
  if (!hasUsableEstimate(snapshot)) return false;
  return (
    snapshot.usage / snapshot.quota >= PRIVATE_STORAGE_PRESSURE_POLICY.triggerRatio ||
    snapshot.available <
      Math.min(
        PRIVATE_STORAGE_PRESSURE_POLICY.absoluteTargetBytes,
        snapshot.quota * PRIVATE_STORAGE_PRESSURE_POLICY.triggerAvailableFraction
      )
  );
}

export function isStoragePressureTargetReached(snapshot: StorageEstimateSnapshot): boolean {
  if (!hasUsableEstimate(snapshot)) return false;
  return (
    snapshot.usage / snapshot.quota <= PRIVATE_STORAGE_PRESSURE_POLICY.targetRatio ||
    snapshot.available >=
      Math.min(
        PRIVATE_STORAGE_PRESSURE_POLICY.absoluteTargetBytes,
        snapshot.quota * PRIVATE_STORAGE_PRESSURE_POLICY.targetAvailableFraction
      )
  );
}

export function createRestoreStoragePressureService(
  dependencies: RestoreStoragePressureServiceDependencies
): RestoreStoragePressureService {
  const now = dependencies.now ?? (() => Date.now());
  return {
    async inspect() {
      const snapshot = await readEstimate(dependencies.estimate);
      return result(
        isStoragePressureTriggered(snapshot),
        !hasUsableEstimate(snapshot)
          ? 'estimate-unavailable'
          : isStoragePressureTriggered(snapshot)
            ? 'pressure-detected'
            : 'below-trigger',
        snapshot,
        snapshot,
        emptyRemovedCounts()
      );
    },
    async runCleanup() {
      const removed = emptyRemovedCounts();
      const initialEstimate = await readEstimate(dependencies.estimate);
      if (!hasUsableEstimate(initialEstimate)) {
        return result(false, 'estimate-unavailable', initialEstimate, initialEstimate, removed);
      }
      if (!isStoragePressureTriggered(initialEstimate)) {
        return result(false, 'below-trigger', initialEstimate, initialEstimate, removed);
      }

      let finalEstimate: StorageEstimateSnapshot = initialEstimate;
      const refresh = async (): Promise<boolean> => {
        finalEstimate = await readEstimate(dependencies.estimate);
        return !hasUsableEstimate(finalEstimate) || isStoragePressureTargetReached(finalEstimate);
      };
      let references = await readSessionDraftReferenceIndex(dependencies.drafts);
      const deleteScreenshots = async (
        candidates: readonly VideoScreenshotCacheBlobMetadata[],
        counter: keyof Pick<
          RestoreStoragePressureRemovedCounts,
          'expiredScreenshots' | 'orphanScreenshots' | 'newlyOrphanedScreenshots'
        >
      ): Promise<boolean> => {
        for (const entry of sortScreenshotMetadataOldestFirst(candidates)) {
          await dependencies.screenshots.deleteMany([entry.key]);
          removed[counter] += 1;
          if (await refresh()) return true;
        }
        return false;
      };

      const firstMetadata = await dependencies.screenshots.listAllMetadata();
      if (
        await deleteScreenshots(
          firstMetadata.filter(
            (entry) =>
              entry.expiresAt <= now() && !references.referencedScreenshotKeys.has(entry.key)
          ),
          'expiredScreenshots'
        )
      ) {
        return finish(initialEstimate, finalEstimate, removed);
      }

      const orphanMetadata = await dependencies.screenshots.listAllMetadata();
      if (
        await deleteScreenshots(
          orphanMetadata.filter((entry) => !references.referencedScreenshotKeys.has(entry.key)),
          'orphanScreenshots'
        )
      ) {
        return finish(initialEstimate, finalEstimate, removed);
      }

      const policy = dependencies.getStoragePolicy();
      const expiredDraftKeys = sortDraftsOldestFirst(references.drafts)
        .filter(
          ({ envelope }) =>
            envelope.status !== 'active' &&
            getSessionDraftEffectiveExpiresAt(envelope, policy.retentionPolicy) <= now()
        )
        .map(({ key }) => key);
      if (expiredDraftKeys.length > 0) {
        await removeSessionDraftStorageKeys(dependencies.drafts, expiredDraftKeys);
        removed.expiredDrafts = expiredDraftKeys.length;
        references = await readSessionDraftReferenceIndex(dependencies.drafts);
        if (await refresh()) return finish(initialEstimate, finalEstimate, removed);
      }

      const excessDraftKeys = selectExcessDraftKeys(references, policy);
      if (excessDraftKeys.length > 0) {
        await removeSessionDraftStorageKeys(dependencies.drafts, excessDraftKeys);
        removed.excessDrafts = excessDraftKeys.length;
        references = await readSessionDraftReferenceIndex(dependencies.drafts);
        if (await refresh()) return finish(initialEstimate, finalEstimate, removed);
      }

      const finalMetadata = await dependencies.screenshots.listAllMetadata();
      if (
        await deleteScreenshots(
          finalMetadata.filter((entry) => !references.referencedScreenshotKeys.has(entry.key)),
          'newlyOrphanedScreenshots'
        )
      ) {
        return finish(initialEstimate, finalEstimate, removed);
      }
      return result(true, 'cleanup-exhausted', initialEstimate, finalEstimate, removed);
    }
  };
}

function hasUsableEstimate(
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

async function readEstimate(service: StorageEstimateService): Promise<StorageEstimateSnapshot> {
  try {
    return await service.getSnapshot();
  } catch {
    return { usage: null, quota: null, available: null, supported: true };
  }
}

function emptyRemovedCounts(): RestoreStoragePressureRemovedCounts {
  return {
    expiredScreenshots: 0,
    orphanScreenshots: 0,
    expiredDrafts: 0,
    excessDrafts: 0,
    newlyOrphanedScreenshots: 0
  };
}

function finish(
  initialEstimate: StorageEstimateSnapshot,
  finalEstimate: StorageEstimateSnapshot,
  removed: RestoreStoragePressureRemovedCounts
): RestoreStoragePressureResult {
  return result(
    true,
    hasUsableEstimate(finalEstimate) ? 'target-reached' : 'estimate-unavailable',
    initialEstimate,
    finalEstimate,
    removed
  );
}

function result(
  triggered: boolean,
  reason: RestoreStoragePressureResult['reason'],
  initialEstimate: StorageEstimateSnapshot,
  finalEstimate: StorageEstimateSnapshot,
  removed: RestoreStoragePressureRemovedCounts
): RestoreStoragePressureResult {
  return { triggered, reason, initialEstimate, finalEstimate, removed: { ...removed } };
}
