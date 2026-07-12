import type { SessionDraftRepositoryResponse } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REVISION_CONFLICT
} from './sessionDraftRepositoryServiceTypes';

export function invalidState(): Error {
  return new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
}

export function conflict(): SessionDraftRepositoryResponse {
  return { success: false, error: RESTORE_STORAGE_REVISION_CONFLICT };
}

export function saveSuccess(revision: number, replayed: boolean): SessionDraftRepositoryResponse {
  return { success: true, operation: 'saveSessionDraft', revision, replayed };
}
