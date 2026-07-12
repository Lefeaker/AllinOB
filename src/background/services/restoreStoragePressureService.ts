import type { StorageAreaService } from '../../platform/interfaces/storage';
import { getSessionDraftEffectiveExpiresAt } from '../../content/sessionDrafts/sessionDraftRetentionPolicy';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import { readSessionDraftReferenceIndex } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type { VideoScreenshotCacheBlobObservationStore } from '../../content/video/videoScreenshotCacheStore';
import type { StorageEstimateService, StorageEstimateSnapshot } from './storageEstimateService';
import { selectExcessDraftKeys, sortDraftsOldestFirst } from './restoreStoragePressureSelectors';
import {
  createEmptyRemovedCounts,
  createRestoreStoragePressureResult,
  hasUsableStorageEstimate,
  readStorageEstimate,
  type RestoreStoragePressureRemovedCounts,
  type RestoreStoragePressureResult
} from './restoreStoragePressureResult';
import { createRestoreStoragePressureScreenshotCleanup } from './restoreStoragePressureScreenshotCleanup';
export {
  createRestoreStoragePressureClient,
  RESTORE_STORAGE_PRESSURE_FAILED
} from './restoreStoragePressureClient';
export const PRIVATE_STORAGE_PRESSURE_POLICY = {
  triggerRatio: 0.9,
  targetRatio: 0.8,
  triggerAvailableFraction: 0.15,
  targetAvailableFraction: 0.2,
  absoluteTargetBytes: 536_870_912
} as const;

export type {
  RestoreStoragePressureRemovedCounts,
  RestoreStoragePressureResult
} from './restoreStoragePressureResult';

export interface RestoreStoragePressureServiceDependencies {
  drafts: Pick<StorageAreaService, 'getAll' | 'remove' | 'set'>;
  screenshots: Pick<VideoScreenshotCacheBlobObservationStore, 'listAllMetadata'>;
  deleteScreenshotCandidates(keys: readonly string[]): Promise<{ deletedKeys: string[] }>;
  deleteDraftCandidates(
    keys: readonly string[],
    cause: 'pressure-expired' | 'pressure-excess'
  ): Promise<{ revisions: Array<{ draftKey: string; revision: number }> }>;
  estimate: StorageEstimateService;
  getStoragePolicy(): SessionDraftStoragePolicy;
  now?: () => number;
}

export interface RestoreStoragePressureService {
  inspect(): Promise<RestoreStoragePressureResult>;
  runCleanup(): Promise<RestoreStoragePressureResult>;
}

export function isStoragePressureTriggered(snapshot: StorageEstimateSnapshot): boolean {
  if (!hasUsableStorageEstimate(snapshot)) return false;
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
  if (!hasUsableStorageEstimate(snapshot)) return false;
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
      const snapshot = await readStorageEstimate(dependencies.estimate);
      return createRestoreStoragePressureResult(
        isStoragePressureTriggered(snapshot),
        !hasUsableStorageEstimate(snapshot)
          ? 'estimate-unavailable'
          : isStoragePressureTriggered(snapshot)
            ? 'pressure-detected'
            : 'below-trigger',
        snapshot,
        snapshot,
        createEmptyRemovedCounts()
      );
    },
    async runCleanup() {
      const removed = createEmptyRemovedCounts();
      const initialEstimate = await readStorageEstimate(dependencies.estimate);
      if (!hasUsableStorageEstimate(initialEstimate)) {
        return createRestoreStoragePressureResult(
          false,
          'estimate-unavailable',
          initialEstimate,
          initialEstimate,
          removed
        );
      }
      if (!isStoragePressureTriggered(initialEstimate)) {
        return createRestoreStoragePressureResult(
          false,
          'below-trigger',
          initialEstimate,
          initialEstimate,
          removed
        );
      }

      let finalEstimate: StorageEstimateSnapshot = initialEstimate;
      const refresh = async (): Promise<boolean> => {
        finalEstimate = await readStorageEstimate(dependencies.estimate);
        return (
          !hasUsableStorageEstimate(finalEstimate) || isStoragePressureTargetReached(finalEstimate)
        );
      };
      let references = await readSessionDraftReferenceIndex(dependencies.drafts);
      const screenshots = createRestoreStoragePressureScreenshotCleanup({
        screenshots: dependencies.screenshots,
        deleteCandidates: (keys) => dependencies.deleteScreenshotCandidates(keys),
        removed,
        refresh
      });

      const firstObservation = await screenshots.observe();
      if (firstObservation.targetReached) {
        return finish(initialEstimate, finalEstimate, removed);
      }
      const firstMetadata = firstObservation.entries;
      if (
        await screenshots.deleteMetadata(
          firstMetadata.filter(
            (entry) =>
              entry.expiresAt <= now() && !references.referencedScreenshotKeys.has(entry.key)
          ),
          'expiredScreenshots'
        )
      ) {
        return finish(initialEstimate, finalEstimate, removed);
      }

      const orphanObservation = await screenshots.observe();
      if (orphanObservation.targetReached) {
        return finish(initialEstimate, finalEstimate, removed);
      }
      const orphanMetadata = orphanObservation.entries;
      if (
        await screenshots.deleteMetadata(
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
        const deletion = await dependencies.deleteDraftCandidates(
          expiredDraftKeys,
          'pressure-expired'
        );
        removed.expiredDrafts = deletion.revisions.length;
        references = await readSessionDraftReferenceIndex(dependencies.drafts);
        if (await refresh()) return finish(initialEstimate, finalEstimate, removed);
      }

      const excessDraftKeys = selectExcessDraftKeys(references, policy);
      if (excessDraftKeys.length > 0) {
        const deletion = await dependencies.deleteDraftCandidates(
          excessDraftKeys,
          'pressure-excess'
        );
        removed.excessDrafts = deletion.revisions.length;
        references = await readSessionDraftReferenceIndex(dependencies.drafts);
        if (await refresh()) return finish(initialEstimate, finalEstimate, removed);
      }

      const finalObservation = await screenshots.observe();
      if (finalObservation.targetReached) {
        return finish(initialEstimate, finalEstimate, removed);
      }
      const finalMetadata = finalObservation.entries;
      if (
        await screenshots.deleteMetadata(
          finalMetadata.filter((entry) => !references.referencedScreenshotKeys.has(entry.key)),
          'newlyOrphanedScreenshots'
        )
      ) {
        return finish(initialEstimate, finalEstimate, removed);
      }
      return createRestoreStoragePressureResult(
        true,
        'cleanup-exhausted',
        initialEstimate,
        finalEstimate,
        removed
      );
    }
  };
}

function finish(
  initialEstimate: StorageEstimateSnapshot,
  finalEstimate: StorageEstimateSnapshot,
  removed: RestoreStoragePressureRemovedCounts
): RestoreStoragePressureResult {
  return createRestoreStoragePressureResult(
    true,
    hasUsableStorageEstimate(finalEstimate) ? 'target-reached' : 'estimate-unavailable',
    initialEstimate,
    finalEstimate,
    removed
  );
}
