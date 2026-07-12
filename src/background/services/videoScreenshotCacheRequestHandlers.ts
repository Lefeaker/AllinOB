import type { StorageAreaService } from '../../platform/interfaces/storage';
import type {
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheSaveResult
} from '../../content/video/videoScreenshotCacheRepository';
import type {
  VideoScreenshotCacheMessage,
  VideoScreenshotCacheResponse
} from '../../content/video/videoScreenshotCacheMessages';
import type { VideoScreenshotCacheBlobStore } from '../../content/video/videoScreenshotCacheStore';
import type { VideoCaptureScreenshot } from '../../content/video/types';
import { createVideoScreenshotCacheStorageKey } from '../../content/video/videoScreenshotCacheTypes';
import { buildVideoScreenshotCacheRef } from '../../content/video/videoScreenshotCacheIndex';
import {
  persistRestoreStorageLease,
  rollbackRestoreStorageLeaseKey
} from './restoreStorageLeaseStore';
import {
  deserializeVideoScreenshot,
  serializeVideoScreenshot
} from './videoScreenshotCacheSerialization';
import { createVideoScreenshotRequestFingerprint } from './videoScreenshotCacheFingerprint';

type SaveMessage = Extract<VideoScreenshotCacheMessage, { operation: 'save' }>;
type LoadMessage = Extract<VideoScreenshotCacheMessage, { operation: 'load' }>;

export async function handleVideoScreenshotSave(
  message: SaveMessage,
  local: StorageAreaService,
  cacheRepository: VideoScreenshotCacheRepository,
  blobStore: VideoScreenshotCacheBlobStore
): Promise<VideoScreenshotCacheResponse> {
  const operationContext = message.input.operationContext;
  if (!operationContext) throw new Error('RESTORE_STORAGE_PREPARE_REQUIRED');
  const screenshotKey = createVideoScreenshotCacheStorageKey({
    pageKey: message.input.pageKey,
    captureId: message.input.captureId,
    screenshotId: message.input.screenshot.id
  });
  const screenshotFingerprint = await createVideoScreenshotRequestFingerprint(
    message.input.screenshot
  );
  const leaseAdded = await persistRestoreStorageLease(
    local,
    operationContext,
    screenshotKey,
    screenshotFingerprint
  );
  try {
    const replay = await replayExistingScreenshot(blobStore, screenshotKey, screenshotFingerprint);
    if (replay) return replay;
  } catch (error) {
    if (leaseAdded) await rollbackRestoreStorageLeaseKey(local, operationContext, screenshotKey);
    throw error;
  }
  let screenshot: VideoCaptureScreenshot;
  try {
    screenshot = deserializeVideoScreenshot(message.input.screenshot);
  } catch (error) {
    if (leaseAdded) await rollbackRestoreStorageLeaseKey(local, operationContext, screenshotKey);
    return toSaveSkip(error);
  }
  let result: VideoScreenshotCacheSaveResult;
  try {
    result = await cacheRepository.save({
      pageKey: message.input.pageKey,
      captureId: message.input.captureId,
      screenshot
    });
  } catch (error) {
    if (leaseAdded) await rollbackRestoreStorageLeaseKey(local, operationContext, screenshotKey);
    return toSaveSkip(error);
  }
  if (leaseAdded && result.status !== 'saved') {
    await rollbackRestoreStorageLeaseKey(local, operationContext, screenshotKey);
  }
  return { success: true, operation: 'save', result };
}

export async function handleVideoScreenshotLoad(
  message: LoadMessage,
  cacheRepository: VideoScreenshotCacheRepository
): Promise<VideoScreenshotCacheResponse> {
  let screenshot: VideoCaptureScreenshot | null;
  try {
    screenshot = await cacheRepository.load(message.ref);
  } catch {
    return loadMissing();
  }
  if (!screenshot) return loadMissing();
  try {
    return {
      success: true,
      operation: 'load',
      status: 'loaded',
      screenshot: await serializeVideoScreenshot(screenshot)
    };
  } catch {
    return loadMissing();
  }
}

async function replayExistingScreenshot(
  blobStore: VideoScreenshotCacheBlobStore,
  screenshotKey: string,
  expectedFingerprint: string
): Promise<VideoScreenshotCacheResponse | null> {
  const inspected = await (blobStore.peek?.(screenshotKey) ?? blobStore.get(screenshotKey));
  if (inspected.status !== 'found') return null;
  const existing = inspected.entry;
  const serialized = await serializeVideoScreenshot({
    id: existing.id,
    fileName: existing.fileName,
    mimeType: existing.mimeType,
    capturedAt: existing.capturedAt,
    content: { kind: 'blob', blob: existing.blob, byteLength: existing.byteLength }
  });
  const fingerprint = await createVideoScreenshotRequestFingerprint(serialized);
  if (fingerprint !== expectedFingerprint) throw new Error('RESTORE_STORAGE_LEASE_CONFLICT');
  return {
    success: true,
    operation: 'save',
    result: { status: 'saved', ref: buildVideoScreenshotCacheRef(existing) }
  };
}

function toSaveSkip(error: unknown): VideoScreenshotCacheResponse {
  return {
    success: true,
    operation: 'save',
    result: {
      status: 'skipped',
      reason: 'serialize-failed',
      error: error instanceof Error ? error.message : String(error)
    }
  };
}

function loadMissing(): VideoScreenshotCacheResponse {
  return { success: true, operation: 'load', status: 'missing' };
}
