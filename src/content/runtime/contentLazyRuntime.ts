import type { MessagingService } from '../../platform/interfaces/messaging';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { StorageService } from '../../platform/interfaces/storage';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import type {
  LocalVaultPermissionPromptMessage,
  LocalVaultPermissionPromptResponse
} from '../../shared/types';
import type { ExtractorRegistryApi } from '../extractors/registry';
import type { ClipPromptGateway } from '../clipper/application/clipPromptGateway';
import type {
  ReaderSessionAdapter,
  VideoSessionAdapter
} from '../clipper/services/selectionController';
import type { SupportProgressReporter } from './supportProgress';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';

interface SupportPromptLike {
  show(options?: unknown): Promise<void> | void;
}

interface LocalVaultPermissionPromptLike {
  request(message: LocalVaultPermissionPromptMessage): Promise<LocalVaultPermissionPromptResponse>;
}

interface LazyRuntimeDependencies {
  document: Document;
  optionsRepository: IOptionsRepository;
  storage: StorageService;
  messaging: Pick<MessagingService, 'send'>;
  runtime: RuntimeService;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  getSessionDraftStoragePolicy?: () => SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

type VideoPromptOnDemandDependencies = Pick<
  LazyRuntimeDependencies,
  | 'optionsRepository'
  | 'storage'
  | 'runtime'
  | 'sessionDraftStoragePolicy'
  | 'getSessionDraftStoragePolicy'
  | 'showSupportProgress'
> &
  Partial<Pick<LazyRuntimeDependencies, 'messaging'>>;

type VideoPromptRuntimeModule = typeof import('../video/videoLazyRuntime');
type LoadVideoPromptRuntime = () => Promise<
  Pick<VideoPromptRuntimeModule, 'initializeVideoPromptRuntime'>
>;
type LocalVaultPermissionPromptModule = typeof import('./localVaultPermissionPrompt');
type LoadLocalVaultPermissionPrompt = () => Promise<
  Pick<LocalVaultPermissionPromptModule, 'createLocalVaultPermissionPrompt'>
>;

const VIDEO_PROMPT_HOST_PATTERNS = [
  /(^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)bilibili\.com$/i
] as const;

export function isVideoPromptCandidateUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (!VIDEO_PROMPT_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
      return false;
    }
    if (url.hostname === 'youtu.be') {
      return url.pathname.length > 1;
    }
    if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
      return url.pathname === '/watch' || url.pathname.startsWith('/shorts/');
    }
    if (/(^|\.)bilibili\.com$/i.test(url.hostname)) {
      return url.pathname.startsWith('/video/') || url.pathname.startsWith('/bangumi/play/');
    }
    return false;
  } catch {
    return false;
  }
}

export function createVideoPromptOnDemandInitializer(loadRuntime: LoadVideoPromptRuntime) {
  return async (dependencies: VideoPromptOnDemandDependencies, href: string): Promise<void> => {
    if (!isVideoPromptCandidateUrl(href)) {
      return;
    }
    const { initializeVideoPromptRuntime } = await loadRuntime();
    await initializeVideoPromptRuntime(dependencies, href);
  };
}

export function createLazySupportPrompt(document: Document): SupportPromptLike {
  let promptPromise: Promise<SupportPromptLike> | null = null;

  const loadPrompt = async (): Promise<SupportPromptLike> => {
    if (!promptPromise) {
      promptPromise = import('../ui/supportPrompt').then(({ SupportPrompt }) => {
        return new SupportPrompt(document);
      });
    }
    return promptPromise;
  };

  return {
    async show(options?: unknown): Promise<void> {
      const prompt = await loadPrompt();
      await prompt.show(options as never);
    }
  };
}

export function createLazyLocalVaultPermissionPrompt(
  dependencies: Pick<LazyRuntimeDependencies, 'document' | 'runtime'> & { window: Window },
  loadPrompt: LoadLocalVaultPermissionPrompt = () => import('./localVaultPermissionPrompt')
): LocalVaultPermissionPromptLike {
  let promptPromise: Promise<LocalVaultPermissionPromptLike> | null = null;

  return {
    request(
      message: LocalVaultPermissionPromptMessage
    ): Promise<LocalVaultPermissionPromptResponse> {
      promptPromise ??= loadPrompt().then(({ createLocalVaultPermissionPrompt }) =>
        createLocalVaultPermissionPrompt(dependencies)
      );
      return promptPromise.then((prompt) => prompt.request(message));
    }
  };
}

export function createLazyReaderSessionFactory(
  dependencies: LazyRuntimeDependencies & {
    promptGateway: ClipPromptGateway;
  }
): (doc: Document, url: string) => ReaderSessionAdapter {
  let readerModulePromise: Promise<typeof import('../reader/readerLazyRuntime')> | null = null;

  const loadModule = async () => {
    if (!readerModulePromise) {
      readerModulePromise = import('../reader/readerLazyRuntime');
    }
    return readerModulePromise;
  };

  return (doc: Document, url: string): ReaderSessionAdapter => {
    let adapterPromise: Promise<ReaderSessionAdapter> | null = null;

    const getAdapter = async (): Promise<ReaderSessionAdapter> => {
      if (!adapterPromise) {
        adapterPromise = loadModule().then(({ createReaderSessionAdapter }) =>
          createReaderSessionAdapter(doc, url, {
            optionsRepository: dependencies.optionsRepository,
            storage: dependencies.storage,
            messaging: dependencies.messaging as MessagingService,
            runtime: dependencies.runtime,
            promptGateway: dependencies.promptGateway,
            ...(dependencies.sessionDraftStoragePolicy
              ? { sessionDraftStoragePolicy: dependencies.sessionDraftStoragePolicy }
              : {}),
            ...(dependencies.getSessionDraftStoragePolicy
              ? { getSessionDraftStoragePolicy: dependencies.getSessionDraftStoragePolicy }
              : {}),
            ...(dependencies.showSupportProgress
              ? { showSupportProgress: dependencies.showSupportProgress }
              : {})
          })
        );
      }
      return adapterPromise;
    };

    return {
      async start(initialHighlight) {
        const adapter = await getAdapter();
        await adapter.start(initialHighlight);
      },
      ingestExternalHighlight(range, selectedHtml, selectedText, comment) {
        void getAdapter().then((adapter) => {
          adapter.ingestExternalHighlight(range, selectedHtml, selectedText, comment);
        });
      }
    };
  };
}

export function createLazyVideoSessionFactory(
  dependencies: LazyRuntimeDependencies
): (doc: Document) => VideoSessionAdapter {
  let videoModulePromise: Promise<typeof import('../video/videoLazyRuntime')> | null = null;

  const loadModule = async () => {
    if (!videoModulePromise) {
      videoModulePromise = import('../video/videoLazyRuntime');
    }
    return videoModulePromise;
  };

  return (doc: Document): VideoSessionAdapter => {
    let adapterPromise: Promise<VideoSessionAdapter> | null = null;

    const getAdapter = async (): Promise<VideoSessionAdapter> => {
      if (!adapterPromise) {
        adapterPromise = loadModule().then(({ createVideoSessionAdapter }) =>
          createVideoSessionAdapter(doc, {
            optionsRepository: dependencies.optionsRepository,
            storage: dependencies.storage,
            runtime: dependencies.runtime,
            messaging: dependencies.messaging,
            ...(dependencies.sessionDraftStoragePolicy
              ? { sessionDraftStoragePolicy: dependencies.sessionDraftStoragePolicy }
              : {}),
            ...(dependencies.getSessionDraftStoragePolicy
              ? { getSessionDraftStoragePolicy: dependencies.getSessionDraftStoragePolicy }
              : {}),
            ...(dependencies.showSupportProgress
              ? { showSupportProgress: dependencies.showSupportProgress }
              : {})
          })
        );
      }
      return adapterPromise;
    };

    return {
      async start() {
        const adapter = await getAdapter();
        await adapter.start();
      },
      ingestTextCapture(selectedHtml, selectedText, comment, selectionRange) {
        void getAdapter().then((adapter) => {
          adapter.ingestTextCapture(selectedHtml, selectedText, comment, selectionRange);
        });
      }
    };
  };
}

export const initializeVideoPromptOnDemand = createVideoPromptOnDemandInitializer(
  () => import('../video/videoLazyRuntime')
);

export function createLazyExtractorRegistry(
  optionsRepository: IOptionsRepository
): ExtractorRegistryApi {
  let registryPromise: Promise<ExtractorRegistryApi> | null = null;

  const loadRegistry = async (): Promise<ExtractorRegistryApi> => {
    if (!registryPromise) {
      registryPromise = import('../extractors/registry').then(
        ({ createDefaultExtractorRegistry }) =>
          createDefaultExtractorRegistry({ optionsRepository })
      );
    }
    return registryPromise;
  };

  return {
    register(source) {
      void loadRegistry().then((registry) => registry.register(source));
    },
    extract(context) {
      return loadRegistry().then((registry) => registry.extract(context));
    },
    list() {
      return loadRegistry().then((registry) => registry.list());
    }
  };
}
