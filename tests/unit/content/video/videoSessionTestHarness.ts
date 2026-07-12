import { expect, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import '../../../setup/globalSetup';
import { SESSION_DRAFT_INDEX_KEY } from '@content/sessionDrafts/sessionDraftKeys';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { VideoSession } from '@content/video/session';
import { DEFAULT_SESSION_MESSAGES } from '@content/video/sessionMessages';
import type { VideoPanelCallbacks } from '@content/video/application/videoPanelModel';
import type { VideoSessionDependencies } from '@content/video/sessionTypes';
import type {
  SessionDraftEnvelope,
  SessionDraftIndex,
  SessionDraftOwnerContext,
  SessionDraftStoragePolicy,
  VideoSessionDraftEnvelope
} from '@content/sessionDrafts/sessionDraftTypes';
import type { VideoSessionView } from '@content/video/application/videoSessionView';
import type { VideoSessionDraftPayloadShape } from '@content/video/sessionDrafts';
import type {
  VideoScreenshotCacheRepository,
  VideoScreenshotCacheSaveInput,
  VideoScreenshotCacheSaveResult
} from '@content/video/videoScreenshotCacheRepository';
import type { VideoScreenshotCacheProvisionalRepository } from '@content/video/videoScreenshotCacheClientRepository';
import type { VideoScreenshotCacheRef } from '@content/video/videoScreenshotCacheTypes';
import type { UsageEventName, UsageEventParamMap } from '@shared/types/analytics';
import type { StorageAreaService } from '@platform/interfaces/storage';
import type { VersionedSessionDraftRepository } from '@content/sessionDrafts/sessionDraftClientRepository';

const ensureContentI18nMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      registerDynamic: vi.fn(),
      destroy: vi.fn()
    })
  )
);
const getContentI18nResourceMock = vi.hoisted(() => vi.fn(() => null));
const getContentMessagesMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      videoPanelTitle: DEFAULT_SESSION_MESSAGES.panel.title,
      videoPanelStatus: DEFAULT_SESSION_MESSAGES.panel.status,
      videoPanelCounter: DEFAULT_SESSION_MESSAGES.panel.counter,
      videoPanelCounterZero: DEFAULT_SESSION_MESSAGES.panel.counterZero,
      videoPanelAdd: DEFAULT_SESSION_MESSAGES.panel.add,
      videoPanelFinish: DEFAULT_SESSION_MESSAGES.panel.finish,
      videoPanelCancel: DEFAULT_SESSION_MESSAGES.panel.cancel,
      videoPanelHint: DEFAULT_SESSION_MESSAGES.panel.hint,
      videoCaptureEditLabel: DEFAULT_SESSION_MESSAGES.panel.captureEditLabel,
      videoCaptureDeleteLabel: DEFAULT_SESSION_MESSAGES.panel.captureDeleteLabel,
      videoCaptureNoComment: DEFAULT_SESSION_MESSAGES.panel.captureNoComment,
      videoCaptureSaveLabel: DEFAULT_SESSION_MESSAGES.panel.captureSaveLabel,
      videoCaptureCancelLabel: DEFAULT_SESSION_MESSAGES.panel.captureCancelLabel,
      videoCaptureEditPlaceholder: DEFAULT_SESSION_MESSAGES.panel.captureEditPlaceholder,
      videoCaptureFocusLabel: DEFAULT_SESSION_MESSAGES.panel.captureFocusLabel,
      videoHintNoVideo: DEFAULT_SESSION_MESSAGES.hintNoVideo,
      videoHintReady: DEFAULT_SESSION_MESSAGES.hintReady,
      videoHintNoCaptures: DEFAULT_SESSION_MESSAGES.hintNoCaptures,
      videoHintSaving: DEFAULT_SESSION_MESSAGES.hintSaving,
      videoHintExporting: DEFAULT_SESSION_MESSAGES.hintExporting,
      videoHintFailure: DEFAULT_SESSION_MESSAGES.hintFailure,
      videoTimestampSectionTitle: DEFAULT_SESSION_MESSAGES.timestampSectionTitle,
      videoFragmentSectionTitle: DEFAULT_SESSION_MESSAGES.fragmentSectionTitle
    })
  )
);
const loadFragmentConfigMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const saveCaptureDataMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const loadStoredCaptureDataMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
const detectVideoIdentityMock = vi.hoisted(() =>
  vi.fn((url: string) => ({
    platform: 'bilibili',
    videoId: 'BV1xx411c7mD',
    canonicalUrl: url,
    storageKey: 'video:test'
  }))
);
const exportMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ success: true })));
const createVideoPlatformAdapterMock = vi.hoisted(() =>
  vi.fn(() => ({
    platform: 'bilibili',
    shouldActivate: vi.fn(() => true),
    resolveSelection: vi.fn(() => null),
    findTextRange: vi.fn(() => null),
    highlight: vi.fn(() => undefined),
    restoreHighlight: vi.fn(() => undefined),
    observeDomChanges: vi.fn(),
    handleMutations: vi.fn(),
    buildTimestampUrl: vi.fn((timeSec: number) => `https://video.example/watch?t=${timeSec}`),
    formatVideoTitle: vi.fn((title: string) => title.replace(/_+哔哩哔哩.*/i, '').trim() || null),
    dispose: vi.fn()
  }))
);
const originalMutationObserver = globalThis.MutationObserver;

vi.mock('../../../../src/content/i18n/context', () => ({
  ensureContentI18n: ensureContentI18nMock,
  getContentI18nResource: getContentI18nResourceMock,
  getContentMessages: getContentMessagesMock
}));
vi.mock('../../../../src/content/clipper/services/fragmentConfig', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/content/clipper/services/fragmentConfig')
  >('../../../../src/content/clipper/services/fragmentConfig');
  return {
    ...actual,
    loadFragmentConfig: loadFragmentConfigMock
  };
});
vi.mock('../../../../src/content/video/captureStorage', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/content/video/captureStorage')
  >('../../../../src/content/video/captureStorage');
  return {
    ...actual,
    saveCaptureData: saveCaptureDataMock,
    loadStoredCaptureData: loadStoredCaptureDataMock
  };
});
vi.mock('../../../../src/content/video/utils', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/content/video/utils')>(
    '../../../../src/content/video/utils'
  );
  return {
    ...actual,
    detectVideoIdentity: detectVideoIdentityMock
  };
});
vi.mock('../../../../src/content/video/platforms', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/content/video/platforms')>(
    '../../../../src/content/video/platforms'
  );
  return {
    ...actual,
    createVideoPlatformAdapter: createVideoPlatformAdapterMock
  };
});
vi.mock('../../../../src/content/video/videoSessionExporter', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/content/video/videoSessionExporter')
  >('../../../../src/content/video/videoSessionExporter');
  return {
    ...actual,
    VideoSessionExporter: vi.fn().mockImplementation(function VideoSessionExporterMock() {
      return {
        export: exportMock
      };
    })
  };
});

export function resetVideoSessionHarnessMocks(): void {
  vi.clearAllMocks();
  saveCaptureDataMock.mockResolvedValue(undefined);
}

export function restoreVideoSessionHarnessGlobals(): void {
  globalThis.MutationObserver = originalMutationObserver;
}

export function getVideoSessionHarnessMocks() {
  return {
    ensureContentI18nMock,
    getContentI18nResourceMock,
    getContentMessagesMock,
    loadFragmentConfigMock,
    saveCaptureDataMock,
    loadStoredCaptureDataMock,
    detectVideoIdentityMock,
    exportMock,
    createVideoPlatformAdapterMock
  };
}

export type TestView = VideoSessionView & {
  snapshotCommentDrafts?: Mock<NonNullable<VideoSessionView['snapshotCommentDrafts']>>;
  hydrateCommentDrafts?: Mock<NonNullable<VideoSessionView['hydrateCommentDrafts']>>;
  updateCount: Mock<VideoSessionView['updateCount']>;
  setCaptures: Mock<VideoSessionView['setCaptures']>;
  updateHint: Mock<VideoSessionView['updateHint']>;
  updateTexts: Mock<VideoSessionView['updateTexts']>;
  beginEditingCapture: Mock<VideoSessionView['beginEditingCapture']>;
  stopEditing: Mock<VideoSessionView['stopEditing']>;
  collapse: Mock<NonNullable<VideoSessionView['collapse']>>;
  destroy: Mock<VideoSessionView['destroy']>;
};

export type SessionTestApi = {
  applyHint: (state: string) => void;
  cleanup: () => void;
  handleAddCapture: (source?: 'button' | 'note-input') => Promise<void>;
  toggleCaptureScreenshot: (id: string) => Promise<void>;
  addCurrentTimestamp: (
    source?: 'button' | 'note-input',
    options?: {
      comment?: string;
      captureScreenshot?: boolean;
      pauseVideo?: boolean;
      beginEditing?: boolean;
      resumePlayback?: boolean;
      collapseAfterCapture?: boolean;
    }
  ) => Promise<void>;
  finish: () => Promise<void>;
  cancel: () => void;
  state: {
    captures: Array<{
      kind: 'timestamp' | 'fragment';
      id: string;
      comment: string;
      createdAt: number;
      timeSec?: number;
      url?: string;
      selectedText?: string;
      selectedHtml?: string;
      fragmentUrl?: string;
      wrapperId?: string;
      screenshotRequested?: boolean;
      screenshot?: {
        id?: string;
        fileName: string;
        mimeType: 'image/jpeg';
        capturedAt?: number;
        dataUrl?: string;
        content?: {
          kind: 'blob';
          byteLength: number;
          blob: Blob;
        };
      };
      screenshotRef?: VideoScreenshotCacheRef;
    }>;
    commentDrafts?: Record<string, string>;
    saving?: boolean;
  };
};

export type CaptureState = SessionTestApi['state']['captures'][number];
export type TimestampCaptureScreenshot = NonNullable<CaptureState['screenshot']>;

export type TabContextProbeMessage = { type: 'AIIOB_IS_TAB_CONTEXT_ACTIVE' };
export type TabContextProbeResponse = {
  success: true;
  active?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
};

export function isTabContextProbeMessage(
  message: object | null
): message is TabContextProbeMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'AIIOB_IS_TAB_CONTEXT_ACTIVE'
  );
}

export type DraftMutationAct = (
  api: SessionTestApi,
  ids: string[],
  activeId: string,
  session: VideoSession,
  callbacks: VideoPanelCallbacks
) => void | Promise<void>;

export interface DraftMutationCase {
  label: string;
  act: DraftMutationAct;
}

export function createView(
  overrides: {
    snapshotCommentDrafts?: Mock<NonNullable<VideoSessionView['snapshotCommentDrafts']>>;
    hydrateCommentDrafts?: Mock<NonNullable<VideoSessionView['hydrateCommentDrafts']>>;
  } = {}
): TestView {
  return {
    ...(overrides.snapshotCommentDrafts
      ? { snapshotCommentDrafts: overrides.snapshotCommentDrafts }
      : {}),
    ...(overrides.hydrateCommentDrafts
      ? { hydrateCommentDrafts: overrides.hydrateCommentDrafts }
      : {}),
    updateCount: vi.fn<VideoSessionView['updateCount']>(),
    setCaptures: vi.fn<VideoSessionView['setCaptures']>(),
    updateHint: vi.fn<VideoSessionView['updateHint']>(),
    updateTexts: vi.fn<VideoSessionView['updateTexts']>(),
    beginEditingCapture: vi.fn<VideoSessionView['beginEditingCapture']>(),
    stopEditing: vi.fn<VideoSessionView['stopEditing']>(),
    collapse: vi.fn<NonNullable<VideoSessionView['collapse']>>(),
    destroy: vi.fn<VideoSessionView['destroy']>()
  };
}

export function createDependencies(
  videoConfig: unknown = null,
  overrides: {
    sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  } = {}
): VideoSessionDependencies {
  const showSupportProgress = vi.fn();
  const trackUsageEvent = vi.fn(() => Promise.resolve(undefined));
  const localArea = createMemoryStorageArea();
  const syncArea = createMemoryStorageArea();
  const local = {
    ...localArea,
    get: vi.fn(localArea.get),
    set: vi.fn(localArea.set),
    getMany: vi.fn(localArea.getMany),
    setMany: vi.fn(localArea.setMany),
    remove: vi.fn(localArea.remove),
    clear: vi.fn(localArea.clear)
  };
  const sync = {
    ...syncArea,
    get: vi.fn(syncArea.get),
    set: vi.fn(syncArea.set),
    getMany: vi.fn(syncArea.getMany),
    setMany: vi.fn(syncArea.setMany),
    remove: vi.fn(syncArea.remove),
    clear: vi.fn(syncArea.clear)
  };
  const sessionDraftRepository = createSessionDraftRepository(
    local as StorageAreaService,
    overrides.sessionDraftStoragePolicy
      ? { retentionPolicy: overrides.sessionDraftStoragePolicy.retentionPolicy }
      : {}
  );
  const versionedSessionDraftRepository: VersionedSessionDraftRepository = {
    ...sessionDraftRepository,
    claim: () => Promise.resolve(),
    runWriteOperation(draftKey, task) {
      return task({
        context: {
          operationId: 'video-session-harness-operation',
          epoch: 1,
          draftKey,
          baseRevision: 0,
          nextRevision: 1
        },
        commit: (envelope) => sessionDraftRepository.save(envelope)
      });
    }
  };
  return {
    viewFactory: {
      createView: vi.fn(() => createView())
    },
    optionsRepository: {
      get: vi.fn(() => Promise.resolve({ readingSession: { highlightTheme: 'gradient' } })),
      set: vi.fn(() => Promise.resolve(undefined)),
      onChange: vi.fn(() => () => {})
    },
    videoRepository: {
      getVideoConfig: vi.fn(() => Promise.resolve(videoConfig)),
      savePromptPosition: vi.fn(() => Promise.resolve(undefined)),
      saveControlBarPreferences: vi.fn(() => Promise.resolve(undefined)),
      getPromptPosition: vi.fn(() => Promise.resolve(null)),
      sendVideoClip: vi.fn(() => Promise.resolve({ success: true })),
      onConfigChange: vi.fn(() => () => {})
    },
    storage: {
      local,
      sync
    },
    sessionDraftRepository: versionedSessionDraftRepository,
    showSupportProgress,
    ...(overrides.sessionDraftStoragePolicy
      ? { sessionDraftStoragePolicy: overrides.sessionDraftStoragePolicy }
      : {}),
    trackUsageEvent
  } as unknown as VideoSessionDependencies;
}

function createSessionDraftRepositoryForDeps(deps: VideoSessionDependencies) {
  return createSessionDraftRepository(
    deps.storage.local,
    deps.sessionDraftStoragePolicy
      ? { retentionPolicy: deps.sessionDraftStoragePolicy.retentionPolicy }
      : {}
  );
}

export async function listVideoDraftCandidates(
  deps: VideoSessionDependencies,
  pageUrl = document.location.href,
  ownerContext?: SessionDraftOwnerContext | null
): Promise<VideoSessionDraftEnvelope[]> {
  const repository = createSessionDraftRepositoryForDeps(deps);
  const candidates = await repository.listCandidates(
    'video',
    pageUrl,
    undefined,
    ownerContext === undefined ? undefined : { ownerContext }
  );
  return candidates.filter(
    (candidate: SessionDraftEnvelope): candidate is VideoSessionDraftEnvelope =>
      candidate.mode === 'video'
  );
}

export async function readDraftIndex(
  deps: VideoSessionDependencies
): Promise<SessionDraftIndex | undefined> {
  return deps.storage.local.get<SessionDraftIndex>(SESSION_DRAFT_INDEX_KEY);
}

export async function loadLatestVideoDraft(
  deps: VideoSessionDependencies,
  pageUrl = document.location.href,
  ownerContext?: SessionDraftOwnerContext | null
): Promise<VideoSessionDraftEnvelope | null> {
  const repository = createSessionDraftRepositoryForDeps(deps);
  const candidate = await repository.loadLatest(
    'video',
    pageUrl,
    undefined,
    ownerContext === undefined ? undefined : { ownerContext }
  );
  return candidate?.mode === 'video' ? candidate : null;
}

export async function readStoredVideoDraft(
  deps: VideoSessionDependencies,
  storageKey: string
): Promise<VideoSessionDraftEnvelope | undefined> {
  const value = await deps.storage.local.get<SessionDraftEnvelope>(storageKey);
  return value?.mode === 'video' ? value : undefined;
}

export function requireMountedPanelCallbacks(
  callbacks: VideoPanelCallbacks | null
): VideoPanelCallbacks {
  if (!callbacks) {
    throw new Error('Video panel callbacks were not mounted');
  }
  return callbacks;
}

export function requirePromise(value: void | Promise<void>): Promise<void> {
  if (!(value instanceof Promise)) {
    throw new Error('Expected panel callback to return a Promise');
  }
  return value;
}

export function requireVideoElement(): HTMLVideoElement {
  const video = document.querySelector('video');
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error('video fixture did not mount');
  }
  return video;
}

export function toSessionTestApi(session: VideoSession): SessionTestApi {
  return session as unknown as SessionTestApi;
}

export function toDraftControllerTestApi(session: VideoSession): {
  flushNow: (
    status?: 'active' | 'restorable'
  ) => Promise<'ready' | 'failure' | 'noCaptures' | null>;
} {
  const draftController = (session as unknown as { draftController?: unknown }).draftController;
  if (
    !draftController ||
    typeof draftController !== 'object' ||
    !('flushNow' in draftController) ||
    typeof draftController.flushNow !== 'function'
  ) {
    throw new Error('draft controller was not initialized');
  }
  return draftController as {
    flushNow: (
      status?: 'active' | 'restorable'
    ) => Promise<'ready' | 'failure' | 'noCaptures' | null>;
  };
}

export function seedTimestampCaptures(sessionApi: SessionTestApi, count: number): string[] {
  const now = Date.now();
  sessionApi.state.captures = Array.from({ length: count }, (_, index) => ({
    kind: 'timestamp',
    id: `timestamp-${index + 1}`,
    timeSec: 10 + index,
    comment: '',
    url: `https://video.example/watch?t=${10 + index}`,
    createdAt: now + index
  }));
  return sessionApi.state.captures.map((capture) => capture.id);
}

export function pickUnrelatedCaptureId(ids: string[], activeId: string): string {
  const unrelatedId = ids.find((id) => id !== activeId);
  if (!unrelatedId) {
    throw new Error(`Unable to find unrelated capture for ${activeId}`);
  }
  return unrelatedId;
}

export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function createBlobScreenshotFixture(
  text: string,
  capturedAt: number,
  options: {
    id?: string;
    fileName?: string;
  } = {}
) {
  const blob = new Blob([text], { type: 'image/jpeg' });
  return {
    id: options.id ?? `shot-${capturedAt}`,
    fileName: options.fileName ?? `file-${capturedAt}.jpg`,
    mimeType: 'image/jpeg' as const,
    capturedAt,
    content: {
      kind: 'blob' as const,
      blob,
      byteLength: blob.size
    }
  };
}

export function createScreenshotCacheRefFixture(
  captureId: string,
  options: {
    id?: string;
    pageKey?: string;
    capturedAt?: number;
    byteLength?: number;
  } = {}
): VideoScreenshotCacheRef {
  const pageKey = options.pageKey ?? 'video-example';
  const id = options.id ?? `shot-${captureId}`;
  const capturedAt = options.capturedAt ?? 2_000_000_000_300;
  return {
    schemaVersion: 1,
    pageKey,
    captureId,
    id,
    key: `aiob.videoScreenshotCache.v1.${pageKey}.${captureId}.${id}`,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: options.byteLength ?? 14,
    capturedAt,
    expiresAt: capturedAt + 60_000
  };
}

export function removalCallIncludesKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.includes(key);
  }
  return value === key;
}

export async function flushMutationWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export async function waitForMockCalls(
  mock: MockInstance,
  expectedCalls = 1,
  turns = 30
): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (mock.mock.calls.length >= expectedCalls) {
      return;
    }
    await Promise.resolve();
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
      continue;
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  }
}

export async function waitForTimestampScreenshot(
  capture: CaptureState,
  turns = 30
): Promise<TimestampCaptureScreenshot> {
  for (let index = 0; index < turns; index += 1) {
    const screenshot = capture.screenshot;
    if (screenshot) {
      return screenshot;
    }
    await flushMutationWork();
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
      continue;
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  }
  throw new Error('expected restored timestamp screenshot to be populated');
}

export class RecordingMutationObserver extends MutationObserver {
  static instances: RecordingMutationObserver[] = [];
  public readonly observe = vi.fn();
  public readonly disconnect = vi.fn();

  constructor(public readonly callback: MutationCallback) {
    super(callback);
    RecordingMutationObserver.instances.push(this);
  }

  static reset(): void {
    RecordingMutationObserver.instances = [];
  }
}

export async function readLatestVideoDraftCandidate(deps: VideoSessionDependencies) {
  const candidates = await listVideoDraftCandidates(deps);
  return [...candidates].sort((left, right) => left.updatedAt - right.updatedAt).at(-1) ?? null;
}

export async function readVideoDraftCandidateWithScreenshotRef(
  deps: VideoSessionDependencies,
  captureId: string
) {
  const candidates = await listVideoDraftCandidates(deps);
  return (
    candidates.find((candidate) =>
      readVideoDraftPayload(candidate)?.captures.some(
        (capture) =>
          capture.kind === 'timestamp' && capture.id === captureId && capture.screenshotRef
      )
    ) ?? null
  );
}

export function isVideoDraftPayloadShape(
  payload: VideoSessionDraftEnvelope['payload']
): payload is VideoSessionDraftPayloadShape {
  return payload.mode === 'video' && Array.isArray(payload.captures);
}

export function readVideoDraftPayload(
  candidate: VideoSessionDraftEnvelope | null | undefined
): VideoSessionDraftPayloadShape | undefined {
  if (!candidate) {
    return undefined;
  }
  if (!isVideoDraftPayloadShape(candidate.payload)) {
    throw new Error('expected video draft payload shape');
  }
  return candidate.payload;
}

export function createPreparationVideoHarness(
  options: {
    currentTime?: number;
    videoWidth?: number;
    videoHeight?: number;
    sourceUrl?: string;
  } = {}
) {
  const video = document.createElement('video');
  let currentTime = options.currentTime ?? 0;
  let videoWidth = options.videoWidth ?? 640;
  let videoHeight = options.videoHeight ?? 360;
  let sourceUrl = options.sourceUrl ?? 'https://cdn.example/video.mp4';
  const currentTimeSetSpy = vi.fn((value: number) => {
    currentTime = value;
    video.dispatchEvent(new Event('seeked'));
  });

  Object.defineProperty(video, 'currentTime', {
    get: () => currentTime,
    set: currentTimeSetSpy,
    configurable: true
  });
  Object.defineProperty(video, 'videoWidth', {
    get: () => videoWidth,
    configurable: true
  });
  Object.defineProperty(video, 'videoHeight', {
    get: () => videoHeight,
    configurable: true
  });
  Object.defineProperty(video, 'currentSrc', {
    get: () => sourceUrl,
    configurable: true
  });
  Object.defineProperty(video, 'src', {
    get: () => sourceUrl,
    set: (value: string) => {
      sourceUrl = value;
    },
    configurable: true
  });

  return {
    video,
    currentTimeSetSpy,
    setDimensions: (width: number, height: number) => {
      videoWidth = width;
      videoHeight = height;
    }
  };
}

export function getTrackUsageEventMock(
  deps: VideoSessionDependencies
): Mock<
  <EventName extends UsageEventName>(
    event: EventName,
    params?: UsageEventParamMap[EventName]
  ) => Promise<void>
> {
  return deps.trackUsageEvent as Mock<
    <EventName extends UsageEventName>(
      event: EventName,
      params?: UsageEventParamMap[EventName]
    ) => Promise<void>
  >;
}

export type VideoScreenshotCacheSaveMock = Mock<
  (input: VideoScreenshotCacheSaveInput) => Promise<VideoScreenshotCacheSaveResult>
>;

export function readFirstCacheSaveInput(
  saveSpy: VideoScreenshotCacheSaveMock
): VideoScreenshotCacheSaveInput {
  const input = saveSpy.mock.calls[0]?.[0];
  if (!input) {
    throw new Error('expected video screenshot cache save call');
  }
  return input;
}

export function createScreenshotCacheRepositoryMock(
  overrides: Partial<VideoScreenshotCacheRepository & VideoScreenshotCacheProvisionalRepository>
): VideoScreenshotCacheRepository & VideoScreenshotCacheProvisionalRepository {
  const defaultSaveResult: VideoScreenshotCacheSaveResult = {
    status: 'skipped',
    reason: 'serialize-failed',
    error: 'not configured'
  };
  const repository: VideoScreenshotCacheRepository = {
    save: vi.fn(() => Promise.resolve(defaultSaveResult)),
    load: vi.fn(() => Promise.resolve(null)),
    remove: vi.fn(() => Promise.resolve(undefined)),
    removeMany: vi.fn(() => Promise.resolve(undefined)),
    pruneExpired: vi.fn(() => Promise.resolve(undefined)),
    pruneToLimits: vi.fn(() => Promise.resolve(undefined)),
    ...overrides
  };
  return {
    ...repository,
    saveProvisional: overrides.saveProvisional ?? ((input) => repository.save(input))
  };
}

export function expectNoForbiddenAnalyticsKeys(params: Record<string, unknown> | undefined): void {
  const keys = Object.keys(params ?? {});
  expect(keys).not.toContain('timestamp_count_bucket');
  expect(keys).not.toContain('fragment_count_bucket');
  expect(keys).not.toContain('has_comment');
  expect(keys).not.toContain('screenshot_requested');
  expect(keys).not.toContain('capture_kind');
  expect(keys).not.toContain('action');
  expect(keys).not.toContain('duration_ms');
  expect(keys).not.toContain('outcome');
}
