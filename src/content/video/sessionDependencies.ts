import { resolveRepository } from '../../shared/di/serviceRegistry';
import { DI_TOKENS } from '../../shared/di/tokens';
import type { VideoSessionDependencies } from './sessionTypes';
import { createVideoPanelViewFactory } from './presentation/videoPanelView';
import type { IVideoRepository } from '../../shared/repositories/IVideoRepository';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import type { MessagingService } from '../../platform/interfaces/messaging';
import type { StorageService } from '../../platform/interfaces/storage';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { SupportProgressReporter } from '../runtime/supportProgress';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import {
  createVisibleTabVideoFrameScreenshotCapture,
  createVisibleTabVideoFrameScreenshotDataUrlCapture
} from './videoVisibleTabScreenshot';
import { createVideoScreenshotCacheClientRepository } from './videoScreenshotCacheClientRepository';
import { captureVideoFrameScreenshotDataUrl } from './videoFrameScreenshot';
import { isFirefox } from '../../shared/utils/browserDetection';
import { createSessionDraftClientRepository } from '../sessionDrafts/sessionDraftClientRepository';
import type { VersionedSessionDraftRepository } from '../sessionDrafts/sessionDraftClientRepository';

export interface VideoSessionPlatformDependencies {
  // Content composition root now passes the primary repository contract.
  optionsRepository: IOptionsRepository;
  videoRepository?: IVideoRepository;
  storage: StorageService;
  runtime?: Pick<RuntimeService, 'getURL'>;
  messaging?: Pick<MessagingService, 'send'>;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  showSupportProgress?: SupportProgressReporter;
}

export function createVideoSessionDependencies(
  deps: VideoSessionPlatformDependencies
): VideoSessionDependencies {
  const runtime = deps.runtime;
  const firefox = isFirefox();
  const sessionDraftRepository = deps.messaging
    ? createSessionDraftClientRepository({
        send: (message) => deps.messaging?.send(message) ?? Promise.resolve(undefined)
      })
    : createUnavailableSessionDraftRepository();
  return {
    viewFactory: createVideoPanelViewFactory(
      runtime
        ? {
            resolveAssetUrl: (path) => runtime.getURL(path)
          }
        : {}
    ),
    optionsRepository: deps.optionsRepository,
    videoRepository:
      deps.videoRepository ?? resolveRepository<IVideoRepository>(DI_TOKENS.IVideoRepository),
    storage: deps.storage,
    sessionDraftRepository,
    ...(firefox ? { captureVideoFrameScreenshot: captureVideoFrameScreenshotDataUrl } : {}),
    ...(deps.messaging
      ? {
          captureVisibleVideoFrameScreenshot: (firefox
            ? createVisibleTabVideoFrameScreenshotDataUrlCapture
            : createVisibleTabVideoFrameScreenshotCapture)({
            messaging: deps.messaging
          }),
          screenshotCacheRepository: createVideoScreenshotCacheClientRepository({
            messaging: deps.messaging
          })
        }
      : {}),
    ...(deps.sessionDraftStoragePolicy
      ? { sessionDraftStoragePolicy: deps.sessionDraftStoragePolicy }
      : {}),
    ...(deps.showSupportProgress ? { showSupportProgress: deps.showSupportProgress } : {})
  };
}

function createUnavailableSessionDraftRepository(): VersionedSessionDraftRepository {
  const unavailable = () => Promise.reject(new Error('SESSION_DRAFT_MESSAGING_UNAVAILABLE'));
  return {
    loadLatest: unavailable,
    save: unavailable,
    remove: unavailable,
    listCandidates: unavailable,
    pruneExpired: unavailable,
    claim: unavailable,
    runWriteOperation: unavailable
  };
}
