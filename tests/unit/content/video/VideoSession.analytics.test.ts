/* @vitest-environment jsdom */

import './videoSessionTestHarness';

import {
  __resetContentSessionRegistryForTests,
  isVideoSessionActive
} from '@content/runtime/contentSessionRegistry';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import { VideoSession } from '@content/video/session';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import { DEFAULT_SESSION_MESSAGES } from '@content/video/sessionMessages';
import type { VideoScreenshotCacheRef } from '@content/video/videoScreenshotCacheTypes';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VideoScreenshotCacheSaveMock } from './videoSessionTestHarness';
import {
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
  loadLatestVideoDraft,
  readVideoDraftCandidateWithScreenshotRef,
  readVideoDraftPayload,
  requireMountedPanelCallbacks,
  requirePromise,
  requireVideoElement,
  resetVideoSessionHarnessMocks,
  restoreVideoSessionHarnessGlobals,
  toDraftControllerTestApi,
  toSessionTestApi,
  waitForMockCalls
} from './videoSessionTestHarness';

const { exportMock, createVideoPlatformAdapterMock } = getVideoSessionHarnessMocks();

describe('VideoSession analytics', () => {
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

  it('keeps the session active and suppresses cancel analytics when terminal draft persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    Object.defineProperty(requireVideoElement(), 'currentTime', {
      value: 42,
      configurable: true
    });
    await sessionApi.handleAddCapture();
    trackUsageEvent.mockClear();
    view.updateHint.mockClear();
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() =>
      Promise.reject(new Error('cancel terminal save failed'))
    );

    requireMountedPanelCallbacks(mountedCallbacks).onCancel();
    await waitForMockCalls(view.updateHint);

    expect(view.destroy).not.toHaveBeenCalled();
    expect(isVideoSessionActive(document)).toBe(true);
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(trackUsageEvent).not.toHaveBeenCalled();
    await expect(loadLatestVideoDraft(deps)).resolves.toMatchObject({ status: 'active' });

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('emits canonical start and cancel analytics with an unknown source fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return createView();
    });
    const session = new VideoSession(document, deps);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();

    expect(trackUsageEvent).toHaveBeenNthCalledWith(1, 'video_session_started', {
      platform: 'bilibili',
      source: 'unknown'
    });
    expect(JSON.stringify(trackUsageEvent.mock.calls.at(0)?.[1] ?? {})).not.toContain(
      'Video Title'
    );

    vi.setSystemTime(new Date('2026-03-14T10:00:05Z'));
    requireMountedPanelCallbacks(mountedCallbacks).onCancel();
    await waitForMockCalls(trackUsageEvent, 2);

    expect(trackUsageEvent).toHaveBeenNthCalledWith(2, 'video_session_cancelled', {
      platform: 'bilibili',
      duration_bucket: '3s_to_9s'
    });
    expectNoForbiddenAnalyticsKeys(
      trackUsageEvent.mock.calls.at(0)?.[1] as Record<string, unknown>
    );
    expectNoForbiddenAnalyticsKeys(
      trackUsageEvent.mock.calls.at(1)?.[1] as Record<string, unknown>
    );
    expect(trackUsageEvent.mock.calls.map(([eventName]) => eventName)).toEqual([
      'video_session_started',
      'video_session_cancelled'
    ]);

    vi.useRealTimers();
  });

  it('updates the panel immediately for fragment adds but emits analytics only after save succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() => deferredSave.promise);
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    trackUsageEvent.mockClear();

    const fragmentHost = document.createElement('p');
    fragmentHost.textContent = 'Selected text that should save';
    document.body.append(fragmentHost);
    const textNode = fragmentHost.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('expected fragment fixture text node');
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'Selected text'.length);

    session.ingestTextCapture('<p>Selected text</p>', 'Selected text', 'fragment note', range);
    await Promise.resolve();

    expect(sessionApi.state.captures).toHaveLength(1);
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    deferredSave.resolve();
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(trackUsageEvent).toHaveBeenCalledWith('video_fragment_added', {
      capture_count_bucket: 'one'
    });

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('swallows video_screenshot_captured analytics failures without interrupting screenshot persistence', async () => {
    const deps = createDependencies();
    const repository = createSessionDraftRepository(deps.storage.local);
    const trackUsageEvent = getTrackUsageEventMock(deps);
    trackUsageEvent.mockImplementation((event) => {
      if (event === 'video_screenshot_captured') {
        return Promise.reject(new Error('analytics failed'));
      }
      return Promise.resolve(undefined);
    });
    const cacheTypesModule =
      await import('../../../../src/content/video/videoScreenshotCacheTypes');
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
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn(() =>
      Promise.resolve({
        status: 'saved',
        ref: savedRef
      })
    );
    deps.screenshotCacheRepository = createScreenshotCacheRepositoryMock({
      save: saveSpy
    });
    const envelope = createVideoSessionDraftEnvelope({
      draftId: 'draft-write-through-analytics-failure-1',
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
      await flushMutationWork();
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 200);
      });
      await flushMutationWork();

      const restoredTimestamp = sessionApi.state.captures[0];
      if (!restoredTimestamp || restoredTimestamp.kind !== 'timestamp') {
        throw new Error('expected restored timestamp capture');
      }
      expect(restoredTimestamp.screenshotRef).toEqual(savedRef);
      expect(currentTime).toBe(8);
      expect(currentTimeSetSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
      expect(trackUsageEvent).toHaveBeenCalledWith('video_screenshot_captured', {
        screenshot_count_bucket: 'one'
      });
      let latestCandidate = await readVideoDraftCandidateWithScreenshotRef(deps, 'ts-1');
      for (let index = 0; index < 20; index += 1) {
        if (latestCandidate) break;
        await flushMutationWork();
        latestCandidate = await readVideoDraftCandidateWithScreenshotRef(deps, 'ts-1');
      }
      expect(readVideoDraftPayload(latestCandidate)?.captures[0]).toMatchObject({
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef: savedRef
      });
    } finally {
      createElementSpy.mockRestore();
      sessionApi.cleanup();
    }
  });

  it('emits only canonical capture analytics events without privacy-sensitive params', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const saveSpy: VideoScreenshotCacheSaveMock = vi.fn((input) =>
      Promise.resolve({
        status: 'saved',
        ref: createScreenshotCacheRefFixture(input.captureId)
      })
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
    const trackUsageEvent = getTrackUsageEventMock(deps);
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback(new Blob(['private-frame'], { type: 'image/jpeg' }));
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

    await session.start();

    const video = requireVideoElement();
    let currentTime = 42;
    const currentTimeSetSpy = vi.fn((value: number) => {
      currentTime = value;
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
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());

    await session.addCurrentTimestamp('button');
    session.ingestTextCapture('<p>Private fragment</p>', 'Private fragment', 'Private comment');
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();
    const timestampId = sessionApi.state.captures.find(
      (capture) => capture.kind === 'timestamp'
    )?.id;
    const fragmentId = (
      sessionApi.state.captures as Array<{
        kind: 'timestamp' | 'fragment';
        id: string;
      }>
    ).find((capture) => capture.kind === 'fragment')?.id;
    if (!timestampId || !fragmentId) {
      throw new Error('expected timestamp and fragment captures');
    }

    await sessionApi.toggleCaptureScreenshot(timestampId);
    await waitForMockCalls(drawImage);
    await sessionApi.toggleCaptureScreenshot(timestampId);
    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture(fragmentId);
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(trackUsageEvent.mock.calls.map(([eventName]) => eventName).sort()).toEqual(
      [
        'video_session_started',
        'video_timestamp_added',
        'video_fragment_added',
        'video_capture_removed',
        'video_screenshot_captured'
      ].sort()
    );
    expect(trackUsageEvent).toHaveBeenCalledWith('video_timestamp_added', {
      capture_count_bucket: 'one'
    });
    expect(trackUsageEvent).toHaveBeenCalledWith('video_fragment_added', {
      capture_count_bucket: 'two_to_five'
    });
    expect(trackUsageEvent).toHaveBeenCalledWith('video_capture_removed', {
      capture_count_bucket: 'one'
    });
    expect(trackUsageEvent).toHaveBeenCalledWith('video_screenshot_captured', {
      screenshot_count_bucket: 'one'
    });
    expect(currentTimeSetSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toDataURL).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledTimes(1);

    const analyticsPayload = trackUsageEvent.mock.calls
      .map(([, params]) => JSON.stringify(params ?? {}))
      .join('\n');
    expect(analyticsPayload).not.toContain('Private fragment');
    expect(analyticsPayload).not.toContain('Private comment');
    expect(analyticsPayload).not.toContain('private-frame');
    expect(analyticsPayload).not.toContain('byteLength');
    expect(analyticsPayload).not.toContain('https://video.example');
    expect(
      trackUsageEvent.mock.calls.some(
        ([eventName]) => String(eventName) === 'video_screenshot_toggled'
      )
    ).toBe(false);
    expect(
      trackUsageEvent.mock.calls.some(
        ([eventName]) => String(eventName) === 'video_screenshot_captured'
      )
    ).toBe(true);
    expect(
      trackUsageEvent.mock.calls.some(
        ([eventName]) => String(eventName) === 'video_session_exported'
      )
    ).toBe(false);
    expect(
      trackUsageEvent.mock.calls.some(([eventName]) => String(eventName) === 'video_session_failed')
    ).toBe(false);
    trackUsageEvent.mock.calls.forEach(([, params]) => {
      expectNoForbiddenAnalyticsKeys(params as Record<string, unknown> | undefined);
    });

    createElementSpy.mockRestore();
    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('does not emit video_timestamp_added until the timestamp save succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    trackUsageEvent.mockClear();

    Object.defineProperty(requireVideoElement(), 'currentTime', {
      value: 42,
      configurable: true
    });
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() => deferredSave.promise);

    const addPromise = session.addCurrentTimestamp('button', { beginEditing: false });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    deferredSave.resolve();
    await addPromise;

    expect(trackUsageEvent).toHaveBeenCalledTimes(1);
    expect(trackUsageEvent).toHaveBeenCalledWith('video_timestamp_added', {
      capture_count_bucket: 'one'
    });
  });

  it('rolls back fragment removal, restores drafts and highlights, and suppresses removal analytics when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    trackUsageEvent.mockClear();
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
        id: 'ts-1',
        timeSec: 10,
        comment: '',
        url: 'https://video.example/watch?t=10',
        createdAt: 1
      },
      {
        kind: 'fragment',
        id: 'frag-1',
        comment: 'fragment note',
        selectedText: 'Quoted text',
        selectedHtml: '<p>Quoted text</p>',
        fragmentUrl: 'https://video.example/watch#:~:text=Quoted%20text',
        createdAt: 2,
        wrapperId: 'frag-1-wrapper'
      },
      {
        kind: 'timestamp',
        id: 'ts-2',
        timeSec: 20,
        comment: '',
        url: 'https://video.example/watch?t=20',
        createdAt: 3
      }
    ];
    sessionApi.state.commentDrafts = {
      'frag-1': 'draft note'
    };
    const fragmentWrapper = document.createElement('mark');
    fragmentWrapper.id = 'frag-1-wrapper';
    fragmentWrapper.textContent = 'Quoted text';
    document.body.append(fragmentWrapper);

    const platformAdapter = createVideoPlatformAdapterMock.mock.results.at(-1)?.value as
      | {
          restoreHighlight: Mock<(capture: { id: string; selectedText: string }) => string>;
        }
      | undefined;
    if (!platformAdapter) {
      throw new Error('expected platform adapter to be created');
    }
    platformAdapter.restoreHighlight.mockImplementation((capture) => {
      const wrapper = document.createElement('mark');
      wrapper.id = `${capture.id}-wrapper`;
      wrapper.textContent = capture.selectedText;
      document.body.append(wrapper);
      return wrapper.id;
    });

    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture('frag-1');
    await Promise.resolve();

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['ts-1', 'ts-2']);
    expect(sessionApi.state.commentDrafts).toEqual({});
    expect(document.getElementById('frag-1-wrapper')).toBeNull();
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toHaveLength(2);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    deferredSave.resolve();
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual([
      'ts-1',
      'frag-1',
      'ts-2'
    ]);
    expect(sessionApi.state.commentDrafts).toEqual({
      'frag-1': 'draft note'
    });
    expect(platformAdapter.restoreHighlight).toHaveBeenCalled();
    expect(document.getElementById('frag-1-wrapper')).not.toBeNull();
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toHaveLength(3);
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('updates the panel immediately for removals but emits removal analytics only after save succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() => deferredSave.promise);
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    trackUsageEvent.mockClear();

    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'ts-1',
        timeSec: 10,
        comment: '',
        url: 'https://video.example/watch?t=10',
        createdAt: 1
      },
      {
        kind: 'timestamp',
        id: 'ts-2',
        timeSec: 20,
        comment: '',
        url: 'https://video.example/watch?t=20',
        createdAt: 2
      }
    ];

    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture('ts-1');
    await Promise.resolve();

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['ts-2']);
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    deferredSave.resolve();
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(trackUsageEvent).toHaveBeenCalledWith('video_capture_removed', {
      capture_count_bucket: 'one'
    });

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('emits canonical export success analytics without leaking private fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
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
        createdAt: 1,
        screenshotRequested: true
      },
      {
        kind: 'fragment',
        id: 'fragment-1',
        comment: 'secret fragment note',
        selectedText: 'sensitive fragment text',
        selectedHtml: '<mark>sensitive fragment text</mark>',
        fragmentUrl: 'https://video.example/watch#:~:text=sensitive%20fragment%20text',
        createdAt: 2
      }
    ];
    vi.setSystemTime(new Date('2026-03-14T10:00:06Z'));

    await sessionApi.finish();

    expect(trackUsageEvent).toHaveBeenLastCalledWith('video_exported', {
      platform: 'bilibili',
      destination: 'downloads',
      duration_bucket: '3s_to_9s',
      capture_count_bucket: 'two_to_five',
      screenshot_count_bucket: 'one'
    });
    expect(JSON.stringify(trackUsageEvent.mock.calls.at(-1)?.[1] ?? {})).not.toContain(
      'private export note'
    );
    expect(JSON.stringify(trackUsageEvent.mock.calls.at(-1)?.[1] ?? {})).not.toContain(
      'sensitive fragment text'
    );
    expectNoForbiddenAnalyticsKeys(
      trackUsageEvent.mock.calls.at(-1)?.[1] as Record<string, unknown>
    );

    vi.useRealTimers();
  });

  it('keeps the session active and suppresses export success analytics when terminal draft persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    Object.defineProperty(requireVideoElement(), 'currentTime', {
      value: 42,
      configurable: true
    });
    await sessionApi.handleAddCapture();
    trackUsageEvent.mockClear();
    view.updateHint.mockClear();
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() =>
      Promise.reject(new Error('export terminal save failed'))
    );

    await requirePromise(requireMountedPanelCallbacks(mountedCallbacks).onFinish());

    expect(exportMock).toHaveBeenCalledTimes(1);
    expect(view.destroy).not.toHaveBeenCalled();
    expect(isVideoSessionActive(document)).toBe(true);
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(trackUsageEvent).not.toHaveBeenCalled();
    await expect(loadLatestVideoDraft(deps)).resolves.toMatchObject({ status: 'active' });

    sessionApi.cleanup();
    vi.useRealTimers();
  });
});
