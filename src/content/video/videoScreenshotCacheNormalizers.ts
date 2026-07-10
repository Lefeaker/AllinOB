import type { SerializedClipAttachmentBinaryContent } from '../../shared/attachments/clipAttachmentBinary';
import { isObjectRecord } from '../../shared/guards/object';
import {
  VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  VIDEO_SCREENSHOT_CACHE_MIME_TYPE,
  VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
  createVideoScreenshotCacheStorageKey,
  isVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheEntry,
  type VideoScreenshotCacheIndex,
  type VideoScreenshotCacheIndexEntry,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheContract';

type Raw = Parameters<typeof isObjectRecord>[0];

export interface VideoScreenshotCacheContentValidationOptions {
  maxContentBytes?: number | undefined;
}

interface VideoScreenshotCacheIdentity {
  pageKey: string;
  captureId: string;
  id: string;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PAGE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function isVideoScreenshotCachePageKey(value: Raw): value is string {
  return normalizePageKey(value) !== null;
}

export function isVideoScreenshotCacheRef(value: Raw): value is VideoScreenshotCacheRef {
  return normalizeVideoScreenshotCacheRef(value) !== null;
}

export function normalizeVideoScreenshotCacheRef(
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheRef | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  const identity = normalizeIdentity(value);
  const key = normalizeStorageKey(value.key, identity);
  const fileName = normalizeNonEmptyString(value.fileName);
  const mimeType = normalizeMimeType(value.mimeType);
  const byteLength = normalizeByteLength(value.byteLength, options);
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
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheIndexEntry | null {
  const ref = normalizeVideoScreenshotCacheRef(value, options);
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
  return { ...ref, createdAt, updatedAt };
}

export function isVideoScreenshotCacheIndex(value: Raw): value is VideoScreenshotCacheIndex {
  return normalizeVideoScreenshotCacheIndex(value) !== null;
}

export function normalizeVideoScreenshotCacheIndex(
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheIndex | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  const entries = Array.isArray(value.entries)
    ? value.entries.map((entry) => normalizeVideoScreenshotCacheIndexEntry(entry, options))
    : null;
  if (
    schemaVersion === null ||
    entries === null ||
    !entries.every((entry): entry is VideoScreenshotCacheIndexEntry => entry !== null)
  ) {
    return null;
  }
  return { schemaVersion, entries };
}

export function isVideoScreenshotCacheEntry(value: Raw): value is VideoScreenshotCacheEntry {
  return normalizeVideoScreenshotCacheEntry(value) !== null;
}

export function normalizeVideoScreenshotCacheEntry(
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheEntry | null {
  const indexEntry = normalizeVideoScreenshotCacheIndexEntry(value, options);
  if (indexEntry === null || !isObjectRecord(value)) {
    return null;
  }
  const content = normalizeBinaryContent(value.content, options);
  return content !== null && content.byteLength === indexEntry.byteLength
    ? { ...indexEntry, content }
    : null;
}

export function normalizeVideoScreenshotCacheMaxContentBytes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES;
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
  return pageKey === null || captureId === null || id === null ? null : { pageKey, captureId, id };
}

function normalizePageKey(value: Raw): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized !== null && PAGE_KEY_PATTERN.test(normalized) ? normalized : null;
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

function normalizeMimeType(value: Raw): VideoScreenshotCacheRef['mimeType'] | null {
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

function normalizeByteLength(
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions
): number | null {
  const maxContentBytes = normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes);
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maxContentBytes
    ? value
    : null;
}

function normalizeBinaryContent(
  value: Raw,
  options: VideoScreenshotCacheContentValidationOptions
): SerializedClipAttachmentBinaryContent | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const { encoding, data, byteLength } = value;
  const normalizedByteLength = normalizeByteLength(byteLength, options);
  if (
    encoding !== 'base64' ||
    typeof data !== 'string' ||
    data.length === 0 ||
    !BASE64_PATTERN.test(data) ||
    normalizedByteLength === null
  ) {
    return null;
  }
  return { encoding: 'base64', data, byteLength: normalizedByteLength };
}
