import { isObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import {
  pruneVideoScreenshotCacheIndexEntries,
  type VideoScreenshotCachePruneOptions,
  type VideoScreenshotCachePruneResult
} from './videoScreenshotCacheIndex';
import {
  normalizeVideoScreenshotCacheIndexEntry,
  type VideoScreenshotCacheContentValidationOptions,
  type VideoScreenshotCacheIndexEntry
} from './videoScreenshotCacheTypes';

export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME = 'aiob-video-screenshot-cache';
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION = 1;
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME = 'entries';
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME = 'byPageKey';
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME = 'byExpiresAt';
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME = 'byUpdatedAt';
export const VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME = 'byPageCapture';

export type VideoScreenshotCacheBlobMetadata = VideoScreenshotCacheIndexEntry;

export interface VideoScreenshotCacheBlobEntry extends VideoScreenshotCacheBlobMetadata {
  blob: Blob;
}

export interface VideoScreenshotCacheBlobStorePruneOptions extends VideoScreenshotCachePruneOptions {}

export interface VideoScreenshotCacheBlobStorePruneResult extends VideoScreenshotCachePruneResult {
  entries: VideoScreenshotCacheBlobMetadata[];
}

export interface VideoScreenshotCacheBlobStore {
  put(entry: VideoScreenshotCacheBlobEntry): Promise<void>;
  get(key: string): Promise<VideoScreenshotCacheBlobEntry | null>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
  listByPageKey(pageKey: string): Promise<VideoScreenshotCacheBlobEntry[]>;
  listAllMetadata(): Promise<VideoScreenshotCacheBlobMetadata[]>;
  prune(
    options: VideoScreenshotCacheBlobStorePruneOptions
  ): Promise<VideoScreenshotCacheBlobStorePruneResult>;
}

export function normalizeVideoScreenshotCacheBlobMetadata(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheBlobMetadata | null {
  return normalizeVideoScreenshotCacheIndexEntry(value, options);
}

export function normalizeVideoScreenshotCacheBlobEntry(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheBlobEntry | null {
  const metadata = normalizeVideoScreenshotCacheBlobMetadata(value, options);
  if (metadata === null || !isObjectRecord(value)) {
    return null;
  }

  const blob = normalizeBlob(value.blob, metadata);
  if (blob === null) {
    return null;
  }

  return {
    ...metadata,
    blob
  };
}

export function sortVideoScreenshotCacheBlobMetadataNewestFirst<
  T extends VideoScreenshotCacheBlobMetadata
>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.capturedAt - left.capturedAt;
  });
}

export function pruneVideoScreenshotCacheBlobMetadataEntries(
  entries: readonly VideoScreenshotCacheBlobMetadata[],
  options: VideoScreenshotCacheBlobStorePruneOptions
): VideoScreenshotCacheBlobStorePruneResult {
  return pruneVideoScreenshotCacheIndexEntries(entries, options);
}

function normalizeBlob(
  value: RuntimePropertyValue,
  metadata: VideoScreenshotCacheBlobMetadata
): Blob | null {
  if (!(value instanceof Blob) || value.size !== metadata.byteLength) {
    return null;
  }
  return value.type === metadata.mimeType ? value : value.slice(0, value.size, metadata.mimeType);
}
