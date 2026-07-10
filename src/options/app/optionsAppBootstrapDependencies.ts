import type { RuntimeService } from '@platform/interfaces/runtime';
import type { StorageService } from '@platform/interfaces/storage';
import type { ActionRegistry } from '@options/schema-runtime/actionRuntime';
import type { PreviewContent, PreviewStoreState } from '@options/stitch/types';
import type { ProductionStitchAssetsProvider } from './productionStitchShellAssetResolver';
import type {
  OptionsOverlayAppDataSnapshot,
  OptionsOverlayRuntimeStatePort
} from './optionsOverlayRuntimeState';

export interface OptionsAppBootstrapDependencies {
  storage: StorageService;
  runtime?: Pick<RuntimeService, 'getURL' | 'getBrowserTarget'>;
  stitchAssetsProvider?: ProductionStitchAssetsProvider;
  additionalActionHandlers?: ActionRegistry<PreviewStoreState, PreviewContent>;
  overlayRuntimeState?: OptionsOverlayRuntimeStatePort<OptionsOverlayAppDataSnapshot>;
}

let optionsAppBootstrapStorage: StorageService | null = null;

export function configureOptionsAppBootstrapStorage(storage: StorageService): void {
  optionsAppBootstrapStorage = storage;
}

export function resolveOptionsAppBootstrapDependencies(
  dependencies?: Partial<OptionsAppBootstrapDependencies>
): OptionsAppBootstrapDependencies {
  const storage = dependencies?.storage ?? optionsAppBootstrapStorage;
  if (!storage) {
    throw new Error('[Options] StorageService is required for bootstrap.');
  }

  optionsAppBootstrapStorage = storage;
  return {
    storage,
    ...(dependencies?.runtime ? { runtime: dependencies.runtime } : {}),
    ...(dependencies?.stitchAssetsProvider
      ? { stitchAssetsProvider: dependencies.stitchAssetsProvider }
      : {}),
    ...(dependencies?.additionalActionHandlers
      ? { additionalActionHandlers: dependencies.additionalActionHandlers }
      : {}),
    ...(dependencies?.overlayRuntimeState
      ? { overlayRuntimeState: dependencies.overlayRuntimeState }
      : {})
  };
}
