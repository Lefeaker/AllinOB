import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import type { VideoScreenshotCacheBlobObservationStore } from '../../content/video/videoScreenshotCacheStore';
import type { SessionDraftOwnerContext } from '../../content/sessionDrafts/sessionDraftTypes';
import type {
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionTypes';
export { RESTORE_STORAGE_REVISION_CONFLICT } from '../../content/sessionDrafts/sessionDraftProtocolErrors';

export const RESTORE_STORAGE_PROTOCOL_STATE_INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';
export const RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED = 'RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED';
export const RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED = 'RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED';

export interface SessionDraftRepositoryServiceDependencies {
  local: StorageAreaService;
  screenshots: Pick<VideoScreenshotCacheBlobObservationStore, 'get'>;
  getStoragePolicy(): SessionDraftStoragePolicy;
  getEpoch?(): number | Promise<number>;
  deleteDraftCandidates(request: SessionDraftDeletionRequest): Promise<SessionDraftDeletionResult>;
  replayDraftDeletion(
    operationId: string,
    requestFingerprint: string
  ): Promise<SessionDraftDeletionResult | null>;
  requestOwnerContext?: SessionDraftOwnerContext | null;
  isOwnerContextActive?(owner: SessionDraftOwnerContext): boolean | Promise<boolean>;
  claimTransfer?: {
    operationId: string;
    draftKey: string;
    previousOwner: SessionDraftOwnerContext;
    nextOwner: SessionDraftOwnerContext;
  };
}

export function readSessionDraftEpoch(
  dependencies: SessionDraftRepositoryServiceDependencies
): number | Promise<number> {
  return dependencies.getEpoch?.() ?? 1;
}
