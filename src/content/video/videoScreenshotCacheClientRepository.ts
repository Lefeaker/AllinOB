import type { MessagingService } from '../../platform/interfaces/messaging';
import type { VideoCaptureScreenshot } from './types';
import type {
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheSaveInput,
  VideoScreenshotCacheSaveResult
} from './videoScreenshotCacheRepository';
import {
  VIDEO_SCREENSHOT_CACHE_MESSAGE,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from './videoScreenshotCacheMessages';
import type { VideoScreenshotCacheRef } from './videoScreenshotCacheTypes';
import type { SessionDraftOperationContext } from '../sessionDrafts/sessionDraftRepositoryMessages';
import { SessionDraftTransportUnknownError } from '../sessionDrafts/sessionDraftWriteOperation';
import {
  normalizeVideoScreenshotCacheResponse,
  type VideoScreenshotCacheClientOperation
} from './videoScreenshotCacheResponses';
import {
  deserializeScreenshotFromCache,
  matchesScreenshotLoadRequest,
  matchesScreenshotSaveRequest,
  serializeScreenshotForCache
} from './videoScreenshotCacheClientCodecs';

export interface VideoScreenshotCacheClientRepositoryOptions {
  messaging: Pick<MessagingService, 'send'>;
}

export interface VideoScreenshotCacheProvisionalRepository extends VideoScreenshotCacheRepository {
  saveProvisional(
    input: VideoScreenshotCacheSaveInput,
    context: SessionDraftOperationContext
  ): Promise<VideoScreenshotCacheSaveResult>;
}

function errorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function messageFailure(error: Error | string): VideoScreenshotCacheSaveResult {
  return {
    status: 'skipped',
    reason: 'serialize-failed',
    error: errorMessage(error)
  };
}

export function createVideoScreenshotCacheClientRepository({
  messaging
}: VideoScreenshotCacheClientRepositoryOptions): VideoScreenshotCacheProvisionalRepository {
  async function send(
    message: VideoScreenshotCacheMessage & { operation: VideoScreenshotCacheClientOperation }
  ): Promise<VideoScreenshotCacheResponse> {
    const response = await messaging.send<VideoScreenshotCacheResponse>(message);
    const normalized = normalizeVideoScreenshotCacheResponse(response, message.operation);
    if (!normalized) {
      return {
        success: false,
        error: 'VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE'
      };
    }
    return normalized;
  }

  async function sendMutation(
    message: VideoScreenshotCacheMessage & { operation: VideoScreenshotCacheClientOperation }
  ): Promise<void> {
    const response = await send(message);
    if (!response.success) {
      throw new Error(response.error);
    }
    if (response.operation !== message.operation) {
      throw new Error(`Unexpected ${message.operation} response.`);
    }
  }

  async function save(
    input: VideoScreenshotCacheSaveInput,
    operationContext?: SessionDraftOperationContext
  ): Promise<VideoScreenshotCacheSaveResult> {
    let screenshot;
    try {
      screenshot = await serializeScreenshotForCache(input.screenshot);
    } catch (error) {
      return messageFailure(error instanceof Error ? error : String(error));
    }
    if (!screenshot) {
      return {
        status: 'skipped',
        reason: 'missing-blob-content'
      };
    }

    try {
      const response = await send({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'save',
        input: {
          pageKey: input.pageKey,
          captureId: input.captureId,
          ...(operationContext ? { operationContext } : {}),
          screenshot
        }
      });

      if (response.success && response.operation === 'save') {
        if (
          response.result.status === 'saved' &&
          !matchesScreenshotSaveRequest(response.result.ref, input, screenshot)
        ) {
          return messageFailure('VIDEO_SCREENSHOT_CACHE_INVALID_RESPONSE');
        }
        return response.result;
      }
      return messageFailure(response.success ? 'Unexpected save response.' : response.error);
    } catch (error) {
      if (operationContext) {
        throw new SessionDraftTransportUnknownError(
          error instanceof Error ? error.message : String(error)
        );
      }
      return messageFailure(error instanceof Error ? error : String(error));
    }
  }

  return {
    save,
    saveProvisional: (input, context) => save(input, context),

    async load(ref: VideoScreenshotCacheRef): Promise<VideoCaptureScreenshot | null> {
      try {
        const response = await send({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'load',
          ref
        });
        if (!response.success || response.operation !== 'load' || response.status !== 'loaded') {
          return null;
        }
        if (!matchesScreenshotLoadRequest(response.screenshot, ref)) return null;
        return deserializeScreenshotFromCache(response.screenshot);
      } catch {
        return null;
      }
    },

    remove(ref: VideoScreenshotCacheRef): Promise<void> {
      return sendMutation({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'remove',
        ref
      });
    },

    removeMany(refs: readonly VideoScreenshotCacheRef[]): Promise<void> {
      return sendMutation({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'removeMany',
        refs: [...refs]
      });
    },

    pruneExpired(): Promise<void> {
      return sendMutation({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'pruneExpired'
      });
    },

    pruneToLimits(): Promise<void> {
      return sendMutation({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'pruneToLimits'
      });
    }
  };
}
