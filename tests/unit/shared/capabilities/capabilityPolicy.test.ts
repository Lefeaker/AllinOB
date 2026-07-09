import {
  DEFAULT_RESTORE_CAPABILITY_POLICY,
  createExtendedRestoreCapabilityPolicy,
  defaultRestoreCapabilityPolicyProvider
} from '../../../../src/shared/capabilities/capabilityPolicy';
import {
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
  FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE,
  FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
  FREE_SESSION_DRAFT_RETENTION_MS,
  SESSION_DRAFT_MAX_ENVELOPE_BYTES,
  SESSION_DRAFT_MAX_ENTRIES
} from '../../../../src/content/sessionDrafts';

describe('restore capability policy', () => {
  it('keeps the public default policy equal to the production Free storage policy', () => {
    expect(DEFAULT_RESTORE_CAPABILITY_POLICY).toEqual(DEFAULT_SESSION_DRAFT_STORAGE_POLICY);
    expect(DEFAULT_RESTORE_CAPABILITY_POLICY).toEqual({
      retentionPolicy: {
        retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
        maxRestorablePages: FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
        maxItemsPerPage: FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE
      },
      maxDraftEntries: SESSION_DRAFT_MAX_ENTRIES,
      maxEnvelopeBytes: SESSION_DRAFT_MAX_ENVELOPE_BYTES,
      videoScreenshotCache: {
        ttlMs: FREE_SESSION_DRAFT_RETENTION_MS,
        maxGlobalEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
        maxPageEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
        maxContentBytes: FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES
      }
    });
  });

  it('exposes a default provider that returns the neutral production policy without refresh side effects', async () => {
    expect(defaultRestoreCapabilityPolicyProvider.getCurrentPolicy()).toBe(
      DEFAULT_SESSION_DRAFT_STORAGE_POLICY
    );
    await expect(defaultRestoreCapabilityPolicyProvider.refreshPolicy?.()).resolves.toBe(
      DEFAULT_SESSION_DRAFT_STORAGE_POLICY
    );
  });

  it('creates a neutral extended policy through the production storage policy normalizer', () => {
    expect(
      createExtendedRestoreCapabilityPolicy({
        retentionPolicy: {
          retentionMs: 96 * 60 * 60 * 1000,
          maxRestorablePages: null,
          maxItemsPerPage: null
        },
        maxDraftEntries: 12,
        maxEnvelopeBytes: 256 * 1024,
        videoScreenshotCache: {
          ttlMs: 96 * 60 * 60 * 1000,
          maxGlobalEntries: 24,
          maxPageEntries: 8,
          maxContentBytes: 512 * 1024
        }
      })
    ).toEqual({
      retentionPolicy: {
        retentionMs: 96 * 60 * 60 * 1000,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      maxDraftEntries: 12,
      maxEnvelopeBytes: 256 * 1024,
      videoScreenshotCache: {
        ttlMs: 96 * 60 * 60 * 1000,
        maxGlobalEntries: 24,
        maxPageEntries: 8,
        maxContentBytes: 512 * 1024
      }
    });
  });
});
