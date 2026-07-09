import {
  configureI18nStorage,
  createDefaultPageI18nController,
  type Language,
  type PageI18nController
} from '@i18n';
import { configureAnalyticsConfigManager } from '../../shared/errors/analytics/analyticsConfig';
import { configureGlobalStateManagerStorage } from '../../shared/state/globalStateManager';
import { DI_TOKENS } from '../../shared/di/tokens';
import { resolveRepository } from '../../shared/di/serviceRegistry';
import type { IOptionsRepository, IMessagingRepository } from '../../shared/repositories';
import type { StoredOptions } from '../../shared/types/options';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { StorageService } from '../../platform/interfaces/storage';
import { showStatusMessage } from '../components/messages';
import { createOptionsFormAdapter } from '../components/optionsFormAdapter';
import { chromeOptionsPersistence } from '../services/persistence';
import { consumeYamlMigrationNotice } from '../state/optionsStore';
import { createOptionsController, type OptionsController } from './optionsController';
import {
  consumePendingAutoSaveSource,
  registerOptionsController
} from './optionsControllerContext';
import { getOptionsMessages, setOptionsI18nContext } from './i18nContext';
import {
  mountProductionStitchShell,
  type MountedProductionStitchShell
} from './productionStitchShell';
import { trackInitialOptionsTelemetry } from './productionStitchTelemetry';
import {
  loadProductionStitchAssets,
  type ProductionStitchAssetsProvider
} from './productionStitchShellAssetResolver';

export interface OptionsAppBootstrapDependencies {
  storage: StorageService;
  runtime?: Pick<RuntimeService, 'getURL' | 'getBrowserTarget'>;
  stitchAssetsProvider?: ProductionStitchAssetsProvider;
}

type CleanupFn = () => void;

const cleanupHandlers: CleanupFn[] = [];
let optionsAppBootstrapStorage: StorageService | null = null;
let declarativeI18nController: PageI18nController | null = null;
let unloadCleanupRegistered = false;
let optionsController: OptionsController | null = null;
let mountedShell: MountedProductionStitchShell | null = null;

export function configureOptionsAppBootstrapStorage(storage: StorageService): void {
  optionsAppBootstrapStorage = storage;
}

function resolveOptionsAppBootstrapDependencies(
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
      : {})
  };
}

async function ensureDeclarativeI18nController(): Promise<PageI18nController> {
  if (!declarativeI18nController) {
    const controller = createDefaultPageI18nController();
    await controller.load();
    if (typeof document !== 'undefined') {
      controller.mount(document);
    }
    declarativeI18nController = controller;
  }

  const resource = declarativeI18nController.getCurrentResource();
  setOptionsI18nContext(declarativeI18nController.getBinder(), resource);
  return declarativeI18nController;
}

function initializeOptionsController(): OptionsController {
  if (optionsController) {
    optionsController.dispose();
    optionsController = null;
  }

  const controller = createOptionsController({
    persistence: chromeOptionsPersistence,
    formAdapter: createOptionsFormAdapter(),
    autoSaveDebounceMs: 400,
    onSaveError: (reason, error) => {
      if (reason === 'auto') {
        console.error('[options] Auto-save failed:', error);
      }
    },
    onSaveSuccess: (reason) => {
      if (reason !== 'auto') {
        return;
      }
      const source = consumePendingAutoSaveSource();
      if (source) {
        void showAutoSaveNotice(source);
      }
    }
  });

  optionsController = controller;
  registerOptionsController(controller);
  registerCleanup(() => {
    if (optionsController === controller) {
      optionsController = null;
    }
    controller.dispose();
  });
  return controller;
}

export async function bootstrapOptionsApp(
  dependencies?: Partial<OptionsAppBootstrapDependencies>
): Promise<void> {
  teardownMountedShell();
  disposeCleanupHandlers();
  ensureUnloadCleanup();

  const {
    storage,
    runtime,
    stitchAssetsProvider = loadProductionStitchAssets
  } = resolveOptionsAppBootstrapDependencies(dependencies);
  configureAnalyticsConfigManager(storage);
  configureGlobalStateManagerStorage(storage);
  configureI18nStorage(storage.sync);

  const i18nController = await ensureDeclarativeI18nController();
  const resource = i18nController.getCurrentResource();
  const controller = initializeOptionsController();
  const stored = await controller.loadInitialState();
  const { getFooterMeta, getFooterView, getSettingsView, previewContent } =
    await stitchAssetsProvider();

  mountedShell = mountProductionStitchShell({
    controller,
    initialOptions: stored,
    getFooterMeta,
    getFooterView,
    getSettingsView,
    previewContent,
    messages: resource?.messages ?? null,
    language: (resource?.language ?? 'zh-CN') as Language,
    ...(runtime ? { runtime } : {}),
    storage,
    optionsRepository: resolveRepository<IOptionsRepository>(DI_TOKENS.IOptionsRepository),
    messagingRepository: resolveRepository<IMessagingRepository>(DI_TOKENS.IMessagingRepository),
    changeLanguage: async (language) => {
      await i18nController.changeLanguage(language);
      const nextResource = i18nController.getCurrentResource();
      setOptionsI18nContext(i18nController.getBinder(), nextResource);
      return {
        messages: nextResource?.messages ?? null,
        language: (nextResource?.language ?? language) as Language
      };
    }
  });
  registerCleanup(() => {
    teardownMountedShell();
  });

  await applyOptionsSnapshot(stored);
  await trackInitialOptionsTelemetry();
}

async function applyOptionsSnapshot(options: StoredOptions): Promise<void> {
  mountedShell?.refreshOptions(options);

  const migrationNotice = consumeYamlMigrationNotice();
  if (migrationNotice) {
    const msgs = await getOptionsMessages();
    const text =
      msgs.yamlConfigMigrated ?? 'YAML field configuration has been migrated to the latest format.';
    showStatusMessage('success', { key: migrationNotice, text });
  }
}

export async function showAutoSaveNotice(source: string): Promise<void> {
  const msgs = await getOptionsMessages();
  if (source === 'yamlConfig') {
    const text = msgs.yamlConfigAutoSaved ?? 'YAML field configuration changes saved.';
    showStatusMessage('success', { key: 'yamlConfigAutoSaved', text });
    return;
  }

  if (source === 'templates') {
    const text = msgs.templatesAutoSaved ?? 'Template settings saved automatically.';
    showStatusMessage('success', { key: 'templatesAutoSaved', text });
  }
}

function registerCleanup(handler: CleanupFn | null | undefined): void {
  if (typeof handler === 'function') {
    cleanupHandlers.push(handler);
  }
}

function ensureUnloadCleanup(): void {
  if (unloadCleanupRegistered) {
    return;
  }

  const disposeOnUnload = (): void => {
    disposeCleanupHandlers();
  };

  window.addEventListener('beforeunload', disposeOnUnload);
  cleanupHandlers.push(() => {
    window.removeEventListener('beforeunload', disposeOnUnload);
  });
  unloadCleanupRegistered = true;
}

function disposeCleanupHandlers(): void {
  while (cleanupHandlers.length > 0) {
    const handler = cleanupHandlers.pop();
    try {
      handler?.();
    } catch (error) {
      console.error('[Options] cleanup failed:', error);
    }
  }
  unloadCleanupRegistered = false;
}

function teardownMountedShell(): void {
  if (!mountedShell) {
    return;
  }
  const currentShell = mountedShell;
  mountedShell = null;
  try {
    currentShell.cleanup();
  } catch (error) {
    console.error('[Options] Stitch shell cleanup failed:', error);
  }
}
