import type {
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobObservationStore
} from '../../content/video/videoScreenshotCacheStore';
import type { RestoreStoragePressureRemovedCounts } from './restoreStoragePressureResult';
import { sortScreenshotMetadataOldestFirst } from './restoreStoragePressureSelectors';

type ScreenshotCounter = keyof Pick<
  RestoreStoragePressureRemovedCounts,
  'expiredScreenshots' | 'orphanScreenshots' | 'newlyOrphanedScreenshots'
>;

export function createRestoreStoragePressureScreenshotCleanup(dependencies: {
  screenshots: Pick<VideoScreenshotCacheBlobObservationStore, 'listAllMetadata'>;
  deleteCandidates(keys: readonly string[]): Promise<{ deletedKeys: string[] }>;
  removed: RestoreStoragePressureRemovedCounts;
  refresh(): Promise<boolean>;
}) {
  return {
    async observe(): Promise<{
      entries: VideoScreenshotCacheBlobMetadata[];
      targetReached: boolean;
    }> {
      const observation = await dependencies.screenshots.listAllMetadata();
      if (observation.invalidKeys.length === 0) {
        return { entries: observation.entries, targetReached: false };
      }
      const deletion = await dependencies.deleteCandidates(
        [...new Set(observation.invalidKeys)].sort()
      );
      dependencies.removed.orphanScreenshots += deletion.deletedKeys.length;
      return {
        entries: observation.entries,
        targetReached: deletion.deletedKeys.length > 0 && (await dependencies.refresh())
      };
    },
    async deleteMetadata(
      candidates: readonly VideoScreenshotCacheBlobMetadata[],
      counter: ScreenshotCounter
    ): Promise<boolean> {
      for (const entry of sortScreenshotMetadataOldestFirst(candidates)) {
        const deletion = await dependencies.deleteCandidates([entry.key]);
        dependencies.removed[counter] += deletion.deletedKeys.length;
        if (deletion.deletedKeys.length > 0 && (await dependencies.refresh())) return true;
      }
      return false;
    }
  };
}
