/* @vitest-environment jsdom */

import './videoSessionTestHarness';

import {
  __resetContentSessionRegistryForTests,
  isVideoSessionActive,
  registerVideoSession
} from '@content/runtime/contentSessionRegistry';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import { VideoSession } from '@content/video/session';
import { DEFAULT_SESSION_MESSAGES } from '@content/video/sessionMessages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobal } from '../../../utils/typeHelpers';

import type { TestView } from './videoSessionTestHarness';
import {
  RecordingMutationObserver,
  createDeferred,
  createDependencies,
  createView,
  flushMutationWork,
  getTrackUsageEventMock,
  getVideoSessionHarnessMocks,
  listVideoDraftCandidates,
  loadLatestVideoDraft,
  readVideoDraftPayload,
  requireMountedPanelCallbacks,
  requirePromise,
  requireVideoElement,
  resetVideoSessionHarnessMocks,
  restoreVideoSessionHarnessGlobals,
  seedTimestampCaptures,
  toDraftControllerTestApi,
  toSessionTestApi
} from './videoSessionTestHarness';

const { ensureContentI18nMock, saveCaptureDataMock } = getVideoSessionHarnessMocks();

describe('VideoSession', () => {
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

  it('requires explicit dependencies', () => {
    const deps = createDependencies();
    expect(() => new VideoSession(document, deps)).not.toThrow();
  });

  it('returns early when a session is already active', async () => {
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const applyHintSpy = vi.spyOn(sessionApi, 'applyHint');
    registerVideoSession({ id: 'active' }, document);

    await session.start();

    expect(applyHintSpy).toHaveBeenCalledWith('ready');
    expect(ensureContentI18nMock).not.toHaveBeenCalled();
  });

  it('starts, mounts the panel, and registers the session', async () => {
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    expect(isVideoSessionActive(document)).toBe(true);
    expect(view?.updateTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        title: DEFAULT_SESSION_MESSAGES.panel.title
      })
    );

    sessionApi.cleanup();
  });

  it('adds a timestamp capture, persists it, and opens edit mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = document.querySelector('video');
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    const pauseSpy = vi
      .spyOn(video as HTMLVideoElement, 'pause')
      .mockImplementation(() => undefined);

    await sessionApi.handleAddCapture();

    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    expect(await listVideoDraftCandidates(deps)).toHaveLength(1);
    expect(saveCaptureDataMock).not.toHaveBeenCalled();
    expect(view?.beginEditingCapture).toHaveBeenCalledWith(
      expect.stringContaining('aiob-video-'),
      ''
    );
    expect(pauseSpy).not.toHaveBeenCalled();

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('threads an injected generic null item cap through video draft saves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00Z'));
    const retentionMs = 96 * 60 * 60 * 1000;
    const deps = createDependencies(null, {
      sessionDraftStoragePolicy: createSessionDraftStoragePolicy({
        retentionPolicy: {
          retentionMs,
          maxRestorablePages: null,
          maxItemsPerPage: null
        }
      })
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    seedTimestampCaptures(sessionApi, 25);

    await toDraftControllerTestApi(session).flushNow('active');

    const draft = await loadLatestVideoDraft(deps);
    const payload = readVideoDraftPayload(draft);
    expect(payload?.captures).toHaveLength(25);
    expect(draft?.expiresAt).toBe(Date.now() + retentionMs);
    const serializedDraft = JSON.stringify(draft);
    expect(serializedDraft).not.toContain('data:image/');
    expect(serializedDraft).not.toContain('"screenshot"');
    expect(serializedDraft).not.toContain('"content"');

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('pauses playback when timestamp capture is started from the add-note input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = document.querySelector('video');
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pauseSpy = vi
      .spyOn(video as HTMLVideoElement, 'pause')
      .mockImplementation(() => undefined);

    await sessionApi.handleAddCapture('note-input');

    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(view?.beginEditingCapture).toHaveBeenCalledWith(
      expect.stringContaining('aiob-video-'),
      ''
    );

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('pauses add-note playback before the capture save resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const saveGate: { resolve?: () => void } = {};
    const deps = createDependencies();
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saveGate.resolve = () => resolve();
        })
    );
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = requireVideoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const addPromise = sessionApi.handleAddCapture('note-input');

    await vi.advanceTimersByTimeAsync(0);

    const view = (deps.viewFactory.createView as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as TestView | undefined;
    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(view?.beginEditingCapture).not.toHaveBeenCalled();

    expect(saveGate.resolve).toBeTruthy();
    if (!saveGate.resolve) {
      throw new Error('capture save did not start');
    }
    saveGate.resolve();
    await addPromise;

    expect(view?.beginEditingCapture).toHaveBeenCalledWith(
      expect.stringContaining('aiob-video-'),
      ''
    );

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('rolls back an add-note capture and playback lease when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    vi.mocked(deps.storage.local.setMany).mockRejectedValueOnce(new Error('save failed'));
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
    const session = new VideoSession(document, deps);

    await session.start();

    const video = document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error('video fixture did not mount');
    }
    let paused = false;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });
    view.setCaptures.mockClear();
    view.beginEditingCapture.mockClear();
    view.stopEditing.mockClear();
    view.updateHint.mockClear();

    await session.addCurrentTimestamp('note-input');

    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(view.beginEditingCapture).not.toHaveBeenCalled();
    expect(view.stopEditing).toHaveBeenCalled();
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);

    paused = false;
    video.dispatchEvent(new Event('play'));

    expect(pauseSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('rolls back a fragment capture, highlight wrapper, and editor state when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    RecordingMutationObserver.reset();
    const restoreMutationObserver = setGlobal('MutationObserver', RecordingMutationObserver);
    const deferredSave = createDeferred<void>();
    const deps = createDependencies();
    const view = createView();
    deps.viewFactory.createView = vi.fn(() => view);
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

    const fragmentHost = document.createElement('p');
    fragmentHost.textContent = 'Selected text that should roll back cleanly';
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

    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    if (typeof captureId !== 'string') {
      throw new Error('expected fragment editing to start before save');
    }
    const wrapperId = `${captureId}-wrapper`;

    expect(sessionApi.state.captures).toHaveLength(1);
    expect(document.getElementById(wrapperId)).not.toBeNull();
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(
      trackUsageEvent.mock.calls.some(([eventName]) => eventName === 'video_fragment_added')
    ).toBe(false);
    expect(RecordingMutationObserver.instances).toHaveLength(1);

    deferredSave.resolve();
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(sessionApi.state.captures).toEqual([]);
    expect(document.getElementById(wrapperId)).toBeNull();
    expect(view.setCaptures.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(view.stopEditing).toHaveBeenCalledWith(captureId);
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(
      trackUsageEvent.mock.calls.some(([eventName]) => eventName === 'video_fragment_added')
    ).toBe(false);
    expect(RecordingMutationObserver.instances[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(RecordingMutationObserver.instances).toHaveLength(1);

    sessionApi.cleanup();
    restoreMutationObserver();
    vi.useRealTimers();
  });

  it('keeps playback paused while a note editor remains active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = requireVideoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());

    await sessionApi.handleAddCapture('note-input');
    video.dispatchEvent(new Event('play'));

    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(playSpy).not.toHaveBeenCalled();

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('does not pause playback when an existing capture editor focuses by default', async () => {
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

    await session.start();

    const video = requireVideoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());

    await session.addCurrentTimestamp('button');
    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    expect(captureId).toBeTruthy();
    if (!captureId) {
      throw new Error('timestamp capture was not created');
    }
    pauseSpy.mockClear();
    playSpy.mockClear();

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onCaptureEditorFocus?.(captureId);
    video.dispatchEvent(new Event('play'));
    callbacks.onCaptureEditorBlur?.(captureId, 'outside-panel');

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();

    callbacks.onCancel();
    vi.useRealTimers();
  });

  it('pauses and restores existing capture editor focus when comment editor auto-pause is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies({
      floatingPromptEnabled: true,
      promptButtonLabel: 'Clip video',
      promptShortcut: 'Alt+V',
      controlBarAutoPause: true,
      controlBarScreenshot: true,
      commentEditorAutoPause: true
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);

    await session.start();

    const video = requireVideoElement();
    let paused = false;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    await session.addCurrentTimestamp('button');
    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    expect(captureId).toBeTruthy();
    if (!captureId) {
      throw new Error('timestamp capture was not created');
    }
    pauseSpy.mockClear();
    playSpy.mockClear();

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onCaptureEditorFocus?.(captureId);
    video.dispatchEvent(new Event('play'));
    callbacks.onCaptureEditorBlur?.(captureId, 'outside-panel');

    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(playSpy).toHaveBeenCalledTimes(1);

    callbacks.onCancel();
    vi.useRealTimers();
  });

  it('does not restore originally paused videos when comment editor auto-pause is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies({
      floatingPromptEnabled: true,
      promptButtonLabel: 'Clip video',
      promptShortcut: 'Alt+V',
      controlBarAutoPause: true,
      controlBarScreenshot: true,
      commentEditorAutoPause: true
    });
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);

    await session.start();

    const video = requireVideoElement();
    let paused = true;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    await session.addCurrentTimestamp('button');
    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    expect(captureId).toBeTruthy();
    if (!captureId) {
      throw new Error('timestamp capture was not created');
    }
    pauseSpy.mockClear();
    playSpy.mockClear();

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onCaptureEditorFocus?.(captureId);
    callbacks.onCaptureEditorBlur?.(captureId, 'outside-panel');

    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();

    callbacks.onCancel();
    vi.useRealTimers();
  });

  it('restores playback after panel add-note input submits with Enter', async () => {
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

    await session.start();

    const video = requireVideoElement();
    let paused = false;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    await session.addCurrentTimestamp('note-input');
    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    expect(captureId).toBeTruthy();
    if (!captureId) {
      throw new Error('add-note did not create a capture');
    }

    const submitGate: { resolve?: () => void } = {};
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          submitGate.resolve = () => resolve();
        })
    );
    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    const submitPromise = requirePromise(callbacks.onSubmitCaptureEdit(captureId, 'panel note'));
    await vi.advanceTimersByTimeAsync(0);

    paused = false;
    video.dispatchEvent(new Event('play'));
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(playSpy).not.toHaveBeenCalled();

    expect(submitGate.resolve).toBeTruthy();
    submitGate.resolve?.();
    await submitPromise;

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(view.stopEditing).toHaveBeenCalledWith(captureId);

    callbacks.onCancel();
    vi.useRealTimers();
  });

  it('preserves add-note playback restore state across repeated editor focus', async () => {
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

    await session.start();

    const video = requireVideoElement();
    let paused = false;
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused
    });
    const pauseSpy = vi.spyOn(video, 'pause').mockImplementation(() => {
      paused = true;
    });
    const playSpy = vi.spyOn(video, 'play').mockImplementation(() => {
      paused = false;
      return Promise.resolve();
    });

    await session.addCurrentTimestamp('note-input');
    const captureId = view.beginEditingCapture.mock.calls.at(-1)?.[0];
    expect(captureId).toBeTruthy();
    if (!captureId) {
      throw new Error('add-note did not create a capture');
    }

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onCaptureEditorFocus?.(captureId);
    callbacks.onCaptureEditorFocus?.(captureId);

    const submitPromise = requirePromise(callbacks.onSubmitCaptureEdit(captureId, 'panel note'));
    await submitPromise;

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);

    callbacks.onCancel();
    vi.useRealTimers();
  });

  it('runs queued mutations after a failed save rolls back the active video mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const firstSave = createDeferred<'failure'>();
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
        flushNow: () => Promise<'ready' | 'failure'>;
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
    sessionApi.state.commentDrafts = {
      'ts-edit': 'draft note'
    };

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    const editPromise = requirePromise(callbacks.onSubmitCaptureEdit('ts-edit', 'edited note'));
    await flushMutationWork();
    const togglePromise = sessionApi.toggleCaptureScreenshot('ts-toggle');
    await flushMutationWork();

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'edited note' });
    expect(sessionApi.state.captures[1]).toMatchObject({ screenshotRequested: true });
    expect(view.setCaptures.mock.calls.at(-1)?.[0]?.[1]).toMatchObject({
      id: 'ts-toggle',
      screenshotState: 'pending'
    });
    expect([...saveEvents]).toEqual(['save-1:start']);

    firstSave.resolve('failure');
    await editPromise;
    await flushMutationWork();

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'original note' });
    expect(sessionApi.state.commentDrafts).toEqual({
      'ts-edit': 'draft note'
    });
    expect(sessionApi.state.captures[1]).toMatchObject({ screenshotRequested: true });
    expect([...saveEvents]).toEqual(['save-1:start', 'save-1:end', 'save-2:start']);

    secondSave.resolve('ready');
    await togglePromise;
    await flushMutationWork();

    expect(sessionApi.state.captures[1]).toMatchObject({ screenshotRequested: true });
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('queues fragment adds behind the same video mutation runner', async () => {
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
    const trackUsageEvent = getTrackUsageEventMock(deps);

    await session.start();
    trackUsageEvent.mockClear();
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
      }
    ];

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    const editPromise = requirePromise(callbacks.onSubmitCaptureEdit('ts-edit', 'edited note'));
    await flushMutationWork();

    session.ingestTextCapture('<p>Queued fragment</p>', 'Queued fragment', 'fragment note');
    await flushMutationWork();

    expect(sessionApi.state.captures).toHaveLength(1);
    expect(trackUsageEvent).not.toHaveBeenCalled();
    expect(saveEvents).toEqual(['save-1:start']);

    firstSave.resolve('ready');
    await editPromise;
    await flushMutationWork();

    expect(sessionApi.state.captures).toHaveLength(2);
    expect(sessionApi.state.captures[1]).toMatchObject({
      kind: 'fragment',
      comment: 'fragment note',
      selectedText: 'Queued fragment'
    });
    expect(saveEvents).toEqual(['save-1:start', 'save-1:end', 'save-2:start']);
    expect(trackUsageEvent).not.toHaveBeenCalled();

    secondSave.resolve('ready');
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(trackUsageEvent).toHaveBeenCalledWith('video_fragment_added', {
      capture_count_bucket: 'two_to_five'
    });
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('resolves queued delete targets at apply time when same-call-stack deletes shift capture indexes', async () => {
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
    seedTimestampCaptures(sessionApi, 3);

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    callbacks.onDeleteCapture('timestamp-1');
    callbacks.onDeleteCapture('timestamp-2');
    await flushMutationWork();

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual([
      'timestamp-2',
      'timestamp-3'
    ]);
    expect(saveEvents).toEqual(['save-1:start']);

    firstSave.resolve('ready');
    for (let index = 0; index < 10 && !saveEvents.includes('save-2:start'); index += 1) {
      await flushMutationWork();
    }

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['timestamp-3']);
    expect(saveEvents).toEqual(['save-1:start', 'save-1:end', 'save-2:start']);

    secondSave.resolve('ready');
    for (let index = 0; index < 10 && !saveEvents.includes('save-2:end'); index += 1) {
      await flushMutationWork();
    }
    for (let index = 0; index < 10 && sessionApi.state.saving; index += 1) {
      await flushMutationWork();
    }

    expect(sessionApi.state.captures.map((capture) => capture.id)).toEqual(['timestamp-3']);
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('stops fragment restore observation when the last fragment capture is deleted', async () => {
    vi.useFakeTimers();
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    RecordingMutationObserver.reset();
    const restoreMutationObserver = setGlobal('MutationObserver', RecordingMutationObserver);
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const fragmentHost = document.createElement('p');
    fragmentHost.textContent = 'Selected text for observer stop';
    document.body.append(fragmentHost);
    const textNode = fragmentHost.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('expected fragment fixture text node');
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'Selected text'.length);

    session.ingestTextCapture('<p>Selected text</p>', 'Selected text', 'fragment note', range);
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    const fragmentId = sessionApi.state.captures.find((capture) => capture.kind === 'fragment')?.id;
    if (!fragmentId) {
      throw new Error('expected fragment capture to be created');
    }
    expect(RecordingMutationObserver.instances).toHaveLength(1);

    requireMountedPanelCallbacks(mountedCallbacks).onDeleteCapture(fragmentId);
    await flushMutationWork();
    await vi.advanceTimersByTimeAsync(200);
    await flushMutationWork();

    expect(sessionApi.state.captures).toEqual([]);
    expect(RecordingMutationObserver.instances[0]?.disconnect).toHaveBeenCalledTimes(1);

    sessionApi.cleanup();
    restoreMutationObserver();
    vi.useRealTimers();
  });

  it('stops watchers and tears down the active session on cleanup', async () => {
    const stopOptionsWatcher = vi.fn();
    const stopLanguageWatcher = vi.fn();
    const deps = createDependencies();
    deps.optionsRepository.onChange = vi.fn(() => stopOptionsWatcher) as never;
    deps.storage.sync.watchKey = vi.fn(() => stopLanguageWatcher) as never;
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    sessionApi.cleanup();

    expect(stopOptionsWatcher).toHaveBeenCalledTimes(1);
    expect(stopLanguageWatcher).toHaveBeenCalledTimes(1);
    expect(isVideoSessionActive(document)).toBe(false);
  });
});
