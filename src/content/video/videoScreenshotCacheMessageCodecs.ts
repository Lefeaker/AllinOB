import { type SerializedClipAttachmentBinaryContent } from '../../shared/attachments/clipAttachmentBinary';
import { readExactOwnDataRecord, readOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { ObjectRecord, RuntimePropertyValue } from '../../shared/guards/object';
import type { VideoCaptureScreenshot } from './types';
import {
  normalizeVideoScreenshotCacheMaxContentBytes,
  type VideoScreenshotCacheContentValidationOptions,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';

const SCHEMA_VERSION = 1;
const KEY_PREFIX = 'aiob.videoScreenshotCache.v1.';
const PAGE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface SerializedVideoScreenshotCacheScreenshot {
  id: string;
  fileName: string;
  mimeType: VideoCaptureScreenshot['mimeType'];
  capturedAt: number;
  content?: SerializedClipAttachmentBinaryContent;
  dataUrl?: string;
}

export function isVideoScreenshotCacheRefMessage(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): value is VideoScreenshotCacheRef {
  return normalizeVideoScreenshotCacheRefMessage(value, options) !== null;
}

export function normalizeVideoScreenshotCacheRefMessage(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): VideoScreenshotCacheRef | null {
  const record = readExactOwnDataRecord(value, [
    'schemaVersion',
    'key',
    'pageKey',
    'captureId',
    'id',
    'fileName',
    'mimeType',
    'byteLength',
    'capturedAt',
    'expiresAt'
  ]);
  if (!record || record.schemaVersion !== SCHEMA_VERSION) return null;
  const pageKey = normalizePageKey(record.pageKey);
  const captureId = normalizeNonEmptyString(record.captureId);
  const id = normalizeNonEmptyString(record.id);
  const key = normalizeNonEmptyString(record.key);
  const fileName = normalizeNonEmptyString(record.fileName);
  const mimeType = record.mimeType === 'image/jpeg' ? record.mimeType : null;
  const byteLength = normalizeByteLength(record.byteLength, options);
  const capturedAt = normalizeTimestamp(record.capturedAt);
  const expiresAt = normalizeTimestamp(record.expiresAt);
  if (
    pageKey === null ||
    captureId === null ||
    id === null ||
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
  const expectedKey = `${KEY_PREFIX}${encodeURIComponent(pageKey)}.${encodeURIComponent(
    captureId
  )}.${encodeURIComponent(id)}`;
  return key === expectedKey
    ? {
        schemaVersion: SCHEMA_VERSION,
        key,
        pageKey,
        captureId,
        id,
        fileName,
        mimeType,
        byteLength,
        capturedAt,
        expiresAt
      }
    : null;
}

export function normalizeSerializedScreenshot(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): SerializedVideoScreenshotCacheScreenshot | null {
  const record = readAllowedOwnDataRecord(value, [
    'id',
    'fileName',
    'mimeType',
    'capturedAt',
    'content',
    'dataUrl'
  ]);
  if (!record) return null;
  const id = normalizeNonEmptyString(record.id);
  const fileName = normalizeNonEmptyString(record.fileName);
  const mimeType = record.mimeType === 'image/jpeg' ? record.mimeType : null;
  const capturedAt = normalizeTimestamp(record.capturedAt);
  const content = normalizeSerializedBinaryContent(record.content, options);
  const dataUrl = mimeType ? normalizeLegacyDataUrl(record.dataUrl, mimeType, options) : null;
  if (
    id === null ||
    fileName === null ||
    mimeType === null ||
    capturedAt === null ||
    (content === null) === (dataUrl === null)
  ) {
    return null;
  }
  return {
    id,
    fileName,
    mimeType,
    capturedAt,
    ...(content ? { content } : {}),
    ...(dataUrl ? { dataUrl } : {})
  };
}

function normalizeSerializedBinaryContent(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): SerializedClipAttachmentBinaryContent | null {
  const record = readExactOwnDataRecord(value, ['encoding', 'data', 'byteLength']);
  if (!record || record.encoding !== 'base64' || typeof record.data !== 'string') return null;
  const byteLength = normalizeByteLength(record.byteLength, options);
  return byteLength !== null &&
    hasCanonicalBase64EncodedLength(record.data, byteLength) &&
    decodeCanonicalBase64ByteLength(record.data) === byteLength
    ? { encoding: 'base64', data: record.data, byteLength }
    : null;
}

function normalizeLegacyDataUrl(
  value: RuntimePropertyValue,
  mimeType: string,
  options: VideoScreenshotCacheContentValidationOptions
): string | null {
  if (typeof value !== 'string') return null;
  const prefix = `data:${mimeType};base64,`;
  if (!value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length);
  const maxContentBytes = normalizeVideoScreenshotCacheMaxContentBytes(options.maxContentBytes);
  if (encoded.length > canonicalBase64EncodedLength(maxContentBytes)) return null;
  const byteLength = decodeCanonicalBase64ByteLength(encoded);
  return byteLength !== null && normalizeByteLength(byteLength, options) !== null ? value : null;
}

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function hasCanonicalBase64EncodedLength(value: string, byteLength: number): boolean {
  return value.length === canonicalBase64EncodedLength(byteLength);
}

function canonicalBase64EncodedLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function decodeCanonicalBase64ByteLength(value: string): number | null {
  if (
    value.length === 0 ||
    !CANONICAL_BASE64_PATTERN.test(value) ||
    typeof globalThis.atob !== 'function' ||
    typeof globalThis.btoa !== 'function'
  )
    return null;
  try {
    const decoded = globalThis.atob(value);
    return globalThis.btoa(decoded) === value ? decoded.length : null;
  } catch {
    return null;
  }
}

function readAllowedOwnDataRecord(
  value: RuntimePropertyValue,
  allowedKeys: readonly string[]
): ObjectRecord | null {
  const record = readOwnDataRecord(value);
  if (!record) return null;
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
}

export function normalizeNonEmptyString(value: RuntimePropertyValue): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeTimestamp(value: RuntimePropertyValue): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function normalizeByteLength(
  value: RuntimePropertyValue,
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

function normalizePageKey(value: RuntimePropertyValue): string | null {
  const normalized = normalizeNonEmptyString(value);
  return normalized !== null && PAGE_KEY_PATTERN.test(normalized) ? normalized : null;
}
