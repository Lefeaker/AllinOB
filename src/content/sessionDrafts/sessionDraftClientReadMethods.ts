import type { SessionDraftEnvelope } from './sessionDraftTypes';
import type {
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from './sessionDraftRepositoryMessages';
import type { VersionedSessionDraftRepository } from './sessionDraftWriteOperation';
import {
  isSessionDraftAcknowledgedError,
  SESSION_DRAFT_REPOSITORY_REQUEST_FAILED,
  sessionDraftSelectionFields
} from './sessionDraftClientSupport';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';

type Send = (
  message: SessionDraftRepositoryMessage
) => Promise<Extract<SessionDraftRepositoryResponse, { success: true }>>;

export function createSessionDraftClientReadMethods(dependencies: {
  send: Send;
  acceptEpoch(epoch: number): void;
  remember(envelope: SessionDraftEnvelope, epoch: number, revision: number): void;
  rememberDeletion(draftKey: string, epoch: number, revision: number): void;
  createOperationId(): string;
  clear(): void;
}): Omit<VersionedSessionDraftRepository, 'save' | 'claim' | 'runWriteOperation'> {
  const pendingDeletionIds = new Map<string, string>();
  const deletionOperationId = (identity: string) => {
    const existing = pendingDeletionIds.get(identity);
    if (existing) return existing;
    const operationId = dependencies.createOperationId();
    pendingDeletionIds.set(identity, operationId);
    return operationId;
  };
  return {
    async loadLatest(mode, pageUrl, now, selectionOptions) {
      const response = await dependencies.send({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'loadLatestSessionDraft',
        mode,
        pageUrl,
        ...sessionDraftSelectionFields(now, selectionOptions)
      });
      if (response.operation !== 'loadLatestSessionDraft') {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      dependencies.acceptEpoch(response.result.epoch);
      if (response.result.envelope) {
        dependencies.remember(
          response.result.envelope,
          response.result.epoch,
          response.result.revision
        );
      }
      return response.result.envelope;
    },
    async remove(target) {
      const identity = canonicalJsonStringify({ operation: 'removeSessionDraft', target });
      let response;
      try {
        response = await dependencies.send({
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'removeSessionDraft',
          operationId: deletionOperationId(identity),
          target
        });
      } catch (error) {
        if (isSessionDraftAcknowledgedError(error)) pendingDeletionIds.delete(identity);
        throw error;
      }
      if (response.operation !== 'removeSessionDraft') {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      pendingDeletionIds.delete(identity);
      dependencies.acceptEpoch(response.result.epoch);
      for (const revision of response.result.revisions) {
        dependencies.rememberDeletion(revision.draftKey, response.result.epoch, revision.revision);
      }
    },
    async listCandidates(mode, pageUrl, now, selectionOptions) {
      const response = await dependencies.send({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'listSessionDraftCandidates',
        mode,
        pageUrl,
        ...sessionDraftSelectionFields(now, selectionOptions)
      });
      if (response.operation !== 'listSessionDraftCandidates') {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      dependencies.acceptEpoch(response.result.epoch);
      for (const candidate of response.result.candidates) {
        dependencies.remember(candidate.envelope, response.result.epoch, candidate.revision);
      }
      return response.result.candidates.map((candidate) => candidate.envelope);
    },
    async pruneExpired(now) {
      const identity = canonicalJsonStringify({
        operation: 'pruneExpiredSessionDrafts',
        ...(now === undefined ? {} : { now })
      });
      let response;
      try {
        response = await dependencies.send({
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'pruneExpiredSessionDrafts',
          operationId: deletionOperationId(identity),
          ...(now === undefined ? {} : { now })
        });
      } catch (error) {
        if (isSessionDraftAcknowledgedError(error)) pendingDeletionIds.delete(identity);
        throw error;
      }
      if (response.operation !== 'pruneExpiredSessionDrafts') {
        throw new Error(SESSION_DRAFT_REPOSITORY_REQUEST_FAILED);
      }
      pendingDeletionIds.delete(identity);
      dependencies.acceptEpoch(response.result.epoch);
      for (const revision of response.result.revisions) {
        dependencies.rememberDeletion(revision.draftKey, response.result.epoch, revision.revision);
      }
    }
  };
}
