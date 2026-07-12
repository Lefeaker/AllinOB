/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import {
  createSessionDraftPageKey,
  createDirectSessionDraftRepository as createSessionDraftRepository,
  createSessionDraftStorageKey,
  createSessionDraftStoragePolicy,
  type SessionDraftStoragePolicy,
  type VideoSessionDraftEnvelope
} from '@content/sessionDrafts';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope,
  type VideoSessionDraftPayloadShape
} from '@content/video/sessionDrafts';
import { VideoSessionState } from '@content/video/sessionState';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import type { ExportDestinationMetadata } from '@shared/exportDestination';
import type { UsageEventParamMap } from '@shared/types/analytics';
import type { StorageAreaService } from '@platform/interfaces/storage';
import { VideoSessionDraftController } from '@content/video/videoSessionDraftController';
import type { VideoCaptureScreenshot } from '@content/video/types';
import { createVideoSessionDraftScreenshotCacheMaintenance } from '@content/video/videoSessionDraftScreenshotCache';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import type { VideoScreenshotCacheRepository } from '@content/video/videoScreenshotCacheRepository';
import type { VersionedSessionDraftRepository } from '@content/sessionDrafts/sessionDraftClientRepository';

type TrackedStorageArea = StorageAreaService & {
  setMany: Mock<StorageAreaService['setMany']>;
  remove: Mock<StorageAreaService['remove']>;
};
type TimestampDraftCapture = Extract<
  VideoSessionDraftPayloadShape['captures'][number],
  { kind: 'timestamp' }
>;
type VideoDraftRestoreTelemetryParams = UsageEventParamMap['video_draft_restored'];

function createTrackedStorageArea(): TrackedStorageArea {
  const area = createMemoryStorageArea();
  return {
    ...area,
    setMany: vi.fn<StorageAreaService['setMany']>(area.setMany),
    remove: vi.fn<StorageAreaService['remove']>(area.remove)
  };
}

function createTestVersionedRepository(
  area: StorageAreaService,
  storagePolicy?: SessionDraftStoragePolicy
): VersionedSessionDraftRepository {
  const repository = createSessionDraftRepository(
    area,
    storagePolicy ? { retentionPolicy: storagePolicy.retentionPolicy } : {}
  );
  return {
    ...repository,
    claim: () => Promise.resolve(),
    runWriteOperation(draftKey, task) {
      return task({
        context: {
          operationId: 'test-video-draft-operation',
          epoch: 1,
          draftKey,
          baseRevision: 0,
          nextRevision: 1
        },
        commit: (draft) => repository.save(draft)
      });
    }
  };
}

function isVideoDraftPayloadShape(
  payload: VideoSessionDraftEnvelope['payload']
): payload is VideoSessionDraftPayloadShape {
  return payload.mode === 'video' && Array.isArray(payload.captures);
}

function requireVideoDraftPayload(draft: VideoSessionDraftEnvelope): VideoSessionDraftPayloadShape {
  if (!isVideoDraftPayloadShape(draft.payload)) {
    throw new Error('expected video draft payload shape');
  }
  return draft.payload;
}

function createTimestampCapture(id = 'timestamp-1'): TimestampDraftCapture {
  return {
    kind: 'timestamp',
    id,
    timeSec: 42,
    comment: 'note',
    url: 'https://video.example/watch?t=42',
    createdAt: 1
  };
}

function createBlobScreenshotFixture(
  text = 'frame',
  capturedAt = 2_000_000_000_101
): VideoCaptureScreenshot {
  const blob = new Blob([text], { type: 'image/jpeg' });
  return {
    id: 'shot-1',
    fileName: 'video-0m42s.jpg',
    mimeType: 'image/jpeg',
    capturedAt,
    dataUrl: 'data:image/jpeg;base64,cHJpdmF0ZS1mcmFtZQ==',
    content: {
      kind: 'blob',
      blob,
      byteLength: blob.size
    }
  };
}

function createScreenshotCacheRef(
  overrides: Partial<VideoScreenshotCacheRef> = {}
): VideoScreenshotCacheRef {
  const pageKey = overrides.pageKey ?? createSessionDraftPageKey('video', document.location.href);
  const captureId = overrides.captureId ?? 'ts-1';
  const id = overrides.id ?? 'shot-1';
  const capturedAt = overrides.capturedAt ?? 2_000_000_000_101;
  const expiresAt = overrides.expiresAt ?? capturedAt + 60_000;

  return {
    schemaVersion: 1,
    pageKey,
    captureId,
    id,
    key:
      overrides.key ??
      createVideoScreenshotCacheStorageKey({
        pageKey,
        captureId,
        screenshotId: id
      }),
    fileName: overrides.fileName ?? 'video-0m42s.jpg',
    mimeType: 'image/jpeg',
    byteLength: overrides.byteLength ?? 12,
    capturedAt,
    expiresAt
  };
}

function createDestinationState(metadata?: ExportDestinationMetadata) {
  let current = metadata;
  return {
    get metadata() {
      return current;
    },
    applyMetadata: vi.fn((next: ExportDestinationMetadata | undefined) => {
      current = next;
    }),
    getCurrent: () => current
  };
}

function createHarness(
  options: {
    destinationMetadata?: ExportDestinationMetadata;
    screenshotCache?:
      | (Pick<VideoScreenshotCacheRepository, 'load' | 'removeMany'> &
          Partial<Pick<VideoScreenshotCacheRepository, 'pruneExpired' | 'pruneToLimits'>>)
      | undefined;
    onScreenshotHydrationChange?: () => void;
    sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
    trackDraftRestoreEvent?: (params: VideoDraftRestoreTelemetryParams) => void | Promise<void>;
  } = {}
) {
  const state = new VideoSessionState('gradient');
  const storage = createTrackedStorageArea();
  const destinationState = createDestinationState(options.destinationMetadata);
  let domDrafts: Record<string, string> = {};
  const dom = {
    readCommentDrafts: vi.fn(() => ({ ...domDrafts })),
    setCommentDrafts: vi.fn((drafts: Record<string, string>) => {
      domDrafts = { ...drafts };
    })
  };
  const cleanupState = {
    isCleaningUp: false,
    shouldTrackSavingState: true
  };
  const controller = new VideoSessionDraftController({
    doc: document,
    state,
    destinationState,
    storageArea: storage,
    repository: createTestVersionedRepository(storage, options.sessionDraftStoragePolicy),
    dom,
    onScreenshotHydrationChange: options.onScreenshotHydrationChange,
    ...(options.sessionDraftStoragePolicy
      ? { sessionDraftStoragePolicy: options.sessionDraftStoragePolicy }
      : {}),
    trackDraftRestoreEvent: options.trackDraftRestoreEvent,
    readCleanupState: () => ({ ...cleanupState }),
    ...(options.screenshotCache ? { screenshotCache: options.screenshotCache } : {})
  });
  const repository = createSessionDraftRepository(
    storage,
    options.sessionDraftStoragePolicy
      ? { retentionPolicy: options.sessionDraftStoragePolicy.retentionPolicy }
      : {}
  );

  return {
    state,
    storage,
    repository,
    dom,
    controller,
    destinationState,
    cleanupState,
    setDomDrafts: (drafts: Record<string, string>) => {
      domDrafts = { ...drafts };
    }
  };
}

async function seedRestorableDraft(
  storage: TrackedStorageArea,
  options: {
    destination?: ExportDestinationMetadata;
    commentDrafts?: Record<string, string>;
  } = {}
) {
  const repository = createSessionDraftRepository(storage);
  const draft = createVideoSessionDraftEnvelope({
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
          createdAt: 2_000_000_000_100,
          screenshotRequested: true
        }
      ],
      commentDrafts: options.commentDrafts ?? { 'ts-1': 'draft note' },
      ...(options.destination ? { destination: options.destination } : {}),
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      videoTitle: 'Restored title',
      videoUrl: document.location.href,
      canonicalUrl: document.location.href
    })
  });
  await repository.save(draft);
  return {
    draft,
    storageKey: createSessionDraftStorageKey({
      mode: 'video',
      pageKey: draft.pageKey,
      draftId: draft.draftId
    })
  };
}

async function seedRestorableDraftWithPayload(
  storage: TrackedStorageArea,
  payload: ReturnType<typeof buildVideoSessionDraftPayload>
) {
  const repository = createSessionDraftRepository(storage);
  const draft = createVideoSessionDraftEnvelope({
    draftId: 'restored-draft',
    pageUrl: document.location.href,
    pageTitle: 'Restored title',
    updatedAt: 2_000_000_000_100,
    status: 'restorable',
    payload
  });
  await repository.save(draft);
  return {
    draft,
    storageKey: createSessionDraftStorageKey({
      mode: 'video',
      pageKey: draft.pageKey,
      draftId: draft.draftId
    })
  };
}

function getDraftStorageKey(draft: VideoSessionDraftEnvelope): string {
  return createSessionDraftStorageKey({
    mode: 'video',
    pageKey: draft.pageKey,
    draftId: draft.draftId
  });
}

function matchesRemovalKey(value: unknown, key: string): boolean {
  if (typeof value === 'string') {
    return value === key;
  }
  if (Array.isArray(value)) {
    return value.includes(key);
  }
  return typeof value === 'object' && value !== null && 'key' in value && value.key === key;
}

async function waitForAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function readDraftRestoreTelemetryPayload(
  trackDraftRestoreEvent: Mock<(params: VideoDraftRestoreTelemetryParams) => void | Promise<void>>
): VideoDraftRestoreTelemetryParams {
  const params = trackDraftRestoreEvent.mock.calls.at(-1)?.[0];
  if (!params || typeof params !== 'object') {
    throw new Error('expected a draft restore telemetry payload');
  }
  return params;
}

describe('VideoSessionDraftController', () => {
  let warnSpy: MockInstance<(...data: unknown[]) => void>;

  beforeEach(() => {
    document.body.innerHTML = '<video></video>';
    document.title = 'Video Title';
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as MockInstance<
      (...data: unknown[]) => void
    >;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('removes the exact current key and returns noCaptures when the draft becomes empty', async () => {
    const { controller, repository, state, setDomDrafts, storage } = createHarness();
    state.captures = [createTimestampCapture()];
    setDomDrafts({ 'timestamp-1': 'draft note' });

    const pending = controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(200);
    await pending;

    const [activeDraft] = await repository.listCandidates('video', document.location.href);
    if (!activeDraft || activeDraft.mode !== 'video') {
      throw new Error('expected an active video draft');
    }
    const currentDraftKey = getDraftStorageKey(activeDraft);

    state.captures = [];
    state.commentDrafts = {};
    setDomDrafts({});

    const result = await controller.flushNow('active');

    expect(result).toBe('noCaptures');
    await expect(repository.loadLatest('video', document.location.href)).resolves.toBeNull();
    await expect(repository.listCandidates('video', document.location.href)).resolves.toEqual([]);
    await expect(controller.remove()).resolves.toBeUndefined();
    await expect(repository.loadLatest('video', document.location.href)).resolves.toBeNull();
    await expect(storage.get(currentDraftKey)).resolves.toBeUndefined();
  });

  it('applies an injected generic storage policy at save time', async () => {
    vi.setSystemTime(new Date('2026-06-22T08:00:00Z'));
    const retentionMs = 96 * 60 * 60 * 1000;
    const harness = createHarness({
      sessionDraftStoragePolicy: createSessionDraftStoragePolicy({
        retentionPolicy: {
          retentionMs,
          maxRestorablePages: null,
          maxItemsPerPage: null
        }
      })
    });
    const ids = Array.from({ length: 25 }, (_, index) => `timestamp-${index + 1}`);
    harness.state.captures = ids.map((id, index) => ({
      ...createTimestampCapture(id),
      createdAt: Date.now() + index,
      screenshotRef: createScreenshotCacheRef({ captureId: id, id: `shot-${index + 1}` })
    }));
    const domDraftEntries: Array<[string, string]> = [
      ...ids.map((id): [string, string] => [id, `draft for ${id}`]),
      ['orphan', 'drop me']
    ];
    harness.setDomDrafts(Object.fromEntries(domDraftEntries));

    await harness.controller.flushNow('active');

    const draft = await harness.repository.loadLatest('video', document.location.href);
    if (!draft || draft.mode !== 'video') {
      throw new Error('expected video draft');
    }
    expect(draft?.expiresAt).toBe(Date.now() + retentionMs);
    const payload = requireVideoDraftPayload(draft);
    expect(payload.captures).toHaveLength(25);
    expect(Object.keys(payload.commentDrafts ?? {})).toEqual(ids);
    const serializedDraft = JSON.stringify(draft);
    expect(serializedDraft).toContain('"screenshotRef"');
    expect(serializedDraft).not.toContain('data:image/');
    expect(serializedDraft).not.toContain('"screenshot"');
    expect(serializedDraft).not.toContain('"content"');
  });

  it('schedules and flushes active drafts with exact active status', async () => {
    const { controller, repository, state, setDomDrafts } = createHarness();
    state.captures = [createTimestampCapture()];
    setDomDrafts({ 'timestamp-1': 'draft note' });
    controller.syncCommentDrafts();

    const pending = controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(200);
    await pending;

    let latestDraft = await repository.loadLatest('video', document.location.href);
    expect(latestDraft).toMatchObject({
      status: 'active',
      payload: { commentDrafts: { 'timestamp-1': 'draft note' } }
    });

    setDomDrafts({ 'timestamp-1': 'draft note v2' });
    const result = await controller.flushNow('active');

    expect(result).toBe('ready');
    latestDraft = await repository.loadLatest('video', document.location.href);
    expect(latestDraft).toMatchObject({
      status: 'active',
      payload: { commentDrafts: { 'timestamp-1': 'draft note v2' } }
    });
  });

  it('binds pagehide and beforeunload persistence and unregisters cleanly on dispose', async () => {
    const { controller, repository, state, setDomDrafts, storage } = createHarness();
    state.captures = [createTimestampCapture()];
    setDomDrafts({ 'timestamp-1': 'draft note' });

    controller.bindPersistence();
    window.dispatchEvent(new Event('pagehide'));
    await waitForAsyncWork();

    let latestDraft = await repository.loadLatest('video', document.location.href);
    expect(latestDraft).toMatchObject({ status: 'restorable' });

    const callsAfterBind = storage.setMany.mock.calls.length;
    await controller.dispose();

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    await waitForAsyncWork();

    expect(storage.setMany).toHaveBeenCalledTimes(callsAfterBind);
    latestDraft = await repository.loadLatest('video', document.location.href);
    expect(latestDraft).toMatchObject({ status: 'restorable' });
  });

  it('hydrates captures, comment drafts, and destination state from a restored same-page draft', async () => {
    const destination = {
      kind: 'downloads',
      adapterId: 'downloads',
      title: 'Downloads',
      type: 'folder'
    } as const;
    const harness = createHarness();
    await seedRestorableDraft(harness.storage, { destination });

    const restored = await harness.controller.restoreDraftState();

    expect(restored).toBe(true);
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    ]);
    expect(harness.state.commentDrafts).toEqual({ 'ts-1': 'draft note' });
    expect(harness.dom.setCommentDrafts).toHaveBeenCalledWith({ 'ts-1': 'draft note' });
    expect(harness.destinationState.applyMetadata).toHaveBeenCalledWith(destination);
    expect(harness.destinationState.getCurrent()).toEqual(destination);
  });

  it('emits aggregate draft restore telemetry only after a draft candidate restores', async () => {
    const trackDraftRestoreEvent = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ trackDraftRestoreEvent });
    await seedRestorableDraft(harness.storage);

    const restored = await harness.controller.restoreDraftState();

    expect(restored).toBe(true);

    await waitForAsyncWork();

    expect(trackDraftRestoreEvent).toHaveBeenCalledTimes(1);
    expect(trackDraftRestoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_count_bucket: 'one',
        screenshot_count_bucket: 'one',
        outcome: 'completed'
      })
    );
    const draftRestorePayload = readDraftRestoreTelemetryPayload(trackDraftRestoreEvent);
    expect(draftRestorePayload.duration_bucket).toEqual(expect.any(String));
    const payload = JSON.stringify(draftRestorePayload);
    expect(payload).not.toContain('https://video.example');
    expect(payload).not.toContain('restored note');
    expect(payload).not.toContain('draft note');
    expect(payload).not.toContain('screenshotRef');
    expect(payload).not.toContain('captureId');
  });

  it('persists screenshotRef metadata without serializing screenshot bytes into the draft payload', async () => {
    vi.setSystemTime(new Date('2026-06-14T10:40:00Z'));
    const harness = createHarness();
    const screenshotRef = createScreenshotCacheRef({ captureId: 'timestamp-1' });
    harness.state.captures = [
      {
        ...createTimestampCapture(),
        screenshotRequested: true,
        screenshotRef,
        screenshot: createBlobScreenshotFixture('private-frame')
      }
    ];

    const result = await harness.controller.flushNow('active');

    expect(result).toBe('ready');
    const storedDraft = await harness.repository.loadLatest('video', document.location.href);
    expect(storedDraft).not.toBeNull();
    if (!storedDraft || storedDraft.mode !== 'video') {
      throw new Error('expected an active video draft');
    }
    const payload = requireVideoDraftPayload(storedDraft);

    expect(payload.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'timestamp-1',
        screenshotRequested: true,
        screenshotRef
      })
    ]);
    expect(payload.captures[0]).not.toHaveProperty('screenshot');
    expect(payload.captures[0]).not.toHaveProperty('dataUrl');
    expect(payload.captures[0]).not.toHaveProperty('content');
  });

  it('restores old draft payloads without screenshot refs and preserves screenshot intent', async () => {
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraft(harness.storage);

    const restored = await harness.controller.restoreDraftState();

    expect(restored).toBe(true);
    expect(screenshotCache.load).not.toHaveBeenCalled();
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    ]);
    expect(harness.state.captures[0]).not.toHaveProperty('screenshot');
  });

  it('hydrates cached screenshots from valid screenshot refs during restore', async () => {
    const screenshotRef = createScreenshotCacheRef();
    const restoredScreenshot = createBlobScreenshotFixture('cached-frame');
    const screenshotCache = {
      load: vi.fn().mockResolvedValue(restoredScreenshot),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef
          }
        ],
        commentDrafts: { 'ts-1': 'draft note' },
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(screenshotCache.load).toHaveBeenCalledWith(screenshotRef);
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef,
        screenshot: restoredScreenshot
      })
    ]);
  });

  it('restores base capture state before cached screenshot hydration resolves', async () => {
    const screenshotRef = createScreenshotCacheRef();
    const deferred = createDeferred<VideoCaptureScreenshot | null>();
    const onScreenshotHydrationChange = vi.fn();
    const screenshotCache = {
      load: vi.fn().mockReturnValue(deferred.promise),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache, onScreenshotHydrationChange });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();

    expect(restored).toBe(true);
    expect(harness.state.captures[0]).toEqual(
      expect.objectContaining({
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef
      })
    );
    expect(harness.state.captures[0]).not.toHaveProperty('screenshot');

    const restoredScreenshot = createBlobScreenshotFixture('late-cached-frame');
    deferred.resolve(restoredScreenshot);
    await waitForAsyncWork();

    expect(harness.state.captures[0]).toEqual(
      expect.objectContaining({
        screenshot: restoredScreenshot
      })
    );
    expect(onScreenshotHydrationChange).toHaveBeenCalledTimes(1);
  });

  it('hydrates cached screenshots with bounded parallelism during restore', async () => {
    const screenshotRefs = Array.from({ length: 6 }, (_, index) =>
      createScreenshotCacheRef({
        captureId: `ts-${index + 1}`,
        id: `shot-${index + 1}`
      })
    );
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const screenshotCache = {
      load: vi.fn(async (ref: VideoScreenshotCacheRef) => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        await Promise.resolve();
        activeLoads -= 1;
        return createBlobScreenshotFixture(`cached-frame-${ref.captureId}`, ref.capturedAt);
      }),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: screenshotRefs.map((screenshotRef, index) => ({
          kind: 'timestamp',
          id: screenshotRef.captureId,
          timeSec: 40 + index,
          url: `https://video.example/watch?t=${40 + index}`,
          comment: 'restored note',
          createdAt: 2_000_000_000_100 + index,
          screenshotRequested: true,
          screenshotRef
        })),
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(maxActiveLoads).toBeLessThanOrEqual(4);
    expect(screenshotCache.load).toHaveBeenCalledTimes(6);
    for (const capture of harness.state.captures) {
      const hydratedCapture = capture as TimestampDraftCapture & {
        screenshot?: VideoCaptureScreenshot;
      };
      expect(hydratedCapture.kind).toBe('timestamp');
      expect(hydratedCapture.screenshotRequested).toBe(true);
      expect(hydratedCapture.screenshot?.content).toMatchObject({ kind: 'blob' });
    }
  });

  it('clears stale screenshot refs and keeps screenshot requests pending when cache entries are missing', async () => {
    const screenshotRef = createScreenshotCacheRef();
    const onScreenshotHydrationChange = vi.fn();
    const trackDraftRestoreEvent = vi.fn().mockResolvedValue(undefined);
    const screenshotCache = {
      load: vi.fn().mockResolvedValue(null),
      removeMany: vi.fn()
    };
    const harness = createHarness({
      screenshotCache,
      onScreenshotHydrationChange,
      trackDraftRestoreEvent
    });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(screenshotCache.load).toHaveBeenCalledWith(screenshotRef);
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    ]);
    expect(harness.state.captures[0]).not.toHaveProperty('screenshot');
    expect(harness.state.captures[0]).not.toHaveProperty('screenshotRef');
    expect(onScreenshotHydrationChange).toHaveBeenCalledTimes(1);
    expect(trackDraftRestoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_count_bucket: 'one',
        screenshot_count_bucket: 'one',
        outcome: 'completed',
        stale_screenshot_ref_count_bucket: 'one'
      })
    );
    const telemetryPayload = JSON.stringify(
      readDraftRestoreTelemetryPayload(trackDraftRestoreEvent)
    );
    expect(telemetryPayload).not.toContain(screenshotRef.key);
    expect(telemetryPayload).not.toContain(screenshotRef.captureId);
    expect(telemetryPayload).not.toContain('restored note');

    await vi.advanceTimersByTimeAsync(150);
    await waitForAsyncWork();
    const storedDraft = await harness.repository.loadLatest('video', document.location.href);
    if (!storedDraft || storedDraft.mode !== 'video') {
      throw new Error('expected saved video draft after stale ref cleanup');
    }
    const payload = requireVideoDraftPayload(storedDraft);
    expect(payload.captures[0]).toEqual(
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    );
    expect(payload.captures[0]).not.toHaveProperty('screenshotRef');
  });

  it('does not emit draft restore telemetry for stale async hydration generations', async () => {
    const screenshotRef = createScreenshotCacheRef();
    const deferred = createDeferred<VideoCaptureScreenshot | null>();
    const trackDraftRestoreEvent = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({
      screenshotCache: {
        load: vi.fn().mockReturnValue(deferred.promise),
        removeMany: vi.fn()
      },
      trackDraftRestoreEvent
    });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();

    expect(restored).toBe(true);
    await harness.controller.dispose();

    deferred.resolve(createBlobScreenshotFixture('late-cached-frame'));
    await waitForAsyncWork();

    expect(trackDraftRestoreEvent).not.toHaveBeenCalled();
  });

  it('ignores invalid screenshot refs while preserving the restored capture', async () => {
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef: {
              schemaVersion: 1,
              pageKey: document.location.href,
              captureId: 'ts-1',
              id: 'shot-1',
              key: 'invalid-ref',
              fileName: 'video-0m42s.jpg',
              mimeType: 'image/jpeg',
              byteLength: 12,
              capturedAt: 2_000_000_000_101,
              expiresAt: 2_000_000_060_101
            }
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(screenshotCache.load).not.toHaveBeenCalled();
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    ]);
    expect(harness.state.captures[0]).not.toHaveProperty('screenshot');
    expect(harness.state.captures[0]).not.toHaveProperty('screenshotRef');
  });

  it('removes invalid screenshot refs from the next persisted draft while preserving screenshot intent', async () => {
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef: {
              schemaVersion: 1,
              pageKey: document.location.href,
              captureId: 'ts-1',
              id: 'shot-1',
              key: 'invalid-ref',
              fileName: 'video-0m42s.jpg',
              mimeType: 'image/jpeg',
              byteLength: 12,
              capturedAt: 2_000_000_000_101,
              expiresAt: 2_000_000_060_101
            }
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    await waitForAsyncWork();

    const storedDraft = await harness.repository.loadLatest('video', document.location.href);
    if (!storedDraft || storedDraft.mode !== 'video') {
      throw new Error('expected saved video draft after invalid ref cleanup');
    }
    const payload = requireVideoDraftPayload(storedDraft);
    expect(payload.captures[0]).toEqual(
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    );
    expect(payload.captures[0]).not.toHaveProperty('screenshotRef');
  });

  it('keeps restore non-fatal when loading a referenced screenshot throws', async () => {
    const screenshotRef = createScreenshotCacheRef();
    const screenshotCache = {
      load: vi.fn().mockRejectedValue(new Error('cache load failed')),
      removeMany: vi.fn()
    };
    const harness = createHarness({ screenshotCache });
    await seedRestorableDraftWithPayload(
      harness.storage,
      buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'ts-1',
            timeSec: 42,
            url: 'https://video.example/watch?t=42',
            comment: 'restored note',
            createdAt: 2_000_000_000_100,
            screenshotRequested: true,
            screenshotRef
          }
        ],
        commentDrafts: {},
        platform: 'bilibili',
        videoId: 'BV1xx411c7mD',
        videoTitle: 'Restored title',
        videoUrl: document.location.href,
        canonicalUrl: document.location.href
      })
    );

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(screenshotCache.load).toHaveBeenCalledWith(screenshotRef);
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true,
        screenshotRef
      })
    ]);
    expect(harness.state.captures[0]).not.toHaveProperty('screenshot');
  });

  it('swallows draft restore telemetry failures after restoring state', async () => {
    const trackDraftRestoreEvent = vi.fn().mockRejectedValue(new Error('analytics failed'));
    const harness = createHarness({ trackDraftRestoreEvent });
    await seedRestorableDraft(harness.storage);

    const restored = await harness.controller.restoreDraftState();
    await waitForAsyncWork();

    expect(restored).toBe(true);
    expect(harness.state.captures).toEqual([
      expect.objectContaining({
        kind: 'timestamp',
        id: 'ts-1',
        screenshotRequested: true
      })
    ]);
    expect(trackDraftRestoreEvent).toHaveBeenCalledTimes(1);
  });

  it('writes the exported terminal envelope to the claimed restored exact key before cleanup', async () => {
    const harness = createHarness();
    const { storage, controller, repository, state, setDomDrafts } = harness;
    const { draft: restoredDraft, storageKey: restoredDraftKey } = await seedRestorableDraft(
      storage,
      { commentDrafts: {} }
    );
    const passthroughRemove = storage.remove.getMockImplementation();
    if (!passthroughRemove) {
      throw new Error('expected storage remove implementation');
    }
    let failSupersededCleanup = true;
    storage.remove.mockImplementation(async (...args) => {
      const [value] = args;
      if (failSupersededCleanup && matchesRemovalKey(value, restoredDraftKey)) {
        failSupersededCleanup = false;
        throw new Error('keep restored exact key active before export');
      }
      return await passthroughRemove(...args);
    });

    await controller.restoreDraftState();
    state.captures[0] = {
      ...createTimestampCapture('ts-1'),
      comment: 'committed note'
    };
    setDomDrafts({});
    await controller.flushNow('active');

    const candidates = await repository.listCandidates('video', document.location.href);
    const currentDraft = candidates.find(
      (candidate) => candidate.draftId === restoredDraft.draftId
    );
    if (!currentDraft || currentDraft.mode !== 'video') {
      throw new Error('expected the claimed restored draft');
    }
    const currentDraftKey = getDraftStorageKey(currentDraft);

    storage.remove.mockClear();
    storage.remove.mockImplementation(async (...args) => {
      const [value] = args;
      if (matchesRemovalKey(value, currentDraftKey) || matchesRemovalKey(value, restoredDraftKey)) {
        throw new Error('terminal cleanup should be best-effort');
      }
      return await passthroughRemove(...args);
    });

    const terminalized = await controller.finalizeTerminal('exported');

    expect(terminalized).toBe(true);
    await expect(repository.loadLatest('video', document.location.href)).resolves.toBeNull();
    await expect(storage.get<VideoSessionDraftEnvelope>(currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraft.draftId,
      status: 'exported'
    });
    expect(currentDraftKey).toBe(restoredDraftKey);
  });

  it('returns false on terminal persistence failure and keeps the active draft intact', async () => {
    const { controller, repository, state, setDomDrafts, storage } = createHarness();
    state.captures = [createTimestampCapture()];
    setDomDrafts({});

    await controller.flushNow('active');
    const activeDraft = await repository.loadLatest('video', document.location.href);
    if (!activeDraft || activeDraft.mode !== 'video') {
      throw new Error('expected an active draft before terminal finalization');
    }

    storage.remove.mockClear();
    storage.setMany.mockImplementationOnce(() => Promise.reject(new Error('terminal save failed')));

    const terminalized = await controller.finalizeTerminal('discarded');

    expect(terminalized).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();
    await expect(repository.loadLatest('video', document.location.href)).resolves.toMatchObject({
      draftId: activeDraft.draftId,
      status: 'active'
    });
  });

  it('removes exact screenshot refs during terminal cleanup when the cache repository is available', async () => {
    const screenshotRef = createScreenshotCacheRef({ captureId: 'ts-1' });
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn().mockResolvedValue(undefined)
    };
    const harness = createHarness({ screenshotCache });
    harness.state.captures = [
      {
        ...createTimestampCapture('ts-1'),
        screenshotRequested: true,
        screenshotRef
      }
    ];
    await harness.controller.flushNow('active');

    const terminalized = await harness.controller.finalizeTerminal('discarded');

    expect(terminalized).toBe(true);
    expect(screenshotCache.removeMany).toHaveBeenCalledWith([screenshotRef]);
  });

  it('deduplicates screenshot refs during terminal cleanup before calling removeMany', async () => {
    const firstRef = createScreenshotCacheRef({ captureId: 'ts-1', id: 'shot-1' });
    const duplicateFirstRef = { ...firstRef };
    const secondRef = createScreenshotCacheRef({ captureId: 'ts-2', id: 'shot-2' });
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn().mockResolvedValue(undefined)
    };
    const harness = createHarness({ screenshotCache });
    harness.state.captures = [
      {
        ...createTimestampCapture('ts-1'),
        screenshotRequested: true,
        screenshotRef: firstRef
      },
      {
        ...createTimestampCapture('ts-1-duplicate'),
        screenshotRequested: true,
        screenshotRef: duplicateFirstRef
      },
      {
        ...createTimestampCapture('ts-2'),
        screenshotRequested: true,
        screenshotRef: secondRef
      }
    ];
    await harness.controller.flushNow('active');

    const terminalized = await harness.controller.finalizeTerminal('discarded');

    expect(terminalized).toBe(true);
    expect(screenshotCache.removeMany).toHaveBeenCalledWith([firstRef, secondRef]);
  });

  it('runs screenshot cache maintenance best-effort without repeating it on draft saves', async () => {
    const pruneExpired = vi.fn().mockRejectedValue(new Error('pruneExpired failed'));
    const pruneToLimits = vi.fn().mockRejectedValue(new Error('pruneToLimits failed'));
    const screenshotCache = {
      load: vi.fn(),
      removeMany: vi.fn(),
      pruneExpired,
      pruneToLimits
    };
    const harness = createHarness({ screenshotCache });
    harness.state.captures = [createTimestampCapture()];
    harness.setDomDrafts({ 'timestamp-1': 'draft note' });

    harness.controller.bindPersistence();
    await waitForAsyncWork();

    expect(pruneExpired).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[VideoSession] Failed to prune expired cached screenshots:',
      expect.any(Error)
    );

    const pendingSave = harness.controller.scheduleSave();
    await vi.advanceTimersByTimeAsync(200);
    await pendingSave;

    expect(pruneExpired).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    await waitForAsyncWork();
    expect(pruneToLimits).toHaveBeenCalledTimes(1);

    await harness.controller.dispose();
    await waitForAsyncWork();

    expect(pruneToLimits).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[VideoSession] Failed to prune cached screenshots to limits:',
      expect.any(Error)
    );
  });

  it('ignores non-function maintenance hooks without throwing or warning', async () => {
    const maintenance = createVideoSessionDraftScreenshotCacheMaintenance({
      pruneExpired: true,
      pruneToLimits: 'invalid'
    });

    maintenance.pruneExpiredOnce();
    maintenance.pruneToLimitsBestEffort();
    await waitForAsyncWork();

    expect(warnSpy).not.toHaveBeenCalledWith(
      '[VideoSession] Failed to prune expired cached screenshots:',
      expect.anything()
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[VideoSession] Failed to prune cached screenshots to limits:',
      expect.anything()
    );
  });

  it.each([
    {
      label: 'restored',
      expectsWarning: true,
      prepare: async (harness: ReturnType<typeof createHarness>) => {
        const { storageKey } = await seedRestorableDraft(harness.storage, { commentDrafts: {} });
        await harness.controller.restoreDraftState();
        return storageKey;
      }
    },
    {
      label: 'legacy',
      expectsWarning: true,
      prepare: async (harness: ReturnType<typeof createHarness>) => {
        await harness.storage.set('legacy-video-captures', { legacy: true });
        harness.controller.handleLegacyRestore('legacy-video-captures');
        harness.state.captures = [createTimestampCapture()];
        return 'legacy-video-captures';
      }
    }
  ])('$label cleanup failures are warned but not fatal', async ({ prepare, expectsWarning }) => {
    const harness = createHarness();
    const { controller, repository, state, setDomDrafts, storage } = harness;
    const targetKey = await prepare(harness);
    state.captures = [createTimestampCapture('ts-1')];
    setDomDrafts({});
    storage.remove.mockImplementation((value) => {
      if (matchesRemovalKey(value, targetKey)) {
        return Promise.reject(new Error(`cleanup failed for ${targetKey}`));
      }
      return Promise.resolve();
    });

    const result = await controller.flushNow('active');

    expect(result).toBe('ready');
    if (expectsWarning) {
      expect(warnSpy).toHaveBeenCalledWith(
        '[VideoSession] Failed to clear superseded durable draft sources:',
        expect.any(Error)
      );
    } else {
      expect(warnSpy).not.toHaveBeenCalledWith(
        '[VideoSession] Failed to clear superseded durable draft sources:',
        expect.any(Error)
      );
    }
    await expect(repository.listCandidates('video', document.location.href)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'active' })])
    );
  });
});
