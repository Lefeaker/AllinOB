import type { SerializedClipAttachmentBinaryContent } from '../../shared/attachments/clipAttachmentBinary';
import { DEFAULT_SESSION_DRAFT_STORAGE_POLICY } from '../sessionDrafts/sessionDraftStoragePolicy';

export const VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION = 1;
export const VIDEO_SCREENSHOT_CACHE_KEY_PREFIX = 'aiob.videoScreenshotCache';
export const VIDEO_SCREENSHOT_CACHE_INDEX_KEY = `${VIDEO_SCREENSHOT_CACHE_KEY_PREFIX}.index.v1`;
export const VIDEO_SCREENSHOT_CACHE_TTL_MS =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY.videoScreenshotCache.ttlMs;
export const VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY.videoScreenshotCache.maxGlobalEntries;
export const VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY.videoScreenshotCache.maxPageEntries;
export const VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES =
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY.videoScreenshotCache.maxContentBytes;
const VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX = `${VIDEO_SCREENSHOT_CACHE_KEY_PREFIX}.v${VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION}.`;
export const VIDEO_SCREENSHOT_CACHE_MIME_TYPE = 'image/jpeg';

interface VideoScreenshotCacheIdentity {
  pageKey: string;
  captureId: string;
  id: string;
}

export interface VideoScreenshotCacheRef extends VideoScreenshotCacheIdentity {
  schemaVersion: typeof VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION;
  key: string;
  fileName: string;
  mimeType: typeof VIDEO_SCREENSHOT_CACHE_MIME_TYPE;
  byteLength: number;
  capturedAt: number;
  expiresAt: number;
}

export interface VideoScreenshotCacheIndexEntry extends VideoScreenshotCacheRef {
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

export interface VideoScreenshotCacheIndex {
  schemaVersion: typeof VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION;
  entries: VideoScreenshotCacheIndexEntry[];
}

export interface VideoScreenshotCacheEntry extends VideoScreenshotCacheIndexEntry {
  content: SerializedClipAttachmentBinaryContent;
}

export function createVideoScreenshotCacheIndex(
  entries: VideoScreenshotCacheIndexEntry[] = []
): VideoScreenshotCacheIndex {
  return {
    schemaVersion: VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
    entries
  };
}

export function createVideoScreenshotCacheStorageKey(options: {
  pageKey: string;
  captureId: string;
  screenshotId: string;
}): string {
  const { pageKey, captureId, screenshotId } = options;
  return `${VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX}${encodeKeyPart(pageKey)}.${encodeKeyPart(captureId)}.${encodeKeyPart(screenshotId)}`;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function isVideoScreenshotCacheStorageKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX);
}
