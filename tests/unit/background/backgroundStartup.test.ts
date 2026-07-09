import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundStartupDependencies } from '../../../src/background/backgroundStartup';
import {
  DEFAULT_RESTORE_CAPABILITY_POLICY,
  createExtendedRestoreCapabilityPolicy
} from '../../../src/shared/capabilities/capabilityPolicy';
import { asType } from '../../utils/typeHelpers';

const configureBackgroundDependencyStorageMock = vi.hoisted(() => vi.fn());
const bootstrapBackgroundDependenciesMock = vi.hoisted(() => vi.fn());
const createContextMenuListenerDependenciesMock = vi.hoisted(() => vi.fn((deps) => deps));
const registerContextMenuListenersMock = vi.hoisted(() => vi.fn());
const createRuntimeMessageListenerDependenciesMock = vi.hoisted(() => vi.fn((...args) => args));
const registerRuntimeMessageListenerMock = vi.hoisted(() => vi.fn());
const ensureUsageStatsInitializedMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const resolveRepositoryMock = vi.hoisted(() => vi.fn(() => ({ onChange: vi.fn() })));

vi.mock('../../../src/background/bootstrap', () => ({
  configureBackgroundDependencyStorage: configureBackgroundDependencyStorageMock,
  bootstrapBackgroundDependencies: bootstrapBackgroundDependenciesMock
}));
vi.mock('../../../src/background/listeners/contextMenus', () => ({
  createContextMenuListenerDependencies: createContextMenuListenerDependenciesMock,
  registerContextMenuListeners: registerContextMenuListenersMock
}));
vi.mock('../../../src/background/listeners/runtimeMessages', () => ({
  createRuntimeMessageListenerDependencies: createRuntimeMessageListenerDependenciesMock,
  registerRuntimeMessageListener: registerRuntimeMessageListenerMock
}));
vi.mock('../../../src/background/services/usageStats', () => ({
  ensureUsageStatsInitialized: ensureUsageStatsInitializedMock
}));
vi.mock('../../../src/shared/di', () => ({
  DI_TOKENS: { IOptionsRepository: Symbol('IOptionsRepository') },
  resolveRepository: resolveRepositoryMock
}));

describe('backgroundStartup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('bootstraps background runtime and registers listeners', async () => {
    const { startBackgroundRuntime } = await import('../../../src/background/backgroundStartup');
    const deps: BackgroundStartupDependencies = {
      action: { onClicked: vi.fn() },
      contextMenus: {
        create: vi.fn(),
        update: vi.fn(),
        removeAll: vi.fn(),
        onClicked: vi.fn(),
        onShown: vi.fn()
      },
      messaging: { addListener: vi.fn(), send: vi.fn(), sendToTab: vi.fn() },
      runtime: {
        onInstalled: vi.fn(),
        onStartup: vi.fn(),
        getURL: vi.fn(),
        getBrowserTarget: vi.fn<() => 'chrome'>(() => 'chrome'),
        openOptionsPage: vi.fn()
      },
      scripting: { executeScript: vi.fn() },
      storage: asType<BackgroundStartupDependencies['storage']>({ sync: {}, local: {} }),
      tabs: {
        query: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        sendMessage: vi.fn(),
        onActivated: vi.fn(),
        onUpdated: vi.fn(),
        onRemoved: vi.fn(),
        remove: vi.fn(),
        getCurrent: vi.fn()
      }
    };

    startBackgroundRuntime(deps);

    expect(configureBackgroundDependencyStorageMock).toHaveBeenCalledWith(deps.storage);
    expect(bootstrapBackgroundDependenciesMock).toHaveBeenCalledTimes(1);
    expect(resolveRepositoryMock).toHaveBeenCalledTimes(1);
    expect(createContextMenuListenerDependenciesMock).toHaveBeenCalledWith(
      expect.objectContaining({ optionsRepository: expect.any(Object) })
    );
    expect(registerContextMenuListenersMock).toHaveBeenCalledTimes(1);
    expect(createRuntimeMessageListenerDependenciesMock).toHaveBeenCalledWith(
      deps.messaging,
      deps.tabs,
      deps.runtime,
      deps.storage,
      DEFAULT_RESTORE_CAPABILITY_POLICY.videoScreenshotCache
    );
    expect(registerRuntimeMessageListenerMock).toHaveBeenCalledTimes(1);
    expect(ensureUsageStatsInitializedMock).toHaveBeenCalledTimes(1);
  });

  it('passes the injected restore policy screenshot cache snapshot to runtime messages', async () => {
    const { startBackgroundRuntime } = await import('../../../src/background/backgroundStartup');
    const storagePolicy = createExtendedRestoreCapabilityPolicy({
      videoScreenshotCache: {
        ttlMs: 987_654,
        maxGlobalEntries: 14,
        maxPageEntries: 5,
        maxContentBytes: 384 * 1024
      }
    });
    const deps: BackgroundStartupDependencies = {
      action: { onClicked: vi.fn() },
      contextMenus: {
        create: vi.fn(),
        update: vi.fn(),
        removeAll: vi.fn(),
        onClicked: vi.fn(),
        onShown: vi.fn()
      },
      messaging: { addListener: vi.fn(), send: vi.fn(), sendToTab: vi.fn() },
      runtime: {
        onInstalled: vi.fn(),
        onStartup: vi.fn(),
        getURL: vi.fn(),
        getBrowserTarget: vi.fn<() => 'chrome'>(() => 'chrome'),
        openOptionsPage: vi.fn()
      },
      scripting: { executeScript: vi.fn() },
      storage: asType<BackgroundStartupDependencies['storage']>({ sync: {}, local: {} }),
      tabs: {
        query: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        sendMessage: vi.fn(),
        onActivated: vi.fn(),
        onUpdated: vi.fn(),
        onRemoved: vi.fn(),
        remove: vi.fn(),
        getCurrent: vi.fn()
      }
    };

    startBackgroundRuntime({
      ...deps,
      restoreStoragePolicyProvider: {
        getCurrentPolicy: () => storagePolicy
      }
    });

    expect(createRuntimeMessageListenerDependenciesMock).toHaveBeenCalledWith(
      deps.messaging,
      deps.tabs,
      deps.runtime,
      deps.storage,
      storagePolicy.videoScreenshotCache
    );
  });
});
