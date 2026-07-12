import type {
  SessionDraftEnvelope,
  SessionDraftMode,
  SessionDraftRemovalTarget,
  SessionDraftSelectionOptions
} from './sessionDraftTypes';

export type SessionDraftRepositoryOperation =
  | 'prepareSessionDraftOperation'
  | 'cancelSessionDraftOperation'
  | 'claimSessionDraft'
  | 'loadLatestSessionDraft'
  | 'saveSessionDraft'
  | 'removeSessionDraft'
  | 'listSessionDraftCandidates'
  | 'pruneExpiredSessionDrafts';

export interface SessionDraftOperationContext {
  operationId: string;
  epoch: number;
  draftKey: string;
  baseRevision: number;
  nextRevision: number;
}

export const SESSION_DRAFT_OPERATION_ID_MAX_LENGTH = 128;
export const SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH = 512;
export const SESSION_DRAFT_DELETION_MAX_TARGETS = 2_048;

export interface SessionDraftLoadSnapshot {
  envelope: SessionDraftEnvelope | null;
  epoch: number;
  revision: number;
}

export interface SessionDraftCandidateSnapshot {
  envelope: SessionDraftEnvelope;
  revision: number;
}

export interface SessionDraftDeletionSnapshot {
  epoch: number;
  revisions: Array<{ draftKey: string; revision: number }>;
  protectedKeys: string[];
  replayed: boolean;
}

export type SessionDraftRepositoryMessage =
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'prepareSessionDraftOperation';
      operationId: string;
      draftKey: string;
      expectedEpoch?: number;
      expectedRevision?: number;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'cancelSessionDraftOperation';
      context: SessionDraftOperationContext;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'claimSessionDraft';
      operationId: string;
      draftKey: string;
      expectedEpoch: number;
      expectedRevision: number;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'saveSessionDraft';
      context: SessionDraftOperationContext;
      envelope: SessionDraftEnvelope;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'loadLatestSessionDraft' | 'listSessionDraftCandidates';
      mode: SessionDraftMode;
      pageUrl: string;
      now?: number;
      options?: SessionDraftSelectionOptions;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'removeSessionDraft';
      operationId: string;
      target: SessionDraftRemovalTarget;
    }
  | {
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE';
      operation: 'pruneExpiredSessionDrafts';
      operationId: string;
      now?: number;
    };

export type SessionDraftRepositoryResponse =
  | {
      success: true;
      operation: 'prepareSessionDraftOperation';
      context: SessionDraftOperationContext;
      replayed: boolean;
      status: 'prepared' | 'completed';
    }
  | { success: true; operation: 'saveSessionDraft'; revision: number; replayed: boolean }
  | {
      success: true;
      operation: 'claimSessionDraft';
      context: SessionDraftOperationContext;
      revision: number;
      replayed: boolean;
    }
  | { success: true; operation: 'loadLatestSessionDraft'; result: SessionDraftLoadSnapshot }
  | {
      success: true;
      operation: 'listSessionDraftCandidates';
      result: { candidates: SessionDraftCandidateSnapshot[]; epoch: number };
    }
  | {
      success: true;
      operation: 'cancelSessionDraftOperation';
      context: SessionDraftOperationContext;
    }
  | {
      success: true;
      operation: 'removeSessionDraft' | 'pruneExpiredSessionDrafts';
      result: SessionDraftDeletionSnapshot;
    }
  | { success: false; error: string };
