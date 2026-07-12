import { LOCAL_RESTORE_DATA_CLEAR_FAILED } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import type { VideoScreenshotCacheResponse } from '../../content/video/videoScreenshotCacheMessages';

export function toVideoScreenshotCacheMessageError(
  error: Error | string
): VideoScreenshotCacheResponse {
  return {
    success: false,
    error: error instanceof Error ? error.message : error
  };
}

export function toVideoScreenshotCacheClearMessageError(
  error: Error | string
): VideoScreenshotCacheResponse {
  const message = error instanceof Error ? error.message : error;
  return {
    success: false,
    error:
      message === 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
        ? message
        : LOCAL_RESTORE_DATA_CLEAR_FAILED
  };
}
