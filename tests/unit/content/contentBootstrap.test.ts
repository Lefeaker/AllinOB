/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestoreCapabilityPolicy } from '../../../src/shared/capabilities/capabilityPolicy';
import {
  DEFAULT_RESTORE_CAPABILITY_POLICY,
  createExtendedRestoreCapabilityPolicy
} from '../../../src/shared/capabilities/capabilityPolicy';

const storageMock = vi.hoisted(() => ({ local: {}, sync: {} }));
const messagingMock = vi.hoisted(() => ({ send: vi.fn(), addListener: vi.fn() }));
const tabsMock = vi.hoisted(() => ({ sendMessage: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({
  getURL: vi.fn((path: string) => `chrome-extension://${path}`),
  getBrowserTarget: vi.fn<() => 'chrome'>(() => 'chrome')
}));
const platformMock = vi.hoisted(() => ({
  storage: storageMock,
  messaging: messagingMock,
  tabs: tabsMock,
  runtime: runtimeMock
}));
const getPlatformServicesMock = vi.hoisted(() => vi.fn(() => platformMock));
const markContentRuntimeInitializedMock = vi.hoisted(() => vi.fn(() => false));
const isReaderSessionActiveMock = vi.hoisted(() => vi.fn(() => false));
const isVideoSessionActiveMock = vi.hoisted(() => vi.fn(() => false));
const getVideoSessionMock = vi.hoisted(() => vi.fn());
const configureContentBootstrapStorageMock = vi.hoisted(() => vi.fn());
const bootstrapContentScriptMock = vi.hoisted(() => vi.fn());
const registerRepositoriesMock = vi.hoisted(() => vi.fn());
const optionsRepositoryMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), onChange: vi.fn() }));
const resolveRepositoryMock = vi.hoisted(() => vi.fn(() => optionsRepositoryMock));
const createContentRuntimeStateMock = vi.hoisted(() =>
  vi.fn(() => ({
    getLastSelectionSnapshot: vi.fn(() => null),
    setLastSelectionSnapshot: vi.fn(),
    setClipMode: vi.fn(),
    refreshFragmentConfig: vi.fn(() => Promise.resolve(undefined))
  }))
);
const stopRuntimeThemeSyncMock = vi.hoisted(() => vi.fn());
const startRuntimeThemeSyncMock = vi.hoisted(() => vi.fn(() => stopRuntimeThemeSyncMock));
const clipPromptGatewayMock = vi.hoisted(() => ({ show: vi.fn() }));
const createClipperDialogPromptGatewayMock = vi.hoisted(() => vi.fn(() => clipPromptGatewayMock));
const supportPromptMock = vi.hoisted(() => ({ show: vi.fn() }));
const createLazySupportPromptMock = vi.hoisted(() => vi.fn(() => supportPromptMock));
const localVaultPermissionPromptMock = vi.hoisted(() => ({ request: vi.fn() }));
const createLazyLocalVaultPermissionPromptMock = vi.hoisted(() =>
  vi.fn(() => localVaultPermissionPromptMock)
);
const readerAdapterFactoryMock = vi.hoisted(() => vi.fn());
const videoAdapterFactoryMock = vi.hoisted(() => vi.fn());
const createLazyReaderSessionFactoryMock = vi.hoisted(() => vi.fn(() => readerAdapterFactoryMock));
const createLazyVideoSessionFactoryMock = vi.hoisted(() => vi.fn(() => videoAdapterFactoryMock));
const initializeVideoPromptOnDemandMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const createLazyExtractorRegistryMock = vi.hoisted(() =>
  vi.fn(() => ({ register: vi.fn(), extract: vi.fn(), list: vi.fn() }))
);
const isVideoPromptCandidateUrlMock = vi.hoisted(() => vi.fn(() => true));
const selectionControllerMock = vi.hoisted(() => ({ run: vi.fn() }));
const createSelectionControllerMock = vi.hoisted(() => vi.fn(() => selectionControllerMock));
const createContentSelectionTrackerMock = vi.hoisted(() =>
  vi.fn(() => ({
    resolveActiveSelection: vi.fn(),
    restoreSelectionFromSnapshot: vi.fn()
  }))
);
const runtimeStartMock = vi.hoisted(() => vi.fn());
const runtimeStopMock = vi.hoisted(() => vi.fn());
const createContentRuntimeMock = vi.hoisted(() =>
  vi.fn(() => ({ start: runtimeStartMock, stop: runtimeStopMock }))
);
const createContentMessageRouterMock = vi.hoisted(() => vi.fn(() => ({ route: vi.fn() })));
const startLazyDraftRestoreMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock('../../../src/platform', () => ({
  getPlatformServices: getPlatformServicesMock
}));
vi.mock('../../../src/content/runtime/contentSessionRegistry', () => ({
  markContentRuntimeInitialized: markContentRuntimeInitializedMock,
  isReaderSessionActive: isReaderSessionActiveMock,
  isVideoSessionActive: isVideoSessionActiveMock,
  getVideoSession: getVideoSessionMock
}));
vi.mock('../../../src/content/bootstrap', () => ({
  configureContentBootstrapStorage: configureContentBootstrapStorageMock,
  bootstrapContentScript: bootstrapContentScriptMock
}));
vi.mock('../../../src/shared/di/serviceRegistry', () => ({
  registerRepositories: registerRepositoriesMock,
  resolveRepository: resolveRepositoryMock
}));
vi.mock('../../../src/shared/di/tokens', () => ({
  DI_TOKENS: { IOptionsRepository: Symbol('IOptionsRepository') }
}));
vi.mock('../../../src/content/runtime/contentRuntimeState', () => ({
  createContentRuntimeState: createContentRuntimeStateMock
}));
vi.mock('../../../src/content/stitch/runtimeTheme', () => ({
  startRuntimeThemeSync: startRuntimeThemeSyncMock
}));
vi.mock('../../../src/content/clipper/presentation/clipperDialogPrompt', () => ({
  createClipperDialogPromptGateway: createClipperDialogPromptGatewayMock
}));
vi.mock('../../../src/content/runtime/contentLazyRuntime', () => ({
  createLazySupportPrompt: createLazySupportPromptMock,
  createLazyLocalVaultPermissionPrompt: createLazyLocalVaultPermissionPromptMock,
  createLazyReaderSessionFactory: createLazyReaderSessionFactoryMock,
  createLazyVideoSessionFactory: createLazyVideoSessionFactoryMock,
  initializeVideoPromptOnDemand: initializeVideoPromptOnDemandMock,
  createLazyExtractorRegistry: createLazyExtractorRegistryMock,
  isVideoPromptCandidateUrl: isVideoPromptCandidateUrlMock
}));
vi.mock('../../../src/content/clipper/services/selectionController', () => ({
  createSelectionController: createSelectionControllerMock
}));
vi.mock('../../../src/content/runtime/contentSelectionTracker', () => ({
  createContentSelectionTracker: createContentSelectionTrackerMock
}));
vi.mock('../../../src/content/runtime/bootstrapRuntime', () => ({
  createContentRuntime: createContentRuntimeMock
}));
vi.mock('../../../src/content/runtime/contentMessageRouter', () => ({
  createContentMessageRouter: createContentMessageRouterMock
}));
vi.mock('../../../src/content/runtime/sessionDraftAutoRestoreBootstrap', () => ({
  startLazyDraftRestore: startLazyDraftRestoreMock
}));

describe('content bootstrap provider composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    markContentRuntimeInitializedMock.mockReturnValue(false);
    document.body.innerHTML = '<main>content</main>';
  });

  it('threads an injected restore policy snapshot into reader, video, prompt, and auto-restore dependencies', async () => {
    const restorePolicy = createExtendedRestoreCapabilityPolicy({
      retentionPolicy: {
        retentionMs: 96 * 60 * 60 * 1000,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      videoScreenshotCache: {
        ttlMs: 96 * 60 * 60 * 1000,
        maxGlobalEntries: 12,
        maxPageEntries: 6,
        maxContentBytes: 512 * 1024
      }
    });
    const restoreStoragePolicyProvider = {
      getCurrentPolicy: vi.fn<() => RestoreCapabilityPolicy>(() => restorePolicy)
    };

    const { initializeClipperRuntime } =
      await import('../../../src/content/runtime/contentRuntimeBootstrap');
    initializeClipperRuntime({ restoreStoragePolicyProvider });

    expect(restoreStoragePolicyProvider.getCurrentPolicy).toHaveBeenCalledTimes(1);
    expect(createLazyReaderSessionFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDraftStoragePolicy: restorePolicy })
    );
    expect(createLazyVideoSessionFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDraftStoragePolicy: restorePolicy })
    );
    expect(initializeVideoPromptOnDemandMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionDraftStoragePolicy: restorePolicy }),
      window.location.href
    );
    expect(startLazyDraftRestoreMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ sessionDraftStoragePolicy: restorePolicy }),
      expect.any(Function)
    );
  });

  it('imports the reusable bootstrap module without starting the public runtime', async () => {
    await import('../../../src/content/runtime/contentRuntimeBootstrap');

    expect(getPlatformServicesMock).not.toHaveBeenCalled();
    expect(configureContentBootstrapStorageMock).not.toHaveBeenCalled();
    expect(bootstrapContentScriptMock).not.toHaveBeenCalled();
    expect(createLazyReaderSessionFactoryMock).not.toHaveBeenCalled();
    expect(createLazyVideoSessionFactoryMock).not.toHaveBeenCalled();
    expect(startLazyDraftRestoreMock).not.toHaveBeenCalled();
  });

  it('keeps the public content entrypoint auto-starting with the default policy', async () => {
    markContentRuntimeInitializedMock.mockReturnValue(true);

    await import('../../../src/content/index');

    expect(createLazyReaderSessionFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDraftStoragePolicy: DEFAULT_RESTORE_CAPABILITY_POLICY
      })
    );
    expect(createLazyVideoSessionFactoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDraftStoragePolicy: DEFAULT_RESTORE_CAPABILITY_POLICY
      })
    );
    expect(startLazyDraftRestoreMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        sessionDraftStoragePolicy: DEFAULT_RESTORE_CAPABILITY_POLICY
      }),
      expect.any(Function)
    );
  });
});
