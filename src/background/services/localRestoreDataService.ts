import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { MessagingService } from '../../platform/interfaces/messaging';
import { isObjectRecord } from '../../shared/guards/object';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import {
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from '../../content/sessionDrafts/sessionDraftKeys';
import {
  isVideoScreenshotCacheStorageKey,
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY
} from '../../content/video/videoScreenshotCacheTypes';
import { type LocalRestoreDataClearMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../content/video/videoScreenshotCacheMessages';

export const LOCAL_RESTORE_DATA_CLEAR_FAILED = 'LOCAL_RESTORE_DATA_CLEAR_FAILED';

export interface LocalRestoreDataClearResult extends LocalRestoreDataClearMessageResult {}

export interface LocalRestoreDataController {
  clearAll(): Promise<LocalRestoreDataClearResult>;
}

export interface LocalRestoreDataServiceDependencies {
  local: Pick<StorageAreaService, 'getAll' | 'remove'>;
  screenshots: { deleteAll(): Promise<number> };
}

export function createLocalRestoreDataClient(
  messaging: Pick<MessagingService, 'send'>
): LocalRestoreDataController {
  return {
    async clearAll() {
      const response = await messaging.send({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'clearAllRestoreData'
      });
      if (
        !isObjectRecord(response) ||
        response.success !== true ||
        response.operation !== 'clearAllRestoreData' ||
        !isLocalRestoreDataClearResult(response.result)
      ) {
        throw new Error(LOCAL_RESTORE_DATA_CLEAR_FAILED);
      }
      return response.result;
    }
  };
}

export function createLocalRestoreDataService(
  dependencies: LocalRestoreDataServiceDependencies
): LocalRestoreDataController {
  return {
    async clearAll() {
      let draftKeys: string[] = [];
      let legacyScreenshotKeys: string[] = [];
      let enumerationFailed = false;
      try {
        const values = await dependencies.local.getAll();
        const keys = Object.keys(values);
        draftKeys = keys.filter(
          (key) => key === SESSION_DRAFT_INDEX_KEY || isSessionDraftStorageKey(key)
        );
        legacyScreenshotKeys = keys.filter(
          (key) => key === VIDEO_SCREENSHOT_CACHE_INDEX_KEY || isVideoScreenshotCacheStorageKey(key)
        );
      } catch {
        enumerationFailed = true;
      }

      const localKeys = Array.from(new Set([...draftKeys, ...legacyScreenshotKeys])).sort();
      const [localResult, screenshotResult] = await Promise.allSettled([
        enumerationFailed || localKeys.length === 0
          ? Promise.resolve()
          : dependencies.local.remove(localKeys),
        dependencies.screenshots.deleteAll()
      ]);

      if (
        enumerationFailed ||
        localResult.status === 'rejected' ||
        screenshotResult.status === 'rejected'
      ) {
        throw new Error(LOCAL_RESTORE_DATA_CLEAR_FAILED);
      }

      return {
        draftKeysRemoved: draftKeys.length,
        screenshotEntriesRemoved: screenshotResult.value,
        legacyScreenshotKeysRemoved: legacyScreenshotKeys.length
      };
    }
  };
}

function isLocalRestoreDataClearResult(
  value: RuntimePropertyValue
): value is LocalRestoreDataClearResult {
  return (
    isObjectRecord(value) &&
    isNonNegativeInteger(value.draftKeysRemoved) &&
    isNonNegativeInteger(value.screenshotEntriesRemoved) &&
    isNonNegativeInteger(value.legacyScreenshotKeysRemoved)
  );
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
