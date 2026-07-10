import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../../../src/platform/interfaces/storage';
import type { OptionsRuntimePlatformServices } from '../../../src/options/runtimeEntry';
import { createOptionsOverlayRuntimeState } from '../../../src/options/app/optionsOverlayRuntimeState';
import { asType } from '../../utils/typeHelpers';

const bootstrapOptionsAppMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const configureOptionsAppBootstrapStorageMock = vi.hoisted(() => vi.fn());
const registerRepositoriesMock = vi.hoisted(() => vi.fn());
const registerFallbackRepositoriesMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/options/app/bootstrap', () => ({
  bootstrapOptionsApp: bootstrapOptionsAppMock,
  configureOptionsAppBootstrapStorage: configureOptionsAppBootstrapStorageMock
}));
vi.mock('../../../src/shared/di/serviceRegistry', () => ({
  registerRepositories: registerRepositoriesMock,
  registerFallbackRepositories: registerFallbackRepositoriesMock
}));
vi.mock('../../../src/shared/di', () => ({
  registerService: vi.fn(),
  TOKENS: { platformServices: Symbol('platformServices') }
}));
vi.mock('../../../src/platform/preview/memoryStorage', () => ({
  createMemoryStorageService: vi.fn(() => ({ sync: {}, local: {} }))
}));
vi.mock('../../../src/platform/preview/services', () => ({
  createPreviewPlatformServices: vi.fn((storage: StorageService) => ({
    storage,
    messaging: {},
    tabs: {},
    runtime: { getURL: vi.fn(), getBrowserTarget: vi.fn(() => 'chrome') }
  }))
}));

describe('options runtime entry provider composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        sync: {},
        local: {}
      }
    });
  });

  it('passes an explicit Stitch assets provider to the app bootstrap', async () => {
    const stitchAssetsProvider = vi.fn();
    const additionalActionHandlers = {
      'owner-extension:test': vi.fn()
    };
    const overlayRuntimeState = createOptionsOverlayRuntimeState({ ownerStatus: 'active' });
    const platformServices = asType<OptionsRuntimePlatformServices>({
      storage: { sync: {}, local: {} },
      messaging: {},
      tabs: {},
      runtime: { getURL: vi.fn(), getBrowserTarget: vi.fn(() => 'chrome') }
    });

    const { bootstrapOptionsRuntime } = await import('../../../src/options/runtimeEntry');
    await bootstrapOptionsRuntime(platformServices, {
      stitchAssetsProvider,
      additionalActionHandlers,
      overlayRuntimeState
    });

    expect(bootstrapOptionsAppMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: platformServices.storage,
        runtime: platformServices.runtime,
        stitchAssetsProvider,
        additionalActionHandlers,
        overlayRuntimeState
      })
    );
  });
});
