import type { MessagingService } from '../../platform/interfaces/messaging';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { StorageService } from '../../platform/interfaces/storage';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import type { ClipPromptGateway } from '../clipper/application/clipPromptGateway';
import type { ReaderSessionAdapter } from '../clipper/services/selectionController';
import type { SupportProgressReporter } from '../runtime/supportProgress';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import { ReaderSession } from './session';
import { createReaderSessionDependencies } from './sessionDependencies';

export interface ReaderLazyRuntimeDependencies {
  optionsRepository: IOptionsRepository;
  storage: StorageService;
  messaging: Pick<MessagingService, 'send'>;
  runtime: Pick<RuntimeService, 'getURL'>;
  promptGateway: ClipPromptGateway;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  getSessionDraftStoragePolicy?: () => SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

export function createReaderSessionAdapter(
  doc: Document,
  url: string,
  dependencies: ReaderLazyRuntimeDependencies
): ReaderSessionAdapter {
  let sessionPromise: Promise<ReaderSessionAdapter> | null = null;

  const getSession = async (): Promise<ReaderSessionAdapter> => {
    if (!sessionPromise) {
      sessionPromise = Promise.resolve().then(() => {
        const sessionDraftStoragePolicy =
          dependencies.getSessionDraftStoragePolicy?.() ?? dependencies.sessionDraftStoragePolicy;
        const readerDependencies = createReaderSessionDependencies({
          optionsRepository: dependencies.optionsRepository,
          storage: dependencies.storage,
          messaging: dependencies.messaging,
          runtime: dependencies.runtime,
          ...(sessionDraftStoragePolicy ? { sessionDraftStoragePolicy } : {}),
          ...(dependencies.showSupportProgress
            ? { showSupportProgress: dependencies.showSupportProgress }
            : {})
        });
        return new ReaderSession(doc, url, dependencies.promptGateway, readerDependencies);
      });
    }
    return sessionPromise;
  };

  return {
    async start(initialHighlight) {
      const session = await getSession();
      await session.start(initialHighlight);
    },
    ingestExternalHighlight(range, selectedHtml, selectedText, comment) {
      void getSession().then((session) => {
        session.ingestExternalHighlight(range, selectedHtml, selectedText, comment);
      });
    }
  };
}
