import { bootstrapOptionsApp, configureOptionsAppBootstrapStorage } from '@options/app/bootstrap';
import type { ProductionStitchAssetsProvider } from '@options/app/productionStitchShellAssetResolver';
import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type { PreviewContent, PreviewStoreState } from '@options/stitch/types';
import { registerFallbackRepositories, registerRepositories } from '@shared/di/serviceRegistry';
import { createMemoryStorageService } from '@platform/preview/memoryStorage';
import { createPreviewPlatformServices } from '@platform/preview/services';
import { registerService, TOKENS } from '@shared/di';
import type { PlatformServices } from '../platform/types';

export type OptionsRuntimePlatformServices = Pick<
  PlatformServices,
  'storage' | 'messaging' | 'tabs' | 'runtime'
>;

export interface OptionsRuntimeBootstrapDependencies {
  stitchAssetsProvider?: ProductionStitchAssetsProvider;
  additionalActionHandlers?: ActionRegistry<PreviewStoreState, PreviewContent>;
}

export async function bootstrapOptionsRuntime(
  platformServices?: OptionsRuntimePlatformServices,
  dependencies: OptionsRuntimeBootstrapDependencies = {}
): Promise<void> {
  const hasChromeStorage =
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime) &&
    Boolean(chrome.storage?.sync) &&
    Boolean(chrome.storage?.local);

  let runtime = platformServices?.runtime;
  const bootstrapStorage = hasChromeStorage
    ? platformServices?.storage
    : createMemoryStorageService();

  if (!bootstrapStorage) {
    throw new Error('Options runtime requires platform services when Chrome storage is available.');
  }

  if (hasChromeStorage) {
    if (!platformServices) {
      throw new Error(
        'Options runtime requires platform services when Chrome storage is available.'
      );
    }
    registerRepositories({
      storage: platformServices.storage,
      messaging: platformServices.messaging,
      tabs: platformServices.tabs,
      runtime: platformServices.runtime
    });
  } else {
    const previewPlatformServices = createPreviewPlatformServices(bootstrapStorage);
    runtime = previewPlatformServices.runtime;
    registerService(TOKENS.platformServices, () => previewPlatformServices);
    registerFallbackRepositories();
  }

  configureOptionsAppBootstrapStorage(bootstrapStorage);
  await bootstrapOptionsApp({
    storage: bootstrapStorage,
    ...(runtime ? { runtime } : {}),
    ...(dependencies.stitchAssetsProvider
      ? { stitchAssetsProvider: dependencies.stitchAssetsProvider }
      : {}),
    ...(dependencies.additionalActionHandlers
      ? { additionalActionHandlers: dependencies.additionalActionHandlers }
      : {})
  });
}
