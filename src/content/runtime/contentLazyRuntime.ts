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
import { selectLazySessionPolicyDependencies } from './contentLazySessionPolicy';

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

function createLazyValue<T>(load: () => Promise<T>): () => Promise<T> {
  let valuePromise: Promise<T> | null = null;
  return () => (valuePromise ??= load());
}

export function isVideoPromptCandidateUrl(href: string): boolean {
  try {
    const url = new URL(href);
    const { hostname, pathname } = url;
    if (hostname === 'youtu.be') {
      return pathname.length > 1;
    }
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      return pathname === '/watch' || pathname.startsWith('/shorts/');
    }
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
      return pathname.startsWith('/video/') || pathname.startsWith('/bangumi/play/');
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
    await (await loadRuntime()).initializeVideoPromptRuntime(dependencies, href);
  };
}

export function createLazySupportPrompt(document: Document): SupportPromptLike {
  const loadPrompt = createLazyValue<SupportPromptLike>(() =>
    import('../ui/supportPrompt').then(({ SupportPrompt }) => new SupportPrompt(document))
  );

  return {
    async show(options?: unknown): Promise<void> {
      await (await loadPrompt()).show(options as never);
    }
  };
}

export function createLazyLocalVaultPermissionPrompt(
  dependencies: Pick<LazyRuntimeDependencies, 'document' | 'runtime'> & { window: Window },
  loadPrompt: LoadLocalVaultPermissionPrompt = () => import('./localVaultPermissionPrompt')
): LocalVaultPermissionPromptLike {
  const getPrompt = createLazyValue<LocalVaultPermissionPromptLike>(() =>
    loadPrompt().then(({ createLocalVaultPermissionPrompt }) =>
      createLocalVaultPermissionPrompt(dependencies)
    )
  );

  return {
    request(
      message: LocalVaultPermissionPromptMessage
    ): Promise<LocalVaultPermissionPromptResponse> {
      return getPrompt().then((prompt) => prompt.request(message));
    }
  };
}

export function createLazyReaderSessionFactory(
  dependencies: LazyRuntimeDependencies & {
    promptGateway: ClipPromptGateway;
  }
): (doc: Document, url: string) => ReaderSessionAdapter {
  const loadModule = createLazyValue(() => import('../reader/readerLazyRuntime'));

  return (doc: Document, url: string): ReaderSessionAdapter => {
    const getAdapter = createLazyValue<ReaderSessionAdapter>(() =>
      loadModule().then(({ createReaderSessionAdapter }) =>
        createReaderSessionAdapter(doc, url, {
          optionsRepository: dependencies.optionsRepository,
          storage: dependencies.storage,
          messaging: dependencies.messaging as MessagingService,
          runtime: dependencies.runtime,
          promptGateway: dependencies.promptGateway,
          ...selectLazySessionPolicyDependencies(dependencies)
        })
      )
    );

    return {
      async start(initialHighlight) {
        await (await getAdapter()).start(initialHighlight);
      },
      ingestExternalHighlight(range, selectedHtml, selectedText, comment) {
        void getAdapter().then((adapter) =>
          adapter.ingestExternalHighlight(range, selectedHtml, selectedText, comment)
        );
      }
    };
  };
}

export function createLazyVideoSessionFactory(
  dependencies: LazyRuntimeDependencies
): (doc: Document) => VideoSessionAdapter {
  const loadModule = createLazyValue(() => import('../video/videoLazyRuntime'));

  return (doc: Document): VideoSessionAdapter => {
    const getAdapter = createLazyValue<VideoSessionAdapter>(() =>
      loadModule().then(({ createVideoSessionAdapter }) =>
        createVideoSessionAdapter(doc, {
          optionsRepository: dependencies.optionsRepository,
          storage: dependencies.storage,
          runtime: dependencies.runtime,
          messaging: dependencies.messaging,
          ...selectLazySessionPolicyDependencies(dependencies)
        })
      )
    );

    return {
      async start() {
        await (await getAdapter()).start();
      },
      ingestTextCapture(selectedHtml, selectedText, comment, selectionRange) {
        void getAdapter().then((adapter) =>
          adapter.ingestTextCapture(selectedHtml, selectedText, comment, selectionRange)
        );
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
  const loadRegistry = createLazyValue<ExtractorRegistryApi>(() =>
    import('../extractors/registry').then(({ createDefaultExtractorRegistry }) =>
      createDefaultExtractorRegistry({ optionsRepository })
    )
  );

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
