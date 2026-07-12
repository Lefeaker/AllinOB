import type { StorageRecord } from '../../platform/interfaces/storage';
import {
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from '../../content/sessionDrafts/sessionDraftKeys';
import {
  isVideoScreenshotCacheStorageKey,
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY
} from '../../content/video/videoScreenshotCacheTypes';
import { isLegacyVideoStorageKey } from '../../content/video/utils';

const RESTORE_PROTOCOL_PREFIXES = [
  'aiob.restoreStorage.cursor.v1.',
  'aiob.restoreStorage.tombstone.v1.',
  'aiob.restoreStorage.lease.v1.',
  'aiob.restoreStorage.pending.v1.',
  'aiob.restoreStorage.outcome.v1.',
  'aiob.restoreStorage.delete.v1.',
  'aiob.restoreStorage.deleteChunk.v1.'
] as const;
const RESTORE_PROTOCOL_KEYS = new Set([
  'aiob.restoreStorage.corruption.v1',
  'aiob.restoreStorage.leaseGcCursor.v1',
  'aiob.restoreStorage.deleteGcCursor.v1'
]);

export interface RestoreStorageLocalClearPlan {
  targetKeys: string[];
  draftKeysRemoved: number;
  legacyScreenshotKeysRemoved: number;
}

export function planRestoreStorageLocalClear(values: StorageRecord): RestoreStorageLocalClearPlan {
  const keys = Object.keys(values);
  const draftKeys = keys.filter(
    (key) => key === SESSION_DRAFT_INDEX_KEY || isSessionDraftStorageKey(key)
  );
  const legacyScreenshotKeys = keys.filter(
    (key) => key === VIDEO_SCREENSHOT_CACHE_INDEX_KEY || isVideoScreenshotCacheStorageKey(key)
  );
  const legacyVideoDraftKeys = keys.filter(isLegacyVideoStorageKey);
  const protocolKeys = keys.filter(
    (key) =>
      RESTORE_PROTOCOL_KEYS.has(key) ||
      RESTORE_PROTOCOL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
  return {
    targetKeys: [
      ...new Set([...draftKeys, ...legacyScreenshotKeys, ...legacyVideoDraftKeys, ...protocolKeys])
    ].sort(),
    draftKeysRemoved: draftKeys.length,
    legacyScreenshotKeysRemoved: legacyScreenshotKeys.length
  };
}
