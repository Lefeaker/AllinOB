import { createSelectionController } from '../clipper/services/selectionController';
import { createClipperDialogPromptGateway } from '../clipper/presentation/clipperDialogPrompt';
import { getPlatformServices } from '../../platform';
import { bootstrapContentScript, configureContentBootstrapStorage } from '../bootstrap';
import {
  getVideoSession,
  isReaderSessionActive,
  isVideoSessionActive
} from './contentSessionRegistry';
import { createContentRuntimeState } from './contentRuntimeState';
import { createContentMessageRouter } from './contentMessageRouter';
import { createContentSelectionTracker } from './contentSelectionTracker';
import { createContentRuntime } from './bootstrapRuntime';
import {
  createLazyExtractorRegistry,
  createLazyLocalVaultPermissionPrompt,
  createLazyReaderSessionFactory,
  createLazySupportPrompt,
  createLazyVideoSessionFactory,
  isVideoPromptCandidateUrl,
  initializeVideoPromptOnDemand
} from './contentLazyRuntime';
import { resolveRepository } from '../../shared/di/serviceRegistry';
import { registerRepositories } from '../../shared/di/serviceRegistry';
import { DI_TOKENS } from '../../shared/di/tokens';
import type { IOptionsRepository } from '../../shared/repositories/IOptionsRepository';
import { startRuntimeThemeSync } from '../stitch/runtimeTheme';
import type { SupportProgressUpdate } from './supportProgress';
import { startLazyDraftRestore } from './sessionDraftAutoRestoreBootstrap';
import {
  defaultRestoreCapabilityPolicyProvider,
  type RestoreCapabilityPolicyProvider
} from '../../shared/capabilities/capabilityPolicy';

export interface ContentRuntimeBootstrapOptions {
  restoreStoragePolicyProvider?: RestoreCapabilityPolicyProvider;
}

export function initializeClipperRuntime(options: ContentRuntimeBootstrapOptions = {}): void {
  const restoreStoragePolicyProvider =
    options.restoreStoragePolicyProvider ?? defaultRestoreCapabilityPolicyProvider;
  const getSessionDraftStoragePolicy = () => restoreStoragePolicyProvider.getCurrentPolicy();
  const platform = getPlatformServices();
  const { storage, messaging, tabs, runtime: extensionRuntime } = platform;
  registerRepositories({
    storage,
    messaging,
    tabs,
    runtime: extensionRuntime
  });
  configureContentBootstrapStorage(storage);
  bootstrapContentScript();
  const primaryOptionsRepository = resolveRepository<IOptionsRepository>(
    DI_TOKENS.IOptionsRepository
  );
  const runtimeState = createContentRuntimeState({
    optionsRepository: primaryOptionsRepository,
    window
  });
  const stopRuntimeThemeSync = startRuntimeThemeSync(primaryOptionsRepository, window);
  const clipPromptGateway = createClipperDialogPromptGateway();
  const supportPrompt = createLazySupportPrompt(document);
  const localVaultPermissionPrompt = createLazyLocalVaultPermissionPrompt({
    document,
    window,
    runtime: extensionRuntime
  });
  const showSupportProgress = (progress: SupportProgressUpdate): void => {
    const variant = progress.variant ?? 'progress';
    const status = variant === 'progress' ? 'progress' : variant;
    void supportPrompt.show({
      status,
      progress: {
        ...progress,
        variant
      }
    });
  };
  const createReaderSession = createLazyReaderSessionFactory({
    document,
    optionsRepository: primaryOptionsRepository,
    storage,
    messaging,
    runtime: extensionRuntime,
    promptGateway: clipPromptGateway,
    getSessionDraftStoragePolicy,
    showSupportProgress
  });
  const createVideoSession = createLazyVideoSessionFactory({
    document,
    optionsRepository: primaryOptionsRepository,
    storage,
    messaging,
    runtime: extensionRuntime,
    getSessionDraftStoragePolicy,
    showSupportProgress
  });
  const selectionController = createSelectionController({
    prompt: clipPromptGateway,
    optionsRepository: primaryOptionsRepository,
    createReaderSession,
    createVideoSession
  });
  const extractorRegistry = createLazyExtractorRegistry(primaryOptionsRepository);
  const selectionTracker = createContentSelectionTracker({
    document,
    window,
    enablePlatformShadowSelection: /(^|\.)bilibili\.com$/i.test(window.location.hostname),
    getLastSelectionSnapshot: () => runtimeState.getLastSelectionSnapshot(),
    setLastSelectionSnapshot: (snapshot) => {
      runtimeState.setLastSelectionSnapshot(snapshot);
    }
  });
  void runtimeState.refreshFragmentConfig();
  void initializeVideoPromptOnDemand(
    {
      optionsRepository: primaryOptionsRepository,
      storage,
      messaging,
      runtime: extensionRuntime,
      getSessionDraftStoragePolicy,
      showSupportProgress
    },
    window.location.href
  );

  const runtime = createContentRuntime({
    document,
    window,
    messaging,
    runtimeState,
    selectionTracker,
    selectionController,
    extractorRegistry,
    showSupportProgress,
    createRouter: (runClip) =>
      createContentMessageRouter({
        document,
        window,
        messaging,
        supportPrompt,
        localVaultPermissionPrompt,
        setClipMode: (mode) => runtimeState.setClipMode(mode),
        runClip,
        selectionController,
        createVideoSession: () => createVideoSession(document),
        isVideoSessionActive: () => isVideoSessionActive(document),
        getVideoSession: () => getVideoSession<ReturnType<typeof createVideoSession>>(document),
        resolveActiveSelection: () => selectionTracker.resolveActiveSelection(),
        restoreSelectionFromSnapshot: (snapshot) =>
          selectionTracker.restoreSelectionFromSnapshot(snapshot),
        getLastSelectionSnapshot: () => runtimeState.getLastSelectionSnapshot(),
        clearLastSelectionSnapshot: () => runtimeState.setLastSelectionSnapshot(null)
      })
  });
  runtime.start();
  const stopDraftRestore = startLazyDraftRestore(
    () => import('./sessionDraftAutoRestore'),
    {
      document,
      window,
      storage,
      getSessionDraftStoragePolicy,
      currentUrl: () => window.location.href,
      createReaderSession: () => createReaderSession(document, window.location.href),
      createVideoSession: () => createVideoSession(document),
      isReaderSessionActive: () => isReaderSessionActive(document),
      isVideoSessionActive: () => isVideoSessionActive(document),
      isVideoCandidateUrl: isVideoPromptCandidateUrl
    },
    (error) => {
      console.warn('[content] Failed to start session draft auto-restore:', error);
    }
  );
  window.addEventListener(
    'pagehide',
    () => {
      stopDraftRestore();
      stopRuntimeThemeSync();
      runtime.stop();
    },
    { passive: true }
  );
}
