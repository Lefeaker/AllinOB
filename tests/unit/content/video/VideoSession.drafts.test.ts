/* @vitest-environment jsdom */

import './videoSessionTestHarness';

import {
  __resetContentSessionRegistryForTests,
  isVideoSessionActive
} from '@content/runtime/contentSessionRegistry';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import { configureSessionDraftRuntimeMessenger } from '@content/sessionDrafts/sessionDraftTabContext';
import type { SessionDraftOwnerContext } from '@content/sessionDrafts/sessionDraftTypes';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import type { VideoSessionView } from '@content/video/application/videoSessionView';
import { VideoSession } from '@content/video/session';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import { DEFAULT_SESSION_MESSAGES } from '@content/video/sessionMessages';
import type { VideoSessionDependencies } from '@content/video/sessionTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DraftMutationCase,
  SessionTestApi,
  TabContextProbeResponse
} from './videoSessionTestHarness';
import {
  createDeferred,
  createDependencies,
  createView,
  flushMutationWork,
  isTabContextProbeMessage,
  listVideoDraftCandidates,
  loadLatestVideoDraft,
  pickUnrelatedCaptureId,
  readDraftIndex,
  readLatestVideoDraftCandidate,
  readStoredVideoDraft,
  removalCallIncludesKey,
  requireMountedPanelCallbacks,
  requirePromise,
  requireVideoElement,
  resetVideoSessionHarnessMocks,
  restoreVideoSessionHarnessGlobals,
  seedTimestampCaptures,
  toSessionTestApi,
  waitForMockCalls
} from './videoSessionTestHarness';

describe('VideoSession drafts', () => {
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

  it('updates live draft state without hydrating stale panel state back into the view', async () => {
    vi.useFakeTimers();
    const hydrateCommentDrafts = vi.fn<NonNullable<VideoSessionView['hydrateCommentDrafts']>>();
    const view = createView({ hydrateCommentDrafts });
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    const deps = createDependencies();
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    hydrateCommentDrafts.mockClear();

    requireMountedPanelCallbacks(mountedCallbacks).onCommentDraftChange?.({
      'timestamp-1': 'live draft from panel input'
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(sessionApi.state.commentDrafts).toEqual({
      'timestamp-1': 'live draft from panel input'
    });
    expect(hydrateCommentDrafts).not.toHaveBeenCalled();

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  const draftMutationCases: DraftMutationCase[] = [
    {
      label: 'submit another capture',
      act: async (
        _api: SessionTestApi,
        ids: string[],
        activeId: string,
        _session: VideoSession,
        callbacks: VideoPanelCallbacks
      ) => {
        const unrelatedId = pickUnrelatedCaptureId(ids, activeId);
        await requirePromise(callbacks.onSubmitCaptureEdit(unrelatedId, 'edited comment'));
      }
    },
    {
      label: 'add timestamp',
      act: async (
        api: SessionTestApi,
        _ids: string[],
        _activeId: string,
        _session: VideoSession,
        _callbacks: VideoPanelCallbacks
      ) => {
        await api.addCurrentTimestamp('button', { beginEditing: false });
      }
    },
    {
      label: 'toggle screenshot',
      act: async (
        api: SessionTestApi,
        ids: string[],
        activeId: string,
        _session: VideoSession,
        _callbacks: VideoPanelCallbacks
      ) => {
        await api.toggleCaptureScreenshot(pickUnrelatedCaptureId(ids, activeId));
      }
    },
    {
      label: 'ingest fragment',
      act: (
        _api: SessionTestApi,
        _ids: string[],
        _activeId: string,
        session: VideoSession,
        _callbacks: VideoPanelCallbacks
      ) => {
        session.ingestTextCapture('<p>Selected text</p>', 'Selected text', 'fragment note');
      }
    },
    {
      label: 'delete another capture',
      act: (
        _api: SessionTestApi,
        ids: string[],
        activeId: string,
        _session: VideoSession,
        callbacks: VideoPanelCallbacks
      ) => {
        callbacks.onDeleteCapture(pickUnrelatedCaptureId(ids, activeId));
      }
    },
    {
      label: 'select destination',
      act: async (
        _api: SessionTestApi,
        _ids: string[],
        _activeId: string,
        _session: VideoSession,
        callbacks: VideoPanelCallbacks
      ) => {
        if (!callbacks.onSelectDestination) {
          throw new Error('destination callback was not mounted');
        }
        const selectPromise = requirePromise(callbacks.onSelectDestination('downloads'));
        await vi.advanceTimersByTimeAsync(200);
        await selectPromise;
      }
    }
  ];

  const activeDraftCases = [
    { label: 'first', activeIndex: 1 },
    { label: 'middle', activeIndex: 4 },
    { label: 'sixth', activeIndex: 6 },
    { label: 'last', activeIndex: 8 }
  ] as const;

  it.each(
    draftMutationCases.flatMap((mutationCase) =>
      activeDraftCases.map(
        (activeCase) =>
          [activeCase.label, mutationCase.label, activeCase.activeIndex, mutationCase.act] as const
      )
    )
  )(
    'syncs the %s active draft before %s',
    async (_activeLabel, _mutationLabel, activeIndex, act) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
      const activeId = `timestamp-${activeIndex}`;
      const activeDraft = `${activeId} draft that must survive runtime mutation`;
      const snapshotCommentDrafts = vi.fn(() => ({ [activeId]: activeDraft }));
      const view = createView({ snapshotCommentDrafts });
      let mountedCallbacks: VideoPanelCallbacks | null = null;
      const deps = createDependencies();
      deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
        mountedCallbacks = callbacks;
        return view;
      });
      const session = new VideoSession(document, deps);
      const sessionApi = toSessionTestApi(session);

      await session.start();
      const ids = seedTimestampCaptures(sessionApi, 8);
      sessionApi.state.commentDrafts = {
        [activeId]: 'stale draft that should be replaced'
      };
      snapshotCommentDrafts.mockClear();
      Object.defineProperty(requireVideoElement(), 'currentTime', {
        value: 99,
        configurable: true
      });

      await act(sessionApi, ids, activeId, session, requireMountedPanelCallbacks(mountedCallbacks));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);

      expect(sessionApi.state.commentDrafts).toMatchObject({
        [activeId]: activeDraft
      });
      expect(snapshotCommentDrafts).toHaveBeenCalled();
      const draftCandidates = await listVideoDraftCandidates(deps);
      expect(
        draftCandidates.some(
          (candidate) => candidate.payload.commentDrafts?.[activeId] === activeDraft
        )
      ).toBe(true);

      sessionApi.cleanup();
      vi.useRealTimers();
    }
  );

  it('syncs live sixth draft before pagehide flush persists a restorable draft', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const sixthDraft = 'sixth draft that must survive pagehide flush';
    const view = createView({
      snapshotCommentDrafts: vi.fn(() => ({ 'timestamp-6': sixthDraft }))
    });
    const deps = createDependencies();
    const session = new VideoSession(document, {
      ...deps,
      viewFactory: {
        createView: vi.fn(() => view)
      }
    } as VideoSessionDependencies);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    seedTimestampCaptures(sessionApi, 6);
    sessionApi.state.commentDrafts = {
      'timestamp-6': 'stale draft that should be replaced'
    };

    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    const latestCandidate = await readLatestVideoDraftCandidate(deps);
    expect(sessionApi.state.commentDrafts).toMatchObject({
      'timestamp-6': sixthDraft
    });
    expect(latestCandidate?.status).toBe('restorable');
    expect(latestCandidate?.payload.commentDrafts).toMatchObject({
      'timestamp-6': sixthDraft
    });

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('cleans up after cancel when exact-key draft removal fails after the terminal envelope is written', async () => {
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
        throw new Error('remove current exact key after terminal cancel failed');
      }
      return await passthroughRemove(...args);
    });

    requireMountedPanelCallbacks(mountedCallbacks).onCancel();
    await waitForMockCalls(view.destroy);

    expect(view.destroy).toHaveBeenCalledTimes(1);
    expect(isVideoSessionActive(document)).toBe(false);
    await expect(loadLatestVideoDraft(deps)).resolves.toBeNull();
    await expect(listVideoDraftCandidates(deps, document.location.href, null)).resolves.toEqual([]);
    expect(await readDraftIndex(deps)).toMatchObject({
      entries: [expect.objectContaining({ draftId: currentDraft.draftId, status: 'discarded' })]
    });
    await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraft.draftId,
      status: 'discarded'
    });

    vi.useRealTimers();
  });

  it('writes a discarded terminal envelope to the restored exact draft key before cleanup', async () => {
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
        throw new Error('keep restored exact key active before cancel');
      }
      return await passthroughRemove(...args);
    });

    const session = new VideoSession(document, deps);
    await session.start();
    await requirePromise(
      requireMountedPanelCallbacks(mountedCallbacks).onSubmitCaptureEdit('ts-1', 'committed note')
    );

    const beforeCancel = await listVideoDraftCandidates(deps, document.location.href, null);
    expect(beforeCancel).toHaveLength(2);
    expect(beforeCancel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: restoredDraft.draftId, status: 'restorable' }),
        expect.objectContaining({ status: 'active' })
      ])
    );
    const currentBeforeCancel = beforeCancel.find(
      (candidate) => candidate.draftId !== restoredDraft.draftId
    );
    if (!currentBeforeCancel) throw new Error('expected new current draft identity');
    const currentDraftKey = createSessionDraftStorageKey(currentBeforeCancel);

    vi.mocked(deps.storage.local.remove).mockClear();
    vi.mocked(deps.storage.local.remove).mockImplementation(async (...args) => {
      const [value] = args;
      if (removalCallIncludesKey(value, restoredDraftKey)) {
        throw new Error('terminal cleanup should be best-effort');
      }
      return await passthroughRemove(...args);
    });

    requireMountedPanelCallbacks(mountedCallbacks).onCancel();
    await waitForMockCalls(view.destroy);

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
        expect.objectContaining({ draftId: restoredDraft.draftId, status: 'discarded' })
      ])
    );
    await expect(readStoredVideoDraft(deps, restoredDraftKey)).resolves.toMatchObject({
      draftId: restoredDraft.draftId,
      status: 'discarded'
    });
    await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toBeUndefined();
    expect(
      vi
        .mocked(deps.storage.local.remove)
        .mock.calls.filter(([value]) => removalCallIncludesKey(value, restoredDraftKey))
    ).toHaveLength(1);

    vi.useRealTimers();
  });

  it('preserves same-page other-owner drafts after cancel when the current exact-key cleanup fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const previousChrome = globalThis.chrome;
    const currentOwner: SessionDraftOwnerContext = { tabId: 11, windowId: 1, frameId: 0 };
    const otherOwner: SessionDraftOwnerContext = { tabId: 22, windowId: 2, frameId: 0 };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage: vi.fn(
            (message: object | null, callback?: (response: TabContextProbeResponse) => void) => {
              if (isTabContextProbeMessage(message)) {
                callback?.({ success: true, active: true });
                return;
              }
              callback?.({ success: true, ...currentOwner });
            }
          )
        }
      }
    });
    configureSessionDraftRuntimeMessenger(<TResult = unknown>(message: unknown) => {
      if (isTabContextProbeMessage(message as object | null)) {
        return Promise.resolve({ success: true, active: true } as TResult);
      }
      return Promise.resolve({ success: true, ...currentOwner } as TResult);
    });
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    const repository = createSessionDraftRepository(deps.storage.local);
    const existing = createVideoSessionDraftEnvelope({
      draftId: 'existing-draft',
      pageUrl: document.location.href,
      pageTitle: 'Existing title',
      updatedAt: 2_000_000_000_050,
      status: 'active',
      payload: buildVideoSessionDraftPayload({
        captures: [],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Existing title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    });
    await repository.save(existing, { ownerContext: otherOwner });
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    try {
      await session.start();
      const video = requireVideoElement();
      Object.defineProperty(video, 'currentTime', { value: 42, configurable: true });
      await sessionApi.handleAddCapture();
      const beforeCancel = await listVideoDraftCandidates(deps, document.location.href, null);
      expect(beforeCancel).toHaveLength(2);
      const currentDraft = beforeCancel.find((candidate) => candidate.draftId !== 'existing-draft');
      if (!currentDraft) {
        throw new Error('expected a current draft to exist before cancel');
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
          throw new Error('keep current key to verify terminal suppression');
        }
        return await passthroughRemove(...args);
      });

      requireMountedPanelCallbacks(mountedCallbacks).onCancel();
      await waitForMockCalls(view.destroy);

      const afterCancel = await listVideoDraftCandidates(deps, document.location.href, null);
      expect(afterCancel).toHaveLength(1);
      expect(afterCancel[0]?.draftId).toBe('existing-draft');
      await expect(loadLatestVideoDraft(deps, document.location.href, null)).resolves.toMatchObject(
        {
          draftId: 'existing-draft'
        }
      );
      expect(
        createSessionDraftStorageKey({
          mode: 'video',
          pageKey: afterCancel[0]!.pageKey,
          draftId: afterCancel[0]!.draftId
        })
      ).toBe(
        createSessionDraftStorageKey({
          mode: 'video',
          pageKey: existing.pageKey,
          draftId: existing.draftId
        })
      );
      const draftIndex = await readDraftIndex(deps);
      if (!draftIndex) {
        throw new Error('Expected session draft index');
      }
      expect(draftIndex.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ draftId: 'existing-draft', status: 'active' }),
          expect.objectContaining({ draftId: currentDraft.draftId, status: 'discarded' })
        ])
      );
      await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toMatchObject({
        draftId: currentDraft.draftId,
        status: 'discarded'
      });
    } finally {
      configureSessionDraftRuntimeMessenger(null);
      sessionApi.cleanup();
      if (previousChrome === undefined) {
        Reflect.deleteProperty(globalThis, 'chrome');
      } else {
        Object.defineProperty(globalThis, 'chrome', {
          configurable: true,
          value: previousChrome
        });
      }
      vi.useRealTimers();
    }
  });

  it('rolls back capture comment edits and restores the previous draft when saving fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    const deps = createDependencies();
    const view = createView();
    let mountedCallbacks: VideoPanelCallbacks | null = null;
    deps.viewFactory.createView = vi.fn((callbacks: VideoPanelCallbacks) => {
      mountedCallbacks = callbacks;
      return view;
    });
    vi.mocked(deps.storage.local.setMany).mockRejectedValueOnce(new Error('save failed'));
    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'original note',
        url: 'https://video.example/watch?t=42',
        createdAt: 1
      }
    ];
    sessionApi.state.commentDrafts = {
      'timestamp-1': 'panel draft note'
    };
    view.setCaptures.mockClear();
    view.stopEditing.mockClear();
    view.updateHint.mockClear();

    await requirePromise(
      requireMountedPanelCallbacks(mountedCallbacks).onSubmitCaptureEdit(
        'timestamp-1',
        'edited note'
      )
    );

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'original note' });
    expect(sessionApi.state.commentDrafts).toEqual({
      'timestamp-1': 'panel draft note'
    });
    const panelCaptures = view.setCaptures.mock.calls.at(-1)?.[0] as
      | Array<{ comment?: string }>
      | undefined;
    expect(panelCaptures?.[0]).toMatchObject({ comment: 'original note' });
    expect(view.stopEditing).not.toHaveBeenCalled();
    expect(view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('queues add timestamp mutations while a draft-mode user save is in flight', async () => {
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

    await session.start();
    sessionApi.state.captures = [
      {
        kind: 'timestamp',
        id: 'timestamp-1',
        timeSec: 42,
        comment: 'original note',
        url: 'https://video.example/watch?t=42',
        createdAt: 1
      }
    ];
    Object.defineProperty(requireVideoElement(), 'currentTime', {
      value: 52,
      configurable: true
    });
    vi.mocked(deps.storage.local.setMany).mockImplementationOnce(() => deferredSave.promise);

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    const submitPromise = requirePromise(
      callbacks.onSubmitCaptureEdit('timestamp-1', 'edited note')
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(sessionApi.state.saving).toBe(true);

    const addPromise = sessionApi.addCurrentTimestamp('button', { beginEditing: false });
    await flushMutationWork();

    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(1);
    expect(sessionApi.state.captures).toHaveLength(1);

    deferredSave.resolve();
    await submitPromise;
    await addPromise;

    expect(deps.storage.local.setMany).toHaveBeenCalledTimes(2);
    expect(sessionApi.state.captures).toHaveLength(2);
    expect(sessionApi.state.captures[1]).toMatchObject({
      kind: 'timestamp',
      timeSec: 52
    });
    expect(sessionApi.state.saving).toBe(false);

    sessionApi.cleanup();
    vi.useRealTimers();
  });

  it('keeps capture edits in the new current draft while restored cleanup retries', async () => {
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
    let failCleanup = true;
    vi.mocked(deps.storage.local.remove).mockImplementation(async (...args) => {
      const [value] = args;
      if (failCleanup && removalCallIncludesKey(value, restoredDraftKey)) {
        failCleanup = false;
        throw new Error('cleanup failed after durable save');
      }
      return await passthroughRemove(...args);
    });

    const session = new VideoSession(document, deps);
    const sessionApi = toSessionTestApi(session);

    await session.start();
    view.stopEditing.mockClear();
    view.updateHint.mockClear();

    const callbacks = requireMountedPanelCallbacks(mountedCallbacks);
    await requirePromise(callbacks.onSubmitCaptureEdit('ts-1', 'committed note'));

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'committed note' });
    expect(view.stopEditing).toHaveBeenCalledWith('ts-1');
    expect(view.updateHint.mock.calls.map(([message]) => message)).not.toContain(
      DEFAULT_SESSION_MESSAGES.hintFailure
    );
    const draftIdsAfterFailedCleanup = (
      await listVideoDraftCandidates(deps, document.location.href, null)
    ).map((candidate) => candidate.draftId);
    expect(draftIdsAfterFailedCleanup).toContain('restored-draft');
    expect(draftIdsAfterFailedCleanup).toHaveLength(2);
    const currentDraftId = draftIdsAfterFailedCleanup.find(
      (draftId) => draftId !== 'restored-draft'
    );
    if (!currentDraftId) throw new Error('expected new current draft identity');
    const currentDraftKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: restoredDraft.pageKey,
      draftId: currentDraftId
    });

    view.stopEditing.mockClear();
    await requirePromise(callbacks.onSubmitCaptureEdit('ts-1', 'committed note v2'));

    expect(sessionApi.state.captures[0]).toMatchObject({ comment: 'committed note v2' });
    expect(view.stopEditing).toHaveBeenCalledWith('ts-1');
    const draftIdsAfterRetry = (
      await listVideoDraftCandidates(deps, document.location.href, null)
    ).map((candidate) => candidate.draftId);
    expect(draftIdsAfterRetry).toEqual([currentDraftId]);
    await expect(readStoredVideoDraft(deps, restoredDraftKey)).resolves.toBeUndefined();
    await expect(readStoredVideoDraft(deps, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraftId,
      payload: { captures: [expect.objectContaining({ comment: 'committed note v2' })] }
    });
    expect(
      vi
        .mocked(deps.storage.local.remove)
        .mock.calls.filter(([value]) => removalCallIncludesKey(value, restoredDraftKey))
    ).toHaveLength(2);

    sessionApi.cleanup();
    vi.useRealTimers();
  });
});
