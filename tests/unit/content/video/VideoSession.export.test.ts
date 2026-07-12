/* @vitest-environment jsdom */

import './videoSessionTestHarness';

import {
  __resetContentSessionRegistryForTests,
  isVideoSessionActive
} from '@content/runtime/contentSessionRegistry';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import { VideoSession } from '@content/video/session';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDependencies,
  createView,
  getVideoSessionHarnessMocks,
  listVideoDraftCandidates,
  loadLatestVideoDraft,
  readDraftIndex,
  readStoredVideoDraft,
  removalCallIncludesKey,
  requireMountedPanelCallbacks,
  requirePromise,
  requireVideoElement,
  resetVideoSessionHarnessMocks,
  restoreVideoSessionHarnessGlobals,
  seedTimestampCaptures,
  toSessionTestApi
} from './videoSessionTestHarness';

const { exportMock } = getVideoSessionHarnessMocks();

describe('VideoSession export', () => {
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

  it('removes the current video draft after successful export but keeps it after export failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();

    const video = requireVideoElement();
    Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
    await sessionApi.handleAddCapture();
    await vi.advanceTimersByTimeAsync(200);

    expect(await listVideoDraftCandidates(deps)).toHaveLength(1);

    exportMock.mockResolvedValueOnce({ success: true });
    await sessionApi.finish();

    expect(await listVideoDraftCandidates(deps)).toHaveLength(0);

    const failureDeps = createDependencies();
    const failureSession = new VideoSession(document, failureDeps);
    const failureApi = toSessionTestApi(failureSession);
    await failureSession.start();
    Object.defineProperty(requireVideoElement(), 'currentTime', { value: 44, configurable: true });
    await failureApi.handleAddCapture();
    await vi.advanceTimersByTimeAsync(200);
    exportMock.mockResolvedValueOnce({ success: false, error: 'boom' } as never);

    await failureApi.finish();

    expect(await listVideoDraftCandidates(failureDeps)).toHaveLength(1);

    failureApi.cleanup();
    vi.useRealTimers();
  });

  it('cleans up after export when exact-key draft removal fails after the terminal envelope is written', async () => {
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

    await session.start();
    Object.defineProperty(requireVideoElement(), 'currentTime', {
      value: 42,
      configurable: true
    });
    await sessionApi.handleAddCapture();

    const [currentDraft] = await listVideoDraftCandidates(deps, document.location.href, null);
    if (!currentDraft) {
      throw new Error('expected an active current draft');
    }
    const currentDraftKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: currentDraft.pageKey,
      draftId: currentDraft.draftId
    });
    const passthroughRemove = vi.mocked(deps.storage.local.remove).getMockImplementation();
    if (!passthroughRemove) {
      throw new Error('expected storage remove implementation');
    }
    vi.mocked(deps.storage.local.remove).mockImplementation(async (...args) => {
      const [value] = args;
      if (removalCallIncludesKey(value, currentDraftKey)) {
        throw new Error('remove current exact key after terminal export failed');
      }
      return await passthroughRemove(...args);
    });

    await requirePromise(requireMountedPanelCallbacks(mountedCallbacks).onFinish());

    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(isVideoSessionActive(document)).toBe(false);
    await expect(loadLatestVideoDraft(deps)).resolves.toBeNull();
    await expect(listVideoDraftCandidates(deps, document.location.href, null)).resolves.toEqual([]);
    expect(await readDraftIndex(deps)).toMatchObject({
      entries: [expect.objectContaining({ draftId: currentDraft.draftId, status: 'exported' })]
    });
    await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraft.draftId,
      status: 'exported'
    });

    vi.useRealTimers();
  });

  it('syncs live sixth draft into state before export begins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    exportMock.mockResolvedValueOnce({ success: false, error: 'boom' } as never);
    const sixthDraft = 'sixth draft that must survive export start';
    const view = createView({
      snapshotCommentDrafts: vi.fn(() => ({ 'timestamp-6': sixthDraft }))
    });
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    const deps = createDependencies();
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    seedTimestampCaptures(sessionApi, 6);
    sessionApi.state.commentDrafts = {
      'timestamp-6': 'stale draft that should be replaced'
    };

    await requirePromise(requireMountedPanelCallbacks(mountedCallbacks).onFinish());

    expect(exportMock).toHaveBeenCalled();
    expect(sessionApi.state.commentDrafts).toMatchObject({
      'timestamp-6': sixthDraft
    });

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('exports through the exporter and cleans up on success', async () => {
    const dependencies = createDependencies();
    const session = new VideoSession(document, dependencies);
    const sessionApi = toSessionTestApi(session);
    const cleanupSpy = vi.spyOn(sessionApi, 'cleanup');

    await session.start();
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 12,
        comment: '',
        url: 'https://video.example/watch?t=12',
        createdAt: 1
      }
    ];

    await sessionApi.finish();

    expect(exportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: 'video:test',
        videoTitle: 'Video Title'
      })
    );
    expect(dependencies.showSupportProgress).toHaveBeenCalledWith({
      value: 10,
      message: {
        key: 'supportProgressVideoPreparing',
        fallback: 'Preparing video export'
      }
    });
    expect(dependencies.showSupportProgress).toHaveBeenCalledWith({
      value: 34,
      message: {
        key: 'supportProgressVideoGenerating',
        fallback: 'Generating video note'
      }
    });
    expect(dependencies.showSupportProgress).toHaveBeenCalledWith({
      value: 70,
      message: {
        key: 'supportProgressVideoWriting',
        fallback: 'Writing to Obsidian'
      }
    });
    expect(dependencies.showSupportProgress).toHaveBeenCalledWith({
      value: 100,
      variant: 'success'
    });
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('writes exported terminal envelopes to the current and restored exact draft keys before cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const repository = createSessionDraftRepository(deps.storage.local);
    const restoredDraft = createVideoSessionDraftEnvelope({
      draftId: 'restored-draft',
      pageUrl: document.location.href,
      pageTitle: 'Restored title',
      updatedAt: 2_000_000_000_100,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(restoredDraft);
    const restoredDraftKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: restoredDraft.pageKey,
      draftId: restoredDraft.draftId
    });
    const passthroughRemove = vi.mocked(deps.storage.local.remove).getMockImplementation();
    if (!passthroughRemove) {
      throw new Error('expected storage remove implementation');
    }
    let failSupersededCleanup = true;
    vi.mocked(deps.storage.local.remove).mockImplementation(async (...args) => {
      const [value] = args;
      if (failSupersededCleanup && removalCallIncludesKey(value, restoredDraftKey)) {
        failSupersededCleanup = false;
        throw new Error('keep restored exact key active before export');
      }
      return await passthroughRemove(...args);
    });

    const session = new VideoSession(document, deps);
    await session.start();
    await requirePromise(
      requireMountedPanelCallbacks(mountedCallbacks).onSubmitCaptureEdit('ts-1', 'committed note')
    );

    const beforeFinish = await listVideoDraftCandidates(deps, document.location.href, null);
    expect(beforeFinish).toHaveLength(2);
    const currentDraft = beforeFinish.find((candidate) => candidate.draftId !== 'restored-draft');
    if (!currentDraft) {
      throw new Error('expected a current replacement draft');
    }
    const currentDraftKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: currentDraft.pageKey,
      draftId: currentDraft.draftId
    });

    vi.mocked(deps.storage.local.remove).mockClear();
    vi.mocked(deps.storage.local.remove).mockImplementation(async (...args) => {
      const [value] = args;
      if (
        removalCallIncludesKey(value, currentDraftKey) ||
        removalCallIncludesKey(value, restoredDraftKey)
      ) {
        throw new Error('terminal cleanup should be best-effort');
      }
      return await passthroughRemove(...args);
    });

    await requirePromise(requireMountedPanelCallbacks(mountedCallbacks).onFinish());

    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(isVideoSessionActive(document)).toBe(false);
    await expect(loadLatestVideoDraft(deps)).resolves.toBeNull();
    await expect(listVideoDraftCandidates(deps, document.location.href, null)).resolves.toEqual([]);
    const draftIndex = await readDraftIndex(deps);
    if (!draftIndex) {
      throw new Error('Expected session draft index');
    }
    expect(draftIndex.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: currentDraft.draftId, status: 'exported' }),
        expect.objectContaining({ draftId: restoredDraft.draftId, status: 'exported' })
      ])
    );
    await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraft.draftId,
      status: 'exported'
    });
    await expect(readStoredVideoDraft(deps, restoredDraftKey)).resolves.toMatchObject({
      draftId: restoredDraft.draftId,
      status: 'exported'
    });
    expect(
      vi
        .mocked(deps.storage.local.remove)
        .mock.calls.filter(([value]) => removalCallIncludesKey(value, currentDraftKey))
    ).toHaveLength(1);
    expect(
      vi
        .mocked(deps.storage.local.remove)
        .mock.calls.filter(([value]) => removalCallIncludesKey(value, restoredDraftKey))
    ).toHaveLength(1);

    vi.useRealTimers();
  });

  it('keeps the session alive when export fails', async () => {
    exportMock.mockResolvedValueOnce({ success: false, error: 'boom' } as {
      success: boolean;
      error: string;
    });
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const applyHintSpy = vi.spyOn(sessionApi, 'applyHint');

    await session.start();
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 12,
        comment: '',
        url: 'https://video.example/watch?t=12',
        createdAt: 1
      }
    ];

    await sessionApi.finish();

    expect(applyHintSpy).toHaveBeenCalledWith('failure');
    expect(deps.showSupportProgress).toHaveBeenCalledWith({
      value: 100,
      variant: 'failure'
    });
    expect(isVideoSessionActive(document)).toBe(true);

    sessionApi.cleanup();
  });

  it('keeps the session alive when the exporter returns an invalid empty response', async () => {
    exportMock.mockResolvedValueOnce(null as never);
    const deps = createDependencies();
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);
    const applyHintSpy = vi.spyOn(sessionApi, 'applyHint');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await session.start();
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 12,
        comment: '',
        url: 'https://video.example/watch?t=12',
        createdAt: 1
      }
    ];

    await sessionApi.finish();

    expect(applyHintSpy).toHaveBeenCalledWith('failure');
    expect(deps.showSupportProgress).toHaveBeenCalledWith({
      value: 100,
      variant: 'failure'
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[VideoSession] Export failed:',
      expect.objectContaining({ message: 'Invalid video export response' })
    );
    expect(isVideoSessionActive(document)).toBe(true);

    consoleErrorSpy.mockRestore();
    sessionApi.cleanup();
  });
});
