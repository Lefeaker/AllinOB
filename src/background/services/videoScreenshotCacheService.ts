import {
  serializeBlobAttachmentContent,
  serializedAttachmentContentToBlob
} from '../../shared/attachments/clipAttachmentBinary';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  createVideoScreenshotCacheRepository,
  type VideoScreenshotCacheRepositoryOptions
} from '../../content/video/videoScreenshotCacheRepository';
import {
  normalizeVideoScreenshotCacheMessage,
  type SerializedVideoScreenshotCacheScreenshot,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from '../../content/video/videoScreenshotCacheMessages';
import type { VideoScreenshotCacheBlobStore } from '../../content/video/videoScreenshotCacheStore';
import type { VideoCaptureScreenshot } from '../../content/video/types';
import {
  createVideoScreenshotCacheIndexedDbStore,
  type VideoScreenshotCacheIndexedDbStoreOptions
} from './videoScreenshotCacheIndexedDbStore';

export interface BackgroundVideoScreenshotCacheStorage {
  local: StorageAreaService;
}

export interface BackgroundVideoScreenshotCacheHandlerDependencies {
  blobStore?: VideoScreenshotCacheBlobStore;
  indexedDb?: VideoScreenshotCacheIndexedDbStoreOptions['indexedDb'];
}

export type BackgroundVideoScreenshotCacheHandler = (
  message: unknown
) => Promise<VideoScreenshotCacheResponse | undefined>;

function errorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function toMessageError(error: Error | string): VideoScreenshotCacheResponse {
  return {
    success: false,
    error: errorMessage(error)
  };
}

function toSaveSkip(error: Error | string): VideoScreenshotCacheResponse {
  return {
    success: true,
    operation: 'save',
    result: {
      status: 'skipped',
      reason: 'serialize-failed',
      error: errorMessage(error)
    }
  };
}

function toLoadMissing(): VideoScreenshotCacheResponse {
  return {
    success: true,
    operation: 'load',
    status: 'missing'
  };
}

function deserializeScreenshot(
  screenshot: SerializedVideoScreenshotCacheScreenshot
): VideoCaptureScreenshot {
  const blob = serializedAttachmentContentToBlob(
    screenshot.content
      ? {
          kind: 'base64',
          binary: screenshot.content
        }
      : {
          kind: 'legacyDataUrl',
          dataUrl: screenshot.dataUrl ?? ''
        },
    screenshot.mimeType
  );

  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content: {
      kind: 'blob',
      blob,
      byteLength: blob.size
    }
  };
}

async function serializeScreenshot(
  screenshot: VideoCaptureScreenshot
): Promise<SerializedVideoScreenshotCacheScreenshot> {
  if (screenshot.content?.kind !== 'blob') {
    throw new Error('Screenshot cache load returned missing blob content.');
  }

  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content: await serializeBlobAttachmentContent(screenshot.content.blob)
  };
}

export function createBackgroundVideoScreenshotCacheHandler(
  storage: BackgroundVideoScreenshotCacheStorage,
  options: VideoScreenshotCacheRepositoryOptions = {},
  dependencies: BackgroundVideoScreenshotCacheHandlerDependencies = {}
): BackgroundVideoScreenshotCacheHandler {
  const repository = createVideoScreenshotCacheRepository(
    {
      blobStore:
        dependencies.blobStore ??
        createVideoScreenshotCacheIndexedDbStore({
          indexedDb: dependencies.indexedDb,
          maxContentBytes: options.maxContentBytes
        }),
      legacyArea: storage.local
    },
    options
  );
  let queue: Promise<void> = Promise.resolve();

  function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function handleSave(
    message: Extract<VideoScreenshotCacheMessage, { operation: 'save' }>
  ): Promise<VideoScreenshotCacheResponse> {
    let screenshot: VideoCaptureScreenshot;
    try {
      screenshot = deserializeScreenshot(message.input.screenshot);
    } catch (error) {
      return toSaveSkip(error instanceof Error ? error : String(error));
    }

    let result;
    try {
      result = await repository.save({
        pageKey: message.input.pageKey,
        captureId: message.input.captureId,
        screenshot
      });
    } catch (error) {
      return toSaveSkip(error instanceof Error ? error : String(error));
    }
    return {
      success: true,
      operation: 'save',
      result
    };
  }

  async function handleLoad(
    message: Extract<VideoScreenshotCacheMessage, { operation: 'load' }>
  ): Promise<VideoScreenshotCacheResponse> {
    let screenshot: VideoCaptureScreenshot | null;
    try {
      screenshot = await repository.load(message.ref);
    } catch {
      return toLoadMissing();
    }
    if (!screenshot) {
      return toLoadMissing();
    }

    try {
      return {
        success: true,
        operation: 'load',
        status: 'loaded',
        screenshot: await serializeScreenshot(screenshot)
      };
    } catch {
      return toLoadMissing();
    }
  }

  async function handleMessage(
    message: VideoScreenshotCacheMessage
  ): Promise<VideoScreenshotCacheResponse> {
    switch (message.operation) {
      case 'save':
        return handleSave(message);
      case 'load':
        return handleLoad(message);
      case 'remove':
        await repository.remove(message.ref);
        return { success: true, operation: 'remove' };
      case 'removeMany':
        await repository.removeMany(message.refs);
        return { success: true, operation: 'removeMany' };
      case 'pruneExpired':
        await repository.pruneExpired();
        return { success: true, operation: 'pruneExpired' };
      case 'pruneToLimits':
        await repository.pruneToLimits();
        return { success: true, operation: 'pruneToLimits' };
    }
  }

  return async (rawMessage) => {
    const message = normalizeVideoScreenshotCacheMessage(rawMessage, {
      maxContentBytes: options.maxContentBytes
    });
    if (!message) {
      return undefined;
    }

    try {
      return await enqueue(() => handleMessage(message));
    } catch (error) {
      return toMessageError(error instanceof Error ? error : String(error));
    }
  };
}
