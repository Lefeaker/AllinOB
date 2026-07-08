import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_DRAFT_RETENTION_POLICY,
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
  FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
  FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE,
  FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
  FREE_SESSION_DRAFT_RETENTION_MS,
  FREE_SESSION_DRAFT_RETENTION_POLICY,
  SESSION_DRAFT_MAX_ENVELOPE_BYTES,
  SESSION_DRAFT_MAX_ENTRIES,
  createSessionDraftStoragePolicy,
  filterSessionCommentDraftsForRetainedIds,
  getSessionDraftEffectiveExpiresAt,
  pruneSessionDraftIndexEntriesForRetentionPolicy,
  selectRetainedSessionDraftItems,
  type SessionDraftIndexEntry
} from '@content/sessionDrafts';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = 2_000_000_000_000;

function createIndexEntry(
  draftId: string,
  overrides: Partial<SessionDraftIndexEntry> = {}
): SessionDraftIndexEntry {
  const mode = overrides.mode ?? 'reader';
  const pageKey = overrides.pageKey ?? `${mode}-page-${draftId}`;
  return {
    key: `aiob.sessionDraft.v1.${mode}.${pageKey}.${draftId}`,
    draftId,
    mode,
    pageKey,
    updatedAt: overrides.updatedAt ?? BASE_TIME,
    expiresAt: overrides.expiresAt ?? BASE_TIME + DAY_MS,
    status: overrides.status ?? 'restorable',
    ...(overrides.ownerContext ? { ownerContext: overrides.ownerContext } : {})
  };
}

describe('session draft retention policy', () => {
  it('defines Free restore limits and uses them as the default policy', () => {
    expect(FREE_SESSION_DRAFT_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
    expect(FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES).toBe(5);
    expect(FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE).toBe(20);
    expect(FREE_SESSION_DRAFT_RETENTION_POLICY).toEqual({
      retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
      maxRestorablePages: 5,
      maxItemsPerPage: 20
    });
    expect(DEFAULT_SESSION_DRAFT_RETENTION_POLICY).toEqual(FREE_SESSION_DRAFT_RETENTION_POLICY);
  });

  it('maps the default session draft storage policy to the Free retention window', () => {
    expect(DEFAULT_SESSION_DRAFT_STORAGE_POLICY).toEqual({
      retentionPolicy: FREE_SESSION_DRAFT_RETENTION_POLICY,
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

  it('maps an injected partial policy to a complete storage policy', () => {
    const customRetentionPolicy = {
      retentionMs: 123_456,
      maxRestorablePages: null,
      maxItemsPerPage: null
    };

    const storagePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: customRetentionPolicy
    });

    expect(storagePolicy.retentionPolicy).toEqual(customRetentionPolicy);
    expect(storagePolicy.maxDraftEntries).toBe(SESSION_DRAFT_MAX_ENTRIES);
    expect(storagePolicy.maxEnvelopeBytes).toBe(SESSION_DRAFT_MAX_ENVELOPE_BYTES);
    expect(storagePolicy.videoScreenshotCache).toEqual({
      ttlMs: customRetentionPolicy.retentionMs,
      maxGlobalEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
      maxPageEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
      maxContentBytes: FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES
    });
  });

  it('accepts neutral extended product caps while keeping explicit technical caps', () => {
    const storagePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 987_654,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      maxDraftEntries: 13,
      maxEnvelopeBytes: 128 * 1024,
      videoScreenshotCache: {
        ttlMs: 654_321,
        maxGlobalEntries: 21,
        maxPageEntries: 7,
        maxContentBytes: 384 * 1024
      }
    });

    expect(storagePolicy).toEqual({
      retentionPolicy: {
        retentionMs: 987_654,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      maxDraftEntries: 13,
      maxEnvelopeBytes: 128 * 1024,
      videoScreenshotCache: {
        ttlMs: 654_321,
        maxGlobalEntries: 21,
        maxPageEntries: 7,
        maxContentBytes: 384 * 1024
      }
    });
  });

  it('normalizes invalid injected policy values back to the Free policy', () => {
    const storagePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: -1,
        maxRestorablePages: 0,
        maxItemsPerPage: Number.NaN
      },
      maxDraftEntries: 0,
      maxEnvelopeBytes: Number.POSITIVE_INFINITY,
      videoScreenshotCache: {
        ttlMs: -1,
        maxGlobalEntries: Number.NaN,
        maxPageEntries: 0,
        maxContentBytes: Number.NEGATIVE_INFINITY
      }
    });

    expect(storagePolicy.retentionPolicy).toEqual(FREE_SESSION_DRAFT_RETENTION_POLICY);
    expect(storagePolicy.maxDraftEntries).toBe(SESSION_DRAFT_MAX_ENTRIES);
    expect(storagePolicy.maxEnvelopeBytes).toBe(SESSION_DRAFT_MAX_ENVELOPE_BYTES);
    expect(storagePolicy.videoScreenshotCache).toEqual({
      ttlMs: FREE_SESSION_DRAFT_RETENTION_MS,
      maxGlobalEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
      maxPageEntries: FREE_VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
      maxContentBytes: FREE_VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES
    });
  });

  it('computes effective expiry from the shorter stored expiry and retention window', () => {
    const longStoredExpiry = createIndexEntry('long-stored-expiry', {
      updatedAt: BASE_TIME,
      expiresAt: BASE_TIME + 10 * DAY_MS
    });
    const shortStoredExpiry = createIndexEntry('short-stored-expiry', {
      updatedAt: BASE_TIME,
      expiresAt: BASE_TIME + 1_000
    });

    expect(
      getSessionDraftEffectiveExpiresAt(longStoredExpiry, FREE_SESSION_DRAFT_RETENTION_POLICY)
    ).toBe(BASE_TIME + FREE_SESSION_DRAFT_RETENTION_MS);
    expect(
      getSessionDraftEffectiveExpiresAt(shortStoredExpiry, FREE_SESSION_DRAFT_RETENTION_POLICY)
    ).toBe(BASE_TIME + 1_000);
  });

  it('keeps only the five newest restorable page identities', () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      createIndexEntry(`restorable-${index}`, {
        mode: index % 2 === 0 ? 'reader' : 'video',
        pageKey: `page-${index}`,
        updatedAt: BASE_TIME + index
      })
    );

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy(entries, BASE_TIME - 1, {
      policy: FREE_SESSION_DRAFT_RETENTION_POLICY,
      maxEntries: 100
    });

    expect(result.entries.map((entry) => entry.draftId)).toEqual([
      'restorable-5',
      'restorable-4',
      'restorable-3',
      'restorable-2',
      'restorable-1'
    ]);
    expect(result.removedKeys).toEqual([entries[0]?.key]);
    expect(result.dirty).toBe(true);
  });

  it('prunes entries whose updatedAt falls outside the retention window even with future expiresAt', () => {
    const stale = createIndexEntry('legacy-long-expiry', {
      updatedAt: BASE_TIME - FREE_SESSION_DRAFT_RETENTION_MS - 1,
      expiresAt: BASE_TIME + DAY_MS
    });

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy([stale], BASE_TIME, {
      policy: FREE_SESSION_DRAFT_RETENTION_POLICY,
      maxEntries: 100
    });

    expect(result.entries).toEqual([]);
    expect(result.removedKeys).toEqual([stale.key]);
    expect(result.dirty).toBe(true);
  });

  it('removes every restorable entry for an over-limit page identity', () => {
    const oldPageFirst = createIndexEntry('old-page-first', {
      pageKey: 'old-page',
      updatedAt: BASE_TIME
    });
    const oldPageSecond = createIndexEntry('old-page-second', {
      pageKey: 'old-page',
      updatedAt: BASE_TIME + 1
    });
    const newerPages = Array.from({ length: 5 }, (_, index) =>
      createIndexEntry(`new-page-${index}`, {
        pageKey: `new-page-${index}`,
        updatedAt: BASE_TIME + 10 + index
      })
    );

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy(
      [oldPageFirst, oldPageSecond, ...newerPages],
      BASE_TIME - 1,
      {
        policy: FREE_SESSION_DRAFT_RETENTION_POLICY,
        maxEntries: 100
      }
    );

    expect(result.entries.map((entry) => entry.draftId)).not.toContain('old-page-first');
    expect(result.entries.map((entry) => entry.draftId)).not.toContain('old-page-second');
    expect(result.removedKeys.sort()).toEqual([oldPageFirst.key, oldPageSecond.key].sort());
  });

  it('does not count terminal drafts against the Free page quota', () => {
    const restorablePages = Array.from({ length: 5 }, (_, index) =>
      createIndexEntry(`restorable-${index}`, {
        pageKey: `restorable-page-${index}`,
        updatedAt: BASE_TIME + index,
        status: 'restorable'
      })
    );
    const terminalPages = [
      createIndexEntry('discarded-terminal', {
        pageKey: 'terminal-page-a',
        updatedAt: BASE_TIME + 100,
        status: 'discarded'
      }),
      createIndexEntry('exported-terminal', {
        mode: 'video',
        pageKey: 'terminal-page-b',
        updatedAt: BASE_TIME + 101,
        status: 'exported'
      })
    ];

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy(
      [...restorablePages, ...terminalPages],
      BASE_TIME - 1,
      {
        policy: FREE_SESSION_DRAFT_RETENTION_POLICY,
        maxEntries: 100
      }
    );

    expect(result.entries.map((entry) => entry.draftId).sort()).toEqual(
      [...restorablePages, ...terminalPages].map((entry) => entry.draftId).sort()
    );
  });

  it('still applies the technical max entries cap after policy page pruning', () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      createIndexEntry(`restorable-${index}`, {
        pageKey: `page-${index}`,
        updatedAt: BASE_TIME + index
      })
    );

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy(entries, BASE_TIME - 1, {
      policy: FREE_SESSION_DRAFT_RETENTION_POLICY,
      maxEntries: 3
    });

    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((entry) => entry.draftId)).toEqual([
      'restorable-5',
      'restorable-4',
      'restorable-3'
    ]);
  });

  it('selects the newest Free item window while preserving stable retained order', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`,
      createdAt: BASE_TIME + index
    }));

    const retained = selectRetainedSessionDraftItems(items, FREE_SESSION_DRAFT_RETENTION_POLICY);

    expect(retained.map((item) => item.id)).toEqual(
      Array.from(
        { length: FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE },
        (_, index) => `item-${index + 5}`
      )
    );
    expect(items).toHaveLength(25);
  });

  it('uses generic null item caps as unlimited without product-specific state', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: `item-${index}`,
      createdAt: BASE_TIME + index
    }));

    const retained = selectRetainedSessionDraftItems(items, {
      retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
      maxRestorablePages: null,
      maxItemsPerPage: null
    });

    expect(retained.map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it('uses generic null page caps as unlimited without product-specific state', () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      createIndexEntry(`restorable-${index}`, {
        pageKey: `page-${index}`,
        updatedAt: BASE_TIME + index
      })
    );

    const result = pruneSessionDraftIndexEntriesForRetentionPolicy(entries, BASE_TIME - 1, {
      policy: {
        retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
        maxRestorablePages: null,
        maxItemsPerPage: FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE
      },
      maxEntries: 100
    });

    expect(result.entries.map((entry) => entry.draftId)).toEqual(
      entries.map((entry) => entry.draftId).reverse()
    );
    expect(result.removedKeys).toEqual([]);
    expect(result.dirty).toBe(false);
  });

  it('filters comment drafts to retained item ids', () => {
    expect(
      filterSessionCommentDraftsForRetainedIds(
        {
          'item-1': 'kept',
          'item-2': 'dropped',
          'item-3': 'also kept'
        },
        ['item-1', 'item-3']
      )
    ).toEqual({
      'item-1': 'kept',
      'item-3': 'also kept'
    });
  });
});
