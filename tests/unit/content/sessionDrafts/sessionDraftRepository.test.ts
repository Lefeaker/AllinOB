import { describe, expect, it, vi } from 'vitest';
import {
  FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
  FREE_SESSION_DRAFT_RETENTION_MS,
  SESSION_DRAFT_MAX_ENVELOPE_BYTES,
  createSessionDraftStoragePolicy
} from '@content/sessionDrafts';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import {
  SESSION_DRAFT_INDEX_KEY,
  createSessionDraftPageKey,
  createSessionDraftStorageKey
} from '@content/sessionDrafts/sessionDraftKeys';
import type {
  SessionDraftEnvelope,
  SessionDraftIndexEntry,
  SessionDraftMode,
  SessionDraftOwnerContext
} from '@content/sessionDrafts/sessionDraftTypes';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';

const BASE_TIME = 2_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_A: SessionDraftOwnerContext = { tabId: 11, windowId: 1, frameId: 0 };
const OWNER_B: SessionDraftOwnerContext = { tabId: 22, windowId: 2, frameId: 0 };
const OWNER_C: SessionDraftOwnerContext = { tabId: 33, windowId: 3, frameId: 0 };

function createEnvelope(
  mode: SessionDraftMode,
  overrides: Partial<SessionDraftEnvelope> = {}
): SessionDraftEnvelope {
  const pageUrl =
    overrides.pageUrl ??
    (mode === 'reader'
      ? 'https://example.com/post#:~:text=Alpha'
      : 'https://video.example/watch?v=1');
  const updatedAt = overrides.updatedAt ?? BASE_TIME + 10;
  const pageKey = createSessionDraftPageKey(mode, pageUrl);

  const base = {
    schemaVersion: 1,
    draftId: overrides.draftId ?? `${mode}-${updatedAt}`,
    pageKey,
    pageUrl,
    pageTitle: overrides.pageTitle ?? `${mode} title`,
    createdAt: overrides.createdAt ?? updatedAt - 1,
    updatedAt,
    expiresAt: overrides.expiresAt ?? updatedAt + 7 * 24 * 60 * 60 * 1000,
    status: overrides.status ?? 'active'
  } satisfies Omit<SessionDraftEnvelope, 'mode' | 'payload'>;
  const payload = overrides.payload ?? {
    commentDrafts: {
      [`${mode}-comment`]: `draft-${updatedAt}`
    }
  };

  if (mode === 'reader') {
    return {
      ...base,
      mode: 'reader',
      payload
    };
  }

  return {
    ...base,
    mode: 'video',
    payload
  };
}

function createIndexEntry(envelope: SessionDraftEnvelope): SessionDraftIndexEntry {
  return {
    key: createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    }),
    draftId: envelope.draftId,
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    updatedAt: envelope.updatedAt,
    expiresAt: envelope.expiresAt,
    status: envelope.status,
    ...(envelope.payload.ownerContext ? { ownerContext: envelope.payload.ownerContext } : {})
  };
}

describe('sessionDraftRepository', () => {
  it('save stores the envelope and updates the draft index', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', {
      draftId: 'reader-1',
      updatedAt: BASE_TIME + 100
    });

    await repository.save(envelope);

    const storageKey = createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    });
    await expect(storage.get(storageKey)).resolves.toMatchObject({ draftId: 'reader-1' });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      schemaVersion: 1,
      entries: [expect.objectContaining({ draftId: 'reader-1', key: storageKey })]
    });
  });

  it('stores discarded reader drafts in the index but excludes them from loadLatest', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', {
      draftId: 'discarded-reader',
      pageUrl: 'https://example.com/post/discarded',
      updatedAt: BASE_TIME + 101,
      status: 'discarded'
    });
    const storageKey = createIndexEntry(envelope).key;

    await repository.save(envelope);

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'discarded-reader',
      status: 'discarded'
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      schemaVersion: 1,
      entries: [expect.objectContaining({ draftId: 'discarded-reader', status: 'discarded' })]
    });
    await expect(
      repository.loadLatest('reader', envelope.pageUrl, BASE_TIME + 102)
    ).resolves.toBeNull();
  });

  it('normalizes saved draft expiry to the Free 48-hour retention window by default', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', {
      draftId: 'free-expiry',
      updatedAt: BASE_TIME + 130,
      expiresAt: BASE_TIME + 130
    });
    const storageKey = createIndexEntry(envelope).key;

    await repository.save(envelope);

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'free-expiry',
      expiresAt: BASE_TIME + 130 + FREE_SESSION_DRAFT_RETENTION_MS
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          draftId: 'free-expiry',
          expiresAt: BASE_TIME + 130 + FREE_SESSION_DRAFT_RETENTION_MS
        })
      ]
    });
  });

  it('caps saved future expiry to the Free 48-hour retention window by default', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const updatedAt = BASE_TIME + 140;
    const envelope = createEnvelope('reader', {
      draftId: 'free-future-expiry',
      updatedAt,
      expiresAt: updatedAt + FREE_SESSION_DRAFT_RETENTION_MS + DAY_MS
    });
    const storageKey = createIndexEntry(envelope).key;

    await repository.save(envelope);

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'free-future-expiry',
      expiresAt: updatedAt + FREE_SESSION_DRAFT_RETENTION_MS
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          draftId: 'free-future-expiry',
          expiresAt: updatedAt + FREE_SESSION_DRAFT_RETENTION_MS
        })
      ]
    });
  });

  it('does not delete the refreshed envelope when saving over an expired same-key index row', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const now = BASE_TIME + 500;
    const pageUrl = 'https://example.com/post/refresh-same-key';
    const oldEnvelope = createEnvelope('reader', {
      draftId: 'refresh-same-key',
      pageUrl,
      updatedAt: now - 100,
      expiresAt: now,
      payload: {
        commentDrafts: {
          note: 'old draft'
        }
      }
    });
    const newEnvelope = createEnvelope('reader', {
      draftId: oldEnvelope.draftId,
      pageUrl,
      updatedAt: now + 1,
      expiresAt: now + 1,
      payload: {
        commentDrafts: {
          note: 'new draft'
        }
      }
    });
    const storageKey = createIndexEntry(oldEnvelope).key;

    await storage.setMany({
      [storageKey]: oldEnvelope,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(oldEnvelope)]
      }
    });

    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await repository.save(newEnvelope);
    } finally {
      dateNowSpy.mockRestore();
    }

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'refresh-same-key',
      updatedAt: now + 1,
      expiresAt: now + 1 + FREE_SESSION_DRAFT_RETENTION_MS,
      payload: {
        commentDrafts: {
          note: 'new draft'
        }
      }
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          key: storageKey,
          draftId: 'refresh-same-key',
          expiresAt: now + 1 + FREE_SESSION_DRAFT_RETENTION_MS
        })
      ]
    });
    await expect(repository.loadLatest('reader', pageUrl, now + 2)).resolves.toMatchObject({
      draftId: 'refresh-same-key',
      updatedAt: now + 1
    });
  });

  it('does not restore drafts older than the default Free 48-hour window', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const now = BASE_TIME + 10 * DAY_MS;
    const expired = createEnvelope('reader', {
      draftId: 'free-expired',
      pageUrl: 'https://example.com/post/free-expired',
      updatedAt: now - FREE_SESSION_DRAFT_RETENTION_MS - 1,
      expiresAt: now - FREE_SESSION_DRAFT_RETENTION_MS - 1,
      status: 'restorable'
    });
    const expiredKey = createIndexEntry(expired).key;

    await repository.save(expired);

    await expect(repository.loadLatest('reader', expired.pageUrl, now)).resolves.toBeNull();
    await expect(storage.get(expiredKey)).resolves.toBeUndefined();
  });

  it('does not let a legacy long expiresAt bypass the Free 48-hour updatedAt window', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const now = BASE_TIME + 20 * DAY_MS;
    const stale = createEnvelope('reader', {
      draftId: 'legacy-long-expiry',
      pageUrl: 'https://example.com/post/legacy-long-expiry',
      updatedAt: now - FREE_SESSION_DRAFT_RETENTION_MS - 1,
      expiresAt: now + DAY_MS,
      status: 'restorable'
    });
    const staleKey = createIndexEntry(stale).key;

    await storage.setMany({
      [staleKey]: stale,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(stale)]
      }
    });

    await expect(repository.loadLatest('reader', stale.pageUrl, now)).resolves.toBeNull();
    await expect(storage.get(staleKey)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: []
    });
  });

  it('applies policy-provided draft entry and envelope technical caps', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage, {
      storagePolicy: createSessionDraftStoragePolicy({
        retentionPolicy: {
          retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
          maxRestorablePages: null,
          maxItemsPerPage: null
        },
        maxDraftEntries: 2,
        maxEnvelopeBytes: 1_024
      })
    });

    await repository.save(
      createEnvelope('reader', {
        draftId: 'policy-entry-1',
        pageUrl: 'https://example.com/post/policy-entry-1',
        updatedAt: BASE_TIME + 1,
        expiresAt: BASE_TIME + 1,
        status: 'restorable',
        payload: { commentDrafts: { a: '1' } }
      })
    );
    await repository.save(
      createEnvelope('reader', {
        draftId: 'policy-entry-2',
        pageUrl: 'https://example.com/post/policy-entry-2',
        updatedAt: BASE_TIME + 2,
        expiresAt: BASE_TIME + 2,
        status: 'restorable',
        payload: { commentDrafts: { b: '2' } }
      })
    );
    await repository.save(
      createEnvelope('reader', {
        draftId: 'policy-entry-3',
        pageUrl: 'https://example.com/post/policy-entry-3',
        updatedAt: BASE_TIME + 3,
        expiresAt: BASE_TIME + 3,
        status: 'restorable',
        payload: { commentDrafts: { c: '3' } }
      })
    );

    await expect(
      storage.get(
        createIndexEntry(
          createEnvelope('reader', {
            draftId: 'policy-entry-1',
            pageUrl: 'https://example.com/post/policy-entry-1'
          })
        ).key
      )
    ).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ draftId: 'policy-entry-3' }),
        expect.objectContaining({ draftId: 'policy-entry-2' })
      ]
    });

    await expect(
      repository.save(
        createEnvelope('reader', {
          draftId: 'policy-envelope-too-large',
          pageUrl: 'https://example.com/post/policy-envelope-too-large',
          updatedAt: BASE_TIME + 4,
          expiresAt: BASE_TIME + 4,
          payload: { commentDrafts: { large: 'x'.repeat(2_048) } }
        })
      )
    ).rejects.toThrow('storage limit');
  });

  it('applies a lone legacy entry override while preserving the default envelope cap', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage, { maxEntries: 1 });
    const first = createEnvelope('reader', {
      draftId: 'legacy-entry-first',
      pageUrl: 'https://example.com/post/legacy-entry-first',
      updatedAt: BASE_TIME + 20,
      payload: { commentDrafts: { note: 'x'.repeat(2_048) } }
    });
    const second = createEnvelope('reader', {
      draftId: 'legacy-entry-second',
      pageUrl: 'https://example.com/post/legacy-entry-second',
      updatedAt: BASE_TIME + 21,
      payload: { commentDrafts: { note: 'y'.repeat(2_048) } }
    });
    const oversized = createEnvelope('reader', {
      draftId: 'legacy-entry-oversized',
      pageUrl: 'https://example.com/post/legacy-entry-oversized',
      updatedAt: BASE_TIME + 22,
      payload: {
        commentDrafts: { note: 'z'.repeat(SESSION_DRAFT_MAX_ENVELOPE_BYTES + 1) }
      }
    });

    await repository.save(first);
    await repository.save(second);

    await expect(storage.get(createIndexEntry(first).key)).resolves.toBeUndefined();
    await expect(storage.get(createIndexEntry(second).key)).resolves.toMatchObject({
      draftId: 'legacy-entry-second'
    });
    await expect(repository.save(oversized)).rejects.toThrow(/configured storage limit/i);
    await expect(storage.get(createIndexEntry(oversized).key)).resolves.toBeUndefined();
    await expect(storage.get(createIndexEntry(second).key)).resolves.toMatchObject({
      draftId: 'legacy-entry-second'
    });
  });

  it('does not restore a stale envelope even when its index row still looks fresh', async () => {
    const now = BASE_TIME + 30 * DAY_MS;
    const stale = createEnvelope('reader', {
      draftId: 'fresh-index-stale-envelope',
      pageUrl: 'https://example.com/post/fresh-index-stale-envelope',
      updatedAt: now - FREE_SESSION_DRAFT_RETENTION_MS - 1,
      expiresAt: now + DAY_MS,
      status: 'restorable'
    });
    const staleKey = createIndexEntry(stale).key;
    const freshIndexEntry = {
      ...createIndexEntry(stale),
      updatedAt: now,
      expiresAt: now + DAY_MS
    };

    const listStorage = createMemoryStorageArea();
    const listRepository = createSessionDraftRepository(listStorage);
    await listStorage.setMany({
      [staleKey]: stale,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [freshIndexEntry]
      }
    });

    await expect(listRepository.listCandidates('reader', stale.pageUrl, now)).resolves.toEqual([]);
    await expect(listStorage.get(staleKey)).resolves.toBeUndefined();
    await expect(listStorage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: []
    });

    const latestStorage = createMemoryStorageArea();
    const latestRepository = createSessionDraftRepository(latestStorage);
    await latestStorage.setMany({
      [staleKey]: stale,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [freshIndexEntry]
      }
    });

    await expect(latestRepository.loadLatest('reader', stale.pageUrl, now)).resolves.toBeNull();
    await expect(latestStorage.get(staleKey)).resolves.toBeUndefined();
    await expect(latestStorage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: []
    });
  });

  it('prunes six unique restorable pages down to the newest five by default', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const saved: SessionDraftEnvelope[] = [];

    for (let index = 0; index < FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES + 1; index += 1) {
      const mode: SessionDraftMode = index % 2 === 0 ? 'reader' : 'video';
      const envelope = createEnvelope(mode, {
        draftId: `page-${index}`,
        pageUrl:
          mode === 'reader'
            ? `https://example.com/post/${index}`
            : `https://video.example/watch?v=${index}`,
        updatedAt: BASE_TIME + 200 + index,
        expiresAt: BASE_TIME + 200 + index,
        status: 'restorable'
      });
      saved.push(envelope);
      await repository.save(envelope);
    }

    const indexState = (await storage.get<{
      schemaVersion: number;
      entries: SessionDraftIndexEntry[];
    }>(SESSION_DRAFT_INDEX_KEY)) ?? { schemaVersion: 1, entries: [] };

    expect(indexState.entries.map((entry) => entry.draftId)).toEqual([
      'page-5',
      'page-4',
      'page-3',
      'page-2',
      'page-1'
    ]);
    await expect(storage.get(createIndexEntry(saved[0]!).key)).resolves.toBeUndefined();
    await expect(
      repository.loadLatest(saved[0]!.mode, saved[0]!.pageUrl, BASE_TIME + 300)
    ).resolves.toBeNull();
  });

  it('does not count terminal drafts toward the default Free five-page quota', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);

    for (let index = 0; index < FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES; index += 1) {
      await repository.save(
        createEnvelope('reader', {
          draftId: `restorable-${index}`,
          pageUrl: `https://example.com/post/restorable-${index}`,
          updatedAt: BASE_TIME + 310 + index,
          expiresAt: BASE_TIME + 310 + index,
          status: 'restorable'
        })
      );
    }

    await repository.save(
      createEnvelope('reader', {
        draftId: 'discarded-terminal',
        pageUrl: 'https://example.com/post/discarded-terminal',
        updatedAt: BASE_TIME + 400,
        expiresAt: BASE_TIME + 400,
        status: 'discarded'
      })
    );
    await repository.save(
      createEnvelope('video', {
        draftId: 'exported-terminal',
        pageUrl: 'https://video.example/watch?v=exported-terminal',
        updatedAt: BASE_TIME + 401,
        expiresAt: BASE_TIME + 401,
        status: 'exported'
      })
    );

    const indexState = (await storage.get<{
      schemaVersion: number;
      entries: SessionDraftIndexEntry[];
    }>(SESSION_DRAFT_INDEX_KEY)) ?? { schemaVersion: 1, entries: [] };

    expect(indexState.entries.map((entry) => entry.draftId).sort()).toEqual([
      'discarded-terminal',
      'exported-terminal',
      'restorable-0',
      'restorable-1',
      'restorable-2',
      'restorable-3',
      'restorable-4'
    ]);
  });

  it('can retain an older draft through an injected custom long retention policy', async () => {
    const storage = createMemoryStorageArea();
    const customLongRetentionPolicy = {
      retentionMs: 10 * DAY_MS,
      maxRestorablePages: null,
      maxItemsPerPage: null
    };
    const repository = createSessionDraftRepository(storage, {
      retentionPolicy: customLongRetentionPolicy
    });
    const now = BASE_TIME + 40 * DAY_MS;
    const customRetainedDraft = createEnvelope('reader', {
      draftId: 'custom-retained',
      pageUrl: 'https://example.com/post/custom-retained',
      updatedAt: now - 5 * DAY_MS,
      expiresAt: now - 5 * DAY_MS,
      status: 'restorable'
    });

    await repository.save(customRetainedDraft);

    await expect(
      repository.loadLatest('reader', customRetainedDraft.pageUrl, now)
    ).resolves.toMatchObject({
      draftId: 'custom-retained',
      expiresAt: now + 5 * DAY_MS
    });
  });

  it('caps saved future expiry to an injected custom retention window', async () => {
    const storage = createMemoryStorageArea();
    const customRetentionPolicy = {
      retentionMs: 10 * DAY_MS,
      maxRestorablePages: null,
      maxItemsPerPage: null
    };
    const repository = createSessionDraftRepository(storage, {
      retentionPolicy: customRetentionPolicy
    });
    const updatedAt = BASE_TIME + 50 * DAY_MS;
    const envelope = createEnvelope('reader', {
      draftId: 'custom-future-expiry',
      pageUrl: 'https://example.com/post/custom-future-expiry',
      updatedAt,
      expiresAt: updatedAt + 20 * DAY_MS,
      status: 'restorable'
    });
    const storageKey = createIndexEntry(envelope).key;

    await repository.save(envelope);

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'custom-future-expiry',
      expiresAt: updatedAt + customRetentionPolicy.retentionMs
    });
    await expect(
      repository.loadLatest('reader', envelope.pageUrl, updatedAt + 9 * DAY_MS)
    ).resolves.toMatchObject({
      draftId: 'custom-future-expiry'
    });
  });

  it('stores exported video drafts in the index but excludes them from listCandidates', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('video', {
      draftId: 'exported-video',
      pageUrl: 'https://video.example/watch?v=exported',
      updatedAt: BASE_TIME + 111,
      status: 'exported'
    });
    const storageKey = createIndexEntry(envelope).key;

    await repository.save(envelope);

    await expect(storage.get(storageKey)).resolves.toMatchObject({
      draftId: 'exported-video',
      status: 'exported'
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      schemaVersion: 1,
      entries: [expect.objectContaining({ draftId: 'exported-video', status: 'exported' })]
    });
    await expect(
      repository.listCandidates('video', envelope.pageUrl, BASE_TIME + 112)
    ).resolves.toEqual([]);
  });

  it('returns the restorable same-page draft when a newer terminal draft also exists', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const pageUrl = 'https://example.com/post/terminal-and-restorable';
    const restorable = createEnvelope('reader', {
      draftId: 'restorable-same-page',
      pageUrl,
      updatedAt: BASE_TIME + 120,
      status: 'restorable'
    });
    const terminal = createEnvelope('reader', {
      draftId: 'terminal-same-page',
      pageUrl,
      updatedAt: BASE_TIME + 121,
      status: 'discarded'
    });

    await repository.save(restorable);
    await repository.save(terminal);

    await expect(repository.loadLatest('reader', pageUrl, BASE_TIME + 122)).resolves.toMatchObject({
      draftId: 'restorable-same-page',
      status: 'restorable'
    });
  });

  it('prunes expired drafts from the index and excludes them from loadLatest', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const expired = createEnvelope('reader', {
      draftId: 'expired',
      updatedAt: 5,
      expiresAt: 9
    });
    const live = createEnvelope('reader', {
      draftId: 'live',
      updatedAt: 7,
      expiresAt: 20
    });
    const expiredKey = createIndexEntry(expired).key;
    const liveKey = createIndexEntry(live).key;

    await storage.setMany({
      [expiredKey]: expired,
      [liveKey]: live,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(live), createIndexEntry(expired)]
      }
    });

    await expect(repository.loadLatest('reader', live.pageUrl, 10)).resolves.toMatchObject({
      draftId: 'live'
    });
    await expect(storage.get(expiredKey)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      entries: [expect.objectContaining({ draftId: 'live' })]
    });
  });

  it('remove deletes both the envelope record and its index entry', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('video', {
      draftId: 'video-1',
      updatedAt: BASE_TIME + 200
    });
    const key = createIndexEntry(envelope).key;

    await repository.save(envelope);
    await repository.remove(envelope.draftId);

    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({
      schemaVersion: 1,
      entries: []
    });
  });

  it('ignores malformed stored envelopes and prunes their index entries', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', { draftId: 'broken', updatedAt: 50 });
    const key = createIndexEntry(envelope).key;

    await storage.setMany({
      [key]: {
        schemaVersion: 1,
        draftId: 'broken',
        mode: 'reader',
        pageKey: envelope.pageKey,
        pageUrl: envelope.pageUrl,
        pageTitle: envelope.pageTitle,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
        expiresAt: envelope.expiresAt,
        status: envelope.status,
        payload: 'not-an-object'
      },
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(envelope)]
      }
    });

    await expect(repository.loadLatest('reader', envelope.pageUrl, 40)).resolves.toBeNull();
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({ entries: [] });
  });

  it('ignores and prunes wrong-mode or mismatched key recovery entries', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const readerUrl = 'https://example.com/post#:~:text=Alpha';
    const envelope = createEnvelope('video', {
      draftId: 'mismatch',
      updatedAt: BASE_TIME + 300
    });
    const mismatchedEntry: SessionDraftIndexEntry = {
      ...createIndexEntry(envelope),
      key: 'aiob.sessionDraft.v1.reader.reader-page.mismatch',
      mode: 'reader',
      pageKey: createSessionDraftPageKey('reader', readerUrl)
    };

    await storage.setMany({
      [mismatchedEntry.key]: envelope,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [mismatchedEntry]
      }
    });

    await expect(repository.loadLatest('reader', readerUrl, BASE_TIME + 301)).resolves.toBeNull();
    await expect(storage.get(mismatchedEntry.key)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({ entries: [] });
  });

  it('pruneExpired removes expired entries and envelopes without loading a session', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const expired = createEnvelope('reader', {
      draftId: 'expired-prune',
      updatedAt: 5,
      expiresAt: 9
    });
    const key = createIndexEntry(expired).key;

    await storage.setMany({
      [key]: expired,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(expired)]
      }
    });

    await repository.pruneExpired(10);

    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({ entries: [] });
  });

  it('ignores unknown schema versions instead of throwing during recovery', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', {
      draftId: 'unknown-schema',
      updatedAt: BASE_TIME + 400
    });
    const key = createIndexEntry(envelope).key;

    await storage.setMany({
      [key]: {
        ...envelope,
        schemaVersion: 2
      },
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [createIndexEntry(envelope)]
      }
    });

    await expect(
      repository.loadLatest('reader', envelope.pageUrl, BASE_TIME + 401)
    ).resolves.toBeNull();
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toMatchObject({ entries: [] });
  });

  it('dedupes duplicate index rows without deleting the retained envelope key', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const envelope = createEnvelope('reader', {
      draftId: 'duplicate-row',
      updatedAt: BASE_TIME + 450
    });
    const entry = createIndexEntry(envelope);

    await storage.setMany({
      [entry.key]: envelope,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [entry, { ...entry }]
      }
    });

    await expect(
      repository.loadLatest('reader', envelope.pageUrl, BASE_TIME + 451)
    ).resolves.toMatchObject({
      draftId: 'duplicate-row'
    });
    await expect(storage.get(entry.key)).resolves.toMatchObject({
      draftId: 'duplicate-row'
    });
    await expect(storage.get(SESSION_DRAFT_INDEX_KEY)).resolves.toEqual({
      schemaVersion: 1,
      entries: [expect.objectContaining({ key: entry.key, draftId: 'duplicate-row' })]
    });
  });

  it('rejects oversized envelopes before writing to storage', async () => {
    const storage = createMemoryStorageArea();
    const setSpy = vi.spyOn(storage, 'set');
    const setManySpy = vi.spyOn(storage, 'setMany');
    const repository = createSessionDraftRepository(storage);

    await expect(
      repository.save(
        createEnvelope('video', {
          payload: {
            binaryLike: 'x'.repeat(520 * 1024)
          }
        })
      )
    ).rejects.toThrow(/storage limit/i);

    expect(setSpy).not.toHaveBeenCalled();
    expect(setManySpy).not.toHaveBeenCalled();
  });

  it('rejects payload fields that contain data image urls before writing', async () => {
    const storage = createMemoryStorageArea();
    const setManySpy = vi.spyOn(storage, 'setMany');
    const repository = createSessionDraftRepository(storage);

    await expect(
      repository.save(
        createEnvelope('video', {
          payload: {
            screenshotIntent: {
              dataUrl: 'data:image/png;base64,shot'
            }
          }
        })
      )
    ).rejects.toThrow(/data:image\//i);

    expect(setManySpy).not.toHaveBeenCalled();
  });

  it('keeps at most 100 index entries and drops non-active drafts first', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage, {
      retentionPolicy: {
        retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
        maxRestorablePages: null,
        maxItemsPerPage: null
      }
    });

    for (let index = 0; index < 100; index += 1) {
      await repository.save(
        createEnvelope('reader', {
          draftId: `active-${index}`,
          pageUrl: `https://example.com/post/${index}`,
          updatedAt: BASE_TIME + index,
          status: 'active'
        })
      );
    }

    for (let index = 0; index < 2; index += 1) {
      await repository.save(
        createEnvelope('reader', {
          draftId: `restorable-${index}`,
          pageUrl: `https://example.com/restorable/${index}`,
          updatedAt: BASE_TIME + 1000 + index,
          status: 'restorable'
        })
      );
    }

    const indexState = (await storage.get<{
      schemaVersion: number;
      entries: SessionDraftIndexEntry[];
    }>(SESSION_DRAFT_INDEX_KEY)) ?? { schemaVersion: 1, entries: [] };

    expect(indexState.schemaVersion).toBe(1);
    expect(indexState.entries).toHaveLength(100);
    expect(indexState.entries.every((entry) => entry.status === 'active')).toBe(true);
  });

  it('keeps same draft ids on different pages instead of collapsing them globally', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const first = createEnvelope('reader', {
      draftId: 'shared-id',
      pageUrl: 'https://example.com/post/one#:~:text=Alpha',
      updatedAt: BASE_TIME + 600
    });
    const second = createEnvelope('reader', {
      draftId: 'shared-id',
      pageUrl: 'https://example.com/post/two#:~:text=Beta',
      updatedAt: BASE_TIME + 601
    });

    await repository.save(first);
    await repository.save(second);

    const indexState = (await storage.get<{
      schemaVersion: number;
      entries: SessionDraftIndexEntry[];
    }>(SESSION_DRAFT_INDEX_KEY)) ?? { schemaVersion: 1, entries: [] };

    expect(indexState.entries.filter((entry) => entry.draftId === 'shared-id')).toHaveLength(2);
    await expect(
      repository.loadLatest('reader', first.pageUrl, BASE_TIME + 602)
    ).resolves.toMatchObject({
      pageUrl: first.pageUrl
    });
    await expect(
      repository.loadLatest('reader', second.pageUrl, BASE_TIME + 602)
    ).resolves.toMatchObject({
      pageUrl: second.pageUrl
    });
  });

  it('prefers the same-owner draft over a newer restorable draft from another tab context', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const pageUrl = 'https://example.com/post/shared';
    const sameOwner = createEnvelope('reader', {
      draftId: 'same-owner',
      pageUrl,
      updatedAt: BASE_TIME + 700,
      status: 'restorable'
    });
    const newerOtherOwner = createEnvelope('reader', {
      draftId: 'newer-other-owner',
      pageUrl,
      updatedAt: BASE_TIME + 701,
      status: 'restorable'
    });

    await repository.save(sameOwner, { ownerContext: OWNER_A });
    await repository.save(newerOtherOwner, { ownerContext: OWNER_B });

    await expect(
      repository.loadLatest('reader', pageUrl, BASE_TIME + 702, { ownerContext: OWNER_A })
    ).resolves.toMatchObject({
      draftId: 'same-owner',
      payload: {
        ownerContext: OWNER_A
      }
    });
  });

  it('claims the newest restorable page-key draft when no owner matches the current tab context', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const pageUrl = 'https://example.com/post/restartable';
    const older = createEnvelope('reader', {
      draftId: 'older-restorable',
      pageUrl,
      updatedAt: BASE_TIME + 710,
      status: 'restorable'
    });
    const newer = createEnvelope('reader', {
      draftId: 'newer-restorable',
      pageUrl,
      updatedAt: BASE_TIME + 711,
      status: 'restorable'
    });

    await repository.save(older, { ownerContext: OWNER_A });
    await repository.save(newer, { ownerContext: OWNER_B });

    const selected = await repository.loadLatest('reader', pageUrl, BASE_TIME + 712, {
      ownerContext: OWNER_C
    });

    expect(selected).toMatchObject({
      draftId: 'newer-restorable',
      payload: {
        ownerContext: OWNER_C
      }
    });

    const selectedKey = createSessionDraftStorageKey({
      mode: 'reader',
      pageKey: createSessionDraftPageKey('reader', pageUrl),
      draftId: 'newer-restorable'
    });
    await expect(storage.get(selectedKey)).resolves.toMatchObject({
      payload: {
        ownerContext: OWNER_C
      }
    });
  });

  it('keeps same-url active drafts separated by owner context instead of collapsing them', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage, {
      isOwnerContextActive: vi.fn(() => Promise.resolve(true))
    });
    const pageUrl = 'https://example.com/post/multi-tab';
    const first = createEnvelope('reader', {
      draftId: 'active-a',
      pageUrl,
      updatedAt: BASE_TIME + 720,
      status: 'active'
    });
    const second = createEnvelope('reader', {
      draftId: 'active-b',
      pageUrl,
      updatedAt: BASE_TIME + 721,
      status: 'active'
    });

    await repository.save(first, { ownerContext: OWNER_A });
    await repository.save(second, { ownerContext: OWNER_B });

    await expect(
      repository.listCandidates('reader', pageUrl, BASE_TIME + 722, { ownerContext: OWNER_A })
    ).resolves.toMatchObject([{ draftId: 'active-a', payload: { ownerContext: OWNER_A } }]);
    await expect(
      repository.listCandidates('reader', pageUrl, BASE_TIME + 722, { ownerContext: OWNER_B })
    ).resolves.toMatchObject([{ draftId: 'active-b', payload: { ownerContext: OWNER_B } }]);
    await expect(
      repository.listCandidates('reader', pageUrl, BASE_TIME + 722, { ownerContext: OWNER_C })
    ).resolves.toEqual([]);
  });

  it('claims an active same-page draft only after the previous owner context is inactive', async () => {
    const storage = createMemoryStorageArea();
    const isOwnerContextActive = vi.fn((ownerContext: SessionDraftOwnerContext) =>
      Promise.resolve(ownerContext.tabId === OWNER_B.tabId)
    );
    const repository = createSessionDraftRepository(storage, { isOwnerContextActive });
    const pageUrl = 'https://example.com/post/closed-tab';
    const closedOwner = createEnvelope('reader', {
      draftId: 'closed-owner-active',
      pageUrl,
      updatedAt: BASE_TIME + 723,
      status: 'active'
    });
    const liveOwner = createEnvelope('reader', {
      draftId: 'live-owner-active',
      pageUrl,
      updatedAt: BASE_TIME + 724,
      status: 'active'
    });

    await repository.save(liveOwner, { ownerContext: OWNER_B });
    await repository.save(closedOwner, { ownerContext: OWNER_A });

    const selected = await repository.listCandidates('reader', pageUrl, BASE_TIME + 725, {
      ownerContext: OWNER_C
    });

    expect(selected).toMatchObject([
      {
        draftId: 'closed-owner-active',
        payload: {
          ownerContext: OWNER_C
        }
      }
    ]);
    expect(isOwnerContextActive).toHaveBeenCalledWith(OWNER_B);
    expect(isOwnerContextActive).toHaveBeenCalledWith(OWNER_A);
  });

  it('restores the latest page-key draft when tab context is unavailable after restart', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const pageUrl = 'https://example.com/post/restart';
    const older = createEnvelope('reader', {
      draftId: 'restart-older',
      pageUrl,
      updatedAt: BASE_TIME + 730,
      status: 'restorable'
    });
    const newer = createEnvelope('reader', {
      draftId: 'restart-newer',
      pageUrl,
      updatedAt: BASE_TIME + 731,
      status: 'restorable'
    });

    await repository.save(older, { ownerContext: OWNER_A });
    await repository.save(newer, { ownerContext: OWNER_B });

    await expect(
      repository.loadLatest('reader', pageUrl, BASE_TIME + 732, { ownerContext: null })
    ).resolves.toMatchObject({
      draftId: 'restart-newer',
      payload: {
        ownerContext: OWNER_B
      }
    });
  });

  it('ignores terminal candidates before any owner-context claim write', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const pageUrl = 'https://example.com/post/terminal-claim';
    const terminal = createEnvelope('reader', {
      draftId: 'terminal-no-owner',
      pageUrl,
      updatedAt: BASE_TIME + 740,
      status: 'discarded'
    });
    const entry = createIndexEntry(terminal);

    await storage.setMany({
      [entry.key]: terminal,
      [SESSION_DRAFT_INDEX_KEY]: {
        schemaVersion: 1,
        entries: [entry]
      }
    });

    const setManySpy = vi.spyOn(storage, 'setMany');

    await expect(
      repository.loadLatest('reader', pageUrl, BASE_TIME + 741, { ownerContext: OWNER_C })
    ).resolves.toBeNull();
    expect(setManySpy).not.toHaveBeenCalled();
    await expect(storage.get(entry.key)).resolves.toMatchObject({
      draftId: 'terminal-no-owner',
      status: 'discarded'
    });
  });
});
