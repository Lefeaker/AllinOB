import { getPlatformServices } from '../platform';
import { registerRepositories } from '../shared/di/serviceRegistry';
import { defaultRestoreCapabilityPolicyProvider } from '../shared/capabilities/capabilityPolicy';
import { startBackgroundRuntime } from './backgroundStartup';
import { createDefaultTrialLifecycleDependencies, registerTrialLifecycle } from './trialLifecycle';

const platformServices = getPlatformServices();

registerRepositories({
  storage: platformServices.storage,
  messaging: platformServices.messaging,
  tabs: platformServices.tabs,
  runtime: platformServices.runtime
});

startBackgroundRuntime({
  action: platformServices.action,
  contextMenus: platformServices.contextMenus,
  messaging: platformServices.messaging,
  runtime: platformServices.runtime,
  scripting: platformServices.scripting,
  storage: platformServices.storage,
  tabs: platformServices.tabs,
  restoreStoragePolicyProvider: defaultRestoreCapabilityPolicyProvider
});

registerTrialLifecycle(
  createDefaultTrialLifecycleDependencies(
    {
      ...platformServices.runtime,
      registerOnSuspend: (listener) => {
        chrome.runtime.onSuspend.addListener(listener);
      }
    },
    platformServices.storage,
    platformServices.tabs,
    platformServices.notifications
  )
);
