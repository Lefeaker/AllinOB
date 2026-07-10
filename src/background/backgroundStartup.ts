import type { ActionService } from '../platform/interfaces/actions';
import type { ContextMenusService } from '../platform/interfaces/contextMenus';
import type { MessagingService } from '../platform/interfaces/messaging';
import type { RuntimeService } from '../platform/interfaces/runtime';
import type { ScriptingService } from '../platform/interfaces/scripting';
import type { StorageService } from '../platform/interfaces/storage';
import type { TabsService } from '../platform/interfaces/tabs';
import { DI_TOKENS, resolveRepository } from '../shared/di';
import type { IOptionsRepository } from '../shared/repositories';
import {
  createContextMenuListenerDependencies,
  registerContextMenuListeners
} from './listeners/contextMenus';
import {
  createRuntimeMessageListenerDependencies,
  registerRuntimeMessageListener
} from './listeners/runtimeMessages';
import { ensureUsageStatsInitialized } from './services/usageStats';
import { bootstrapBackgroundDependencies, configureBackgroundDependencyStorage } from './bootstrap';
import {
  defaultRestoreCapabilityPolicyProvider,
  type RestoreCapabilityPolicyProvider
} from '../shared/capabilities/capabilityPolicy';

export interface BackgroundStartupDependencies {
  action: ActionService;
  contextMenus: ContextMenusService;
  messaging: MessagingService;
  runtime: RuntimeService;
  scripting: ScriptingService;
  storage: StorageService;
  tabs: TabsService;
  restoreStoragePolicyProvider?: RestoreCapabilityPolicyProvider;
}

export function startBackgroundRuntime(dependencies: BackgroundStartupDependencies): void {
  configureBackgroundDependencyStorage(dependencies.storage);
  bootstrapBackgroundDependencies();
  const optionsRepository = resolveRepository<IOptionsRepository>(DI_TOKENS.IOptionsRepository);

  registerContextMenuListeners(
    createContextMenuListenerDependencies({
      action: dependencies.action,
      contextMenus: dependencies.contextMenus,
      runtime: dependencies.runtime,
      tabs: dependencies.tabs,
      scripting: dependencies.scripting,
      messaging: dependencies.messaging,
      optionsRepository
    })
  );

  const restoreStoragePolicyProvider =
    dependencies.restoreStoragePolicyProvider ?? defaultRestoreCapabilityPolicyProvider;

  registerRuntimeMessageListener(
    createRuntimeMessageListenerDependencies(
      dependencies.messaging,
      dependencies.tabs,
      dependencies.runtime,
      dependencies.storage,
      restoreStoragePolicyProvider
    )
  );

  void ensureUsageStatsInitialized().catch((error) => {
    console.error('[background] Failed to initialize usage stats storage:', error);
  });
}
