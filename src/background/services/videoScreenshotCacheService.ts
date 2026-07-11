import {
  serializeBlobAttachmentContent,
  serializedAttachmentContentToBlob
} from '../../shared/attachments/clipAttachmentBinary';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoScreenshotCacheRepository } from '../../content/video/videoScreenshotCacheRepository';
import { isRestoreStorageMaintenanceMessage } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import {
  normalizeVideoScreenshotCacheMessage,
  type SerializedVideoScreenshotCacheScreenshot,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from '../../content/video/videoScreenshotCacheMessages';
import type { VideoScreenshotCacheBlobStore } from '../../content/video/videoScreenshotCacheStore';
import type { VideoCaptureScreenshot } from '../../content/video/types';
import type { VideoScreenshotCacheIndexedDbStoreOptions } from './videoScreenshotCacheIndexedDbStore';
import { createVideoScreenshotCacheIndexedDbStore } from './videoScreenshotCacheIndexedDbStore';
import {
  createStorageEstimateService,
  type StorageEstimateService
} from './storageEstimateService';
import { handleRestoreStorageMaintenanceMessage } from './restoreStorageMaintenanceHandler';
import {
  createVideoScreenshotCachePolicyRuntime,
  type BackgroundVideoScreenshotCachePolicyInput
} from './videoScreenshotCachePolicyRuntime';

export interface BackgroundVideoScreenshotCacheStorage {
  local: StorageAreaService;
}
export interface BackgroundVideoScreenshotCacheHandlerDependencies {
  blobStore?: VideoScreenshotCacheBlobStore;
  indexedDb?: VideoScreenshotCacheIndexedDbStoreOptions['indexedDb'];
  storageEstimate?: StorageEstimateService;
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
  policyInput: BackgroundVideoScreenshotCachePolicyInput = {},
  dependencies: BackgroundVideoScreenshotCacheHandlerDependencies = {}
): BackgroundVideoScreenshotCacheHandler {
  let queue: Promise<void> = Promise.resolve();
  const policyRuntime = createVideoScreenshotCachePolicyRuntime(policyInput, {
    legacyArea: storage.local,
    ...(dependencies.blobStore ? { blobStore: dependencies.blobStore } : {}),
    ...(dependencies.indexedDb ? { indexedDb: dependencies.indexedDb } : {})
  });
  let maintenanceBlobStore = dependencies.blobStore;
  const storageEstimate = dependencies.storageEstimate ?? createStorageEstimateService();
  function getMaintenanceBlobStore(
    maxContentBytes: number | undefined
  ): VideoScreenshotCacheBlobStore {
    maintenanceBlobStore ??= createVideoScreenshotCacheIndexedDbStore({
      indexedDb: dependencies.indexedDb,
      maxContentBytes
    });
    return maintenanceBlobStore;
  }
  function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  async function handleSave(
    message: Extract<VideoScreenshotCacheMessage, { operation: 'save' }>,
    cacheRepository: VideoScreenshotCacheRepository
  ): Promise<VideoScreenshotCacheResponse> {
    let screenshot: VideoCaptureScreenshot;
    try {
      screenshot = deserializeScreenshot(message.input.screenshot);
    } catch (error) {
      return toSaveSkip(error instanceof Error ? error : String(error));
    }

    let result;
    try {
      result = await cacheRepository.save({
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
    message: Extract<VideoScreenshotCacheMessage, { operation: 'load' }>,
    cacheRepository: VideoScreenshotCacheRepository
  ): Promise<VideoScreenshotCacheResponse> {
    let screenshot: VideoCaptureScreenshot | null;
    try {
      screenshot = await cacheRepository.load(message.ref);
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
    message: VideoScreenshotCacheMessage,
    cacheRepository: VideoScreenshotCacheRepository,
    blobStore: VideoScreenshotCacheBlobStore
  ): Promise<VideoScreenshotCacheResponse> {
    if (isRestoreStorageMaintenanceMessage(message)) {
      return handleRestoreStorageMaintenanceMessage(message, {
        local: storage.local,
        blobStore,
        estimate: storageEstimate,
        policyInput
      });
    }
    switch (message.operation) {
      case 'save':
        return handleSave(message, cacheRepository);
      case 'load':
        return handleLoad(message, cacheRepository);
      case 'remove':
        await cacheRepository.remove(message.ref);
        return { success: true, operation: 'remove' };
      case 'removeMany':
        await cacheRepository.removeMany(message.refs);
        return { success: true, operation: 'removeMany' };
      case 'pruneExpired':
        await cacheRepository.pruneExpired();
        return { success: true, operation: 'pruneExpired' };
      case 'pruneToLimits':
        await cacheRepository.pruneToLimits();
        return { success: true, operation: 'pruneToLimits' };
    }
  }

  return async (rawMessage) => {
    const options = policyRuntime.getCurrentOptions();
    const message = normalizeVideoScreenshotCacheMessage(rawMessage, {
      maxContentBytes: options.maxContentBytes
    });
    if (!message) {
      return undefined;
    }

    try {
      return await enqueue(() =>
        handleMessage(
          message,
          policyRuntime.getRepository(options),
          getMaintenanceBlobStore(options.maxContentBytes)
        )
      );
    } catch (error) {
      return toMessageError(error instanceof Error ? error : String(error));
    }
  };
}
