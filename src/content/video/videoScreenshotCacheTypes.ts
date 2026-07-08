import type { SerializedClipAttachmentBinaryContent } from '../../shared/attachments/clipAttachmentBinary';
import { isObjectRecord } from '../../shared/guards/object';
import { DEFAULT_SESSION_DRAFT_STORAGE_POLICY } from '../sessionDrafts/sessionDraftStoragePolicy';

type Raw = Parameters<typeof isObjectRecord>[0];
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
const VIDEO_SCREENSHOT_CACHE_MIME_TYPE = 'image/jpeg';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PAGE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

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

export function isVideoScreenshotCacheStorageKey(value: Raw): value is string {
  return typeof value === 'string' && value.startsWith(VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX);
}

export function isVideoScreenshotCachePageKey(value: Raw): value is string {
  return normalizePageKey(value) !== null;
}

export function isVideoScreenshotCacheRef(value: Raw): value is VideoScreenshotCacheRef {
  return normalizeVideoScreenshotCacheRef(value) !== null;
}

export function normalizeVideoScreenshotCacheRef(value: Raw): VideoScreenshotCacheRef | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  const identity = normalizeIdentity(value);
  const key = normalizeStorageKey(value.key, identity);
  const fileName = normalizeNonEmptyString(value.fileName);
  const mimeType = normalizeMimeType(value.mimeType);
  const byteLength = normalizeByteLength(value.byteLength);
  const capturedAt = normalizeTimestamp(value.capturedAt);
  const expiresAt = normalizeTimestamp(value.expiresAt);

  if (
    schemaVersion === null ||
    identity === null ||
    key === null ||
    fileName === null ||
    mimeType === null ||
    byteLength === null ||
    capturedAt === null ||
    expiresAt === null ||
    expiresAt <= capturedAt
  ) {
    return null;
  }

  return {
    schemaVersion,
    key,
    pageKey: identity.pageKey,
    captureId: identity.captureId,
    id: identity.id,
    fileName,
    mimeType,
    byteLength,
    capturedAt,
    expiresAt
  };
}

export function isVideoScreenshotCacheIndexEntry(
  value: Raw
): value is VideoScreenshotCacheIndexEntry {
  return normalizeVideoScreenshotCacheIndexEntry(value) !== null;
}

export function normalizeVideoScreenshotCacheIndexEntry(
  value: Raw
): VideoScreenshotCacheIndexEntry | null {
  const ref = normalizeVideoScreenshotCacheRef(value);
  if (ref === null || !isObjectRecord(value)) {
    return null;
  }

  const createdAt = normalizeTimestamp(value.createdAt);
  const updatedAt = normalizeTimestamp(value.updatedAt);

  if (
    createdAt === null ||
    updatedAt === null ||
    createdAt < ref.capturedAt ||
    updatedAt < createdAt ||
    ref.expiresAt <= updatedAt
  ) {
    return null;
  }

  return {
    ...ref,
    createdAt,
    updatedAt
  };
}

export function isVideoScreenshotCacheIndex(value: Raw): value is VideoScreenshotCacheIndex {
  return normalizeVideoScreenshotCacheIndex(value) !== null;
}

export function normalizeVideoScreenshotCacheIndex(value: Raw): VideoScreenshotCacheIndex | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  const entries = Array.isArray(value.entries)
    ? value.entries.map(normalizeVideoScreenshotCacheIndexEntry)
    : null;

  if (
    schemaVersion === null ||
    entries === null ||
    !entries.every((entry): entry is VideoScreenshotCacheIndexEntry => entry !== null)
  ) {
    return null;
  }

  return {
    schemaVersion,
    entries
  };
}

export function isVideoScreenshotCacheEntry(value: Raw): value is VideoScreenshotCacheEntry {
  return normalizeVideoScreenshotCacheEntry(value) !== null;
}

export function normalizeVideoScreenshotCacheEntry(value: Raw): VideoScreenshotCacheEntry | null {
  const indexEntry = normalizeVideoScreenshotCacheIndexEntry(value);
  if (indexEntry === null || !isObjectRecord(value)) {
    return null;
  }

  const content = normalizeBinaryContent(value.content);
  if (content === null || content.byteLength !== indexEntry.byteLength) {
    return null;
  }

  return {
    ...indexEntry,
    content
  };
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function normalizeSchemaVersion(value: Raw): typeof VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION | null {
  return value === VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION
    ? VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION
    : null;
}

function normalizeIdentity(value: Record<string, Raw>): VideoScreenshotCacheIdentity | null {
  const pageKey = normalizePageKey(value.pageKey);
  const captureId = normalizeNonEmptyString(value.captureId);
  const id = normalizeNonEmptyString(value.id);
  if (pageKey === null || captureId === null || id === null) {
    return null;
  }
  return { pageKey, captureId, id };
}

function normalizePageKey(value: Raw): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (normalized === null || !PAGE_KEY_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeStorageKey(
  value: Raw,
  identity: VideoScreenshotCacheIdentity | null
): string | null {
  if (identity === null || typeof value !== 'string' || !isVideoScreenshotCacheStorageKey(value)) {
    return null;
  }
  const expected = createVideoScreenshotCacheStorageKey({
    pageKey: identity.pageKey,
    captureId: identity.captureId,
    screenshotId: identity.id
  });
  return value === expected ? expected : null;
}

function normalizeMimeType(value: Raw): typeof VIDEO_SCREENSHOT_CACHE_MIME_TYPE | null {
  return value === VIDEO_SCREENSHOT_CACHE_MIME_TYPE ? VIDEO_SCREENSHOT_CACHE_MIME_TYPE : null;
}

function normalizeNonEmptyString(value: Raw): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeTimestamp(value: Raw): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function normalizeByteLength(value: Raw): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES
    ? value
    : null;
}

function normalizeBinaryContent(value: Raw): SerializedClipAttachmentBinaryContent | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const { encoding, data, byteLength } = value;
  const normalizedByteLength = normalizeByteLength(byteLength);

  if (
    encoding !== 'base64' ||
    typeof data !== 'string' ||
    data.length === 0 ||
    !BASE64_PATTERN.test(data) ||
    normalizedByteLength === null
  ) {
    return null;
  }

  return {
    encoding: 'base64',
    data,
    byteLength: normalizedByteLength
  };
}
