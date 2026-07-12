import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoScreenshotCacheBlobDeletionStore } from '../../content/video/videoScreenshotCacheStore';
import { isVideoScreenshotCacheStorageKey } from '../../content/video/videoScreenshotCacheTypes';
import type { RestoreStorageOperationQueue } from './restoreStorageOperationQueue';
import { pruneRestoreStorageLeases } from './restoreStorageLeaseMaintenance';
import { readSessionDraftJournalInventory } from './sessionDraftSaveJournalMaintenance';
import { buildRestoreStorageProtectionInventory } from './restoreStorageProtectionInventory';

export interface RestoreStorageScreenshotDeletionResult {
  deletedKeys: string[];
  protectedKeys: string[];
  rejectedKeys: string[];
}

export interface RestoreStorageScreenshotDeletionOwner {
  deleteCandidates(keys: readonly string[]): Promise<RestoreStorageScreenshotDeletionResult>;
}

export type RestoreStorageScreenshotDeletionExecutor = (
  keys: readonly string[]
) => Promise<RestoreStorageScreenshotDeletionResult>;

export function createRestoreStorageScreenshotDeletionOwner(dependencies: {
  local: Pick<StorageAreaService, 'get' | 'getAll' | 'set' | 'remove'>;
  screenshots: Pick<VideoScreenshotCacheBlobDeletionStore, 'deleteMany'>;
  operationQueue: RestoreStorageOperationQueue;
  getCurrentEpoch(): number | Promise<number>;
  now?: () => number;
}): {
  queuedOwner: RestoreStorageScreenshotDeletionOwner;
  withinOperationExecutor: RestoreStorageScreenshotDeletionExecutor;
} {
  const execute = async (keys: readonly string[]) => {
    const candidates = [...new Set(keys)].sort();
    const rejectedKeys = candidates.filter((key) => !isVideoScreenshotCacheStorageKey(key));
    const validCandidates = candidates.filter(isVideoScreenshotCacheStorageKey);
    const now = dependencies.now?.() ?? Date.now();
    const currentEpoch = await dependencies.getCurrentEpoch();

    await pruneRestoreStorageLeases(dependencies.local, now, currentEpoch);
    await readSessionDraftJournalInventory(dependencies.local, now);
    const finalInventory = await buildRestoreStorageProtectionInventory(dependencies.local, {
      now,
      currentEpoch
    });
    const protectedSet = new Set(finalInventory.screenshotKeys);
    const protectedKeys = validCandidates.filter((key) => protectedSet.has(key));
    const deletedKeys = validCandidates.filter((key) => !protectedSet.has(key));
    if (deletedKeys.length > 0) await dependencies.screenshots.deleteMany(deletedKeys);
    return { deletedKeys, protectedKeys, rejectedKeys };
  };
  return {
    queuedOwner: {
      deleteCandidates(keys) {
        return dependencies.operationQueue.enqueue(() => execute(keys));
      }
    },
    withinOperationExecutor: execute
  };
}
