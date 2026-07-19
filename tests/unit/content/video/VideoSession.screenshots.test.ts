/* @vitest-environment jsdom */

import './videoSessionTestHarness';

import {
  __resetContentSessionRegistryForTests,
  isVideoSessionActive
} from '@content/runtime/contentSessionRegistry';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import type { VideoSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import { VideoSession } from '@content/video/session';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import { DEFAULT_SESSION_MESSAGES } from '@content/video/sessionMessages';
import type { VideoScreenshotCacheSaveResult } from '@content/video/videoScreenshotCacheRepository';
import type { VideoScreenshotCacheRef } from '@content/video/videoScreenshotCacheTypes';
import { VideoScreenshotPreparationCoordinator } from '@content/video/videoScreenshotPreparationCoordinator';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TestView, VideoScreenshotCacheSaveMock } from './videoSessionTestHarness';
import {
  createBlobScreenshotFixture,
  createDeferred,
  createDependencies,
  createPreparationVideoHarness,
  createScreenshotCacheRefFixture,
  createScreenshotCacheRepositoryMock,
  createView,
  expectNoForbiddenAnalyticsKeys,
  flushMutationWork,
  getTrackUsageEventMock,
  getVideoSessionHarnessMocks,
  listVideoDraftCandidates,
  loadLatestVideoDraft,
  readFirstCacheSaveInput,
  readLatestVideoDraftCandidate,
  readVideoDraftCandidateWithScreenshotRef,
  readVideoDraftPayload,
  requireMountedPanelCallbacks,
  requirePromise,
  requireVideoElement,
  resetVideoSessionHarnessMocks,
  restoreVideoSessionHarnessGlobals,
  seedTimestampCaptures,
  toDraftControllerTestApi,
  toSessionTestApi,
  waitForMockCalls,
  waitForTimestampScreenshot
} from './videoSessionTestHarness';

const { exportMock, loadStoredCaptureDataMock } = getVideoSessionHarnessMocks();

const draftWriteCases: Array<{
  name: string;
  arrivalOrder: 'screenshot-first' | 'mutation-first';
}> = [
  {
    name: 'screenshot persistence arrives before the capture edit',
    arrivalOrder: 'screenshot-first'
  },
  {
    name: 'capture edit arrives before screenshot persistence',
    arrivalOrder: 'mutation-first'
  }
];

describe('VideoSession screenshots', () => {
  beforeEach(() => {
    document.body.innerHTML = '<h1>Video Title</h1><video></video>';
    document.title = 'Video Title___哔哩哔哩_bilibili';
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      configurable: true
    });
    __resetContentSessionRegistryForTests(document);
    resetVideoSessionHarnessMocks();
  });

  afterEach(() => {
    restoreVideoSessionHarnessGlobals();
  });

  it.each(['restorable', 'active'] as const)(
    'hydrates legacy %s drafts by preparing requested screenshots through fallback without touching visible playback',
    async (status) => {
      const deps = createDependencies();
      const repository = createSessionDraftRepository(deps.storage.local);
      const cacheTypesModule =
        await import('../../../../src/content/video/videoScreenshotCacheTypes');
      const savedRef: VideoScreenshotCacheRef = {
        schemaVersion: 1,
        pageKey: 'video-example',
        captureId: 'ts-1',
        id: 'shot-restore-legacy',
        key: cacheTypesModule.createVideoScreenshotCacheStorageKey({
          pageKey: 'video-example',
          captureId: 'ts-1',
          screenshotId: 'shot-restore-legacy'
        }),
        fileName: 'video-0m42s.jpg',
        mimeType: 'image/jpeg',
        byteLength: 14,
        capturedAt: 2_000_000_000_300,
        expiresAt: 2_000_000_000_300 + 60_000
      };
      const loadSpy = vi.fn(() => Promise.resolve(null));
      const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
        (): Promise<VideoScreenshotCacheSaveResult> =>
          Promise.resolve({
            status: 'saved',
            ref: savedRef
          })
      );
      deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
        save: saveSpy,
        load: loadSpy
      });
      const envelope = createVideoSessionDraftEnvelope({
        draftId: 'draft-start-1',
        pageUrl: document.location.href,
        pageTitle: 'Draft title',
        updatedAt: 2_000_000_000_100,
        status,
        payload: buildVideoSessionDraftPayload({
          captures: [
            {
              kind: 'timestamp',
              id: 'ts-1',
              timeSec: 42,
              url: 'https://video.example/watch?t=42',
              comment: 'Restored marker',
              createdAt: 2_000_000_000_100,
              screenshotRequested: true
            },
            {
              kind: 'fragment',
              id: 'frag-1',
              timeSec: 45,
              comment: 'Restored fragment',
              selectedText: 'Quoted text',
              selectedHtml: '<p>Quoted text</p>',
              fragmentUrl: 'https://video.example/watch#:~:text=Quoted%20text',
              createdAt: 2_000_000_000_102
            }
          ],
          commentDrafts: { 'ts-1': 'draft note' },
          platform: 'bilibili',
          videoId: 'BV1xx411c7mD',
          videoTitle: 'Draft title',
          videoUrl: document.location.href,
          canonicalUrl: document.location.href
        })
      });
      await repository.save(envelope);
      const session = new VideoSession(document, deps);
      const sessionApi = toSessionTestApi(session);
      const canvas = document.createElement('canvas');
      const drawImage = vi.fn();
      const toBlob = vi.fn((callback: BlobCallback) => {
        callback(new Blob(['restored-frame'], { type: 'image/jpeg' }));
      });
      const toDataURL = vi.fn();
      const hiddenVideo = createPreparationVideoHarness({
        currentTime: 0,
        sourceUrl: 'https://cdn.example/video.mp4'
      });
      const createElementSpy = vi
        .spyOn(document, 'createElement')
        .mockImplementation((tagName: string) => {
          if (tagName.toLowerCase() === 'video') {
            return hiddenVideo.video;
          }
          if (tagName.toLowerCase() === 'canvas') {
            Object.defineProperty(canvas, 'getContext', {
              value: vi.fn(() => ({ drawImage })),
              configurable: true
            });
            Object.defineProperty(canvas, 'toBlob', {
              value: toBlob,
              configurable: true
            });
            Object.defineProperty(canvas, 'toDataURL', {
              value: toDataURL,
              configurable: true
            });
            return canvas;
          }
          return Document.prototype.createElement.call(document, tagName);
        });
      const video = requireVideoElement();
      let currentTime = 8;
      let paused = false;
      const currentTimeSetSpy = vi.fn((value: number) => {
        currentTime = value;
      });
      Object.defineProperty(video, 'currentTime', {
        get: () => currentTime,
        set: currentTimeSetSpy,
        configurable: true
      });
      Object.defineProperty(video, 'paused', {
        get: () => paused,
        configurable: true
      });
      Object.defineProperty(video, 'readyState', {
        value: 4,
        configurable: true
      });
      Object.defineProperty(video, 'videoWidth', {
        value: 640,
        configurable: true
      });
      Object.defineProperty(video, 'videoHeight', {
        value: 360,
        configurable: true
      });
      Object.defineProperty(video, 'currentSrc', {
        value: 'https://cdn.example/video.mp4',
        configurable: true
      });
      Object.defineProperty(video, 'src', {
        value: 'https://cdn.example/video.mp4',
        configurable: true
      });
      const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
        paused = true;
      });
      const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
        paused = false;
        return Promise.resolve();
      });

      try {
        await session.start();
        await waitForMockCalls(drawImage, 1, 300);
        if (drawImage.mock.calls.length === 0) {
          throw new Error('expected restored draft screenshot fallback to draw hidden video frame');
        }

        expect(drawImage).toHaveBeenCalledWith(hiddenVideo.video, 0, 0, 640, 360);
        expect(hiddenVideo.currentTimeSetSpy).toHaveBeenCalledWith(42);
        expect(sessionApi.state.captures).toHaveLength(2);
        const [restoredTimestamp, restoredFragment] = sessionApi.state.captures;
        expect(restoredTimestamp).toMatchObject({
          kind: 'timestamp',
          id: 'ts-1',
          screenshotRequested: true
        });
        if (restoredTimestamp?.kind !== 'timestamp') {
          throw new Error('expected restored timestamp capture');
        }
        const restoredScreenshot = await waitForTimestampScreenshot(restoredTimestamp);
        expect(restoredScreenshot).toMatchObject({
          mimeType: 'image/jpeg',
          content: {
            kind: 'blob',
            byteLength: 14
          }
        });
        expect(restoredScreenshot.content?.blob).toBeInstanceOf(Blob);
        expect(restoredScreenshot.content?.blob.size).toBe(14);
        expect(loadSpy).not.toHaveBeenCalled();
        const cacheSaveInput = readFirstCacheSaveInput(saveSpy);
        expect(cacheSaveInput.captureId).toBe('ts-1');
        expect(typeof cacheSaveInput.pageKey).toBe('string');
        expect(cacheSaveInput.screenshot).toBe(restoredScreenshot);
        expect(toBlob).toHaveBeenCalledTimes(1);
        expect(toDataURL).not.toHaveBeenCalled();
        expect(restoredFragment).toMatchObject({
          kind: 'fragment',
          id: 'frag-1',
          selectedText: 'Quoted text'
        });
        expect(currentTime).toBe(8);
        expect(currentTimeSetSpy).not.toHaveBeenCalled();
        expect(pauseSpy).not.toHaveBeenCalled();
        expect(playSpy).not.toHaveBeenCalled();
        expect(sessionApi.state.commentDrafts).toEqual({ 'ts-1': 'draft note' });
        expect(loadStoredCaptureDataMock).not.toHaveBeenCalled();

        expect(restoredTimestamp.screenshotRef).toEqual(savedRef);
        await flushMutationWork();
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 200);
        });
        await flushMutationWork();

        let candidateWithRef: VideoSessionDraftEnvelope | null = null;
        for (let index = 0; index < 20; index += 1) {
          const candidates = await listVideoDraftCandidates(deps);
          candidateWithRef =
            candidates.find((candidate) => {
              const capture = readVideoDraftPayload(candidate)?.captures[0];
              return capture?.kind === 'timestamp' && capture.screenshotRef !== undefined;
            }) ?? null;
          if (candidateWithRef) {
            break;
          }
          await flushMutationWork();
        }

        const latestPayload = readVideoDraftPayload(candidateWithRef);
        expect(latestPayload?.captures[0]).toMatchObject({
          id: 'ts-1',
          screenshotRequested: true,
          screenshotRef: savedRef
        });
        expect(latestPayload?.captures[0]).not.toHaveProperty('screenshot');
        expect(latestPayload?.captures[0]).not.toHaveProperty('dataUrl');
        expect(latestPayload?.captures[0]).not.toHaveProperty('content');
      } finally {
        createElementSpy.mockRestore();
        sessionApi.cleanup();
      }
    }
  );

  it('hydrates cached screenshot refs from restored drafts without touching visible playback or recapturing', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const cacheTypesModule =
      await import('../../../../src/content/video/videoScreenshotCacheTypes');
    const restoredScreenshot = createBlobScreenshotFixture('cached-frame', 2_000_000_000_101, {
      id: 'shot-cached',
      fileName: 'video-0m42s.jpg'
    });
    const savedRef: VideoScreenshotCacheRef = {
      schemaVersion: 1,
      pageKey: 'video-example',
      captureId: 'ts-1',
      id: 'shot-cached',
      key: cacheTypesModule.createVideoScreenshotCacheStorageKey({
        pageKey: 'video-example',
        captureId: 'ts-1',
        screenshotId: 'shot-cached'
      }),
      fileName: 'video-0m42s.jpg',
      mimeType: 'image/jpeg',
      byteLength: restoredScreenshot.content.byteLength,
      capturedAt: restoredScreenshot.capturedAt,
      expiresAt: restoredScreenshot.capturedAt + 60_000
    };
    const loadSpy = vi.fn(() => Promise.resolve(restoredScreenshot));
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> =>
        Promise.reject(new Error('cache save should not run for cache-hit restore'))
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy,
      load: loadSpy
    });
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-cache-hit-1',
      pageUrl: document.location.href,
      pageTitle: 'Draft title',
      updatedAt: 2_000_000_000_100,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'Restored marker',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef: savedRef
          }
        ],
        commentDrafts: { 'ts-1': 'draft note' },
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Draft title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(envelope);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toBlob = vi.fn();
    const toDataURL = vi.fn();
    const hiddenVideo = createPreparationVideoHarness({
      currentTime: 0,
      sourceUrl: 'https://cdn.example/video.mp4'
    });
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'video') {
        return hiddenVideo.video;
      }
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });
    const video = requireVideoElement();
    let currentTime = 42;
    let paused = false;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      get: () => paused,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', {
      value: 640,
      configurable: true
    });
    Object.defineProperty(video, 'videoHeight', {
      value: 360,
      configurable: true
    });
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    Object.defineProperty(video, 'src', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    try {
      await session.start();

      expect(sessionApi.state.captures).toHaveLength(1);
      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }

      const hydratedScreenshot = await waitForTimestampScreenshot(restoredTimestamp);
      expect(hydratedScreenshot).toBe(restoredScreenshot);
      expect(loadSpy).toHaveBeenCalledWith(savedRef);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(drawImage).not.toHaveBeenCalled();
      expect(toBlob).not.toHaveBeenCalled();
      expect(toDataURL).not.toHaveBeenCalled();
      expect(hiddenVideo.currentTimeSetSpy).not.toHaveBeenCalled();
      expect(currentTime).toBe(42);
      expect(currentTimeSetSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
      expect(restoredTimestamp.screenshotRef).toEqual(savedRef);
      expect(loadStoredCaptureDataMock).not.toHaveBeenCalled();

      const latestCandidate = await readLatestVideoDraftCandidate(deps);
      const latestCapture = readVideoDraftPayload(latestCandidate)?.captures[0];
      expect(latestCapture).toMatchObject({
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef: savedRef
      });
      expect(latestCapture).not.toHaveProperty('screenshot');
      expect(latestCapture).not.toHaveProperty('dataUrl');
      expect(latestCapture).not.toHaveProperty('content');
    } finally {
      createElementSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('waits for cache-hit hydration before requesting fallback screenshot preparation on restored drafts', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const cacheTypesModule =
      await import('../../../../src/content/video/videoScreenshotCacheTypes');
    const restoredScreenshot = createBlobScreenshotFixture('cached-frame', 2_000_000_000_101, {
      id: 'shot-cached',
      fileName: 'video-0m42s.jpg'
    });
    const savedRef: VideoScreenshotCacheRef = {
      schemaVersion: 1,
      pageKey: 'video-example',
      captureId: 'ts-1',
      id: 'shot-cached',
      key: cacheTypesModule.createVideoScreenshotCacheStorageKey({
        pageKey: 'video-example',
        captureId: 'ts-1',
        screenshotId: 'shot-cached'
      }),
      fileName: 'video-0m42s.jpg',
      mimeType: 'image/jpeg',
      byteLength: restoredScreenshot.content.byteLength,
      capturedAt: restoredScreenshot.capturedAt,
      expiresAt: restoredScreenshot.capturedAt + 60_000
    };
    const loadDeferred = createDeferred<typeof restoredScreenshot | null>();
    const loadSpy = vi.fn(() => loadDeferred.promise);
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> =>
        Promise.reject(new Error('cache save should not run for cache-hit restore'))
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy,
      load: loadSpy
    });
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-cache-hit-race',
      pageUrl: document.location.href,
      pageTitle: 'Draft title',
      updatedAt: 2_000_000_000_100,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'Restored marker',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef: savedRef
          }
        ],
        commentDrafts: { 'ts-1': 'draft note' },
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Draft title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(envelope);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toBlob = vi.fn();
    const toDataURL = vi.fn();
    const hiddenVideo = createPreparationVideoHarness({
      currentTime: 0,
      sourceUrl: 'https://cdn.example/video.mp4'
    });
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'video') {
        return hiddenVideo.video;
      }
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });
    const video = requireVideoElement();
    let currentTime = 42;
    let paused = false;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      get: () => paused,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', {
      value: 640,
      configurable: true
    });
    Object.defineProperty(video, 'videoHeight', {
      value: 360,
      configurable: true
    });
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    Object.defineProperty(video, 'src', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    try {
      await session.start();
      (
        session as unknown as {
          handleVideoElementChange(element: HTMLVideoElement | null): void;
        }
      ).handleVideoElementChange(video);
      await flushMutationWork();
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
      await flushMutationWork();

      expect(sessionApi.state.captures).toHaveLength(1);
      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }

      expect(loadSpy).toHaveBeenCalledWith(savedRef);
      expect(restoredTimestamp.screenshot).toBeUndefined();
      expect(drawImage).not.toHaveBeenCalled();
      expect(toBlob).not.toHaveBeenCalled();
      expect(toDataURL).not.toHaveBeenCalled();
      expect(hiddenVideo.currentTimeSetSpy).not.toHaveBeenCalled();
      expect(currentTime).toBe(42);
      expect(currentTimeSetSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();

      loadDeferred.resolve(restoredScreenshot);
      const hydratedScreenshot = await waitForTimestampScreenshot(restoredTimestamp);
      expect(hydratedScreenshot).toBe(restoredScreenshot);
      await flushMutationWork();
      expect(saveSpy).not.toHaveBeenCalled();
      expect(restoredTimestamp.screenshotRef).toEqual(savedRef);
    } finally {
      createElementSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('keeps cache-hit restore non-fatal when session-start pruneExpired maintenance fails', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const cacheTypesModule =
      await import('../../../../src/content/video/videoScreenshotCacheTypes');
    const restoredScreenshot = createBlobScreenshotFixture('cached-frame', 2_000_000_000_101, {
      id: 'shot-cached',
      fileName: 'video-0m42s.jpg'
    });
    const savedRef: VideoScreenshotCacheRef = {
      schemaVersion: 1,
      pageKey: 'video-example',
      captureId: 'ts-1',
      id: 'shot-cached',
      key: cacheTypesModule.createVideoScreenshotCacheStorageKey({
        pageKey: 'video-example',
        captureId: 'ts-1',
        screenshotId: 'shot-cached'
      }),
      fileName: 'video-0m42s.jpg',
      mimeType: 'image/jpeg',
      byteLength: restoredScreenshot.content.byteLength,
      capturedAt: restoredScreenshot.capturedAt,
      expiresAt: restoredScreenshot.capturedAt + 60_000
    };
    const loadSpy = vi.fn(() => Promise.resolve(restoredScreenshot));
    const pruneExpired = vi.fn().mockRejectedValue(new Error('pruneExpired failed'));
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      load: loadSpy,
      pruneExpired
    });
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-cache-hit-prune-expired-failure',
      pageUrl: document.location.href,
      pageTitle: 'Draft title',
      updatedAt: 2_000_000_000_100,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'Restored marker',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef: savedRef
          }
        ],
        commentDrafts: { 'ts-1': 'draft note' },
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Draft title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(envelope);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await session.start();

      expect(pruneExpired).toHaveBeenCalledTimes(1);
      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }

      const hydratedScreenshot = await waitForTimestampScreenshot(restoredTimestamp);
      expect(hydratedScreenshot).toBe(restoredScreenshot);
      expect(loadSpy).toHaveBeenCalledWith(savedRef);
      expect(warnSpy).toHaveBeenCalledWith(
        '[VideoSession] Failed to prune expired cached screenshots:',
        expect.any(Error)
      );
    } finally {
      warnSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('runs outer cleanup once after successful cancel and disables draft and screenshot cleanup hooks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const cleanupSpy = vi.spyOn(sessionApi, 'cleanup');
    const screenshotDisposeSpy = vi.spyOn(
      VideoScreenshotPreparationCoordinator.prototype,
      'dispose'
    );
    let cancelCleanupCompleted = false;

    try {
      await session.start();
      Object.defineProperty(requireVideoElement(), 'currentTime', {
        value: 42,
        configurable: true
      });
      await sessionApi.handleAddCapture();
      await vi.advanceTimersByTimeAsync(200);
      await flushMutationWork();
      await expect(loadLatestVideoDraft(deps)).resolves.toMatchObject({ status: 'active' });

      vi.mocked(deps.storage.local.setMany).mockClear();
      sessionApi.cancel();
      await waitForMockCalls(cleanupSpy);
      cancelCleanupCompleted = true;

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(screenshotDisposeSpy).toHaveBeenCalledTimes(1);
      expect(isVideoSessionActive(document)).toBe(false);
      await expect(listVideoDraftCandidates(deps)).resolves.toEqual([]);

      vi.mocked(deps.storage.local.setMany).mockClear();
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('beforeunload'));
      await vi.advanceTimersByTimeAsync(200);
      await flushMutationWork();

      expect(deps.storage.local.setMany).not.toHaveBeenCalled();
      await expect(listVideoDraftCandidates(deps)).resolves.toEqual([]);
    } finally {
      screenshotDisposeSpy.mockRestore();
      if (!cancelCleanupCompleted) {
        sessionApi.cleanup();
      }
      vi.useRealTimers();
    }
  });

  it('does not start screenshot preparation when add-with-screenshot saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    vi.mocked(deps.storage.local.setMany).mockRejectedValueOnce(new Error('save failed'));
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => 'data:image/jpeg;base64,frame');
    const toBlob = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });

    await session.start();

    const video = requireVideoElement();
    let paused = false;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });
    view.setCaptures.mockClear();
    view.stopEditing.mockClear();
    view.updateHint.mockClear();

    await session.addCurrentTimestamp('note-input', {
      comment: 'captured frame',
      captureScreenshot: true,
      pauseVideo: true,
      beginEditing: false,
      resumePlayback: true
    });

    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(drawImage).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(view.stopEditing).toHaveBeenCalled();
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).not.toHaveBeenCalled();

    createElementSpy.mockRestore();
    vi.useRealTimers();
  });

  it('queues screenshot toggles behind an in-flight capture edit and keeps saving true until both saves finish', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const firstSave = createDeferred<'ready'>();
    const secondSave = createDeferred<'ready'>();
    const saveEvents: string[] = [];
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    vi.spyOn(
      toDraftControllerTestApi(session) as {
        flushNow: () => Promise<'ready'>;
      },
      'flushNow'
    ).mockImplementation(async () => {
      const saveIndex = saveEvents.filter((event) => event.endsWith(':start')).length;
      const gate = saveIndex === 0 ? firstSave : secondSave;
      saveEvents.push(`save-${saveIndex + 1}:start`);
      const result = await gate.promise;
      saveEvents.push(`save-${saveIndex + 1}:end`);
      return result;
    });
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'ts-edit',
        timeSec: 10,
        comment: 'original note',
        url: 'https://video.example/watch?t=10',
        createdAt: 1
      },
      {
        kind: 'timestamp',
        id: 'ts-toggle',
        timeSec: 20,
        comment: '',
        url: 'https://video.example/watch?t=20',
        createdAt: 2
      }
    ];

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    const editPromise = requirePromise(callbacks.onSubmitCaptureEdit('ts-edit', 'edited note'));
    await flushMutationWork();

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'edited note' });
    expect([...saveEvents]).toEqual(['save-1:start']);
    expect(sessionApi.state.saving).toBe(true);

    const togglePromise = sessionApi.toggleCaptureScreenshot('ts-toggle');
    await flushMutationWork();

    expect(sessionApi.state.captures[1]).toMatchObject({ screenshotRequested: true });
    expect(view.setCaptures.mock.calls.at(-1)?.[0]?.[1]).toMatchObject({
      id: 'ts-toggle',
      screenshotState: 'pending'
    });
    expect([...saveEvents]).toEqual(['save-1:start']);
    expect(sessionApi.state.saving).toBe(true);

    firstSave.resolve('ready');
    await editPromise;
    await flushMutationWork();

    expect(sessionApi.state.captures[1]).toMatchObject({ screenshotRequested: true });
    expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end', 'save-2:start']);
    expect(sessionApi.state.saving).toBe(true);

    secondSave.resolve('ready');
    await togglePromise;
    await flushMutationWork();

    expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end', 'save-2:start', 'save-2:end']);
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('acknowledges an enabled first screenshot click while timestamp-add persistence is still in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const firstSave = createDeferred<'ready'>();
    const secondSave = createDeferred<'ready'>();
    const saveEvents: string[] = [];
    const deps = createDependencies();
    const screenshotCacheLoadMock = vi.fn(() => Promise.resolve(null));
    const screenshotCacheSaveMock: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> =>
        Promise.resolve({
          status: 'skipped',
          reason: 'serialize-failed',
          error: 'not configured'
        })
    );
    const screenshotCache = createScreenshotCacheRepositoryMock({
      load: screenshotCacheLoadMock,
      save: screenshotCacheSaveMock
    });
    deps.screenshotCacheRepository = screenshotCache;
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const preparationSpy = vi.spyOn(
      VideoScreenshotPreparationCoordinator.prototype,
      'prepareRequestedScreenshot'
    );
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    let addPromise: Promise<void> | null = null;
    let togglePromise: Promise<void> | null = null;

    try {
      await session.start();
      const flushNowSpy = vi
        .spyOn(toDraftControllerTestApi(session), 'flushNow')
        .mockImplementation(async () => {
          const saveIndex = saveEvents.filter((event) => event.endsWith(':start')).length;
          const gate = saveIndex === 0 ? firstSave : secondSave;
          saveEvents.push(`save-${saveIndex + 1}:start`);
          const result = await gate.promise;
          saveEvents.push(`save-${saveIndex + 1}:end`);
          return result;
        });
      const toggleEntrySpy = vi.spyOn(sessionApi, 'toggleCaptureScreenshot');
      const callbacks = requireMountedPanelCallbacks(mountedCallbacks);

      addPromise = requirePromise(callbacks.onAddCapture('button'));
      await flushMutationWork();

      const capture = sessionApi.state.captures[0];
      if (!capture) {
        throw new Error('Expected timestamp-add to render a capture before persistence completed');
      }
      const renderedBeforeClick = view.setCaptures.mock.calls.at(-1)?.[0]?.[0];
      expect({
        captureId: renderedBeforeClick?.id,
        kind: renderedBeforeClick?.kind,
        screenshotState: renderedBeforeClick?.screenshotState,
        toggleAction: typeof callbacks.onToggleScreenshot,
        saveEvents: [...saveEvents]
      }).toEqual({
        captureId: capture.id,
        kind: 'timestamp',
        screenshotState: 'off',
        toggleAction: 'function',
        saveEvents: ['save-1:start']
      });

      void callbacks.onToggleScreenshot(capture.id);
      const toggleResult = toggleEntrySpy.mock.results[0];
      if (!toggleResult || toggleResult.type !== 'return') {
        throw new Error('Expected the mounted toggle callback to enter the session action');
      }
      togglePromise = requirePromise(toggleResult.value);
      await flushMutationWork();

      const renderedAfterClick = view.setCaptures.mock.calls.at(-1)?.[0]?.[0];
      expect({
        callbackEntries: toggleEntrySpy.mock.calls.length,
        screenshotRequested: capture.screenshotRequested === true,
        screenshotState: renderedAfterClick?.screenshotState,
        saveEvents: [...saveEvents],
        preparationCalls: preparationSpy.mock.calls.length,
        cacheReads: screenshotCacheLoadMock.mock.calls.length,
        cacheWrites: screenshotCacheSaveMock.mock.calls.length
      }).toEqual({
        callbackEntries: 1,
        screenshotRequested: true,
        screenshotState: 'pending',
        saveEvents: ['save-1:start'],
        preparationCalls: 0,
        cacheReads: 0,
        cacheWrites: 0
      });

      firstSave.resolve('ready');
      await addPromise;
      await flushMutationWork();

      expect(capture).toMatchObject({ screenshotRequested: true });
      expect(view.setCaptures.mock.calls.at(-1)?.[0]?.[0]).toMatchObject({
        id: capture.id,
        screenshotState: 'pending'
      });
      expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end', 'save-2:start']);
      expect(preparationSpy).not.toHaveBeenCalled();
      expect(screenshotCacheLoadMock).not.toHaveBeenCalled();
      expect(screenshotCacheSaveMock).not.toHaveBeenCalled();

      secondSave.resolve('ready');
      await togglePromise;
      await flushMutationWork();

      expect(toggleEntrySpy).toHaveBeenCalledTimes(1);
      expect(toggleEntrySpy).toHaveBeenCalledWith(capture.id);
      expect(flushNowSpy).toHaveBeenCalledTimes(2);
      expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end', 'save-2:start', 'save-2:end']);
      expect(preparationSpy).toHaveBeenCalledTimes(1);
      expect(preparationSpy).toHaveBeenCalledWith(capture.id);
      expect(sessionApi.state.captures).toHaveLength(1);
      expect(sessionApi.state.captures[0]).toMatchObject({ screenshotRequested: true });
    } finally {
      firstSave.resolve('ready');
      secondSave.resolve('ready');
      await Promise.allSettled(
        [addPromise, togglePromise].filter((promise): promise is Promise<void> => promise !== null)
      );
      sessionApi.cleanup();
      preparationSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('skips queued edit and screenshot toggle when an earlier queued delete removes the target before apply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const firstSave = createDeferred<'ready'>();
    const saveEvents: string[] = [];
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    vi.spyOn(
      toDraftControllerTestApi(session) as {
        flushNow: () => Promise<'ready'>;
      },
      'flushNow'
    ).mockImplementation(async () => {
      const saveIndex = saveEvents.filter((event) => event.endsWith(':start')).length;
      saveEvents.push(`save-${saveIndex + 1}:start`);
      if (saveIndex === 0) {
        const result = await firstSave.promise;
        saveEvents.push('save-1:end');
        return result;
      }
      saveEvents.push(`save-${saveIndex + 1}:end`);
      return 'ready';
    });
    seedTimestampCaptures(sessionApi, 2);
    sessionApi.state.commentDrafts = {
      'timestamp-2': 'queued draft'
    };

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onDeleteCapture('timestamp-2');
    const editPromise = requirePromise(callbacks.onSubmitCaptureEdit('timestamp-2', 'edited'));
    const togglePromise = sessionApi.toggleCaptureScreenshot('timestamp-2');
    await flushMutationWork();

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['timestamp-1']);
    expect([...saveEvents]).toEqual(['save-1:start']);

    firstSave.resolve('ready');
    await editPromise;
    await togglePromise;
    await flushMutationWork();

    expect(sessionApi.state.captures).toEqual([expect.objectContaining({ id: 'timestamp-1' })]);
    expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end']);
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('removes the cached screenshot ref after a timestamp capture deletion commits', async () => {
    const removeMany = vi.fn(() => Promise.resolve(undefined));
    const deps = createDependencies();
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      removeMany
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    const deletedId = seedTimestampCaptures(sessionApi, 2)[0];
    if (!deletedId) {
      throw new Error('expected timestamp capture id fixture');
    }
    const screenshotRef = createScreenshotCacheRefFixture(deletedId);
    const deletedCapture = sessionApi.state.captures.find((capture) => capture.id === deletedId);
    if (!deletedCapture || deletedCapture.kind !== 'timestamp') {
      throw new Error('expected timestamp capture fixture');
    }
    deletedCapture.screenshotRequested = true;
    deletedCapture.screenshotRef = screenshotRef;

    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture(deletedId);
    await flushMutationWork();
    await waitForMockCalls(removeMany);

    expect(sessionApi.state.captures.map((capture) => capture.id)).not.toContain(deletedId);
    expect(removeMany).toHaveBeenCalledTimes(1);
    expect(removeMany).toHaveBeenCalledWith([screenshotRef]);

    sessionApi.cleanup();
  });

  it('does not remove cached screenshots when deleting captures without screenshot refs', async () => {
    const removeMany = vi.fn(() => Promise.resolve(undefined));
    const deps = createDependencies();
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      removeMany
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    seedTimestampCaptures(sessionApi, 1);
    sessionApi.state.captures.push({
      kind: 'fragment',
      id: 'fragment-1',
      timeSec: 12,
      comment: '',
      selectedText: 'Fragment text',
      selectedHtml: '<p>Fragment text</p>',
      fragmentUrl: 'https://video.example/watch#:~:text=Fragment%20text',
      createdAt: Date.now()
    });

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onDeleteCapture('timestamp-1');
    await flushMutationWork();
    callbacks.onDeleteCapture('fragment-1');
    for (let index = 0; index < 10 && sessionApi.state.captures.length > 0; index += 1) {
      await flushMutationWork();
    }

    expect(sessionApi.state.captures).toHaveLength(0);
    expect(removeMany).not.toHaveBeenCalled();

    sessionApi.cleanup();
  });

  it('keeps capture deletion committed when cached screenshot cleanup fails', async () => {
    const cleanupError = new Error('cache cleanup failed');
    const removeMany = vi.fn(() => Promise.reject(cleanupError));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deps = createDependencies();
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      removeMany
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    try {
      await session.start();
      const deletedId = seedTimestampCaptures(sessionApi, 2)[0];
      if (!deletedId) {
        throw new Error('expected timestamp capture id fixture');
      }
      const screenshotRef = createScreenshotCacheRefFixture(deletedId);
      const deletedCapture = sessionApi.state.captures.find((capture) => capture.id === deletedId);
      if (!deletedCapture || deletedCapture.kind !== 'timestamp') {
        throw new Error('expected timestamp capture fixture');
      }
      deletedCapture.screenshotRequested = true;
      deletedCapture.screenshotRef = screenshotRef;

      requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture(deletedId);
      await flushMutationWork();
      await waitForMockCalls(removeMany);
      await waitForMockCalls(warnSpy);

      expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['timestamp-2']);
      expect(sessionApi.state.saving).toBe(false);
      expect(view.updateHint).not.toHaveBeenCalledWith('failure');
      expect(warnSpy).toHaveBeenCalledWith(
        '[VideoSession] Failed to remove cached screenshot after capture deletion:',
        cleanupError
      );
    } finally {
      warnSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('does not remove a deleted screenshot ref while another capture still references it', async () => {
    const removeMany = vi.fn(() => Promise.resolve(undefined));
    const deps = createDependencies();
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      removeMany
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    seedTimestampCaptures(sessionApi, 2);
    const sharedRef = createScreenshotCacheRefFixture('timestamp-1', { id: 'shared-shot' });
    for (const capture of sessionApi.state.captures) {
      if (capture.kind === 'timestamp') {
        capture.screenshotRequested = true;
        capture.screenshotRef = sharedRef;
      }
    }

    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture('timestamp-1');
    await flushMutationWork();

    expect(sessionApi.state.captures).toEqual([
      expect.objectContaining({
        id: 'timestamp-2',
        screenshotRef: sharedRef
      })
    ]);
    expect(removeMany).not.toHaveBeenCalled();

    sessionApi.cleanup();
  });

  it('persists screenshot intent before starting background screenshot preparation for control bar note captures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const preparationSpy = vi.spyOn(
      VideoScreenshotPreparationCoordinator.prototype,
      'prepareRequestedScreenshot'
    );
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => 'data:image/jpeg;base64,frame');
    let resolveToBlob: ((blob: Blob | null) => void) | null = null;
    const toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      resolveToBlob = callback;
    });
    const createElementSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tagName: string) => {
        if (tagName.toLowerCase() === 'canvas') {
          Object.defineProperty(canvas, 'getContext', {
            value: vi.fn(() => ({ drawImage })),
            configurable: true
          });
          Object.defineProperty(canvas, 'toBlob', {
            value: toBlob,
            configurable: true
          });
          Object.defineProperty(canvas, 'toDataURL', {
            value: toDataURL,
            configurable: true
          });
          return canvas;
        }
        return Document.prototype.createElement.call(document, tagName);
      });

    await session.start();

    const video = requireVideoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());
    const setManyMock = deps.storage.local.setMany as unknown as Mock;
    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    setManyMock.mockClear();
    view?.setCaptures.mockClear();
    view?.collapse.mockClear();

    await sessionApi.addCurrentTimestamp('note-input', {
      comment: 'captured frame',
      captureScreenshot: true,
      pauseVideo: true,
      beginEditing: false,
      resumePlayback: true,
      collapseAfterCapture: true
    });
    await waitForMockCalls(drawImage);

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(preparationSpy).toHaveBeenCalledWith(sessionApi.state.captures[0]?.id);
    expect(setManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      preparationSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toDataURL).not.toHaveBeenCalled();
    expect(setManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      toBlob.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(sessionApi.state.captures[0]).toMatchObject({
      comment: 'captured frame',
      screenshotRequested: true
    });
    expect(sessionApi.state.captures[0]).not.toHaveProperty('screenshot');
    expect(view?.stopEditing).toHaveBeenCalled();
    expect(view?.collapse).toHaveBeenCalledTimes(1);
    expect(view?.collapse.mock.invocationCallOrder[0]).toBeLessThan(
      view?.setCaptures.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );

    const completeBackgroundCapture = resolveToBlob as ((blob: Blob | null) => void) | null;
    if (!completeBackgroundCapture) {
      throw new Error('expected background screenshot preparation to start');
    }
    completeBackgroundCapture(null);
    await Promise.resolve();
    await Promise.resolve();
    createElementSpy.mockRestore();
    sessionApi.cleanup();
    preparationSpy.mockRestore();
    vi.useRealTimers();
  });

  it('toggles timestamp screenshots without exposing screenshot content in the panel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const preparationSpy = vi.spyOn(
      VideoScreenshotPreparationCoordinator.prototype,
      'prepareRequestedScreenshot'
    );
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: vi.fn(() => 'data:image/jpeg;base64,toggled-frame'),
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });

    await session.start();
    const setManyMock = vi.mocked(deps.storage.local.setMany);
    setManyMock.mockClear();

    const video = requireVideoElement();
    let currentTime = 8;
    let paused = false;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
      video.dispatchEvent(new Event('seeked'));
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      get: () => paused,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'note',
        url: 'https://video.example/watch?t=42',
        createdAt: Date.now()
      }
    ];

    await sessionApi.toggleCaptureScreenshot('timestamp-1');

    expect(video.currentTime).toBe(8);
    expect(currentTimeSetSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
    expect(sessionApi.state.captures[0]).toMatchObject({
      screenshotRequested: true
    });
    expect(sessionApi.state.captures[0]?.screenshot).toBeUndefined();
    expect(setManyMock).toHaveBeenCalledTimes(1);
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(preparationSpy).toHaveBeenCalledWith('timestamp-1');
    expect(setManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      preparationSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    const panelCaptures = view?.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string; screenshot?: unknown }>
      | undefined;
    expect(panelCaptures?.[0]).toMatchObject({
      hasScreenshot: false,
      screenshotState: 'pending'
    });
    expect(panelCaptures?.[0]?.screenshot).toBeUndefined();

    await sessionApi.toggleCaptureScreenshot('timestamp-1');

    expect(sessionApi.state.captures[0]?.screenshot).toBeUndefined();
    expect(sessionApi.state.captures[0]).not.toHaveProperty('screenshotRequested');
    expect(setManyMock).toHaveBeenCalledTimes(2);
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    const toggledOffCaptures = view?.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string }>
      | undefined;
    expect(toggledOffCaptures?.[0]).toMatchObject({
      hasScreenshot: false,
      screenshotState: 'off'
    });

    createElementSpy.mockRestore();
    sessionApi.cleanup();
    preparationSpy.mockRestore();
    vi.useRealTimers();
  });

  it('rolls back screenshot export intent and restores the previous screenshot state when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const previousScreenshot = createBlobScreenshotFixture('cached-frame', 2_026_031_410_000, {
      fileName: 'file-20260314100000000.jpg'
    });

    await session.start();
    vi.spyOn(
      toDraftControllerTestApi(session) as { flushNow: () => Promise<'failure'> },
      'flushNow'
    ).mockImplementation(async () => {
      await deferredSave.promise;
      return 'failure';
    });

    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'note',
        url: 'https://video.example/watch?t=42',
        createdAt: 1,
        screenshotRequested: true,
        screenshot: previousScreenshot
      }
    ];

    const togglePromise = sessionApi.toggleCaptureScreenshot('timestamp-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionApi.state.captures[0]).not.toHaveProperty('screenshotRequested');
    expect(sessionApi.state.captures[0]?.screenshot).toBe(previousScreenshot);
    const toggledOffCaptures = view.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string }>
      | undefined;
    expect(toggledOffCaptures?.[0]).toMatchObject({
      hasScreenshot: false,
      screenshotState: 'off'
    });

    deferredSave.resolve();
    await togglePromise;

    expect(sessionApi.state.captures[0]).toMatchObject({
      screenshotRequested: true,
      screenshot: previousScreenshot
    });
    const restoredCaptures = view.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string; screenshot?: unknown }>
      | undefined;
    expect(restoredCaptures?.[0]).toMatchObject({ hasScreenshot: true, screenshotState: 'on' });
    expect(restoredCaptures?.[0]?.screenshot).toBeUndefined();
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('rolls back screenshot intent and does not start screenshot preparation when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => 'data:image/jpeg;base64,should-not-run');
    const toBlob = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });

    await session.start();
    vi.spyOn(
      toDraftControllerTestApi(session) as { flushNow: () => Promise<'failure'> },
      'flushNow'
    ).mockImplementation(async () => {
      await deferredSave.promise;
      return 'failure';
    });

    const video = requireVideoElement();
    let currentTime = 8;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
      video.dispatchEvent(new Event('seeked'));
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      value: false,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'note',
        url: 'https://video.example/watch?t=42',
        createdAt: Date.now()
      }
    ];

    const togglePromise = sessionApi.toggleCaptureScreenshot('timestamp-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionApi.state.captures[0]).toMatchObject({ screenshotRequested: true });
    const toggledOnCaptures = view.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string }>
      | undefined;
    expect(toggledOnCaptures?.[0]).toMatchObject({
      hasScreenshot: false,
      screenshotState: 'pending'
    });

    deferredSave.resolve();
    await togglePromise;
    await vi.advanceTimersByTimeAsync(200);

    expect(sessionApi.state.captures[0]).not.toHaveProperty('screenshotRequested');
    expect(sessionApi.state.captures[0]?.screenshot).toBeUndefined();
    const rolledBackCaptures = view.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string }>
      | undefined;
    expect(rolledBackCaptures?.[0]).toMatchObject({
      hasScreenshot: false,
      screenshotState: 'off'
    });
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(currentTimeSetSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();

    createElementSpy.mockRestore();
    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('reuses same-session transient screenshots when a requested screenshot is toggled back on', async () => {
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: vi.fn(() => 'data:image/jpeg;base64,unexpected-frame'),
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });

    await session.start();

    const video = requireVideoElement();
    let currentTime = 8;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
      video.dispatchEvent(new Event('seeked'));
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'note',
        url: 'https://video.example/watch?t=42',
        createdAt: 1,
        screenshotRequested: true,
        screenshot: createBlobScreenshotFixture('cached-frame', 2_026_031_410_000, {
          fileName: 'file-20260314100000000.jpg'
        })
      }
    ];

    await sessionApi.toggleCaptureScreenshot('timestamp-1');

    expect(sessionApi.state.captures[0]?.screenshot).toMatchObject({
      content: {
        kind: 'blob',
        byteLength: 12
      }
    });
    expect(sessionApi.state.captures[0]).not.toHaveProperty('screenshotRequested');

    await sessionApi.toggleCaptureScreenshot('timestamp-1');

    expect(video.currentTime).toBe(8);
    expect(currentTimeSetSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();
    expect(sessionApi.state.captures[0]).toMatchObject({
      screenshotRequested: true,
      screenshot: {
        content: {
          kind: 'blob',
          byteLength: 12
        }
      }
    });
    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    const panelCaptures = view?.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ hasScreenshot?: boolean; screenshotState?: string; screenshot?: unknown }>
      | undefined;
    expect(panelCaptures?.[0]).toMatchObject({ hasScreenshot: true, screenshotState: 'on' });
    expect(panelCaptures?.[0]?.screenshot).toBeUndefined();

    createElementSpy.mockRestore();
    sessionApi.cleanup();
  });

  it.each(draftWriteCases)('serializes draft writes when $name', async ({ arrivalOrder }) => {
    const deps = createDependencies();
    const screenshotSave = createDeferred<{
      status: 'saved';
      ref: VideoScreenshotCacheRef;
    }>();
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> => screenshotSave.promise
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const screenshotBlob = new Blob(['serialized-frame'], { type: 'image/jpeg' });
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const screenshotCompletion: { callback: BlobCallback | null } = { callback: null };
    const transactionWriteGate = createDeferred<void>();
    const toBlob = vi.fn((callback: BlobCallback) => {
      if (arrivalOrder === 'screenshot-first') {
        callback(screenshotBlob);
        return;
      }
      screenshotCompletion.callback = callback;
    });
    const toDataURL = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });

    try {
      await session.start();
      const video = requireVideoElement();
      Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });

      await session.addCurrentTimestamp('button', {
        comment: 'original note',
        captureScreenshot: true,
        beginEditing: false
      });
      await waitForMockCalls(toBlob);

      const capture = sessionApi.state.captures[0];
      if (!capture || capture.kind !== 'timestamp') {
        throw new Error('expected timestamp capture with screenshot preparation');
      }
      const savedRef = createScreenshotCacheRefFixture(capture.id, {
        id: `serialized-shot-${arrivalOrder}`,
        byteLength: screenshotBlob.size
      });
      const transactionWriteStarted = createDeferred<void>();
      const setManyMock = vi.mocked(deps.storage.local.setMany);
      const writeToStorage = setManyMock.getMockImplementation();
      if (!writeToStorage) {
        throw new Error('expected direct draft storage implementation');
      }
      setManyMock.mockImplementation(async (values) => {
        const serialized = JSON.stringify(values);
        if (serialized.includes('serialized edit') && !serialized.includes(savedRef.key)) {
          transactionWriteStarted.resolve();
          await transactionWriteGate.promise;
        }
        return writeToStorage(values);
      });

      if (arrivalOrder === 'screenshot-first') {
        await waitForMockCalls(saveSpy);
      }

      const editPromise = requirePromise(
        requireMountedPanelCallbacks(mountedCallbacks).onSubmitCaptureEdit(
          capture.id,
          'serialized edit'
        )
      );

      if (arrivalOrder === 'mutation-first') {
        await transactionWriteStarted.promise;
        const finishScreenshot = screenshotCompletion.callback;
        if (!finishScreenshot) {
          throw new Error('expected deferred screenshot preparation callback');
        }
        screenshotCompletion.callback = null;
        finishScreenshot(screenshotBlob);
      } else {
        await flushMutationWork();
      }

      screenshotSave.resolve({ status: 'saved', ref: savedRef });

      if (arrivalOrder === 'screenshot-first') {
        let durableWithRef = await readVideoDraftCandidateWithScreenshotRef(deps, capture.id);
        for (let index = 0; index < 20 && !durableWithRef; index += 1) {
          await flushMutationWork();
          durableWithRef = await readVideoDraftCandidateWithScreenshotRef(deps, capture.id);
        }
        expect(durableWithRef).not.toBeNull();
      } else {
        for (let index = 0; index < 20; index += 1) {
          await flushMutationWork();
        }
      }

      transactionWriteGate.resolve();
      await editPromise;

      let durable = await readVideoDraftCandidateWithScreenshotRef(deps, capture.id);
      for (let index = 0; index < 20 && !durable; index += 1) {
        await flushMutationWork();
        durable = await readVideoDraftCandidateWithScreenshotRef(deps, capture.id);
      }
      const durableCapture = readVideoDraftPayload(durable)?.captures[0];
      expect(durableCapture).toMatchObject({
        kind: 'timestamp',
        screenshotRequested: true,
        screenshotRef: savedRef
      });
      expect(await listVideoDraftCandidates(deps)).toHaveLength(1);
      expect(toDataURL).not.toHaveBeenCalled();
    } finally {
      transactionWriteGate.resolve();
      screenshotCompletion.callback?.(null);
      screenshotSave.resolve({
        status: 'saved',
        ref: createScreenshotCacheRefFixture('cleanup')
      });
      createElementSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('writes through prepared screenshots asynchronously, assigns screenshot refs after save, and schedules draft persistence', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const trackUsageEvent = getTrackUsageEventMock(deps);
    const saveDeferred = createDeferred<{ status: 'saved'; ref: VideoScreenshotCacheRef }>();
    const cacheTypesModule =
      await import('../../../../src/content/video/videoScreenshotCacheTypes');
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> => saveDeferred.promise
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy
    });
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-write-through-1',
      pageUrl: document.location.href,
      pageTitle: 'Draft title',
      updatedAt: 2_000_000_000_200,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'Restored marker',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Draft title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(envelope);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob(['prepared-frame'], { type: 'image/jpeg' }));
    });
    const toDataURL = vi.fn();
    const hiddenVideo = createPreparationVideoHarness({
      currentTime: 0,
      sourceUrl: 'https://cdn.example/video.mp4'
    });
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'video') {
        return hiddenVideo.video;
      }
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });
    const video = requireVideoElement();
    let currentTime = 8;
    let paused = false;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      get: () => paused,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', {
      value: 640,
      configurable: true
    });
    Object.defineProperty(video, 'videoHeight', {
      value: 360,
      configurable: true
    });
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    Object.defineProperty(video, 'src', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });
    const savedRef: VideoScreenshotCacheRef = {
      schemaVersion: 1,
      pageKey: 'video-example',
      captureId: 'ts-1',
      id: 'shot-42',
      key: cacheTypesModule.createVideoScreenshotCacheStorageKey({
        pageKey: 'video-example',
        captureId: 'ts-1',
        screenshotId: 'shot-42'
      }),
      fileName: 'video-0m42s.jpg',
      mimeType: 'image/jpeg',
      byteLength: 14,
      capturedAt: 2_000_000_000_300,
      expiresAt: 2_000_000_000_300 + 60_000
    };

    try {
      await session.start();
      await waitForMockCalls(drawImage);
      trackUsageEvent.mockClear();

      expect(sessionApi.state.captures).toHaveLength(1);
      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }
      const screenshot = await waitForTimestampScreenshot(restoredTimestamp);

      const cacheSaveInput = readFirstCacheSaveInput(saveSpy);
      expect(cacheSaveInput.captureId).toBe('ts-1');
      expect(typeof cacheSaveInput.pageKey).toBe('string');
      expect(cacheSaveInput.screenshot).toBe(screenshot);
      expect(restoredTimestamp.screenshot).toBe(screenshot);
      expect(restoredTimestamp.screenshotRef).toBeUndefined();
      expect(trackUsageEvent).not.toHaveBeenCalled();
      expect(currentTime).toBe(8);
      expect(currentTimeSetSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();

      saveDeferred.resolve({
        status: 'saved',
        ref: savedRef
      });
      await flushMutationWork();
      expect(trackUsageEvent).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 200);
      });
      await flushMutationWork();

      expect(restoredTimestamp.screenshotRef).toEqual(savedRef);
      expect(trackUsageEvent).toHaveBeenCalledTimes(1);
      expect(trackUsageEvent).toHaveBeenCalledWith('video_screenshot_captured', {
        screenshot_count_bucket: 'one'
      });
      expectNoForbiddenAnalyticsKeys(
        trackUsageEvent.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
      );
      const analyticsPayload = JSON.stringify(trackUsageEvent.mock.calls.at(-1)?.[1] ?? {});
      expect(analyticsPayload).not.toContain(savedRef.key);
      expect(analyticsPayload).not.toContain(savedRef.id);
      expect(analyticsPayload).not.toContain(savedRef.captureId);
      expect(analyticsPayload).not.toContain(savedRef.pageKey);
      expect(analyticsPayload).not.toContain('prepared-frame');
      expect(analyticsPayload).not.toContain('byteLength');
      let latestCandidate = await readVideoDraftCandidateWithScreenshotRef(deps, 'ts-1');
      for (let index = 0; index < 20; index += 1) {
        if (latestCandidate) break;
        await flushMutationWork();
        latestCandidate = await readVideoDraftCandidateWithScreenshotRef(deps, 'ts-1');
      }
      const latestCapture = readVideoDraftPayload(latestCandidate)?.captures[0];
      expect(latestCapture).toMatchObject({
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef: savedRef
      });
      expect(toDataURL).not.toHaveBeenCalled();
    } finally {
      createElementSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('keeps prepared screenshots in memory when cache write-through fails', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const trackUsageEvent = getTrackUsageEventMock(deps);
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(
      (): Promise<VideoScreenshotCacheSaveResult> => Promise.reject(new Error('cache write failed'))
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-write-through-failure-1',
      pageUrl: document.location.href,
      pageTitle: 'Draft title',
      updatedAt: 2_000_000_000_200,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'Restored marker',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Draft title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(envelope);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob(['prepared-frame'], { type: 'image/jpeg' }));
    });
    const toDataURL = vi.fn();
    const hiddenVideo = createPreparationVideoHarness({
      currentTime: 0,
      sourceUrl: 'https://cdn.example/video.mp4'
    });
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName.toLowerCase() === 'video') {
        return hiddenVideo.video;
      }
      if (tagName.toLowerCase() === 'canvas') {
        Object.defineProperty(canvas, 'getContext', {
          value: vi.fn(() => ({ drawImage })),
          configurable: true
        });
        Object.defineProperty(canvas, 'toBlob', {
          value: toBlob,
          configurable: true
        });
        Object.defineProperty(canvas, 'toDataURL', {
          value: toDataURL,
          configurable: true
        });
        return canvas;
      }
      return Document.prototype.createElement.call(document, tagName);
    });
    const video = requireVideoElement();
    let currentTime = 8;
    let paused = false;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'paused', {
      get: () => paused,
      configurable: true
    });
    Object.defineProperty(video, 'readyState', {
      value: 4,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', {
      value: 640,
      configurable: true
    });
    Object.defineProperty(video, 'videoHeight', {
      value: 360,
      configurable: true
    });
    Object.defineProperty(video, 'currentSrc', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    Object.defineProperty(video, 'src', {
      value: 'https://cdn.example/video.mp4',
      configurable: true
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    try {
      await session.start();
      await waitForMockCalls(drawImage);
      trackUsageEvent.mockClear();

      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }
      const screenshot = await waitForTimestampScreenshot(restoredTimestamp);
      await flushMutationWork();

      expect(saveSpy).toHaveBeenCalledTimes(2);
      expect(restoredTimestamp.screenshot).toBe(screenshot);
      expect(restoredTimestamp.screenshotRef).toBeUndefined();
      expect(currentTime).toBe(8);
      expect(currentTimeSetSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[VideoSession] Failed to persist prepared screenshot:',
        expect.any(Error)
      );
      const latestCandidate = await readLatestVideoDraftCandidate(deps);
      const latestPayload = readVideoDraftPayload(latestCandidate);
      expect(latestPayload?.captures[0]).toMatchObject({
        id: 'ts-1',
        screenshotRequested: true
      });
      expect(latestPayload?.captures[0]).not.toHaveProperty('screenshotRef');
      expect(trackUsageEvent).not.toHaveBeenCalled();
      expect(toDataURL).not.toHaveBeenCalled();
    } finally {
      createElementSpy.mockRestore();
      warnSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('exports only already-live screenshots and does not seek or recapture missing requested screenshots', async () => {
    const dependencies = createDependencies();
    const session = new VideoSession(document, dependencies);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = requireVideoElement();
    let currentTime = 8;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set: currentTimeSetSpy,
      configurable: true
    });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: '',
        url: 'https://video.example/watch?t=42',
        createdAt: 1,
        screenshotRequested: true
      }
    ];

    await sessionApi.finish();

    const lastExportCall = exportMock.mock.calls.at(-1);
    expect(lastExportCall).toBeDefined();
    if (!lastExportCall) {
      throw new Error('expected exporter to be called');
    }
    const exportArgs = (lastExportCall as unknown[])[0];
    expect(exportArgs).toEqual(
      expect.objectContaining({
        captures: [expect.objectContaining({ id: 'timestamp-1', screenshotRequested: true })]
      })
    );
    expect(
      (
        exportArgs as unknown as {
          captures?: Array<{ screenshot?: unknown }>;
        }
      )?.captures?.[0]?.screenshot
    ).toBeUndefined();
    expect(currentTimeSetSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'propagated failure buckets',
      configureFailure: () =>
        exportMock.mockResolvedValueOnce({
          success: false,
          error: 'boom',
          failureCategory: 'write'
        } as {
          success: boolean;
          error: string;
          failureCategory: 'write';
        }),
      expectedCategory: 'write'
    },
    {
      name: 'validation failures from invalid payload responses',
      configureFailure: () =>
        exportMock.mockResolvedValueOnce({
          success: false,
          error: 'Invalid clip payload received.'
        } as {
          success: boolean;
          error: string;
        }),
      expectedCategory: 'validation'
    },
    {
      name: 'unsupported export surfaces',
      configureFailure: () =>
        exportMock.mockRejectedValueOnce(
          new Error('Visible tab screenshot capture is unsupported.')
        ),
      expectedCategory: 'unsupported'
    },
    {
      name: 'permission-denied export surfaces',
      configureFailure: () => exportMock.mockRejectedValueOnce(new Error('permission denied')),
      expectedCategory: 'permission'
    },
    {
      name: 'message timeout failures',
      configureFailure: () =>
        exportMock.mockRejectedValueOnce(new Error('Message timeout after waiting for response')),
      expectedCategory: 'timeout'
    },
    {
      name: 'local write failures',
      configureFailure: () =>
        exportMock.mockRejectedValueOnce({
          code: 'LOCAL_VAULT_WRITE_FAILED',
          domain: 'background',
          message: 'Local vault write failed: Vault/video.md',
          severity: 'error',
          recoverable: true
        }),
      expectedCategory: 'write'
    },
    {
      name: 'rest connectivity failures',
      configureFailure: () =>
        exportMock.mockRejectedValueOnce({
          code: 'REST_NETWORK_OFFLINE',
          domain: 'rest',
          message: 'rest offline',
          severity: 'error',
          recoverable: true
        }),
      expectedCategory: 'connection'
    },
    {
      name: 'opaque export errors',
      configureFailure: () =>
        exportMock.mockResolvedValueOnce({ success: false, error: 'boom' } as {
          success: boolean;
          error: string;
        }),
      expectedCategory: 'unknown'
    }
  ])(
    'emits canonical export failure analytics with actionable category for $name',
    async ({ configureFailure, expectedCategory }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
      configureFailure();
      const deps = createDependencies();
      const session = new VideoSession(document, deps);
      const sessionApi = toSessionTestApi(session);
      const trackUsageEvent = getTrackUsageEventMock(deps);

      await session.start();
      sessionApi.state.captures = [
        {
          kind: 'timestamp',
          id: 'timestamp-1',
          timeSec: 12,
          comment: 'private export note',
          url: 'https://video.example/watch?t=12',
          createdAt: 1
        }
      ];
      vi.setSystemTime(new Date('2026-03-14T10:00:06Z'));

      await sessionApi.finish();

      expect(trackUsageEvent).toHaveBeenLastCalledWith('video_export_failed', {
        platform: 'bilibili',
        destination: 'downloads',
        failure_category: expectedCategory
      });
      expect(JSON.stringify(trackUsageEvent.mock.calls.at(-1)?.[1] ?? {})).not.toContain(
        'private export note'
      );
      expectNoForbiddenAnalyticsKeys(
        trackUsageEvent.mock.calls.at(-1)?.[1] as Record<string, unknown>
      );

      sessionApi.cleanup();
      vi.useRealTimers();
    }
  );
});
