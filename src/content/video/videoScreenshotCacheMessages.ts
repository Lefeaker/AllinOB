import { readExactOwnDataRecord, readOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { ObjectRecord, RuntimePropertyValue } from '../../shared/guards/object';
import type { VideoScreenshotCacheSaveResult } from './videoScreenshotCacheRepository';
import {
  type VideoScreenshotCacheContentValidationOptions,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';
import {
  normalizeSessionDraftOperationContext,
  type SessionDraftOperationContext
} from '../sessionDrafts/sessionDraftRepositoryMessages';
import {
  isRestoreStorageMaintenanceMessage,
  type RestoreStorageMaintenanceMessage,
  type RestoreStorageMaintenanceResponse
} from '../sessionDrafts/restoreStorageMaintenanceMessages';
import {
  normalizeNonEmptyString,
  normalizeSerializedScreenshot,
  normalizeVideoScreenshotCacheRefMessage,
  type SerializedVideoScreenshotCacheScreenshot
} from './videoScreenshotCacheMessageCodecs';

export const VIDEO_SCREENSHOT_CACHE_MESSAGE = 'AIIOB_VIDEO_SCREENSHOT_CACHE';

export type { SerializedVideoScreenshotCacheScreenshot } from './videoScreenshotCacheMessageCodecs';
export type VideoScreenshotCacheMessage =
  | {
      type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE;
      operation: 'save';
      input: {
        pageKey: string;
        captureId: string;
        operationContext?: SessionDraftOperationContext;
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
  | { type: typeof VIDEO_SCREENSHOT_CACHE_MESSAGE; operation: 'pruneExpired' | 'pruneToLimits' }
  | RestoreStorageMaintenanceMessage;

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
  | RestoreStorageMaintenanceResponse
  | {
      success: false;
      error: string;
    };
export function isVideoScreenshotCacheMessage<T>(
  value: T,
  options: VideoScreenshotCacheContentValidationOptions = {}
): value is T & VideoScreenshotCacheMessage {
  return normalizeVideoScreenshotCacheMessage(value, options) !== null;
}

export function normalizeVideoScreenshotCacheMessage<T>(
  value: T,
  options: VideoScreenshotCacheContentValidationOptions = {}
): VideoScreenshotCacheMessage | null {
  const record = readOwnDataRecord(value);
  if (!record || record.type !== VIDEO_SCREENSHOT_CACHE_MESSAGE) return null;

  if (record.operation === 'save') {
    const message = readExactOwnDataRecord(record, ['type', 'operation', 'input']);
    const input = readAllowedOwnDataRecord(message?.input, [
      'pageKey',
      'captureId',
      'operationContext',
      'screenshot'
    ]);
    if (!message || !input) return null;
    const pageKey = normalizeNonEmptyString(input.pageKey);
    const captureId = normalizeNonEmptyString(input.captureId);
    const screenshot = normalizeSerializedScreenshot(input.screenshot, options);
    const operationContext =
      input.operationContext === undefined
        ? undefined
        : normalizeStableSessionDraftOperationContext(input.operationContext);
    return pageKey &&
      captureId &&
      screenshot &&
      (input.operationContext === undefined || operationContext)
      ? {
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'save',
          input: {
            pageKey,
            captureId,
            ...(operationContext ? { operationContext } : {}),
            screenshot
          }
        }
      : null;
  }

  if (record.operation === 'load' || record.operation === 'remove') {
    const message = readExactOwnDataRecord(record, ['type', 'operation', 'ref']);
    const ref = message ? normalizeVideoScreenshotCacheRefMessage(message.ref, options) : null;
    return message && ref
      ? {
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: record.operation,
          ref
        }
      : null;
  }

  if (record.operation === 'removeMany') {
    const message = readExactOwnDataRecord(record, ['type', 'operation', 'refs']);
    const rawRefs = message ? readOwnDataArray(message.refs) : null;
    if (!rawRefs) return null;
    const refs = rawRefs.map((ref) => normalizeVideoScreenshotCacheRefMessage(ref, options));
    return refs.every((ref): ref is VideoScreenshotCacheRef => ref !== null)
      ? { type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: 'removeMany', refs }
      : null;
  }

  if (record.operation === 'pruneExpired' || record.operation === 'pruneToLimits') {
    const message = readExactOwnDataRecord(record, ['type', 'operation']);
    return message ? { type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: record.operation } : null;
  }

  if (!isRestoreStorageMaintenanceMessage(record)) return null;
  if (record.operation === 'clearAllRestoreData') {
    return {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: record.operationId
    };
  }
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: record.operation
  };
}

function normalizeStableSessionDraftOperationContext(
  value: RuntimePropertyValue
): SessionDraftOperationContext | null {
  const context = readExactOwnDataRecord(value, [
    'operationId',
    'epoch',
    'draftKey',
    'baseRevision',
    'nextRevision'
  ]);
  return context ? normalizeSessionDraftOperationContext(context) : null;
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

function readOwnDataArray(value: RuntimePropertyValue): RuntimePropertyValue[] | null {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  if (
    !isRuntimeDataDescriptor(lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
  ) {
    return null;
  }
  const snapshot: RuntimePropertyValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (!isRuntimeDataDescriptor(descriptor) || !descriptor.enumerable) {
      return null;
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

type RuntimeDataDescriptor = Omit<PropertyDescriptor, 'value'> & {
  value: RuntimePropertyValue;
};

function isRuntimeDataDescriptor(
  descriptor: PropertyDescriptor | undefined
): descriptor is RuntimeDataDescriptor {
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  );
}
