/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts';
import { VideoSessionState } from '@content/video/sessionState';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';

describe('VideoSessionDraftController title fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<video></video>';
    document.title = '';
  });

  afterEach(() => {
    vi.doUnmock('../../../../src/i18n/catalog/runtimeFallbackMessages');
  });

  it('sources the saved draft title fallback from the default runtime catalog', async () => {
    const actualFallbacks = await vi.importActual<
      typeof import('../../../../src/i18n/catalog/runtimeFallbackMessages')
    >('../../../../src/i18n/catalog/runtimeFallbackMessages');
    vi.doMock('../../../../src/i18n/catalog/runtimeFallbackMessages', () => ({
      ...actualFallbacks,
      RUNTIME_FALLBACK_MESSAGES: {
        ...actualFallbacks.RUNTIME_FALLBACK_MESSAGES,
        videoSessionDraftTitleFallback: 'Video draft title sentinel'
      },
      VIDEO_TITLE_FALLBACK: 'Video draft title sentinel'
    }));

    const { VideoSessionDraftController } =
      await import('../../../../src/content/video/videoSessionDraftController');
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const versionedRepository = {
      ...repository,
      claim: () => Promise.resolve(),
      runWriteOperation: () => Promise.reject(new Error('unexpected write operation'))
    };
    const state = new VideoSessionState('gradient');
    state.captures = [
      {
        kind: 'timestamp',
        id: 'ts-1',
        timeSec: 42,
        comment: 'note',
        url: 'https://video.example/watch?t=42',
        createdAt: 1
      }
    ];

    const controller = new VideoSessionDraftController({
      doc: document,
      state,
      storageArea: storage,
      repository: versionedRepository,
      destinationState: {
        metadata: undefined,
        applyMetadata: vi.fn()
      },
      dom: {
        readCommentDrafts: vi.fn(() => ({})),
        setCommentDrafts: vi.fn()
      },
      readCleanupState: () => ({
        isCleaningUp: false,
        shouldTrackSavingState: true
      })
    });

    const result = await controller.flushNow('active');

    expect(result).toBe('ready');
    const latestDraft = await repository.loadLatest('video', document.location.href);
    expect(latestDraft?.pageTitle).toBe('Video draft title sentinel');
    if (!latestDraft || latestDraft.mode !== 'video') {
      throw new Error('expected a saved video draft');
    }
    expect(latestDraft.payload.videoTitle).toBe('Video draft title sentinel');
  });
});
