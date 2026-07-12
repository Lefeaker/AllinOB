import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoScreenshotCacheRepository } from '../../content/video/videoScreenshotCacheRepository';
import { isRestoreStorageMaintenanceMessage } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import {
  normalizeNonCanonicalSessionDraftSaveContext,
  normalizeSessionDraftRepositoryMessage,
  type SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  normalizeVideoScreenshotCacheMessage,
  type VideoScreenshotCacheMessage,
  type VideoScreenshotCacheResponse
} from '../../content/video/videoScreenshotCacheMessages';
import type {
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobStore
} from '../../content/video/videoScreenshotCacheStore';
import type { VideoScreenshotCacheIndexedDbStoreOptions } from './videoScreenshotCacheIndexedDbStore';
import { createVideoScreenshotCacheIndexedDbStore } from './videoScreenshotCacheIndexedDbStore';
import {
  createStorageEstimateService,
  type StorageEstimateService
} from './storageEstimateService';
import {
  handleRestoreStorageMaintenanceMessage,
  resolveRestoreStoragePolicy
} from './restoreStorageMaintenanceHandler';
import { createRestoreStorageOperationQueue } from './restoreStorageOperationQueue';
import { handleSessionDraftRepositoryMessage } from './sessionDraftRepositoryService';
import {
  createVideoScreenshotCachePolicyRuntime,
  type BackgroundVideoScreenshotCachePolicyInput
} from './videoScreenshotCachePolicyRuntime';
import { normalizeSessionDraftOwnerContext } from '../../content/sessionDrafts/sessionDraftTabContext';
import type { SessionDraftOwnerContext } from '../../content/sessionDrafts/sessionDraftTypes';
import {
  handleVideoScreenshotLoad,
  handleVideoScreenshotSave
} from './videoScreenshotCacheRequestHandlers';
import { createRestoreStorageScreenshotDeletionOwner } from './restoreStorageScreenshotDeletionOwner';
import { removeLegacyVideoScreenshotCacheKeys } from '../../content/video/videoScreenshotCacheLegacyRepository';
import { normalizeVideoScreenshotCacheMaxContentBytes } from '../../content/video/videoScreenshotCacheTypes';
import {
  createSessionDraftDeletionOwner,
  type SessionDraftDeletionRequest
} from './sessionDraftDeletionOwner';
import { createRestoreStorageClearOwner } from './restoreStorageClearOwner';
import {
  readActiveRestoreStorageClearRequest,
  registerActiveRestoreStorageClearRequest
} from './restoreStorageClearRequestGate';
import {
  toVideoScreenshotCacheClearMessageError,
  toVideoScreenshotCacheMessageError
} from './videoScreenshotCacheServiceErrors';
import { consumeMatchingRestoreStorageLease } from './restoreStorageLeaseStore';
export interface BackgroundVideoScreenshotCacheStorage {
  local: StorageAreaService;
}
export interface BackgroundVideoScreenshotCacheHandlerDependencies {
  blobStore?: VideoScreenshotCacheBlobMaintenanceStore;
  indexedDb?: VideoScreenshotCacheIndexedDbStoreOptions['indexedDb'];
  storageEstimate?: StorageEstimateService;
  getEpoch?(): number | Promise<number>;
  isOwnerContextActive?(owner: SessionDraftOwnerContext): boolean | Promise<boolean>;
}

export type BackgroundVideoScreenshotCacheHandler = (
  message: unknown,
  sender?: SessionDraftOwnerContext | null
) => Promise<VideoScreenshotCacheResponse | SessionDraftRepositoryResponse | undefined>;
export function createBackgroundVideoScreenshotCacheHandler(
  storage: BackgroundVideoScreenshotCacheStorage,
  policyInput: BackgroundVideoScreenshotCachePolicyInput = {},
  dependencies: BackgroundVideoScreenshotCacheHandlerDependencies = {}
): BackgroundVideoScreenshotCacheHandler {
  const operationQueue = createRestoreStorageOperationQueue(storage.local);
  const getFallbackEpoch = dependencies.getEpoch ? () => dependencies.getEpoch?.() ?? 1 : () => 1;
  let maintenanceBlobStore = dependencies.blobStore;
  const storageEstimate = dependencies.storageEstimate ?? createStorageEstimateService();
  function getMaintenanceBlobStore(
    maxContentBytes: number | undefined
  ): VideoScreenshotCacheBlobMaintenanceStore {
    maintenanceBlobStore ??= createVideoScreenshotCacheIndexedDbStore({
      indexedDb: dependencies.indexedDb,
      maxContentBytes
    });
    return maintenanceBlobStore;
  }
  const clearOwner = createRestoreStorageClearOwner({
    local: storage.local,
    getScreenshots: () =>
      getMaintenanceBlobStore(policyRuntime.getCurrentOptions().maxContentBytes),
    getFallbackEpoch
  });
  const getCurrentEpoch = () => clearOwner.getReadyEpoch();
  const deletionOwner = createSessionDraftDeletionOwner({
    local: storage.local,
    operationQueue,
    getCurrentEpoch
  });
  const deleteDraftCandidates = (request: SessionDraftDeletionRequest) =>
    deletionOwner.withinOperationExecutor(request);
  const replayDraftDeletion = (operationId: string, requestFingerprint: string) =>
    deletionOwner.withinOperationReplay(operationId, requestFingerprint);
  const maintainDraftDeletions = () => deletionOwner.withinOperationMaintenance();
  const { withinOperationExecutor: deleteCandidates } = createRestoreStorageScreenshotDeletionOwner(
    {
      local: storage.local,
      screenshots: {
        async deleteMany(keys) {
          const maxContentBytes = normalizeVideoScreenshotCacheMaxContentBytes(
            policyRuntime.getCurrentOptions().maxContentBytes
          );
          await getMaintenanceBlobStore(maxContentBytes).deleteMany(keys);
          await removeLegacyVideoScreenshotCacheKeys(storage.local, keys, {
            maxContentBytes
          });
        }
      },
      operationQueue,
      getCurrentEpoch
    }
  );
  const policyRuntime = createVideoScreenshotCachePolicyRuntime(policyInput, {
    legacyArea: storage.local,
    deleteCandidates,
    ...(dependencies.blobStore ? { blobStore: dependencies.blobStore } : {}),
    ...(dependencies.indexedDb ? { indexedDb: dependencies.indexedDb } : {})
  });
  async function handleMessage(
    message: VideoScreenshotCacheMessage,
    cacheRepository: VideoScreenshotCacheRepository,
    blobStore: VideoScreenshotCacheBlobStore
  ): Promise<VideoScreenshotCacheResponse> {
    if (isRestoreStorageMaintenanceMessage(message)) {
      return handleRestoreStorageMaintenanceMessage(message, {
        local: storage.local,
        blobStore,
        estimate: storageEstimate,
        policyInput,
        deleteScreenshotCandidates: deleteCandidates,
        deleteDraftCandidates,
        clearRestoreData: (operationId) => clearOwner.clear(operationId)
      });
    }
    if (
      message.operation === 'save' &&
      message.input.operationContext?.epoch !== (await getCurrentEpoch())
    ) {
      throw new Error('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    }
    switch (message.operation) {
      case 'save':
        return handleVideoScreenshotSave(message, storage.local, cacheRepository, blobStore);
      case 'load':
        return handleVideoScreenshotLoad(message, cacheRepository);
      case 'remove':
        await cacheRepository.remove(message.ref);
        return { success: true, operation: 'remove' };
      case 'removeMany':
        await cacheRepository.removeMany(message.refs);
        return { success: true, operation: 'removeMany' };
      case 'pruneExpired':
        await cacheRepository.pruneExpired();
        return { success: true, operation: 'pruneExpired' };
      case 'pruneToLimits':
        await cacheRepository.pruneToLimits();
        return { success: true, operation: 'pruneToLimits' };
    }
  }

  return async (rawMessage, sender) => {
    const nonCanonicalSaveContext = normalizeNonCanonicalSessionDraftSaveContext(rawMessage);
    const sessionDraftMessage = normalizeSessionDraftRepositoryMessage(rawMessage);
    if (sessionDraftMessage) {
      try {
        return await operationQueue.enqueue(async () => {
          await clearOwner.recover();
          await maintainDraftDeletions();
          return handleSessionDraftRepositoryMessage(sessionDraftMessage, {
            local: storage.local,
            screenshots: getMaintenanceBlobStore(policyRuntime.getCurrentOptions().maxContentBytes),
            getStoragePolicy: () => resolveRestoreStoragePolicy(policyInput),
            getEpoch: getCurrentEpoch,
            deleteDraftCandidates,
            replayDraftDeletion,
            requestOwnerContext: normalizeSessionDraftOwnerContext(sender),
            ...(dependencies.isOwnerContextActive
              ? {
                  isOwnerContextActive: (owner: SessionDraftOwnerContext) =>
                    dependencies.isOwnerContextActive?.(owner) ?? false
                }
              : {})
          });
        });
      } catch (error) {
        return toVideoScreenshotCacheMessageError(error instanceof Error ? error : String(error));
      }
    }
    if (nonCanonicalSaveContext) {
      try {
        await operationQueue.enqueue(async () => {
          await clearOwner.recover();
          await maintainDraftDeletions();
          await consumeMatchingRestoreStorageLease(storage.local, nonCanonicalSaveContext);
        });
        return toVideoScreenshotCacheMessageError('CANONICAL_JSON_INVALID');
      } catch (error) {
        return toVideoScreenshotCacheMessageError(error instanceof Error ? error : String(error));
      }
    }
    const options = policyRuntime.getCurrentOptions();
    const message = normalizeVideoScreenshotCacheMessage(rawMessage, {
      maxContentBytes: options.maxContentBytes
    });
    if (!message) {
      return undefined;
    }
    const activeClear = readActiveRestoreStorageClearRequest(storage.local);
    if (message.operation === 'clearAllRestoreData' && activeClear) {
      return message.operationId === activeClear.operationId
        ? activeClear.promise
        : toVideoScreenshotCacheMessageError('RESTORE_STORAGE_PROTOCOL_STATE_INVALID');
    }
    const promise = operationQueue
      .enqueue(async () => {
        if (message.operation !== 'clearAllRestoreData') {
          await clearOwner.recover();
          await maintainDraftDeletions();
        }
        return handleMessage(
          message,
          policyRuntime.getRepository(options),
          getMaintenanceBlobStore(options.maxContentBytes)
        );
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : String(error);
        return message.operation === 'clearAllRestoreData'
          ? toVideoScreenshotCacheClearMessageError(failure)
          : toVideoScreenshotCacheMessageError(failure);
      });
    if (message.operation === 'clearAllRestoreData') {
      registerActiveRestoreStorageClearRequest(storage.local, message.operationId, promise);
    }
    return promise;
  };
}
