/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { setWindowProp, asType } from '../utils/typeHelpers';
import type { PageI18nController, Messages } from '../../src/i18n';
import { partialOf } from '../utils/typeHelpers';
import {
  MockClipRepository,
  MockOptionsRepository,
  MockVideoRepository,
  MockReaderRepository,
  MockNavigationRepository
} from '../utils/repositories';
import { VideoSessionExporter } from '../../src/content/video/videoSessionExporter';
import type { VideoCapture } from '../../src/content/video/types';
import { DEFAULT_SESSION_MESSAGES as VIDEO_MESSAGES } from '../../src/content/video/sessionMessages';
import type { ClipPromptGateway } from '../../src/content/clipper/application/clipPromptGateway';
import type { ReaderSessionDependencies } from '../../src/content/reader/sessionTypes';
import type { ReaderHighlightRecord } from '../../src/content/reader/services/highlightManager';
import type { ReadingOptions } from '../../src/shared/repositories/IReaderRepository';
import type { ReadingSessionOptions } from '../../src/shared/types/options';
import { DEFAULT_FRAGMENT_CONFIG } from '../../src/content/clipper/services/fragmentConfig';
import { DEFAULT_SESSION_MESSAGES as READER_MESSAGES } from '../../src/content/reader/sessionMessages';
import { OnboardingController } from '../../src/onboarding/bootstrap';
import { registerService, resetGlobalRegistry, TOKENS } from '../../src/shared/di';
import { repositoryContainer } from '../../src/shared/di/serviceRegistry';
import { DI_TOKENS } from '../../src/shared/di/tokens';
import type { ReaderHighlightManager } from '../../src/content/reader/services/highlightManager';
import type { ReaderSelectionController } from '../../src/content/reader/services/selectionController';
import type { ReaderPanelCoordinator } from '../../src/content/reader/panelCoordinator';
import type { ReaderPanelEditingSnapshot } from '../../src/content/reader/application/readerSessionView';
import type { ReaderEnvironmentController } from '../../src/content/reader/environmentController';
import type { ReaderSessionLifecycle } from '../../src/content/reader/sessionLifecycle';
import type { IOptionsRepository } from '../../src/shared/repositories/IOptionsRepository';
import { createMemoryStorageService } from '../../src/platform/preview/memoryStorage';
import type { PlatformServices } from '../../src/platform/types';
import type { SessionCommentDraftSnapshot } from '../../src/content/shared/panels/sessionCommentDrafts';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '../../src/content/sessionDrafts/sessionDraftRepository';

type I18nContextModule = typeof import('../../src/content/i18n/context');
type StyleSheetManagerModule = typeof import('../../src/content/clipper/shared/styleSheetManager');

const ensureContentI18nMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['ensureContentI18n']>
    ) => ReturnType<I18nContextModule['ensureContentI18n']>
  >()
);
const getContentI18nBinderMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['getContentI18nBinder']>
    ) => ReturnType<I18nContextModule['getContentI18nBinder']>
  >()
);
const getContentMessagesMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<I18nContextModule['getContentMessages']>
    ) => ReturnType<I18nContextModule['getContentMessages']>
  >()
);
const initializeStylesMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<StyleSheetManagerModule['clipperStyleSheetManager']['initialize']>
    ) => ReturnType<StyleSheetManagerModule['clipperStyleSheetManager']['initialize']>
  >()
);
const applyStylesMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<StyleSheetManagerModule['clipperStyleSheetManager']['applyTo']>
    ) => ReturnType<StyleSheetManagerModule['clipperStyleSheetManager']['applyTo']>
  >()
);
const applyStitchRuntimeStylesMock = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<
        StyleSheetManagerModule['clipperStyleSheetManager']['applyStitchRuntimeStyles']
      >
    ) => ReturnType<StyleSheetManagerModule['clipperStyleSheetManager']['applyStitchRuntimeStyles']>
  >()
);

vi.mock('../../src/content/i18n/context', () => ({
  ensureContentI18n: ensureContentI18nMock,
  getContentI18nBinder: getContentI18nBinderMock,
  getContentMessages: getContentMessagesMock
}));

vi.mock('../../src/content/clipper/shared/styleSheetManager', () => ({
  clipperStyleSheetManager: {
    initialize: initializeStylesMock,
    applyTo: applyStylesMock,
    applyStitchRuntimeStyles: applyStitchRuntimeStylesMock
  },
  supportsAdoptedStyleSheets: () => true
}));

// Reuse real comment form implementation
vi.mock('../../src/content/clipper/components/commentForm', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/content/clipper/components/commentForm')
  >('../../src/content/clipper/components/commentForm');
  return actual;
});

const dialogMessages = partialOf<Messages>({
  clipDialogTitle: 'Clip Selection',
  clipDialogInstructions: 'Select text and press Alt+C',
  cancelButton: 'Cancel',
  clipButton: 'Save',
  commentLabel: 'Comment',
  commentPlaceholder: 'Add a note'
});

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

type ReaderSessionCtor = (typeof import('../../src/content/reader/session'))['ReaderSession'];
type ReaderSessionInstance = InstanceType<ReaderSessionCtor>;
type ReaderSessionTestAdapter = {
  __setTestHighlights(records: ReaderHighlightRecord[]): void;
};
let ReaderSessionClass: ReaderSessionCtor;

const asTestReaderSession = (
  session: ReaderSessionInstance
): ReaderSessionInstance & ReaderSessionTestAdapter =>
  session as ReaderSessionInstance & ReaderSessionTestAdapter;

const overrideReadingConfig = (
  session: ReaderSessionInstance,
  config: ReadingSessionOptions
): void => {
  Reflect.set(session, 'readingConfig', config);
};

const injectTestHighlights = (
  session: ReaderSessionInstance,
  highlights: ReaderHighlightRecord[]
): void => {
  asTestReaderSession(session).__setTestHighlights(highlights);
};

let restorePointerEvent: (() => void) | undefined;
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class TestPointerEvent extends MouseEvent {
      constructor(type: string, init?: PointerEventInit) {
        super(type, init);
      }
    }
    restorePointerEvent = setWindowProp(
      'PointerEvent',
      asType<typeof PointerEvent>(TestPointerEvent)
    );
  }
});

afterAll(() => {
  restorePointerEvent?.();
});

beforeAll(async () => {
  repositoryContainer.reset();
  repositoryContainer.registerSingleton(
    DI_TOKENS.IOptionsRepository,
    () => new MockOptionsRepository()
  );
  repositoryContainer.registerSingleton(
    DI_TOKENS.IReaderRepository,
    () => new MockReaderRepository()
  );
  repositoryContainer.registerSingleton(DI_TOKENS.IClipRepository, () => new MockClipRepository());
  repositoryContainer.registerSingleton(
    DI_TOKENS.IVideoRepository,
    () => new MockVideoRepository()
  );
  const readerModule = await import('../../src/content/reader/session');
  ReaderSessionClass = readerModule.ReaderSession;
});

describe('Content scripts repository integration (Clipper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureContentI18nMock.mockResolvedValue(asType<PageI18nController>(undefined));
    getContentI18nBinderMock.mockReturnValue(null);
    getContentMessagesMock.mockResolvedValue(dialogMessages);
    initializeStylesMock.mockResolvedValue(undefined);
    applyStylesMock.mockResolvedValue(undefined);
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    resetGlobalRegistry();
    registerService(TOKENS.platformServices, () =>
      asType<PlatformServices>({
        storage: { sync: { watchKey: vi.fn(() => () => undefined) }, local: {} },
        runtime: { getURL: vi.fn((path?: string) => path ?? '') }
      })
    );
  });

  it('loads fragment config from repository when Clipper dialog opens', async () => {
    const { ClipperDialog } = await import('../../src/content/clipper/components/dialog');
    const clipRepo = new MockClipRepository();
    const spy = vi.spyOn(clipRepo, 'getFragmentConfig');

    const dialog = new ClipperDialog({ clipRepo });
    void dialog.show('Selection');
    await flushPromises();

    expect(spy).toHaveBeenCalledTimes(1);
    dialog.destroy();
  });

  it('reacts to fragment config updates through repository subscription', async () => {
    const { ClipperDialog } = await import('../../src/content/clipper/components/dialog');
    const clipRepo = new MockClipRepository();
    await clipRepo.setFragmentConfig({ keyboardShortcutsEnabled: false });

    const dialog = new ClipperDialog({ clipRepo });
    void dialog.show('Selection');
    await flushPromises();

    const state = asType<{ keyboardShortcutsEnabled: boolean }>(dialog);
    expect(state.keyboardShortcutsEnabled).toBe(false);

    await clipRepo.setFragmentConfig({ keyboardShortcutsEnabled: true });
    await flushPromises();
    expect(state.keyboardShortcutsEnabled).toBe(true);
    dialog.destroy();
  });
});

describe('Content scripts repository integration (Video)', () => {
  it('sends clip payload through VideoRepository', async () => {
    const videoRepo = new MockVideoRepository();
    const exporter = new VideoSessionExporter(videoRepo);

    await exporter.export({
      captures: [],
      videoTitle: 'Deep dive',
      canonicalUrl: 'https://example.com/video',
      videoUrl: 'https://example.com/video?watch=1',
      platform: 'youtube',
      messages: VIDEO_MESSAGES,
      storageKey: 'video:test'
    });

    expect(videoRepo.sentClips).toHaveLength(1);
    expect(videoRepo.sentClips[0]?.title).toBe('Deep dive');
    expect(videoRepo.sentClips[0]?.platform).toBe('youtube');
  });

  it('preserves capture counts and canonical url metadata in VideoRepository payload', async () => {
    const videoRepo = new MockVideoRepository();
    const exporter = new VideoSessionExporter(videoRepo);
    const now = Date.now();
    const captures: VideoCapture[] = [
      {
        kind: 'timestamp',
        id: 'ts-1',
        timeSec: 42,
        url: 'https://example.com/video?t=42',
        comment: 'Intro',
        createdAt: now - 10
      },
      {
        kind: 'fragment',
        id: 'frag-1',
        selectedHtml: '<p>Quote</p>',
        selectedText: 'Quote',
        createdAt: now,
        fragmentUrl: 'https://example.com/video?t=99',
        comment: 'Key point'
      }
    ];

    await exporter.export({
      captures,
      videoTitle: '',
      canonicalUrl: 'https://canonical.example/video',
      videoUrl: '',
      platform: 'bilibili',
      messages: VIDEO_MESSAGES,
      storageKey: null
    });

    const clip = videoRepo.sentClips[0];
    expect(clip).toBeTruthy();
    expect(clip?.url).toBe('https://canonical.example/video');
    expect(clip?.platform).toBe('bilibili');
    expect(videoRepo.sentClips).toHaveLength(1);
  });
});

function createReaderSessionHarness(overrides?: Partial<ReaderSessionDependencies>) {
  const highlightManagerMocks = {
    applyTheme: vi.fn(),
    createHighlight: vi.fn(() => null),
    sortByDocumentOrder: vi.fn((records: ReaderHighlightRecord[]) => records),
    reconstructText: vi.fn(() => ''),
    updateComment: vi.fn(),
    unwrapHighlight: vi.fn()
  };

  const selectionControllerMocks = {
    start: vi.fn(),
    stop: vi.fn(),
    updateFragmentConfig: vi.fn()
  };

  const currentCommentDrafts: SessionCommentDraftSnapshot = {};
  let currentEditingState: ReaderPanelEditingSnapshot = {
    editingHighlightId: null,
    pendingNoteFocusHighlightId: null
  };
  const panelCoordinatorMocks = {
    getElement: vi.fn(() => null),
    updateMessages: vi.fn(),
    updateHighlights: vi.fn(),
    updateDestination: vi.fn(),
    refreshHint: vi.fn(),
    applyHint: vi.fn(),
    mount: vi.fn(),
    destroy: vi.fn(),
    snapshotCommentDrafts: vi.fn(() => ({ ...currentCommentDrafts })),
    hydrateCommentDrafts: vi.fn((drafts: SessionCommentDraftSnapshot) => {
      Object.keys(currentCommentDrafts).forEach((id) => {
        delete currentCommentDrafts[id];
      });
      Object.assign(currentCommentDrafts, drafts);
    }),
    clearCommentDraft: vi.fn((id: string) => {
      delete currentCommentDrafts[id];
    }),
    restoreCommentDraft: vi.fn((id: string, draft: string | undefined) => {
      if (draft === undefined) {
        delete currentCommentDrafts[id];
        return;
      }
      currentCommentDrafts[id] = draft;
    }),
    snapshotEditingState: vi.fn(() => ({ ...currentEditingState })),
    restoreEditingState: vi.fn((snapshot: ReaderPanelEditingSnapshot) => {
      currentEditingState = { ...snapshot };
    }),
    finishEditing: vi.fn(() => {
      currentEditingState = {
        editingHighlightId: null,
        pendingNoteFocusHighlightId: null
      };
    }),
    isEditing: vi.fn(() => currentEditingState.editingHighlightId !== null),
    stopEditing: vi.fn(() => {
      currentEditingState = {
        editingHighlightId: null,
        pendingNoteFocusHighlightId: null
      };
    })
  };

  const environmentControllerMocks = {
    start: vi.fn(() =>
      Promise.resolve({
        controller: null,
        messages: READER_MESSAGES,
        fragmentConfig: DEFAULT_FRAGMENT_CONFIG
      })
    ),
    stop: vi.fn()
  };

  const lifecycleMocks = {
    start: vi.fn(() =>
      Promise.resolve({
        messages: READER_MESSAGES,
        fragmentConfig: DEFAULT_FRAGMENT_CONFIG
      })
    ),
    cleanup: vi.fn(),
    cancel: vi.fn()
  };

  const readerRepositoryMocks = new MockReaderRepository();
  readerRepositoryMocks.setMockConfig({
    exportMode: 'highlights',
    highlightTheme: 'gradient'
  } as Partial<ReadingOptions>);

  let preparedHighlights: Array<{ text: string; note?: string; color: string; timestamp: number }> =
    [];
  const exporterMocks = {
    prepareHighlights: vi.fn((records: ReaderHighlightRecord[]) => {
      preparedHighlights = records.map((record) => ({
        text: record.selectedText,
        note: record.comment,
        color: 'gold',
        timestamp: record.createdAt
      }));
      return preparedHighlights;
    }),
    buildMarkdown: vi.fn(() => ({
      markdown: 'content',
      title: 'title',
      meta: { url: 'https://example.com' }
    })),
    applyTokens: vi.fn()
  };

  const storage = overrides?.storage ?? createMemoryStorageService();
  const dependencies: ReaderSessionDependencies = {
    ...overrides,
    viewFactory:
      overrides?.viewFactory ??
      ({ createView: vi.fn() } as ReaderSessionDependencies['viewFactory']),
    optionsRepository: overrides?.optionsRepository ?? ({} as IOptionsRepository),
    storage,
    sessionDraftRepository:
      overrides?.sessionDraftRepository ?? createSessionDraftRepository(storage.local),
    messaging:
      overrides?.messaging ?? ({ send: vi.fn() } as ReaderSessionDependencies['messaging']),
    readerRepository: overrides?.readerRepository ?? readerRepositoryMocks,
    createHighlightManager:
      overrides?.createHighlightManager ??
      (() => asType<ReaderHighlightManager>(highlightManagerMocks)),
    createSelectionController:
      overrides?.createSelectionController ??
      (() => asType<ReaderSelectionController>(selectionControllerMocks)),
    createPanelCoordinator:
      overrides?.createPanelCoordinator ??
      (() => asType<ReaderPanelCoordinator>(panelCoordinatorMocks)),
    createEnvironmentController:
      overrides?.createEnvironmentController ??
      (() => asType<ReaderEnvironmentController>(environmentControllerMocks)),
    createLifecycle:
      overrides?.createLifecycle ?? (() => asType<ReaderSessionLifecycle>(lifecycleMocks)),
    exporter: overrides?.exporter ?? asType<ReaderSessionDependencies['exporter']>(exporterMocks),
    dispatchClipResult:
      overrides?.dispatchClipResult ??
      (async (payload) => {
        const result = await readerRepositoryMocks.sendReadingClip({
          content: payload.markdown,
          title: payload.title ?? '',
          url: typeof payload.meta?.url === 'string' ? payload.meta.url : '',
          highlights: preparedHighlights,
          exportMode: 'highlights'
        });
        if (!result.success) {
          throw new Error(typeof result.error === 'string' ? result.error : 'export failed');
        }
      })
  };

  const clipPrompt: ClipPromptGateway = {
    requestSelectionAction: vi.fn<ClipPromptGateway['requestSelectionAction']>(() =>
      Promise.resolve({ action: 'clip', comment: '' })
    )
  };
  const session = new ReaderSessionClass(
    document,
    'https://example.com/article',
    clipPrompt,
    dependencies
  );

  return {
    session,
    readerRepositoryMocks,
    panelCoordinatorMocks,
    lifecycleMocks
  };
}

function createHighlight(comment: string): ReaderHighlightRecord {
  const wrapper = document.createElement('mark');
  return {
    id: comment,
    selectedHtml: '<p>text</p>',
    selectedText: 'text',
    comment,
    fragmentUrl: '#fragment',
    wrapper,
    wrapperSegments: [wrapper],
    createdAt: Date.now()
  };
}

describe('Content scripts repository integration (Reader)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Reflect.set(window, '__aiobReaderActive', false);
    Reflect.set(window, '__aiobReaderController', undefined);
  });

  it('sends highlights through ReaderRepository when finishing session', async () => {
    const context = createReaderSessionHarness();
    injectTestHighlights(context.session, [createHighlight('note-1')]);
    overrideReadingConfig(context.session, {
      exportMode: 'highlights',
      highlightTheme: 'gradient'
    });

    await asType<{ finish(): Promise<void> }>(context.session).finish();

    expect(context.lifecycleMocks.cleanup).toHaveBeenCalled();
    expect(context.readerRepositoryMocks.sentClips).toHaveLength(1);
    const clip = context.readerRepositoryMocks.sentClips[0];
    expect(clip.highlights[0]?.note).toBe('note-1');
    expect(clip.exportMode).toBe('highlights');
  });

  it('surfaces repository errors as panel hints when export fails', async () => {
    const context = createReaderSessionHarness();
    context.readerRepositoryMocks.setMockResult({ success: false, error: 'boom' });
    injectTestHighlights(context.session, [createHighlight('fail')]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await asType<{ finish(): Promise<void> }>(context.session).finish();

    expect(context.readerRepositoryMocks.sentClips).toHaveLength(1);
    expect(context.panelCoordinatorMocks.applyHint).toHaveBeenCalledWith('failure', 1);
    errorSpy.mockRestore();
  });
});

describe('Content scripts repository integration (Onboarding)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="openVault">Open Vault</button>
      <button id="configureApiBtn">Step1</button>
      <button id="skipStep1Btn">Skip1</button>
      <button id="configureVaultsBtn">Step2</button>
      <button id="skipStep2Btn">Skip2</button>
      <button id="exploreSettingsBtn">Step3</button>
      <button id="skipStep3Btn">Skip3</button>
      <button id="exploreAuxiliaryBtn">Step4</button>
      <button id="skipStep4Btn">Skip4</button>
      <a id="suggestionsLink" href="#">feedback</a>
      <a id="supportLink" href="#">support</a>
      <a id="contactLink" href="#">contact</a>
      <button id="skipOnboardingBtn">Skip</button>
      <button id="completeOnboardingBtn" class="hidden">Complete</button>
    `;
    const storage = globalThis.localStorage as Record<string, unknown> & { clear?: () => void };
    if (typeof storage.clear === 'function') {
      storage.clear();
    } else {
      for (const key of Object.keys(storage)) {
        delete storage[key];
      }
    }
  });

  it('routes onboarding CTA clicks through NavigationRepository', async () => {
    const navRepo = new MockNavigationRepository();
    const controller = new OnboardingController(navRepo);
    controller.initialize();

    document.getElementById('configureApiBtn')?.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(navRepo.optionsOpenedCount).toBe(1);

    document.getElementById('openVault')?.dispatchEvent(new MouseEvent('click'));
    await flushPromises();
    expect(navRepo.openedVaults[0]).toBe('obsidian://open');
  });

  it('opens feedback resources in the onboarding modal', async () => {
    const navRepo = new MockNavigationRepository();
    const controller = new OnboardingController(navRepo);
    controller.initialize();

    const link = document.getElementById('suggestionsLink');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const modal = document.querySelector<HTMLElement>('.resource-modal-overlay');
      const githubLink = modal?.querySelector<HTMLAnchorElement>(
        'a[href*="github.com/Lefeaker/zendio/issues/new"]'
      );

      expect(modal).toBeTruthy();
      expect(githubLink?.href).toContain('https://github.com/Lefeaker/zendio/issues/new');
    });

    expect(navRepo.openedExternalLinks).toHaveLength(0);
  });
});
