import type { VideoCaptureScreenshot } from './types';
import { requireVideoScreenshotCacheIndexEntry } from './videoScreenshotCacheIndex';
import {
  VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_TTL_MS,
  createVideoScreenshotCacheStorageKey,
  normalizeVideoScreenshotCacheMaxContentBytes,
  type VideoScreenshotCacheIndexEntry
} from './videoScreenshotCacheTypes';
import type {
  ResolvedVideoScreenshotCacheRepositoryOptions,
  VideoScreenshotCacheRepositoryOptions
} from './videoScreenshotCacheRepositoryTypes';

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveVideoScreenshotCacheRepositoryOptions(
  options: VideoScreenshotCacheRepositoryOptions
): ResolvedVideoScreenshotCacheRepositoryOptions {
  return {
    ttlMs: normalizePositiveInteger(options.ttlMs, VIDEO_SCREENSHOT_CACHE_TTL_MS),
    maxGlobalEntries: normalizePositiveInteger(
      options.maxGlobalEntries,
      VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES
    ),
    maxPageEntries: normalizePositiveInteger(
      options.maxPageEntries,
      VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES
    ),
    maxContentBytes: normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes),
    now: options.now ?? (() => Date.now())
  };
}

export function hasVideoScreenshotBlobContent(
  screenshot: VideoCaptureScreenshot
): screenshot is VideoCaptureScreenshot & {
  content: NonNullable<VideoCaptureScreenshot['content']>;
} {
  return screenshot.content?.kind === 'blob';
}

export function tryBuildVideoScreenshotCacheEntryMetadata(
  pageKey: string,
  captureId: string,
  screenshot: Pick<VideoCaptureScreenshot, 'id' | 'fileName' | 'mimeType' | 'capturedAt'>,
  byteLength: number,
  options: ResolvedVideoScreenshotCacheRepositoryOptions,
  operationTime: number
): VideoScreenshotCacheIndexEntry | null {
  const writeTime = Math.max(operationTime, screenshot.capturedAt);
  try {
    return requireVideoScreenshotCacheIndexEntry(
      {
        schemaVersion: 1,
        key: createVideoScreenshotCacheStorageKey({
          pageKey,
          captureId,
          screenshotId: screenshot.id
        }),
        pageKey,
        captureId,
        id: screenshot.id,
        fileName: screenshot.fileName,
        mimeType: screenshot.mimeType,
        byteLength,
        capturedAt: screenshot.capturedAt,
        createdAt: writeTime,
        updatedAt: writeTime,
        lastAccessedAt: writeTime,
        expiresAt: writeTime + options.ttlMs
      },
      options
    );
  } catch {
    return null;
  }
}

export function toVideoCaptureScreenshot(
  entry: Pick<
    VideoScreenshotCacheIndexEntry,
    'id' | 'fileName' | 'mimeType' | 'capturedAt' | 'byteLength'
  >,
  blob: Blob
): VideoCaptureScreenshot {
  return {
    id: entry.id,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    capturedAt: entry.capturedAt,
    content: { kind: 'blob', blob, byteLength: entry.byteLength }
  };
}
