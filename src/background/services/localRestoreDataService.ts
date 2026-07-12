import type { MessagingService } from '../../platform/interfaces/messaging';
import {
  LOCAL_RESTORE_DATA_CLEAR_FAILED,
  normalizeRestoreStorageMaintenanceResponse,
  type LocalRestoreDataClearMessageResult
} from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../content/video/videoScreenshotCacheMessages';

export { LOCAL_RESTORE_DATA_CLEAR_FAILED } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';

export interface LocalRestoreDataClearResult extends LocalRestoreDataClearMessageResult {}

export interface LocalRestoreDataController {
  clearAll(): Promise<LocalRestoreDataClearResult>;
}

export function createLocalRestoreDataClient(
  messaging: Pick<MessagingService, 'send'>,
  options: { createOperationId?: () => string } = {}
): LocalRestoreDataController {
  let pendingOperationId: string | null = null;
  let inFlight: Promise<LocalRestoreDataClearResult> | null = null;

  async function execute(): Promise<LocalRestoreDataClearResult> {
    pendingOperationId ??= options.createOperationId?.() ?? globalThis.crypto.randomUUID();
    const response = await messaging.send({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: pendingOperationId
    });
    const normalized = normalizeRestoreStorageMaintenanceResponse(response, 'clearAllRestoreData');
    if (!normalized || normalized.operation !== 'clearAllRestoreData') {
      throw new Error(LOCAL_RESTORE_DATA_CLEAR_FAILED);
    }
    pendingOperationId = null;
    return normalized.result;
  }

  return {
    clearAll() {
      if (inFlight) return inFlight;
      const run = execute();
      inFlight = run;
      void run.then(
        () => {
          if (inFlight === run) inFlight = null;
        },
        () => {
          if (inFlight === run) inFlight = null;
        }
      );
      return run;
    }
  };
}
