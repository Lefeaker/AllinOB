import {
  isLegacyDataUrlForMimeType,
  isSerializedClipAttachmentBinaryContent,
  type SerializedClipAttachmentBinaryContent
} from '../../shared/attachments/clipAttachmentBinary';
import { isObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import type { VideoScreenshotCacheSaveResult } from './videoScreenshotCacheRepository';
import {
  normalizeVideoScreenshotCacheMaxContentBytes,
  type VideoScreenshotCacheContentValidationOptions,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';
import type { VideoCaptureScreenshot } from './types';

export const VIDEO_SCREENSHOT_CACHE_MESSAGE = 'AIIOB_VIDEO_SCREENSHOT_CACHE';

const VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION = 1;
const VIDEO_SCREENSHOT_CACHE_KEY_PREFIX = 'aiob.videoScreenshotCache';
const VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX = `${VIDEO_SCREENSHOT_CACHE_KEY_PREFIX}.v${VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION}.`;
const PAGE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface SerializedVideoScreenshotCacheScreenshot {
  id: string;
  fileName: string;
  mimeType: VideoCaptureScreenshot['mimeType'];
  capturedAt: number;
  content?: SerializedClipAttachmentBinaryContent;
  dataUrl?: string;
}

export type VideoScreenshotCacheMessage =
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'save';
      input: {
        pageKey: string;
        captureId: string;
        screenshot: SerializedVideoScreenshotCacheScreenshot;
      };
    }
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'load';
      ref: VideoScreenshotCacheRef;
    }
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'remove';
      ref: VideoScreenshotCacheRef;
    }
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'removeMany';
      refs: VideoScreenshotCacheRef[];
    }
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'pruneExpired' | 'pruneToLimits';
    };

export type VideoScreenshotCacheResponse =
  | {
      success: true;
      operation: 'save';
      result: VideoScreenshotCacheSaveResult;
    }
  | {
      success: true;
      operation: 'load';
      status: 'loaded';
      screenshot: SerializedVideoScreenshotCacheScreenshot;
    }
  | {
      success: true;
      operation: 'load';
      status: 'missing';
    }
  | {
      success: true;
      operation: 'remove' | 'removeMany' | 'pruneExpired' | 'pruneToLimits';
    }
  | {
      success: false;
      error: string;
    };

function normalizeNonEmptyString(value: RuntimePropertyValue): string | null {
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

function createExpectedVideoScreenshotCacheStorageKey(options: {
  pageKey: string;
  captureId: string;
  screenshotId: string;
}): string {
  return `${VIDEO_SCREENSHOT_CACHE_KEY_VERSION_PREFIX}${encodeURIComponent(
    options.pageKey
  )}.${encodeURIComponent(options.captureId)}.${encodeURIComponent(options.screenshotId)}`;
}

function isVideoScreenshotCacheRefMessage(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): value is VideoScreenshotCacheRef {
  if (!isObjectRecord(value) || value.schemaVersion !== VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION) {
    return false;
  }

  const pageKey = normalizePageKey(value.pageKey);
  const captureId = normalizeNonEmptyString(value.captureId);
  const id = normalizeNonEmptyString(value.id);
  const key = normalizeNonEmptyString(value.key);
  const fileName = normalizeNonEmptyString(value.fileName);
  const mimeType = value.mimeType === 'image/jpeg' ? value.mimeType : null;
  const byteLength = normalizeByteLength(value.byteLength, options);
  const capturedAt = normalizeTimestamp(value.capturedAt);
  const expiresAt = normalizeTimestamp(value.expiresAt);

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
    return false;
  }

  return (
    key ===
    createExpectedVideoScreenshotCacheStorageKey({
      pageKey,
      captureId,
      screenshotId: id
    })
  );
}

function normalizeSerializedScreenshot(
  value: RuntimePropertyValue,
  options: VideoScreenshotCacheContentValidationOptions
): SerializedVideoScreenshotCacheScreenshot | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const id = normalizeNonEmptyString(value.id);
  const fileName = normalizeNonEmptyString(value.fileName);
  const mimeType = value.mimeType === 'image/jpeg' ? value.mimeType : null;
  const capturedAt = normalizeTimestamp(value.capturedAt);
  const content =
    isSerializedClipAttachmentBinaryContent(value.content) &&
    normalizeByteLength(value.content.byteLength, options) !== null
      ? value.content
      : null;
  const dataUrl =
    mimeType && isLegacyDataUrlForMimeType(value.dataUrl, mimeType) ? value.dataUrl : null;

  if (
    id === null ||
    fileName === null ||
    mimeType === null ||
    capturedAt === null ||
    (content === null && dataUrl === null)
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

export function isVideoScreenshotCacheMessage<T>(
  value: T,
  options: VideoScreenshotCacheContentValidationOptions = {}
): value is T & VideoScreenshotCacheMessage {
  if (!isObjectRecord(value) || value.type !== VIDEO_SCREENSHOT_CACHE_MESSAGE) {
    return false;
  }

  if (value.operation === 'save') {
    if (!isObjectRecord(value.input)) {
      return false;
    }
    return (
      normalizeNonEmptyString(value.input.pageKey) !== null &&
      normalizeNonEmptyString(value.input.captureId) !== null &&
      normalizeSerializedScreenshot(value.input.screenshot, options) !== null
    );
  }

  if (value.operation === 'load' || value.operation === 'remove') {
    return isVideoScreenshotCacheRefMessage(value.ref, options);
  }

  if (value.operation === 'removeMany') {
    const refs = value.refs;
    return (
      Array.isArray(refs) &&
      refs.every((ref: RuntimePropertyValue) => isVideoScreenshotCacheRefMessage(ref, options))
    );
  }

  return value.operation === 'pruneExpired' || value.operation === 'pruneToLimits';
}

export function normalizeVideoScreenshotCacheMessage<T>(
  value: T,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheMessage | null {
  return isVideoScreenshotCacheMessage(value, options) ? value : null;
}
