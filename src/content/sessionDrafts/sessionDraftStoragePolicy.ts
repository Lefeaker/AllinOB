import {
  SESSION_DRAFT_MAX_ENTRIES,
  SESSION_DRAFT_MAX_ENVELOPE_BYTES,
  type SessionDraftStoragePolicy,
  type SessionDraftStoragePolicyOptions,
  type VideoScreenshotCacheStoragePolicy
} from './sessionDraftTypes';
import {
  DEFAULT_SESSION_DRAFT_RETENTION_POLICY,
  normalizeSessionDraftRetentionPolicy
} from './sessionDraftRetentionPolicy';

export { SESSION_DRAFT_MAX_ENTRIES, SESSION_DRAFT_MAX_ENVELOPE_BYTES } from './sessionDraftTypes';
export type { SessionDraftStoragePolicy, SessionDraftStoragePolicyOptions };
export type { VideoScreenshotCacheStoragePolicy };

export const FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES = SESSION_DRAFT_MAX_ENTRIES;
export const FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES = 50;
export const FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES = 1024 * 1024;

export function createSessionDraftStoragePolicy(
  options: SessionDraftStoragePolicyOptions = {}
): SessionDraftStoragePolicy {
  const retentionPolicy = normalizeSessionDraftRetentionPolicy(options.retentionPolicy);
  const videoScreenshotCache = options.videoScreenshotCache;
  return {
    retentionPolicy,
    maxDraftEntries: normalizePositiveFiniteInteger(
      options.maxDraftEntries,
      SESSION_DRAFT_MAX_ENTRIES
    ),
    maxEnvelopeBytes: normalizePositiveFiniteInteger(
      options.maxEnvelopeBytes,
      SESSION_DRAFT_MAX_ENVELOPE_BYTES
    ),
    videoScreenshotCache: {
      ttlMs: normalizePositiveFiniteInteger(
        videoScreenshotCache?.ttlMs,
        retentionPolicy.retentionMs
      ),
      maxGlobalEntries: normalizePositiveFiniteInteger(
        videoScreenshotCache?.maxGlobalEntries,
        FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES
      ),
      maxPageEntries: normalizePositiveFiniteInteger(
        videoScreenshotCache?.maxPageEntries,
        FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES
      ),
      maxContentBytes: normalizePositiveFiniteInteger(
        videoScreenshotCache?.maxContentBytes,
        FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES
      )
    }
  };
}

export const DEFAULT_SESSION_DRAFT_STORAGE_POLICY = createSessionDraftStoragePolicy({
  retentionPolicy: DEFAULT_SESSION_DRAFT_RETENTION_POLICY
});

function normalizePositiveFiniteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
