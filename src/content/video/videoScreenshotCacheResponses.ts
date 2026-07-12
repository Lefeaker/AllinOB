import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import {
  normalizeSerializedScreenshot,
  normalizeVideoScreenshotCacheRefMessage
} from './videoScreenshotCacheMessageCodecs';
import type { VideoScreenshotCacheResponse } from './videoScreenshotCacheMessages';

export type VideoScreenshotCacheClientOperation =
  | 'save'
  | 'load'
  | 'remove'
  | 'removeMany'
  | 'pruneExpired'
  | 'pruneToLimits';
const validation = { maxContentBytes: Number.MAX_SAFE_INTEGER };

export function normalizeVideoScreenshotCacheResponse(
  value: RuntimePropertyValue,
  expectedOperation: VideoScreenshotCacheClientOperation
): VideoScreenshotCacheResponse | null {
  const failure = readExactOwnDataRecord(value, ['success', 'error']);
  if (failure?.success === false) {
    return isNonEmptyString(failure.error) ? { success: false, error: failure.error } : null;
  }
  if (expectedOperation === 'save') {
    const response = readExactOwnDataRecord(value, ['success', 'operation', 'result']);
    if (response?.success !== true || response.operation !== expectedOperation) return null;
    const result = normalizeSaveResult(response.result);
    return result ? { success: true, operation: 'save', result } : null;
  }
  if (expectedOperation === 'load') {
    const missing = readExactOwnDataRecord(value, ['success', 'operation', 'status']);
    if (
      missing?.success === true &&
      missing.operation === expectedOperation &&
      missing.status === 'missing'
    ) {
      return { success: true, operation: 'load', status: 'missing' };
    }
    const loaded = readExactOwnDataRecord(value, ['success', 'operation', 'status', 'screenshot']);
    if (
      loaded?.success !== true ||
      loaded.operation !== expectedOperation ||
      loaded.status !== 'loaded'
    ) {
      return null;
    }
    const screenshot = normalizeSerializedScreenshot(loaded.screenshot, validation);
    return screenshot ? { success: true, operation: 'load', status: 'loaded', screenshot } : null;
  }
  if (
    expectedOperation === 'remove' ||
    expectedOperation === 'removeMany' ||
    expectedOperation === 'pruneExpired' ||
    expectedOperation === 'pruneToLimits'
  ) {
    const response = readExactOwnDataRecord(value, ['success', 'operation']);
    return response?.success === true && response.operation === expectedOperation
      ? { success: true, operation: expectedOperation }
      : null;
  }
  return null;
}

function normalizeSaveResult(
  value: RuntimePropertyValue
): Extract<VideoScreenshotCacheResponse, { success: true; operation: 'save' }>['result'] | null {
  const saved = readExactOwnDataRecord(value, ['status', 'ref']);
  if (saved?.status === 'saved') {
    const ref = normalizeVideoScreenshotCacheRefMessage(saved.ref, validation);
    return ref ? { status: 'saved', ref } : null;
  }
  const missing = readExactOwnDataRecord(value, ['status', 'reason']);
  if (missing?.status === 'skipped' && missing.reason === 'missing-blob-content') {
    return { status: 'skipped', reason: 'missing-blob-content' };
  }
  const invalidMetadata = readExactOwnDataRecord(value, ['status', 'reason', 'field']);
  if (
    invalidMetadata?.status === 'skipped' &&
    invalidMetadata.reason === 'invalid-metadata' &&
    invalidMetadata.field === 'pageKey'
  ) {
    return { status: 'skipped', reason: 'invalid-metadata', field: 'pageKey' };
  }
  const tooLarge = readExactOwnDataRecord(value, [
    'status',
    'reason',
    'byteLength',
    'maxContentBytes'
  ]);
  if (
    tooLarge?.status === 'skipped' &&
    tooLarge.reason === 'content-too-large' &&
    isPositiveInteger(tooLarge.byteLength) &&
    isPositiveInteger(tooLarge.maxContentBytes)
  ) {
    return {
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: tooLarge.byteLength,
      maxContentBytes: tooLarge.maxContentBytes
    };
  }
  const serializeFailed = readExactOwnDataRecord(value, ['status', 'reason', 'error']);
  return serializeFailed?.status === 'skipped' &&
    serializeFailed.reason === 'serialize-failed' &&
    isNonEmptyString(serializeFailed.error)
    ? { status: 'skipped', reason: 'serialize-failed', error: serializeFailed.error }
    : null;
}

function isNonEmptyString(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
