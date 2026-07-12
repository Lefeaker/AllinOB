import type { ReaderSessionViewFactory } from './application/readerSessionView';
import type { ReaderHighlightManager } from './services/highlightManager';
import type {
  ReaderSelectionController,
  ReaderSelectionControllerOptions
} from './services/selectionController';
import type { ReaderPanelCoordinator, ReaderPanelCoordinatorOptions } from './panelCoordinator';
import type {
  ReaderEnvironmentController,
  ReaderEnvironmentDependencies,
  ReaderEnvironmentHandlers
} from './environmentController';
import type {
  ReaderSessionLifecycle,
  ReaderSessionLifecycleDependencies,
  ReaderSessionLifecycleHandlers
} from './sessionLifecycle';
import type { ReaderSessionExporter } from './services/exporter';
import type { StorageService } from '../../platform/interfaces/storage';
import type { MessagingService } from '../../platform/interfaces/messaging';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import type { IReaderRepository } from '../../shared/repositories/IReaderRepository';
import type { ReadingSessionOptions } from '../../shared/types/options';
import type { ReaderMarkdownPayload } from './utils/markdownBuilder';
import type { SupportProgressReporter } from '../runtime/supportProgress';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import type { SessionDraftRepository } from '../sessionDrafts';

export interface ReaderSessionDependencies {
  viewFactory: ReaderSessionViewFactory;
  optionsRepository: IOptionsRepository;
  storage: StorageService;
  messaging: Pick<MessagingService, 'send'>;
  sessionDraftRepository: SessionDraftRepository;
  readerRepository: IReaderRepository;
  optionsPageUrl?: string;
  createHighlightManager: (doc: Document) => ReaderHighlightManager;
  createSelectionController: (
    options: ReaderSelectionControllerOptions
  ) => ReaderSelectionController;
  createPanelCoordinator: (options: ReaderPanelCoordinatorOptions) => ReaderPanelCoordinator;
  createEnvironmentController: (
    deps: ReaderEnvironmentDependencies,
    handlers: ReaderEnvironmentHandlers
  ) => ReaderEnvironmentController;
  createLifecycle: (
    deps: ReaderSessionLifecycleDependencies,
    handlers: ReaderSessionLifecycleHandlers
  ) => ReaderSessionLifecycle;
  exporter: ReaderSessionExporter;
  dispatchClipResult: (payload: ReaderMarkdownPayload) => Promise<void>;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

export const DEFAULT_READING_CONFIG: ReadingSessionOptions = {
  exportMode: 'highlights',
  highlightTheme: 'gradient'
};
