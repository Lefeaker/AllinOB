/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageService } from '@platform/interfaces/storage';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  SESSION_DRAFT_INDEX_KEY,
  createSessionDraftPageKey,
  createDirectSessionDraftRepository as createSessionDraftRepository,
  createSessionDraftStoragePolicy,
  createSessionDraftStorageKey,
  type SessionDraftEnvelope,
  type ReaderSessionDraftEnvelope,
  type SessionDraftStoragePolicy
} from '@content/sessionDrafts';
import type {
  ReaderSessionAdapter,
  VideoSessionAdapter
} from '@content/clipper/services/selectionController';
import { buildReaderSessionDraftEnvelope } from '@content/reader/sessionDrafts';
import { startSessionDraftAutoRestore } from '@content/runtime/sessionDraftAutoRestore';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import { isObjectRecord } from '@shared/guards/object';

function createHarness(
  initialUrl: string,
  options: {
    sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
    getSessionDraftStoragePolicy?: () => SessionDraftStoragePolicy;
  } = {}
) {
  document.body.innerHTML = '<main id="app">content</main>';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  });

  let href = initialUrl;
  const storage: StorageService = {
    local: createMemoryStorageArea(),
    sync: createMemoryStorageArea()
  };
  const repository = createSessionDraftRepository(
    storage.local,
    options.sessionDraftStoragePolicy
      ? { retentionPolicy: options.sessionDraftStoragePolicy.retentionPolicy }
      : {}
  );
  const backgroundHandler = createBackgroundVideoScreenshotCacheHandler(
    { local: storage.local },
    {
      getCurrentPolicy: () =>
        options.getSessionDraftStoragePolicy?.() ??
        options.sessionDraftStoragePolicy ??
        createSessionDraftStoragePolicy()
    }
  );
  const sessionDraftSend = vi.fn(async (message: unknown) => {
    return backgroundHandler(message, { tabId: 7, windowId: 3, frameId: 0 });
  });
  const readerStart = vi.fn<ReaderSessionAdapter['start']>().mockResolvedValue(undefined);
  const videoStart = vi.fn<VideoSessionAdapter['start']>().mockResolvedValue(undefined);
  const createReaderSession = vi.fn<() => ReaderSessionAdapter>(() => ({
    start: readerStart,
    ingestExternalHighlight: vi.fn()
  }));
  const createVideoSession = vi.fn<() => VideoSessionAdapter>(() => ({
    start: videoStart,
    ingestTextCapture: vi.fn()
  }));
  const isReaderSessionActive = vi.fn(() => false);
  const isVideoSessionActive = vi.fn(() => false);
  const isVideoCandidateUrl = vi.fn((url: string) => url.includes('youtube.com/watch'));

  return {
    repository,
    sessionDraftSend,
    storage,
    currentUrl: () => href,
    setUrl: (url: string) => {
      href = url;
    },
    createReaderSession,
    createVideoSession,
    readerStart,
    videoStart,
    isReaderSessionActive,
    isVideoSessionActive,
    isVideoCandidateUrl,
    start: () =>
      startSessionDraftAutoRestore({
        document,
        window,
        storage,
        messaging: { send: sessionDraftSend },
        currentUrl: () => href,
        createReaderSession,
        createVideoSession,
        isReaderSessionActive,
        isVideoSessionActive,
        isVideoCandidateUrl,
        ...(options.sessionDraftStoragePolicy
          ? { sessionDraftStoragePolicy: options.sessionDraftStoragePolicy }
          : {}),
        ...(options.getSessionDraftStoragePolicy
          ? { getSessionDraftStoragePolicy: options.getSessionDraftStoragePolicy }
          : {})
      })
  };
}

async function seedStoredDraft(
  harness: ReturnType<typeof createHarness>,
  envelope: SessionDraftEnvelope
): Promise<void> {
  const storageKey = createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    draftId: envelope.draftId
  });

  await harness.storage.local.setMany({
    [storageKey]: envelope,
    [SESSION_DRAFT_INDEX_KEY]: {
      schemaVersion: 1,
      entries: [
        {
          key: storageKey,
          draftId: envelope.draftId,
          mode: envelope.mode,
          pageKey: envelope.pageKey,
          updatedAt: envelope.updatedAt,
          expiresAt: envelope.expiresAt,
          status: envelope.status
        }
      ]
    }
  });
}

function createReaderDraftEnvelope(
  pageUrl: string,
  updatedAt = Date.now()
): ReaderSessionDraftEnvelope {
  const wrapper = document.createElement('mark');
  wrapper.dataset.readerHighlightId = 'draft-highlight';
  wrapper.textContent = 'Reader highlight';
  const envelope = buildReaderSessionDraftEnvelope({
    draftId: `reader-${updatedAt}`,
    createdAt: updatedAt - 1,
    now: updatedAt,
    pageUrl,
    pageTitle: 'Reader draft',
    highlights: [
      {
        id: 'draft-highlight',
        selectedHtml: '<mark>Reader highlight</mark>',
        selectedText: 'Reader highlight',
        comment: 'reader comment',
        fragmentUrl: '#draft-highlight',
        wrapper,
        wrapperSegments: [wrapper],
        createdAt: updatedAt
      }
    ],
    commentDrafts: {
      'draft-highlight': 'reader comment'
    },
    status: 'restorable'
  });
  if (!envelope) {
    throw new Error('Expected reader draft envelope');
  }
  return {
    ...envelope,
    pageKey: createSessionDraftPageKey('reader', pageUrl),
    expiresAt: updatedAt + 60_000
  };
}

function createVideoDraftEnvelope(pageUrl: string, updatedAt = Date.now()) {
  return createVideoSessionDraftEnvelope({
    draftId: `video-${updatedAt}`,
    pageUrl,
    pageTitle: 'Video draft',
    updatedAt,
    createdAt: updatedAt - 1,
    expiresAt: updatedAt + 60_000,
    status: 'restorable',
    payload: buildVideoSessionDraftPayload({
      captures: [],
      commentDrafts: {
        timestamp: 'video comment'
      },
      platform: 'youtube',
      videoId: 'video-1',
      videoUrl: pageUrl,
      canonicalUrl: pageUrl,
      videoTitle: 'Video draft'
    })
  });
}

async function flushAsyncWork(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    if (!vi.isFakeTimers()) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    } else {
      await vi.advanceTimersByTimeAsync(0);
    }
  }
}

async function waitForCall(
  mock: { mock: { calls: unknown[][] } },
  expectedCalls = 1
): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    if (mock.mock.calls.length >= expectedCalls) return;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${expectedCalls} call(s), received ${mock.mock.calls.length}`);
}

describe('sessionDraftAutoRestore', () => {
  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('starts video session when a video draft exists on a supported video URL', async () => {
    const url = 'https://www.youtube.com/watch?v=video-1';
    const harness = createHarness(url);
    document.body.appendChild(document.createElement('video'));
    await harness.repository.save(createVideoDraftEnvelope(url));

    const stop = harness.start();
    await waitForCall(harness.videoStart);

    expect(harness.videoStart).toHaveBeenCalledTimes(1);
    expect(harness.readerStart).not.toHaveBeenCalled();
    expect(
      harness.sessionDraftSend.mock.calls.some(
        ([message]) => isObjectRecord(message) && message.operation === 'loadLatestSessionDraft'
      )
    ).toBe(true);
    stop();
  });

  it('starts reader session when a reader draft exists and no video draft is restored', async () => {
    const url = 'https://example.com/article';
    const harness = createHarness(url);
    await harness.repository.save(createReaderDraftEnvelope(url));

    const stop = harness.start();
    await waitForCall(harness.readerStart);

    expect(harness.readerStart).toHaveBeenCalledTimes(1);
    expect(harness.readerStart.mock.calls[0]).toHaveLength(0);
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it('keeps the default Free retention window for auto-restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00Z'));
    const url = 'https://example.com/article';
    const harness = createHarness(url);
    const staleUpdatedAt = Date.now() - 49 * 60 * 60 * 1000;
    await seedStoredDraft(harness, {
      ...createReaderDraftEnvelope(url, staleUpdatedAt),
      expiresAt: Date.now() + 60_000
    });

    const stop = harness.start();
    await flushAsyncWork();

    expect(harness.readerStart).not.toHaveBeenCalled();
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it('threads an injected generic retention policy through auto-restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00Z'));
    const url = 'https://example.com/article';
    const harness = createHarness(url, {
      sessionDraftStoragePolicy: createSessionDraftStoragePolicy({
        retentionPolicy: {
          retentionMs: 96 * 60 * 60 * 1000,
          maxRestorablePages: null,
          maxItemsPerPage: null
        }
      })
    });
    const staleUpdatedAt = Date.now() - 49 * 60 * 60 * 1000;
    await seedStoredDraft(harness, {
      ...createReaderDraftEnvelope(url, staleUpdatedAt),
      expiresAt: Date.now() + 60_000
    });

    const stop = harness.start();
    await waitForCall(harness.readerStart);

    expect(harness.readerStart).toHaveBeenCalledTimes(1);
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it('uses the latest generic storage policy when a later restore run creates its repository', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00Z'));
    const initialPolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 60 * 60 * 1000,
        maxRestorablePages: null,
        maxItemsPerPage: null
      }
    });
    const extendedPolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 96 * 60 * 60 * 1000,
        maxRestorablePages: null,
        maxItemsPerPage: null
      }
    });
    let currentPolicy = initialPolicy;
    const url = 'https://example.com/article';
    const harness = createHarness(url, {
      getSessionDraftStoragePolicy: () => currentPolicy
    });
    harness.isReaderSessionActive.mockReturnValueOnce(true).mockReturnValue(false);
    const staleUpdatedAt = Date.now() - 49 * 60 * 60 * 1000;
    await seedStoredDraft(harness, {
      ...createReaderDraftEnvelope(url, staleUpdatedAt),
      expiresAt: Date.now() + 60_000
    });

    const stop = harness.start();
    await flushAsyncWork();

    expect(harness.readerStart).not.toHaveBeenCalled();

    currentPolicy = extendedPolicy;
    window.dispatchEvent(new Event('pageshow'));
    await waitForCall(harness.readerStart);

    expect(harness.readerStart).toHaveBeenCalledTimes(1);
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it('ignores terminal reader drafts during auto-restore', async () => {
    const url = 'https://example.com/article';
    const harness = createHarness(url);

    await seedStoredDraft(harness, {
      ...createReaderDraftEnvelope(url),
      status: 'discarded'
    });

    const stop = harness.start();
    await flushAsyncWork();

    expect(harness.readerStart).not.toHaveBeenCalled();
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it('ignores terminal video drafts during auto-restore', async () => {
    const url = 'https://www.youtube.com/watch?v=video-1';
    const harness = createHarness(url);
    const videoDraft = createVideoDraftEnvelope(url);
    document.body.appendChild(document.createElement('video'));

    await seedStoredDraft(harness, {
      ...videoDraft,
      status: 'exported'
    });

    const stop = harness.start();
    await flushAsyncWork();

    expect(harness.videoStart).not.toHaveBeenCalled();
    expect(harness.readerStart).not.toHaveBeenCalled();
    stop();
  });

  it('starts nothing when no draft exists', async () => {
    const harness = createHarness('https://example.com/article');

    const stop = harness.start();
    await flushAsyncWork();

    expect(harness.readerStart).not.toHaveBeenCalled();
    expect(harness.videoStart).not.toHaveBeenCalled();
    stop();
  });

  it.each([
    ['reader', true, false],
    ['video', false, true]
  ])(
    'starts nothing when an active %s session already exists',
    async (_, readerActive, videoActive) => {
      const url = 'https://www.youtube.com/watch?v=video-1';
      const harness = createHarness(url);
      harness.isReaderSessionActive.mockReturnValue(readerActive);
      harness.isVideoSessionActive.mockReturnValue(videoActive);
      document.body.appendChild(document.createElement('video'));
      await harness.repository.save(createReaderDraftEnvelope(url));
      await harness.repository.save(createVideoDraftEnvelope(url));

      const stop = harness.start();
      await flushAsyncWork();

      expect(harness.createReaderSession).not.toHaveBeenCalled();
      expect(harness.createVideoSession).not.toHaveBeenCalled();
      stop();
    }
  );

  it('prefers video draft restoration when both reader and video drafts exist on a supported video URL', async () => {
    const url = 'https://www.youtube.com/watch?v=video-1';
    const harness = createHarness(url);
    document.body.appendChild(document.createElement('video'));
    await harness.repository.save(createReaderDraftEnvelope(url));
    await harness.repository.save(createVideoDraftEnvelope(url));

    const stop = harness.start();
    await waitForCall(harness.videoStart);

    expect(harness.videoStart).toHaveBeenCalledTimes(1);
    expect(harness.readerStart).not.toHaveBeenCalled();
    stop();
  });

  it('reacts to navigation events and rechecks the new URL', async () => {
    const initialUrl = 'https://example.com/first';
    const nextUrl = 'https://example.com/second';
    const harness = createHarness(initialUrl);
    const stop = harness.start();

    await flushAsyncWork();
    expect(harness.readerStart).not.toHaveBeenCalled();

    await harness.repository.save(createReaderDraftEnvelope(nextUrl));
    harness.setUrl(nextUrl);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitForCall(harness.readerStart);

    expect(harness.readerStart).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retries video draft restoration after a bounded wait when the video element appears later', async () => {
    vi.useFakeTimers();
    const url = 'https://www.youtube.com/watch?v=video-1';
    const harness = createHarness(url);
    await harness.repository.save(createVideoDraftEnvelope(url));

    const stop = harness.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsyncWork();
    expect(harness.videoStart).not.toHaveBeenCalled();

    document.body.appendChild(document.createElement('video'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitForCall(harness.videoStart);

    const claimCall = harness.sessionDraftSend.mock.calls.findIndex(
      ([message]) => isObjectRecord(message) && message.operation === 'claimSessionDraft'
    );
    expect(claimCall).toBeGreaterThanOrEqual(0);
    expect(harness.sessionDraftSend.mock.invocationCallOrder[claimCall]).toBeLessThan(
      harness.videoStart.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );

    expect(harness.videoStart).toHaveBeenCalledTimes(1);
    stop();
  });
});
