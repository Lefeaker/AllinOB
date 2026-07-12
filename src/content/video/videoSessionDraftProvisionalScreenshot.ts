import { createSessionDraftPageKey, type VideoSessionDraftEnvelope } from '../sessionDrafts';
import {
  isSessionDraftAcknowledgedError,
  type VersionedSessionDraftRepository
} from '../sessionDrafts/sessionDraftClientRepository';
import { clearTimestampScreenshotRef, setTimestampScreenshotRef } from './screenshotIntent';
import { createVideoSessionDraftStorageKey } from './sessionDrafts';
import type { VideoScreenshotCacheProvisionalRepository } from './videoScreenshotCacheClientRepository';
import type { VideoScreenshotCacheSaveResult } from './videoScreenshotCacheRepository';
import type { VideoCaptureScreenshot, VideoTimestampCapture } from './types';

interface PersistPreparedVideoDraftScreenshotOptions {
  repository: VersionedSessionDraftRepository;
  saveProvisional?: VideoScreenshotCacheProvisionalRepository['saveProvisional'] | undefined;
  activeDraftPageUrl: string;
  draftId: string;
  capture: VideoTimestampCapture;
  screenshot: VideoCaptureScreenshot;
  buildEnvelope(): VideoSessionDraftEnvelope | null;
}

export async function persistPreparedVideoDraftScreenshot(
  options: PersistPreparedVideoDraftScreenshotOptions
): Promise<VideoScreenshotCacheSaveResult> {
  const saveProvisional = options.saveProvisional;
  if (!saveProvisional) {
    return {
      status: 'skipped',
      reason: 'serialize-failed',
      error: 'VIDEO_SCREENSHOT_CACHE_REPOSITORY_UNAVAILABLE'
    };
  }
  const draftKey = createVideoSessionDraftStorageKey(options.activeDraftPageUrl, options.draftId);
  let savedResult: Extract<VideoScreenshotCacheSaveResult, { status: 'saved' }> | null = null;
  let envelope: VideoSessionDraftEnvelope | null = null;
  const execute = () =>
    options.repository.runWriteOperation(draftKey, async (operation) => {
      if (!savedResult) {
        const result = await saveProvisional(
          {
            pageKey: createSessionDraftPageKey('video', options.activeDraftPageUrl),
            captureId: options.capture.id,
            screenshot: options.screenshot
          },
          operation.context
        );
        if (result.status !== 'saved' || options.capture.screenshot !== options.screenshot) {
          return result;
        }
        savedResult = result;
        setTimestampScreenshotRef(options.capture, result.ref);
        envelope = options.buildEnvelope();
      }
      if (envelope) await operation.commit(envelope);
      return savedResult;
    });
  try {
    return await execute();
  } catch (error) {
    if (isSessionDraftAcknowledgedError(error)) {
      rollbackProvisionalRef(options.capture, savedResult);
      throw error;
    }
    try {
      return await execute();
    } catch (retryError) {
      if (isSessionDraftAcknowledgedError(retryError)) {
        rollbackProvisionalRef(options.capture, savedResult);
      }
      throw retryError;
    }
  }
}

function rollbackProvisionalRef(
  capture: VideoTimestampCapture,
  result: Extract<VideoScreenshotCacheSaveResult, { status: 'saved' }> | null
): void {
  if (result && capture.screenshotRef?.key === result.ref.key) {
    clearTimestampScreenshotRef(capture);
  }
}
