import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundStartupDependencies } from '../../../src/background/backgroundStartup';
import { createExtendedRestoreCapabilityPolicy } from '../../../src/shared/capabilities/capabilityPolicy';
import { asType } from '../../utils/typeHelpers';

const configureBackgroundDependencyStorageMock = vi.hoisted(() => vi.fn());
const bootstrapBackgroundDependenciesMock = vi.hoisted(() => vi.fn());
const createContextMenuListenerDependenciesMock = vi.hoisted(() => vi.fn((deps) => deps));
const registerContextMenuListenersMock = vi.hoisted(() => vi.fn());
type CreateRuntimeMessageListenerDependencies =
  typeof import('../../../src/background/listeners/runtimeMessages').createRuntimeMessageListenerDependencies;
const createRuntimeMessageListenerDependenciesMock = vi.hoisted(() =>
  vi.fn<CreateRuntimeMessageListenerDependencies>()
);
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
    const runtimeDependencyArgs = createRuntimeMessageListenerDependenciesMock.mock.calls[0];
    expect(runtimeDependencyArgs?.slice(0, 4)).toEqual([
      deps.messaging,
      deps.tabs,
      deps.runtime,
      deps.storage
    ]);
    const defaultPolicyInput = runtimeDependencyArgs?.[4];
    expect(defaultPolicyInput && 'getCurrentPolicy' in defaultPolicyInput).toBe(true);
    expect(registerRuntimeMessageListenerMock).toHaveBeenCalledTimes(1);
    expect(ensureUsageStatsInitializedMock).toHaveBeenCalledTimes(1);
  });

  it('passes the injected live restore policy source to runtime messages', async () => {
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

    const restoreStoragePolicyProvider = {
      getCurrentPolicy: () => storagePolicy
    };

    startBackgroundRuntime({
      ...deps,
      restoreStoragePolicyProvider
    });

    expect(createRuntimeMessageListenerDependenciesMock).toHaveBeenCalledWith(
      deps.messaging,
      deps.tabs,
      deps.runtime,
      deps.storage,
      restoreStoragePolicyProvider
    );
  });

  it('exposes an exact in-process policy-prune handle without runtime self-messaging', async () => {
    const result = {
      expiredDrafts: 1,
      excessDrafts: 2,
      newlyOrphanedScreenshots: 3
    };
    const handleVideoScreenshotCacheMessage = vi.fn(async () => ({
      success: true as const,
      operation: 'pruneRestoreDataToCurrentPolicy' as const,
      result
    }));
    createRuntimeMessageListenerDependenciesMock.mockReturnValueOnce(
      asType<
        ReturnType<
          typeof import('../../../src/background/listeners/runtimeMessages').createRuntimeMessageListenerDependencies
        >
      >({ handleVideoScreenshotCacheMessage })
    );
    const { startBackgroundRuntime } = await import('../../../src/background/backgroundStartup');
    const deps = createDependencies();

    const runtime = startBackgroundRuntime(deps);

    await expect(
      runtime.pruneRestoreDataToCurrentPolicy('signout-prune:operation-1')
    ).resolves.toEqual(result);
    expect(handleVideoScreenshotCacheMessage).toHaveBeenCalledWith(
      {
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'pruneRestoreDataToCurrentPolicy',
        operationId: 'signout-prune:operation-1'
      },
      null
    );
    expect(deps.messaging.send).not.toHaveBeenCalled();
  });
});

function createDependencies(): BackgroundStartupDependencies {
  return {
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
}
