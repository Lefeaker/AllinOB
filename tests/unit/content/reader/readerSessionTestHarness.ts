import { expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import '../../../setup/globalSetup';
import type { ClipPromptGateway } from '@content/clipper/application/clipPromptGateway';
import { DEFAULT_FRAGMENT_CONFIG } from '@content/clipper/services/fragmentConfig';
import type {
  ReaderPanelCallbacks,
  ReaderPanelHighlight,
  ReaderPanelTexts
} from '@content/reader/application/readerPanelModel';
import type {
  ReaderPanelEditingSnapshot,
  ReaderPanelRenderOptions,
  ReaderSessionView,
  ReaderSessionViewOptions
} from '@content/reader/application/readerSessionView';
import { ReaderPanelCoordinator } from '@content/reader/panelCoordinator';
import { ReaderSession } from '@content/reader/session';
import type { ReaderSessionDependencies } from '@content/reader/session';
import { ReaderSessionLifecycle } from '@content/reader/sessionLifecycle';
import type { ReaderEnvironmentController } from '@content/reader/environmentController';
import { DEFAULT_SESSION_MESSAGES } from '@content/reader/sessionMessages';
import type { ReaderSelectionPayload } from '@content/reader/services/selectionController';
import type { SessionMutationTransaction } from '@content/sessionMutations';
import { ReaderSessionExporter } from '@content/reader/services/exporter';
import type {
  ReaderHighlightManager,
  ReaderHighlightRecord
} from '@content/reader/services/highlightManager';
import { ReaderSelectionController } from '@content/reader/services/selectionController';
import {
  buildReaderFullMarkdown,
  buildReaderHighlightsMarkdown
} from '@content/reader/utils/markdownBuilder';
import type { ReadingOptions } from '@shared/repositories/IReaderRepository';
import {
  SESSION_DRAFT_INDEX_KEY,
  createDirectSessionDraftRepository as createSessionDraftRepository,
  type ReaderSessionDraftEnvelope,
  type SessionDraftEnvelope,
  type SessionDraftIndex,
  type SessionDraftStoragePolicy
} from '@content/sessionDrafts';
import type { SessionCommentDraftSnapshot } from '@content/shared/panels/sessionCommentDrafts';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { mergeOptions } from '@shared/config/optionsMerger';
import { getTestRestUrls } from '../../../fixtures/configTestHelpers';
import { asType } from '../../../utils/typeHelpers';
import { isObjectRecord, type RuntimePropertyValue } from '@shared/guards/object';

const LOCAL_REST_URLS = getTestRestUrls('localhost');
const LOCAL_REST_BASE_URL = LOCAL_REST_URLS.baseUrl.replace(/\/$/, '');
const LOCAL_REST_HTTPS_URL = LOCAL_REST_URLS.httpsUrl.replace(/\/$/, '');
const LOCAL_REST_HTTP_URL = LOCAL_REST_URLS.httpUrl.replace(/\/$/, '');

export type TestView = ReaderSessionView & {
  updateCount: Mock<(...args: [count: number]) => void>;
  updateHint: Mock<(...args: [message: string]) => void>;
  updateTexts: Mock<(...args: [texts: ReaderPanelTexts]) => void>;
  updateDestination: Mock<NonNullable<ReaderSessionView['updateDestination']>>;
  setHighlights: Mock<
    (...args: [highlights: ReaderPanelHighlight[], options?: ReaderPanelRenderOptions]) => void
  >;
  snapshotCommentDrafts: Mock<(...args: []) => SessionCommentDraftSnapshot>;
  hydrateCommentDrafts: Mock<(...args: [drafts: SessionCommentDraftSnapshot]) => void>;
  clearCommentDraft: Mock<(...args: [id: string]) => void>;
  restoreCommentDraft: Mock<(...args: [id: string, draft: string | undefined]) => void>;
  snapshotEditingState: Mock<(...args: []) => ReaderPanelEditingSnapshot>;
  restoreEditingState: Mock<(...args: [snapshot: ReaderPanelEditingSnapshot]) => void>;
  finishEditing: Mock<(...args: []) => void>;
  stopEditing: Mock<(...args: []) => void>;
  isEditing: Mock<(...args: []) => boolean>;
  destroy: Mock<(...args: []) => void>;
  currentDrafts: SessionCommentDraftSnapshot;
};

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: Error): void;
}

export type ReaderSessionTestHarness = {
  __setTestHighlights(
    records: Array<{
      id: string;
      selectedHtml: string;
      selectedText: string;
      comment: string;
      fragmentUrl: string;
      wrapper: HTMLElement;
    }>
  ): void;
  __testHighlights: Array<{
    id: string;
    selectedHtml: string;
    selectedText: string;
    comment: string;
    fragmentUrl: string;
    wrapper: HTMLElement;
    footnoteIndex?: number;
  }>;
  handleSelection(payload: ReaderSelectionPayload): Promise<void>;
  persistDraftMutation(): Promise<void>;
  runDraftMutation<Result>(transaction: SessionMutationTransaction<Result, void>): Promise<boolean>;
  draftId: string | null;
  draftCreatedAt: number | null;
  draftStorageKey: string | null;
  state: {
    saving?: boolean;
  };
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function getSessionHarness(session: ReaderSession): ReaderSessionTestHarness {
  return asType<ReaderSessionTestHarness>(session);
}

export function getDraftIdentity(session: ReaderSession): {
  draftId: string | null;
  draftCreatedAt: number | null;
  draftStorageKey: string | null;
} {
  const harness = getSessionHarness(session);
  return {
    draftId: harness.draftId,
    draftCreatedAt: harness.draftCreatedAt,
    draftStorageKey: harness.draftStorageKey
  };
}

export function createView(): TestView {
  let currentDrafts: SessionCommentDraftSnapshot = {};
  let editingSnapshot: ReaderPanelEditingSnapshot = {
    editingHighlightId: null,
    pendingNoteFocusHighlightId: null
  };
  return {
    element: document.createElement('div'),
    updateCount: vi.fn(),
    updateHint: vi.fn(),
    updateTexts: vi.fn(),
    updateDestination: vi.fn(),
    setHighlights: vi.fn(),
    snapshotCommentDrafts: vi.fn(() => ({ ...currentDrafts })),
    hydrateCommentDrafts: vi.fn((drafts: SessionCommentDraftSnapshot) => {
      currentDrafts = { ...drafts };
    }),
    clearCommentDraft: vi.fn((id: string) => {
      const remainingDrafts = { ...currentDrafts };
      delete remainingDrafts[id];
      currentDrafts = remainingDrafts;
    }),
    restoreCommentDraft: vi.fn((id: string, draft: string | undefined) => {
      if (draft === undefined) {
        const remainingDrafts = { ...currentDrafts };
        delete remainingDrafts[id];
        currentDrafts = remainingDrafts;
        return;
      }
      currentDrafts = { ...currentDrafts, [id]: draft };
    }),
    snapshotEditingState: vi.fn(() => ({ ...editingSnapshot })),
    restoreEditingState: vi.fn((snapshot: ReaderPanelEditingSnapshot) => {
      editingSnapshot = { ...snapshot };
    }),
    finishEditing: vi.fn(() => {
      editingSnapshot = {
        editingHighlightId: null,
        pendingNoteFocusHighlightId: null
      };
    }),
    stopEditing: vi.fn(),
    isEditing: vi.fn(() => false),
    destroy: vi.fn(),
    get currentDrafts() {
      return currentDrafts;
    },
    set currentDrafts(drafts: SessionCommentDraftSnapshot) {
      currentDrafts = drafts;
    }
  };
}

export function createClipPrompt(): ClipPromptGateway & {
  requestSelectionAction: ReturnType<typeof vi.fn>;
} {
  return {
    requestSelectionAction: vi.fn().mockResolvedValue({
      action: 'clip',
      comment: ''
    })
  };
}

export function setSelectionFor(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

export function createSelectionPayload(node: Node) {
  const range = setSelectionFor(node);
  return {
    range,
    selectedHtml: '<span>selection</span>',
    selectedText: node.textContent?.trim() ?? '',
    event: new MouseEvent('mouseup', { button: 0, bubbles: true })
  };
}

const CANONICAL_READER_EVENTS = new Set([
  'reader_session_started',
  'reader_draft_restored',
  'reader_highlight_added',
  'reader_exported',
  'reader_export_failed',
  'reader_session_cancelled'
]);
const FORBIDDEN_READER_EVENT_NAMES = new Set(['reader_session_exported', 'reader_session_failed']);
const FORBIDDEN_READER_PARAM_KEYS = new Set([
  'entry_point',
  'export_mode',
  'export_destination',
  'duration_ms',
  'selectedText',
  'selectedHtml',
  'comment',
  'fragmentUrl',
  'url',
  'title',
  'markdown'
]);

export type TabContextProbeMessage = { type: 'AIIOB_IS_TAB_CONTEXT_ACTIVE' };
export type TabContextProbeResponse = {
  success: true;
  active?: boolean;
  tabId?: number;
  windowId?: number;
  frameId?: number;
};

export type TelemetryMessage = {
  type: 'ANALYTICS_EVENT';
  event: string;
  params?: Record<string, RuntimePropertyValue>;
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

export function getTelemetryMessages(context: { messaging: { send: Mock } }): TelemetryMessage[] {
  return context.messaging.send.mock.calls.flatMap(([message]) => {
    if (!isObjectRecord(message)) {
      return [];
    }
    if (message.type !== 'ANALYTICS_EVENT' || typeof message.event !== 'string') {
      return [];
    }
    return [
      {
        type: 'ANALYTICS_EVENT',
        event: message.event,
        ...(isObjectRecord(message.params) ? { params: message.params } : {})
      }
    ];
  });
}

export function expectCanonicalReaderTelemetry(messages: TelemetryMessage[]): void {
  for (const message of messages) {
    expect(CANONICAL_READER_EVENTS.has(message.event)).toBe(true);
    expect(FORBIDDEN_READER_EVENT_NAMES.has(message.event)).toBe(false);
    for (const key of Object.keys(message.params ?? {})) {
      expect(FORBIDDEN_READER_PARAM_KEYS.has(key)).toBe(false);
    }
  }
}

export function createSessionContext(
  options: {
    sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  } = {}
) {
  document.body.innerHTML = '<article><p id="content">Hello reader session world.</p></article>';
  const view = createView();
  let callbacks: ReaderPanelCallbacks | undefined;
  let viewOptions: ReaderSessionViewOptions | undefined;
  const readerConfigListener = vi.fn<(config: ReadingOptions) => void>();
  const getReadingConfig = vi.fn().mockResolvedValue({
    exportMode: 'highlights',
    highlightTheme: 'gradient'
  });
  const environment = {
    start: vi.fn(() =>
      Promise.resolve({
        controller: null,
        messages: DEFAULT_SESSION_MESSAGES,
        fragmentConfig: DEFAULT_FRAGMENT_CONFIG
      })
    ),
    stop: vi.fn()
  };
  const dispatchClipResult = vi.fn().mockResolvedValue(undefined);
  const showSupportProgress = vi.fn();
  const messaging = {
    send: vi.fn().mockResolvedValue(undefined)
  };
  const syncStorageArea = createMemoryStorageArea();
  const localStorageArea = createMemoryStorageArea();
  const sessionDraftRepository = createSessionDraftRepository(
    localStorageArea,
    options.sessionDraftStoragePolicy ? { storagePolicy: options.sessionDraftStoragePolicy } : {}
  );
  const highlightManager = {
    applyTheme: vi.fn((theme: string) => {
      document.body.dataset.aiobReaderHighlight = theme;
    }),
    createHighlight: vi.fn(
      (options: {
        id: string;
        selectedHtml: string;
        selectedText: string;
        comment: string;
        fragmentUrl: string;
      }) => {
        const wrapper = document.createElement('mark');
        wrapper.className = 'aiob-reader-highlight';
        wrapper.dataset.readerHighlightId = options.id;
        wrapper.dataset.readerComment = options.comment.trim();
        wrapper.textContent = options.selectedText;
        return {
          id: options.id,
          selectedHtml: options.selectedHtml,
          selectedText: options.selectedText,
          comment: options.comment.trim(),
          fragmentUrl: options.fragmentUrl,
          wrapper,
          wrapperSegments: [wrapper],
          createdAt: Date.now()
        } satisfies ReaderHighlightRecord;
      }
    ),
    updateComment: vi.fn((highlight: ReaderHighlightRecord, comment: string) => {
      highlight.comment = comment.trim();
      if (highlight.comment) {
        highlight.wrapper.dataset.readerComment = highlight.comment;
      } else {
        delete highlight.wrapper.dataset.readerComment;
      }
      delete highlight.footnoteIndex;
      delete highlight.wrapper.dataset.readerFootnote;
    }),
    assignFootnote: vi.fn(
      (highlight: ReaderHighlightRecord, comment: string, footnoteIndex?: number) => {
        highlight.comment = comment.trim();
        highlight.wrapper.dataset.readerComment = highlight.comment;
        if (footnoteIndex === undefined) {
          delete highlight.footnoteIndex;
          delete highlight.wrapper.dataset.readerFootnote;
          return;
        }
        highlight.footnoteIndex = footnoteIndex;
        highlight.wrapper.dataset.readerFootnote = String(footnoteIndex);
      }
    ),
    unwrapHighlight: vi.fn(),
    sortByDocumentOrder: vi.fn(),
    reconstructText: vi.fn((highlight: ReaderHighlightRecord) => highlight.selectedText),
    focusHighlight: vi.fn((highlight: ReaderHighlightRecord) => {
      highlight.wrapper.classList.add('aiob-reader-highlight--focus');
      return 1;
    })
  };

  const dependencies: ReaderSessionDependencies = {
    viewFactory: {
      createView: vi.fn<ReaderSessionDependencies['viewFactory']['createView']>(
        (nextCallbacks, _texts, nextViewOptions) => {
          callbacks = nextCallbacks;
          viewOptions = nextViewOptions;
          return view;
        }
      )
    },
    optionsRepository: {
      get: vi.fn().mockResolvedValue(
        mergeOptions({
          rest: {
            vault: 'Default Vault',
            baseUrl: LOCAL_REST_BASE_URL,
            apiKey: 'token'
          },
          vaultRouter: {
            defaultVaultId: 'default',
            vaults: [
              {
                id: 'default',
                name: 'Default Vault',
                vault: 'Default Vault',
                httpsUrl: LOCAL_REST_HTTPS_URL,
                httpUrl: LOCAL_REST_HTTP_URL,
                apiKey: 'token',
                enabled: true,
                isDefault: true
              },
              {
                id: 'research',
                name: 'Research Vault',
                vault: 'Research Vault',
                httpsUrl: 'https://localhost:27125',
                httpUrl: 'http://localhost:27122',
                apiKey: 'token',
                enabled: true
              }
            ],
            rules: []
          }
        })
      ),
      set: vi.fn(),
      onChange: vi.fn(() => () => undefined)
    },
    storage: {
      sync: syncStorageArea,
      local: localStorageArea
    },
    sessionDraftRepository,
    messaging,
    readerRepository: {
      getReadingConfig,
      sendReadingClip: vi.fn(),
      onConfigChange: vi.fn((listener: (config: ReadingOptions) => void) => {
        readerConfigListener.mockImplementation(listener);
        return () => undefined;
      })
    },
    createHighlightManager: () => asType<ReaderHighlightManager>(highlightManager),
    createSelectionController: (options) => new ReaderSelectionController(options),
    createPanelCoordinator: (options) => new ReaderPanelCoordinator(options),
    createEnvironmentController: () => asType<ReaderEnvironmentController>(environment),
    createLifecycle: (deps, handlers) => new ReaderSessionLifecycle(deps, handlers),
    exporter: new ReaderSessionExporter({
      buildHighlightsMarkdown: buildReaderHighlightsMarkdown,
      buildFullMarkdown: buildReaderFullMarkdown
    }),
    dispatchClipResult,
    ...(options.sessionDraftStoragePolicy
      ? { sessionDraftStoragePolicy: options.sessionDraftStoragePolicy }
      : {}),
    showSupportProgress
  };

  const clipPrompt = createClipPrompt();
  const session = new ReaderSession(
    document,
    'https://example.com/article',
    clipPrompt,
    dependencies
  );

  return {
    session,
    sessionDraftRepository,
    view,
    storageLocal: localStorageArea,
    draftRepository: createSessionDraftRepository(
      localStorageArea,
      options.sessionDraftStoragePolicy
        ? { retentionPolicy: options.sessionDraftStoragePolicy.retentionPolicy }
        : {}
    ),
    clipPrompt,
    messaging,
    environment,
    highlightManager,
    readerRepository: {
      ...dependencies.readerRepository,
      getReadingConfig
    },
    dispatchClipResult,
    showSupportProgress,
    getCallbacks: () => callbacks,
    emitCommentDraftChange: (drafts: SessionCommentDraftSnapshot) => {
      view.currentDrafts = { ...drafts };
      viewOptions?.onCommentDraftChange?.({ ...drafts });
    },
    emitReadingConfig: readerConfigListener
  };
}

export function createPersistedHighlightRecord(
  overrides: Partial<ReaderHighlightRecord> = {}
): ReaderHighlightRecord {
  const wrapper = document.createElement('mark');
  wrapper.className = 'aiob-reader-highlight';
  wrapper.dataset.readerHighlightId = overrides.id ?? 'saved-highlight';
  wrapper.textContent = overrides.selectedText ?? 'Saved highlight';
  return {
    id: overrides.id ?? 'saved-highlight',
    selectedHtml: overrides.selectedHtml ?? '<mark>Saved highlight</mark>',
    selectedText: overrides.selectedText ?? 'Saved highlight',
    comment: overrides.comment ?? '',
    fragmentUrl: overrides.fragmentUrl ?? '#saved-highlight',
    wrapper,
    wrapperSegments: overrides.wrapperSegments ?? [wrapper],
    createdAt: overrides.createdAt ?? 123
  };
}

export async function loadLatestReaderDraft(
  context: ReturnType<typeof createSessionContext>,
  pageUrl = 'https://example.com/article'
): Promise<ReaderSessionDraftEnvelope | null> {
  const candidate = await context.draftRepository.loadLatest('reader', pageUrl);
  return candidate?.mode === 'reader' ? candidate : null;
}

export async function listReaderDraftCandidates(
  context: ReturnType<typeof createSessionContext>,
  pageUrl = 'https://example.com/article'
): Promise<ReaderSessionDraftEnvelope[]> {
  const candidates = await context.draftRepository.listCandidates('reader', pageUrl);
  return candidates.filter(
    (candidate: SessionDraftEnvelope): candidate is ReaderSessionDraftEnvelope =>
      candidate.mode === 'reader'
  );
}

export async function readStoredReaderDraft(
  context: ReturnType<typeof createSessionContext>,
  storageKey: string
): Promise<ReaderSessionDraftEnvelope | undefined> {
  const value = await context.storageLocal.get<SessionDraftEnvelope>(storageKey);
  return value?.mode === 'reader' ? value : undefined;
}

export async function readDraftIndex(
  context: ReturnType<typeof createSessionContext>
): Promise<SessionDraftIndex | undefined> {
  return context.storageLocal.get<SessionDraftIndex>(SESSION_DRAFT_INDEX_KEY);
}

export function removalCallIncludesKey(value: string | string[], key: string): boolean {
  return Array.isArray(value) ? value.includes(key) : value === key;
}

export async function flushDraftPersistence(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
  await Promise.resolve();
}

export async function settleReaderMutation<T>(task: Promise<T>): Promise<T> {
  await flushDraftPersistence();
  return await task;
}
