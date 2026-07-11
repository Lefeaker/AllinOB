import type { StorageAreaService } from '../../platform/interfaces/storage';
import type {
  RestoreStorageMaintenanceMessage,
  RestoreStorageMaintenanceResponse
} from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import { createSessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import type { VideoScreenshotCacheBlobStore } from '../../content/video/videoScreenshotCacheStore';
import type { RestoreCapabilityPolicyProvider } from '../../shared/capabilities/capabilityPolicy';
import type { BackgroundVideoScreenshotCachePolicyInput } from './videoScreenshotCachePolicyRuntime';
import type { StorageEstimateService } from './storageEstimateService';
import { createLocalRestoreDataService } from './localRestoreDataService';
import { createRestoreStoragePressureService } from './restoreStoragePressureService';

export interface RestoreStorageMaintenanceHandlerDependencies {
  local: StorageAreaService;
  blobStore: VideoScreenshotCacheBlobStore;
  estimate: StorageEstimateService;
  policyInput: BackgroundVideoScreenshotCachePolicyInput;
}

export async function handleRestoreStorageMaintenanceMessage(
  message: RestoreStorageMaintenanceMessage,
  dependencies: RestoreStorageMaintenanceHandlerDependencies
): Promise<RestoreStorageMaintenanceResponse> {
  if (message.operation === 'clearAllRestoreData') {
    return {
      success: true,
      operation: message.operation,
      result: await createLocalRestoreDataService({
        local: dependencies.local,
        screenshots: dependencies.blobStore
      }).clearAll()
    };
  }

  const pressure = createRestoreStoragePressureService({
    drafts: dependencies.local,
    screenshots: dependencies.blobStore,
    estimate: dependencies.estimate,
    getStoragePolicy: () => resolveStoragePolicy(dependencies.policyInput)
  });
  return {
    success: true,
    operation: message.operation,
    result:
      message.operation === 'inspectStoragePressure'
        ? await pressure.inspect()
        : await pressure.runCleanup()
  };
}

function resolveStoragePolicy(input: BackgroundVideoScreenshotCachePolicyInput) {
  return isPolicyProvider(input)
    ? input.getCurrentPolicy()
    : createSessionDraftStoragePolicy({ videoScreenshotCache: input });
}

function isPolicyProvider(
  input: BackgroundVideoScreenshotCachePolicyInput
): input is RestoreCapabilityPolicyProvider {
  return (
    typeof input === 'object' &&
    input !== null &&
    'getCurrentPolicy' in input &&
    typeof input.getCurrentPolicy === 'function'
  );
}
