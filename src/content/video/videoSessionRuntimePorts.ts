import type { SessionDraftTerminalStatus } from '../sessionDrafts';
import type { ContentExportDestinationState } from '../shared/exportDestinationState';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { UsageEventParamMap } from '../../shared/types/analytics';
import type { VideoCaptureMutationTransaction } from './videoCaptureMutationTypes';
import type { VideoSessionState } from './sessionState';
import type { VideoHintState } from './videoHintManager';
import type { VideoScreenshotCacheRepository } from './videoScreenshotCacheRepository';
import type { SessionDraftStoragePolicy } from '../sessionDrafts';
import type { VersionedSessionDraftRepository } from '../sessionDrafts/sessionDraftClientRepository';
import type { VideoScreenshotCacheProvisionalRepository } from './videoScreenshotCacheClientRepository';
import type { VideoCaptureScreenshot, VideoTimestampCapture } from './types';
import type { VideoScreenshotCacheSaveResult } from './videoScreenshotCacheRepository';

export interface VideoSessionDraftDomPort {
  readCommentDrafts(): Record<string, string>;
  setCommentDrafts(drafts: Record<string, string>): void;
}

export interface VideoSessionDraftCleanupState {
  isCleaningUp: boolean;
  shouldTrackSavingState: boolean;
}

export type ReadVideoSessionDraftCleanupState = () => VideoSessionDraftCleanupState;

export interface VideoSessionDraftControllerOptions {
  doc: Document;
  state: VideoSessionState;
  destinationState: Pick<ContentExportDestinationState, 'metadata' | 'applyMetadata'>;
  storageArea: StorageAreaService;
  repository: VersionedSessionDraftRepository;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  screenshotCache?:
    | (Pick<VideoScreenshotCacheRepository, 'load' | 'removeMany'> &
        Partial<Pick<VideoScreenshotCacheProvisionalRepository, 'saveProvisional'>>)
    | undefined;
  dom: VideoSessionDraftDomPort;
  trackDraftRestoreEvent?:
    | ((params: UsageEventParamMap['video_draft_restored']) => void | Promise<void>)
    | undefined;
  onScreenshotHydrationStart?: (() => void) | undefined;
  onScreenshotHydrationChange?: (() => void) | undefined;
  onScreenshotHydrationSettled?:
    | ((result: {
        isCurrent: boolean;
        hydratedCount: number;
        invalidRefCount: number;
        staleRefCount: number;
        failedCount: number;
      }) => void)
    | undefined;
  readCleanupState: ReadVideoSessionDraftCleanupState;
}

export interface VideoSessionDraftRuntimePort {
  syncCommentDrafts(): Record<string, string>;
  scheduleSave(): Promise<void>;
  flushNow(status?: 'active' | 'restorable'): Promise<VideoHintState | null>;
  remove(): Promise<void>;
  finalizeTerminal(status: SessionDraftTerminalStatus): Promise<boolean>;
  persistPreparedScreenshot(
    capture: VideoTimestampCapture,
    screenshot: VideoCaptureScreenshot
  ): Promise<VideoScreenshotCacheSaveResult>;
}

export interface VideoSessionPlaybackEditLeasePort {
  begin(captureId: string): void;
  release(captureId: string, restorePlayback: boolean): void;
  reset(): void;
}

export interface VideoSessionScreenshotsPort {
  prepareRequested(captureId: string): void | Promise<void>;
}

export interface VideoSessionMutationPort {
  runCaptureMutation<Result>(
    transaction: VideoCaptureMutationTransaction<Result>
  ): Promise<boolean>;
  hasPendingMutations(): boolean;
}
