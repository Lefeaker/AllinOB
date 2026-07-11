import { ClipperDialog } from '../content/clipper/components/dialog';
import { ReaderSession } from '../content/reader/session';
import type { ReaderSessionDependencies } from '../content/reader/session';
import { createReaderPanelViewFactory } from '../content/reader/presentation/readerPanelView';
import { ReaderHighlightManager } from '../content/reader/services/highlightManager';
import { ReaderSelectionController } from '../content/reader/services/selectionController';
import { ReaderPanelCoordinator } from '../content/reader/panelCoordinator';
import { ReaderEnvironmentController } from '../content/reader/environmentController';
import { ReaderSessionLifecycle } from '../content/reader/sessionLifecycle';
import { ReaderSessionExporter } from '../content/reader/services/exporter';
import {
  buildReaderFullMarkdown,
  buildReaderHighlightsMarkdown
} from '../content/reader/utils/markdownBuilder';
import { VideoSession } from '../content/video/session';
import { createPromptElement } from '../content/video/videoPromptRenderer';
import { panelStyleSheetManager } from '../content/shared/panels/styleSheetManager';
import { setControlledRuntimeTheme } from '../content/stitch/runtimeTheme';
import { SupportPrompt } from '../content/ui/supportPrompt';
import { createContentRuntimeState } from '../content/runtime/contentRuntimeState';
import type { ReaderMarkdownPayload } from '../content/reader/utils/markdownBuilder';
import type { StorageAreaService, StorageService } from '../platform/interfaces/storage';
import type { MessagingService } from '../platform/interfaces/messaging';
import type { ErrorHandler as SharedErrorHandler } from '../shared/errors/errorHandler';
import { registerService, TOKENS } from '../shared/di';
import { registerFallbackRepositories } from '../shared/di/serviceRegistry';
import { createPreviewPlatformServices } from '../platform/preview/services';
import { DEFAULT_RUNTIME_MESSAGES } from '@i18n';

type HarnessStorageValue = Parameters<StorageAreaService['set']>[1];
const status = document.getElementById('status');
function setStatus(message: string): void {
  if (status) {
    status.textContent = message;
  }
}
function createStorageArea(): StorageAreaService {
  const values = new Map<string, HarnessStorageValue>();
  return {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(values.get(key) as T | undefined);
    },
    getAll(): Promise<Record<string, HarnessStorageValue>> {
      return Promise.resolve(Object.fromEntries(values));
    },
    set<T>(key: string, value: T): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    getMany<T>(keys: string[]): Promise<Record<string, T | undefined>> {
      return Promise.resolve(
        Object.fromEntries(keys.map((key) => [key, values.get(key) as T | undefined]))
      );
    },
    setMany<T>(entries: Record<string, T>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
      return Promise.resolve();
    },
    remove(key: string | string[]): Promise<void> {
      for (const currentKey of Array.isArray(key) ? key : [key]) values.delete(currentKey);
      return Promise.resolve();
    },
    clear(): Promise<void> {
      values.clear();
      return Promise.resolve();
    },
    watchKey(): () => void {
      return () => undefined;
    },
    watchAll(): () => void {
      return () => undefined;
    }
  };
}
const storage: StorageService = {
  local: createStorageArea(),
  sync: createStorageArea(),
  session: createStorageArea()
};

const configuredInterfaceTheme =
  new URLSearchParams(window.location.search).get('interfaceTheme') === 'light' ? 'light' : 'dark';
setControlledRuntimeTheme(window, configuredInterfaceTheme);
const HARNESS_VIDEO_PROMPT_LABEL = DEFAULT_RUNTIME_MESSAGES.videoPromptAction;
const HARNESS_VIDEO_PROMPT_DISMISS = DEFAULT_RUNTIME_MESSAGES.videoPromptDismiss;
const HARNESS_VIDEO_OPTIONS = {
  floatingPromptEnabled: true,
  promptButtonLabel: HARNESS_VIDEO_PROMPT_LABEL,
  promptShortcut: 'Alt+V',
  controlBarAutoPause: true,
  controlBarScreenshot: true,
  commentEditorAutoPause: false
};

const optionsRepository = {
  get() {
    return Promise.resolve({
      interfaceTheme: configuredInterfaceTheme,
      readingSession: { exportMode: 'highlights', highlightTheme: 'gradient' },
      video: HARNESS_VIDEO_OPTIONS
    });
  },
  async set() {},
  onChange() {
    return () => undefined;
  }
};

const clipRepo = {
  getFragmentConfig() {
    return Promise.resolve({
      useFootnoteFormat: true,
      captureContext: false,
      contextLength: 200,
      contextMode: 'chars',
      selectionModifierEnabled: false,
      selectionModifierKeys: [],
      keyboardShortcutsEnabled: true
    });
  },
  onConfigChange() {
    return () => undefined;
  }
};

const previewPlatformServices = createPreviewPlatformServices(storage);
registerService(TOKENS.platformServices, () => previewPlatformServices);
registerFallbackRepositories();

const runtime = previewPlatformServices.runtime;
const runtimeState = createContentRuntimeState({
  optionsRepository: optionsRepository as never,
  window
});

const errorHandler = {
  handle(error: Parameters<SharedErrorHandler['handle']>[0]): Promise<void> {
    console.warn('[harness:errorHandler]', error);
    return Promise.resolve();
  }
};

let activeReader: ReaderSession | null = null;
let activeVideo: VideoSession | null = null;
let activeVideoPromptHost: HTMLElement | null = null;

function buildReaderDependencies(): ReaderSessionDependencies {
  return {
    viewFactory: createReaderPanelViewFactory(),
    optionsRepository: optionsRepository as never,
    storage,
    messaging: {
      send<TResult>(message: Parameters<MessagingService['send']>[0]): Promise<TResult> {
        console.info('[harness:reader:send]', message);
        return Promise.resolve(undefined as TResult);
      }
    },
    readerRepository: {
      getReadingConfig() {
        return Promise.resolve({ exportMode: 'highlights', highlightTheme: 'gradient' });
      },
      sendReadingClip() {
        return Promise.resolve({ success: true });
      },
      onConfigChange() {
        return () => undefined;
      }
    },
    createHighlightManager: (doc) => new ReaderHighlightManager(doc),
    createSelectionController: (options) => new ReaderSelectionController(options),
    createPanelCoordinator: (options) => new ReaderPanelCoordinator(options),
    createEnvironmentController: (deps, handlers) =>
      new ReaderEnvironmentController(deps, handlers),
    createLifecycle: (deps, handlers) => new ReaderSessionLifecycle(deps, handlers),
    exporter: new ReaderSessionExporter({
      buildHighlightsMarkdown: buildReaderHighlightsMarkdown,
      buildFullMarkdown: buildReaderFullMarkdown
    }),
    dispatchClipResult(payload: ReaderMarkdownPayload): Promise<void> {
      console.info('[harness:reader:clip]', payload);
      setStatus('ReaderSession exported once');
      return Promise.resolve();
    }
  };
}

function openClipperDialog(): Promise<void> {
  const dialog = new ClipperDialog({
    storage,
    errorHandler: errorHandler as never,
    runtime: runtime as never,
    clipRepo: clipRepo as never
  });
  void dialog
    .show('Harness selection', { initialComment: 'Harness note', allowVideoMode: true })
    .then((result) => {
      if (result.action === 'clip') {
        setStatus('ClipperDialog confirmed');
        return;
      }
      setStatus(`ClipperDialog ${result.action}`);
    });
  setStatus('ClipperDialog opened');
  return Promise.resolve();
}

async function startReaderSession(): Promise<void> {
  activeReader?.destroy();
  const article = document.getElementById('reader-article');
  const paragraph = article?.querySelector('p');
  if (!paragraph) {
    throw new Error('Reader paragraph missing');
  }
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  activeReader = new ReaderSession(
    document,
    window.location.href,
    {
      requestSelectionAction() {
        return Promise.resolve({ action: 'clip', comment: 'Reader harness comment' });
      }
    },
    buildReaderDependencies()
  );
  await activeReader.initialize({
    range,
    selectedHtml: paragraph.innerHTML,
    selectedText: paragraph.textContent ?? '',
    comment: 'Reader harness comment'
  });
  setStatus('ReaderSession mounted');
}

async function startVideoSession(): Promise<void> {
  (activeVideo as { cleanup?: () => void } | null)?.cleanup?.();
  const video = document.querySelector('video');
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error('Video element missing');
  }
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 42 });
  activeVideo = new VideoSession(document, {
    viewFactory: (
      await import('../content/video/presentation/videoPanelView')
    ).createVideoPanelViewFactory(),
    optionsRepository: optionsRepository as never,
    videoRepository: {
      getVideoConfig() {
        return Promise.resolve(HARNESS_VIDEO_OPTIONS);
      },
      async savePromptPosition() {},
      async saveControlBarPreferences() {},
      getPromptPosition() {
        return Promise.resolve(null);
      },
      sendVideoClip() {
        setStatus('VideoSession exported once');
        return Promise.resolve({ success: true });
      },
      onConfigChange() {
        return () => undefined;
      }
    } as never,
    storage
  } as never);
  await activeVideo.start();
  await activeVideo.addCurrentTimestamp();
  setStatus('VideoSession mounted and one capture added');
}

async function showVideoFloatingPrompt(): Promise<void> {
  activeVideoPromptHost?.remove();
  await panelStyleSheetManager.initialize();
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  panelStyleSheetManager.applyStitchRuntimeStyles(shadow);
  const { container } = createPromptElement({
    id: 'aiob-video-floating-prompt',
    label: HARNESS_VIDEO_PROMPT_LABEL,
    shortcut: 'Alt+V',
    previewTheme: configuredInterfaceTheme,
    messages: {
      videoPromptDismiss: HARNESS_VIDEO_PROMPT_DISMISS
    } as never,
    getIconUrl: () => runtime.getURL('icons/bannerlogo-48.png'),
    onPrimaryAction: () => {
      setStatus('Video floating prompt primary action');
    },
    onDismiss: () => {
      activeVideoPromptHost?.remove();
      activeVideoPromptHost = null;
      setStatus('Video floating prompt dismissed');
    }
  });
  shadow.appendChild(container);
  document.body.appendChild(host);
  activeVideoPromptHost = host;
  setStatus('Video floating prompt mounted');
}

async function showSupportPrompt(): Promise<void> {
  const prompt = new SupportPrompt(document);
  await prompt.show({ status: 'success', vaultName: 'Harness Vault' });
  setStatus('SupportPrompt mounted');
}

document.getElementById('open-clipper')?.addEventListener('click', () => {
  void openClipperDialog().catch((error) => {
    console.error('[harness:clipper]', error);
    setStatus(`Clipper failed: ${String(error)}`);
  });
});
document.getElementById('start-reader')?.addEventListener('click', () => {
  void startReaderSession().catch((error) => {
    console.error('[harness:reader]', error);
    setStatus(`Reader failed: ${String(error)}`);
  });
});
document.getElementById('start-video')?.addEventListener('click', () => {
  void startVideoSession().catch((error) => {
    console.error('[harness:video]', error);
    setStatus(`Video failed: ${String(error)}`);
  });
});
document.getElementById('show-video-floating-prompt')?.addEventListener('click', () => {
  void showVideoFloatingPrompt().catch((error) => {
    console.error('[harness:video-floating-prompt]', error);
    setStatus(`Video floating prompt failed: ${String(error)}`);
  });
});
document.getElementById('show-support-prompt')?.addEventListener('click', () => {
  void showSupportPrompt().catch((error) => {
    console.error('[harness:support]', error);
    setStatus(`Support prompt failed: ${String(error)}`);
  });
});

(
  window as Window & {
    harness?: {
      openClipperDialog: () => Promise<void>;
      startReaderSession: () => Promise<void>;
      startVideoSession: () => Promise<void>;
      showVideoFloatingPrompt: () => Promise<void>;
      showSupportPrompt: () => Promise<void>;
    };
  }
).harness = {
  openClipperDialog,
  startReaderSession,
  startVideoSession,
  showVideoFloatingPrompt,
  showSupportPrompt
};

void runtimeState.refreshFragmentConfig().finally(() => {
  setStatus('Harness ready');
});
