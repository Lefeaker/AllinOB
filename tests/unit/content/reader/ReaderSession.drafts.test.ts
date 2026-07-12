/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup/globalSetup';
import { buildReaderSessionDraftEnvelope } from '@content/reader/sessionDrafts';
import { ReaderSessionDraftController } from '@content/reader/readerSessionDraftController';
import { __resetContentSessionRegistryForTests } from '@content/runtime/contentSessionRegistry';
import {
  createSessionDraftStorageKey,
  type SessionDraftEnvelope,
  type SessionDraftRepository
} from '@content/sessionDrafts';
import type { SessionCommentDraftSnapshot } from '@content/shared/panels/sessionCommentDrafts';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  createPersistedHighlightRecord,
  createSelectionPayload,
  createSessionContext,
  flushDraftPersistence,
  getSessionHarness,
  getTelemetryMessages,
  settleReaderMutation
} from './readerSessionTestHarness';

describe('ReaderSession drafts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = '';
    document.documentElement.removeAttribute('data-aiob-reader-active');
    document.body.removeAttribute('data-aiobReaderHighlight');
    document.body.removeAttribute('data-aiobReaderHighlightTheme');
    __resetContentSessionRegistryForTests(document);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores stored highlights, comment drafts, and destination from the latest reader draft', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    const context = createSessionContext();
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-1',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Restored article',
      destination: { kind: 'vault', vaultId: 'research' },
      highlights: [
        createPersistedHighlightRecord({
          id: 'saved-1',
          selectedText: 'Hello reader session world.',
          selectedHtml: '<mark>Hello reader session world.</mark>',
          comment: 'remember this',
          fragmentUrl: '#saved-1',
          createdAt: 15
        })
      ],
      commentDrafts: {
        'saved-1': 'unsaved note'
      },
      status: 'restorable'
    });
    if (!envelope) {
      throw new Error('expected restorable reader envelope');
    }
    await context.draftRepository.save(envelope);

    await context.session.initialize();

    expect(getSessionHarness(context.session).__testHighlights).toEqual([
      expect.objectContaining({
        id: 'saved-1',
        selectedText: 'Hello reader session world.',
        comment: 'remember this',
        createdAt: 15
      })
    ]);
    expect(context.view.currentDrafts).toEqual({
      'saved-1': 'unsaved note'
    });
    expect(context.view.setHighlights).toHaveBeenLastCalledWith(expect.any(Array), {});
    expect(context.view.updateDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'research',
        kind: 'vault',
        label: 'Research Vault'
      })
    );
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_draft_restored')
    ).toEqual({
      type: 'ANALYTICS_EVENT',
      event: 'reader_draft_restored',
      params: {
        highlight_count_bucket: 'one',
        outcome: 'completed',
        detached_highlight_count_bucket: 'zero',
        duration_bucket: 'under_100ms'
      }
    });

    await flushDraftPersistence();

    await expect(
      context.draftRepository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toMatchObject({
      draftId: 'reader-draft-1',
      status: 'active'
    });
  });

  it('restores the latest reader draft before appending a new initial highlight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    const context = createSessionContext();
    const content = document.getElementById('content')?.firstChild;
    if (!content) {
      throw new Error('content missing');
    }
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-1',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Restored article',
      destination: { kind: 'vault', vaultId: 'research' },
      highlights: [
        createPersistedHighlightRecord({
          id: 'saved-1',
          selectedText: 'Hello reader session world.',
          selectedHtml: '<mark>Hello reader session world.</mark>',
          comment: 'remember this',
          fragmentUrl: '#saved-1',
          createdAt: 15
        })
      ],
      commentDrafts: {
        'saved-1': 'unsaved note'
      },
      status: 'restorable'
    });
    if (!envelope) {
      throw new Error('expected restorable reader envelope');
    }
    await context.draftRepository.save(envelope);

    const range = document.createRange();
    range.setStart(content, 6);
    range.setEnd(content, 20);

    await context.session.initialize({
      range,
      selectedHtml: '<mark>reader session</mark>',
      selectedText: 'reader session',
      comment: 'fresh note',
      destination: { kind: 'downloads' }
    });

    expect(getSessionHarness(context.session).__testHighlights).toEqual([
      expect.objectContaining({
        id: 'saved-1',
        selectedText: 'Hello reader session world.',
        comment: 'remember this',
        createdAt: 15
      }),
      expect.objectContaining({
        selectedText: 'reader session',
        comment: 'fresh note'
      })
    ]);
    expect(context.view.currentDrafts).toEqual({
      'saved-1': 'unsaved note'
    });
    expect(context.view.updateDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'research',
        kind: 'vault',
        label: 'Research Vault'
      })
    );

    await flushDraftPersistence();

    const persistedDraft = await context.draftRepository.loadLatest(
      'reader',
      'https://example.com/article'
    );
    if (!persistedDraft || persistedDraft.mode !== 'reader') {
      throw new Error('reader draft missing');
    }
    expect(persistedDraft.draftId).toBe('reader-draft-1');
    expect(persistedDraft.status).toBe('active');
    expect(persistedDraft.payload.destination).toEqual({
      kind: 'vault',
      vaultId: 'research'
    });
    expect(persistedDraft.payload.commentDrafts).toEqual({
      'saved-1': 'unsaved note'
    });
    const persistedHighlights = persistedDraft.payload.highlights ?? [];
    expect(
      persistedHighlights.some(
        ({ id, selectedText, comment }) =>
          id === 'saved-1' &&
          selectedText === 'Hello reader session world.' &&
          comment === 'remember this'
      )
    ).toBe(true);
    expect(
      persistedHighlights.some(
        ({ selectedText, comment }) => selectedText === 'reader session' && comment === 'fresh note'
      )
    ).toBe(true);
  });

  it('tracks detached highlight counts when a restored reader draft can only hydrate detached rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    const context = createSessionContext();
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-detached',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Detached article',
      destination: { kind: 'downloads' },
      highlights: [
        createPersistedHighlightRecord({
          id: 'detached-1',
          selectedText: 'Missing reader text',
          selectedHtml: '<mark>Missing reader text</mark>',
          comment: 'detached note',
          fragmentUrl: '#detached-1',
          createdAt: 15
        })
      ],
      commentDrafts: {},
      status: 'restorable'
    });
    if (!envelope) {
      throw new Error('expected detached reader envelope');
    }
    await context.draftRepository.save(envelope);

    await context.session.initialize();

    expect(getSessionHarness(context.session).__testHighlights).toEqual([
      expect.objectContaining({
        id: 'detached-1',
        selectedText: 'Missing reader text',
        comment: 'detached note',
        createdAt: 15
      })
    ]);
    expect(getSessionHarness(context.session).__testHighlights[0]?.wrapper.isConnected).toBe(false);
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_draft_restored')
    ).toEqual({
      type: 'ANALYTICS_EVENT',
      event: 'reader_draft_restored',
      params: {
        highlight_count_bucket: 'one',
        outcome: 'completed',
        detached_highlight_count_bucket: 'one',
        duration_bucket: 'under_100ms'
      }
    });
  });

  it('tracks failed draft restore outcomes and removes invalid candidates without hydrating reader state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    const context = createSessionContext();
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-invalid',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Broken article',
      destination: { kind: 'downloads' },
      highlights: [
        createPersistedHighlightRecord({
          id: 'saved-1',
          selectedText: 'Hello reader session world.',
          selectedHtml: '<mark>Hello reader session world.</mark>',
          comment: 'remember this',
          fragmentUrl: '#saved-1',
          createdAt: 15
        })
      ],
      commentDrafts: {
        'saved-1': 'unsaved note'
      },
      status: 'restorable'
    });
    if (!envelope) {
      throw new Error('expected invalid reader envelope');
    }
    await context.draftRepository.save(envelope);
    const invalidDraftStorageKey = createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    });
    await context.storageLocal.set(invalidDraftStorageKey, {
      ...envelope,
      payload: {
        ...envelope.payload,
        commentDrafts: [] as unknown as SessionCommentDraftSnapshot
      }
    } as SessionDraftEnvelope);

    await context.session.initialize();

    expect(getSessionHarness(context.session).__testHighlights).toEqual([]);
    expect(context.view.currentDrafts).toEqual({});
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_draft_restored')
    ).toEqual({
      type: 'ANALYTICS_EVENT',
      event: 'reader_draft_restored',
      params: {
        highlight_count_bucket: 'one',
        outcome: 'failed',
        duration_bucket: 'under_100ms'
      }
    });
    await expect(
      context.draftRepository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toBeNull();
  });

  it('flushes a restorable reader draft on pagehide after prior mutation-time saves', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const content = document.getElementById('content');
    if (!content?.firstChild) {
      throw new Error('content node missing');
    }

    await settleReaderMutation(
      getSessionHarness(context.session).handleSelection(createSelectionPayload(content.firstChild))
    );
    const saveDraft = vi.spyOn(context.sessionDraftRepository, 'save');

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({ status: 'restorable' }));
    await vi.waitFor(async () => {
      await expect(
        context.draftRepository.loadLatest('reader', 'https://example.com/article')
      ).resolves.toMatchObject({
        status: 'restorable'
      });
    });
  });

  it('queues restorable pagehide state synchronously behind an in-flight active save', async () => {
    vi.useFakeTimers();
    const storageArea = createMemoryStorageArea();
    const saves: SessionDraftEnvelope[] = [];
    let durable: SessionDraftEnvelope | null = null;
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let writeTail = Promise.resolve();
    const repository: SessionDraftRepository = {
      save(envelope) {
        saves.push(envelope);
        const write = writeTail.then(async () => {
          if (envelope.status === 'active') await activeGate;
          durable = envelope;
        });
        writeTail = write;
        return write;
      },
      async loadLatest() {
        await writeTail;
        return durable;
      },
      remove: () => Promise.resolve(),
      listCandidates: () => Promise.resolve(durable ? [durable] : []),
      pruneExpired: () => Promise.resolve()
    };
    const controller = new ReaderSessionDraftController({
      doc: document,
      pageUrl: 'https://example.com/article',
      storageArea,
      repository,
      getPageTitle: () => 'Article',
      getHighlights: () => [createPersistedHighlightRecord()],
      getCommentDrafts: () => ({}),
      getDestinationMetadata: () => undefined,
      onPersistenceFailure: () => undefined
    });
    controller.bindLifecycleListeners();
    const activeSave = controller.persistMutation();
    await vi.advanceTimersByTimeAsync(150);
    expect(saves.map(({ status }) => status)).toEqual(['active']);

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));

    expect(saves.map(({ status }) => status)).toEqual(['active', 'restorable']);
    releaseActive();
    await activeSave;
    await expect(
      repository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toMatchObject({ status: 'restorable' });
    await controller.dispose();
  });

  it('does not create a durable reader draft when the session stays empty', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const callbacks = context.getCallbacks();
    if (!callbacks?.onSelectDestination) {
      throw new Error('destination callback missing');
    }

    await settleReaderMutation(Promise.resolve(callbacks.onSelectDestination('downloads')));

    await expect(
      context.draftRepository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toBeNull();
  });
});
