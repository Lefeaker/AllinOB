import { defaultRestoreCapabilityPolicyProvider } from '../shared/capabilities/capabilityPolicy';
import { markContentRuntimeInitialized } from './runtime/contentSessionRegistry';
import { initializeClipperRuntime } from './runtime/contentRuntimeBootstrap';

if (markContentRuntimeInitialized(document)) {
  initializeClipperRuntime({
    restoreStoragePolicyProvider: defaultRestoreCapabilityPolicyProvider
  });
}
