import { createSessionDraftRepository } from '../../content/sessionDrafts/sessionDraftRepository';
import { repairSessionDraftIndex } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type {
  SessionDraftRepositoryMessage,
  SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  saveSessionDraft
} from './sessionDraftSaveService';
import {
  readSessionDraftEpoch,
  RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';
import { consumeMatchingRestoreStorageLease } from './restoreStorageLeaseStore';
import { prepareSessionDraftOperation } from './sessionDraftOperationPreparation';
import { claimSessionDraft } from './sessionDraftClaimService';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import type { SessionDraftDeletionResult } from './sessionDraftDeletionOwner';
import {
  maintainSessionDraftProtocol,
  readSessionDraftEnvelopeRevision,
  readSessionDraftSelectionProtection
} from './sessionDraftRepositoryMaintenance';
import { executeImplicitSessionDraftDeletion } from './sessionDraftImplicitDeletion';

export type { SessionDraftRepositoryServiceDependencies } from './sessionDraftRepositoryServiceTypes';
export {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED,
  RESTORE_STORAGE_REVISION_CONFLICT
} from './sessionDraftSaveService';

export async function handleSessionDraftRepositoryMessage(
  message: SessionDraftRepositoryMessage,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<SessionDraftRepositoryResponse> {
  if (message.operation === 'saveSessionDraft') {
    return saveSessionDraft(message.context, message.envelope, dependencies);
  }
  await maintainSessionDraftProtocol(dependencies);
  if (message.operation === 'cancelSessionDraftOperation') {
    await consumeMatchingRestoreStorageLease(dependencies.local, message.context);
    return { success: true, operation: message.operation, context: message.context };
  }
  if (message.operation === 'prepareSessionDraftOperation') {
    return prepareSessionDraftOperation(message, dependencies);
  }
  if (message.operation === 'claimSessionDraft') {
    return claimSessionDraft(message, dependencies);
  }
  if (
    (message.operation === 'loadLatestSessionDraft' ||
      message.operation === 'listSessionDraftCandidates') &&
    message.options?.ownerContext != null
  ) {
    return { success: false, error: RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED };
  }
  if (
    message.operation === 'loadLatestSessionDraft' ||
    message.operation === 'listSessionDraftCandidates'
  ) {
    await repairSessionDraftIndex(dependencies.local, (keys) =>
      executeImplicitSessionDraftDeletion(dependencies, keys, 'repository-read-repair')
    );
  }
  const protection = await readSessionDraftSelectionProtection(dependencies);
  let deletionResult: SessionDraftDeletionResult | null = null;
  const explicitOperationId =
    message.operation === 'removeSessionDraft' || message.operation === 'pruneExpiredSessionDrafts'
      ? message.operationId
      : null;
  const requestFingerprint = await createSessionDraftProtocolFingerprint(
    explicitOperationId
      ? {
          operation: message.operation,
          operationId: explicitOperationId,
          ...('target' in message ? { target: message.target } : {}),
          ...('now' in message && message.now !== undefined ? { now: message.now } : {})
        }
      : { operation: message.operation }
  );
  if (explicitOperationId) {
    const replay = await dependencies.replayDraftDeletion(explicitOperationId, requestFingerprint);
    if (replay) {
      if (message.operation === 'removeSessionDraft') {
        return { success: true, operation: message.operation, result: replay };
      }
      if (message.operation === 'pruneExpiredSessionDrafts') {
        return { success: true, operation: message.operation, result: replay };
      }
    }
  }
  const repository = createSessionDraftRepository(protection.local, {
    storagePolicy: protection.policy,
    resolveOwnerContext: () => null,
    async deleteKeys(keys, cause) {
      if (deletionResult && explicitOperationId) {
        throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
      }
      const operationId = explicitOperationId ?? `implicit-${globalThis.crypto.randomUUID()}`;
      const fingerprint = explicitOperationId
        ? requestFingerprint
        : await createSessionDraftProtocolFingerprint({
            operationId,
            cause,
            keys: [...keys].sort()
          });
      const next = await dependencies.deleteDraftCandidates({
        operationId,
        requestFingerprint: fingerprint,
        candidateKeys: keys
      });
      deletionResult = deletionResult
        ? {
            epoch: next.epoch,
            revisions: [...deletionResult.revisions, ...next.revisions].sort((a, b) =>
              a.draftKey.localeCompare(b.draftKey)
            ),
            protectedKeys: [
              ...new Set([...deletionResult.protectedKeys, ...next.protectedKeys])
            ].sort(),
            replayed: deletionResult.replayed && next.replayed
          }
        : next;
    }
  });
  const flushDeletions = async () => {
    if (deletionResult || !explicitOperationId) return deletionResult;
    deletionResult = await dependencies.deleteDraftCandidates({
      operationId: explicitOperationId,
      requestFingerprint,
      candidateKeys: []
    });
    return deletionResult;
  };
  switch (message.operation) {
    case 'loadLatestSessionDraft': {
      const envelope = await repository.loadLatest(
        message.mode,
        message.pageUrl,
        message.now,
        message.options
      );
      await flushDeletions();
      return {
        success: true,
        operation: message.operation,
        result: {
          envelope,
          epoch: await readSessionDraftEpoch(dependencies),
          revision: envelope
            ? await readSessionDraftEnvelopeRevision(dependencies.local, envelope)
            : 0
        }
      };
    }
    case 'listSessionDraftCandidates': {
      const candidates = await repository.listCandidates(
        message.mode,
        message.pageUrl,
        message.now,
        message.options
      );
      await flushDeletions();
      return {
        success: true,
        operation: message.operation,
        result: {
          candidates: await Promise.all(
            candidates.map(async (envelope) => ({
              envelope,
              revision: await readSessionDraftEnvelopeRevision(dependencies.local, envelope)
            }))
          ),
          epoch: await readSessionDraftEpoch(dependencies)
        }
      };
    }
    case 'removeSessionDraft':
      await repository.remove(message.target);
      deletionResult = await flushDeletions();
      if (!deletionResult) throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
      return { success: true, operation: message.operation, result: deletionResult };
    case 'pruneExpiredSessionDrafts':
      await repository.pruneExpired(message.now);
      deletionResult = await flushDeletions();
      if (!deletionResult) throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
      return { success: true, operation: message.operation, result: deletionResult };
  }
}
