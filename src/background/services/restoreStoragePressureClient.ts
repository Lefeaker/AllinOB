import type { MessagingService } from '../../platform/interfaces/messaging';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '../../content/video/videoScreenshotCacheMessages';
import type { RestoreStoragePressureMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import { normalizeRestoreStorageMaintenanceResponse } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';

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
    const normalized = normalizeRestoreStorageMaintenanceResponse(response, operation);
    if (!normalized || normalized.operation === 'clearAllRestoreData') {
      throw new Error(RESTORE_STORAGE_PRESSURE_FAILED);
    }
    return normalized.result;
  };
  return {
    inspect: () => send('inspectStoragePressure'),
    runCleanup: () => send('runStoragePressureCleanup')
  };
}
