import { resolveRepository } from '../../shared/di/serviceRegistry';
import { DI_TOKENS } from '../../shared/di/tokens';
import type { IReaderRepository } from '../../shared/repositories/IReaderRepository';
import type { ReaderSessionDependencies } from './sessionTypes';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import type { StorageService } from '../../platform/interfaces/storage';
import type { MessagingService } from '../../platform/interfaces/messaging';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { SupportProgressReporter } from '../runtime/supportProgress';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import { createReaderPanelViewFactory } from './presentation/readerPanelView';
import { ReaderHighlightManager } from './services/highlightManager';
import { ReaderSelectionController } from './services/selectionController';
import { ReaderPanelCoordinator } from './panelCoordinator';
import { ReaderEnvironmentController } from './environmentController';
import { ReaderSessionLifecycle } from './sessionLifecycle';
import { ReaderSessionExporter } from './services/exporter';
import { createSessionDraftClientRepository } from '../sessionDrafts/sessionDraftClientRepository';

export interface ReaderSessionPlatformDependencies {
  // Content composition root now passes the primary repository contract.
  optionsRepository: IOptionsRepository;
  storage: StorageService;
  messaging: Pick<MessagingService, 'send'>;
  runtime: Pick<RuntimeService, 'getURL'>;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

type ReaderSessionDependencyOverrides = Omit<
  ReaderSessionDependencies,
  'optionsRepository' | 'storage' | 'messaging' | 'readerRepository'
>;

export function createReaderSessionDependencies(
  deps: ReaderSessionPlatformDependencies,
  overrides: Partial<ReaderSessionDependencyOverrides> = {}
): ReaderSessionDependencies {
  const readerRepository = resolveRepository<IReaderRepository>(DI_TOKENS.IReaderRepository);
  const sessionDraftStoragePolicy =
    overrides.sessionDraftStoragePolicy ?? deps.sessionDraftStoragePolicy;

  return {
    viewFactory:
      overrides.viewFactory ??
      createReaderPanelViewFactory({
        resolveAssetUrl: (path) => deps.runtime.getURL(path)
      }),
    optionsRepository: deps.optionsRepository,
    storage: deps.storage,
    messaging: deps.messaging,
    sessionDraftRepository: createSessionDraftClientRepository({
      send: (message) => deps.messaging.send(message)
    }),
    ...(sessionDraftStoragePolicy ? { sessionDraftStoragePolicy } : {}),
    ...((overrides.showSupportProgress ?? deps.showSupportProgress)
      ? { showSupportProgress: overrides.showSupportProgress ?? deps.showSupportProgress }
      : {}),
    readerRepository,
    createHighlightManager:
      overrides.createHighlightManager ?? ((doc) => new ReaderHighlightManager(doc)),
    createSelectionController:
      overrides.createSelectionController ?? ((options) => new ReaderSelectionController(options)),
    createPanelCoordinator:
      overrides.createPanelCoordinator ?? ((options) => new ReaderPanelCoordinator(options)),
    createEnvironmentController:
      overrides.createEnvironmentController ??
      ((deps, handlers) => new ReaderEnvironmentController(deps, handlers)),
    createLifecycle:
      overrides.createLifecycle ?? ((deps, handlers) => new ReaderSessionLifecycle(deps, handlers)),
    exporter:
      overrides.exporter ??
      new ReaderSessionExporter({
        loadMarkdownBuilders: () =>
          import('./utils/markdownBuilder').then(
            ({ buildReaderFullMarkdown, buildReaderHighlightsMarkdown }) => ({
              buildHighlightsMarkdown: buildReaderHighlightsMarkdown,
              buildFullMarkdown: buildReaderFullMarkdown
            })
          )
      }),
    dispatchClipResult:
      overrides.dispatchClipResult ??
      ((payload) => deps.messaging.send({ type: 'CLIP_RESULT', payload }).then(() => undefined))
  };
}
