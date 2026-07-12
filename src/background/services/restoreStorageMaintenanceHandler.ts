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
import { createRestoreStoragePressureService } from './restoreStoragePressureService';
import { createRestoreDataPolicyPruneService } from './restoreDataPolicyPruneService';
import { buildRestoreStorageProtectionInventory } from './restoreStorageProtectionInventory';
import type {
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionOwner';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';

export interface RestoreStorageMaintenanceHandlerDependencies {
  local: StorageAreaService;
  blobStore: VideoScreenshotCacheBlobStore;
  estimate: StorageEstimateService;
  policyInput: BackgroundVideoScreenshotCachePolicyInput;
  deleteScreenshotCandidates(keys: readonly string[]): Promise<{ deletedKeys: string[] }>;
  deleteDraftCandidates(request: SessionDraftDeletionRequest): Promise<SessionDraftDeletionResult>;
  clearRestoreData(
    operationId: string
  ): Promise<
    Extract<RestoreStorageMaintenanceResponse, { operation: 'clearAllRestoreData' }>['result']
  >;
  getCurrentEpoch(): Promise<number>;
}

export async function handleRestoreStorageMaintenanceMessage(
  message: RestoreStorageMaintenanceMessage,
  dependencies: RestoreStorageMaintenanceHandlerDependencies
): Promise<RestoreStorageMaintenanceResponse> {
  if (message.operation === 'clearAllRestoreData') {
    return {
      success: true,
      operation: message.operation,
      result: await dependencies.clearRestoreData(message.operationId)
    };
  }

  if (message.operation === 'pruneRestoreDataToCurrentPolicy') {
    const prune = createRestoreDataPolicyPruneService({
      drafts: dependencies.local,
      screenshots: dependencies.blobStore,
      deleteScreenshotCandidates: (keys) => dependencies.deleteScreenshotCandidates(keys),
      deleteDraftCandidates: (request) => dependencies.deleteDraftCandidates(request),
      getProtectedDraftKeys: async () =>
        (
          await buildRestoreStorageProtectionInventory(dependencies.local, {
            currentEpoch: await dependencies.getCurrentEpoch()
          })
        ).pendingDraftKeys,
      getStoragePolicy: () => resolveRestoreStoragePolicy(dependencies.policyInput)
    });
    return {
      success: true,
      operation: message.operation,
      result: await prune.prune(message.operationId)
    };
  }

  const pressure = createRestoreStoragePressureService({
    drafts: dependencies.local,
    screenshots: dependencies.blobStore,
    deleteScreenshotCandidates: (keys) => dependencies.deleteScreenshotCandidates(keys),
    async deleteDraftCandidates(keys, cause) {
      const operationId = `implicit-${globalThis.crypto.randomUUID()}`;
      return dependencies.deleteDraftCandidates({
        operationId,
        requestFingerprint: await createSessionDraftProtocolFingerprint({
          operationId,
          cause,
          keys: [...keys].sort()
        }),
        candidateKeys: keys
      });
    },
    estimate: dependencies.estimate,
    getStoragePolicy: () => resolveRestoreStoragePolicy(dependencies.policyInput)
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

export function resolveRestoreStoragePolicy(input: BackgroundVideoScreenshotCachePolicyInput) {
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
