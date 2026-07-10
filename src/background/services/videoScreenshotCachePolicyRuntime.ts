import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { RestoreCapabilityPolicyProvider } from '../../shared/capabilities/capabilityPolicy';
import {
  createVideoScreenshotCacheRepository,
  type VideoScreenshotCacheRepository,
  type VideoScreenshotCacheRepositoryOptions
} from '../../content/video/videoScreenshotCacheRepository';
import type { VideoScreenshotCacheBlobStore } from '../../content/video/videoScreenshotCacheStore';
import {
  createVideoScreenshotCacheIndexedDbStore,
  type VideoScreenshotCacheIndexedDbStoreOptions
} from './videoScreenshotCacheIndexedDbStore';

export type BackgroundVideoScreenshotCachePolicyInput =
  | VideoScreenshotCacheRepositoryOptions
  | RestoreCapabilityPolicyProvider;

interface VideoScreenshotCachePolicyRuntimeDependencies {
  legacyArea: StorageAreaService;
  blobStore?: VideoScreenshotCacheBlobStore;
  indexedDb?: VideoScreenshotCacheIndexedDbStoreOptions['indexedDb'];
}

export interface VideoScreenshotCachePolicyRuntime {
  getCurrentOptions(): VideoScreenshotCacheRepositoryOptions;
  getRepository(options: VideoScreenshotCacheRepositoryOptions): VideoScreenshotCacheRepository;
}

export function createVideoScreenshotCachePolicyRuntime(
  policyInput: BackgroundVideoScreenshotCachePolicyInput,
  dependencies: VideoScreenshotCachePolicyRuntimeDependencies
): VideoScreenshotCachePolicyRuntime {
  let repository: VideoScreenshotCacheRepository | null = null;
  let repositoryPolicyKey: string | null = null;

  if (isRestoreCapabilityPolicyProvider(policyInput)) {
    policyInput.subscribePolicyChanges?.(() => {
      repository = null;
      repositoryPolicyKey = null;
    });
  }

  return {
    getCurrentOptions() {
      return isRestoreCapabilityPolicyProvider(policyInput)
        ? policyInput.getCurrentPolicy().videoScreenshotCache
        : policyInput;
    },
    getRepository(options) {
      const policyKey = createCachePolicyKey(options);
      if (!repository || repositoryPolicyKey !== policyKey) {
        repository = createVideoScreenshotCacheRepository(
          {
            blobStore:
              dependencies.blobStore ??
              createVideoScreenshotCacheIndexedDbStore({
                indexedDb: dependencies.indexedDb,
                maxContentBytes: options.maxContentBytes
              }),
            legacyArea: dependencies.legacyArea
          },
          options
        );
        repositoryPolicyKey = policyKey;
      }
      return repository;
    }
  };
}

function isRestoreCapabilityPolicyProvider(
  value: BackgroundVideoScreenshotCachePolicyInput
): value is RestoreCapabilityPolicyProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getCurrentPolicy' in value &&
    typeof value.getCurrentPolicy === 'function'
  );
}

function createCachePolicyKey(options: VideoScreenshotCacheRepositoryOptions): string {
  return [
    options.ttlMs ?? '',
    options.maxGlobalEntries ?? '',
    options.maxPageEntries ?? '',
    options.maxContentBytes ?? ''
  ].join(':');
}
