import { createSessionDraftRepository } from '../../content/sessionDrafts/sessionDraftRepository';
import { repairSessionDraftIndex } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type {
  SessionDraftEnvelope,
  SessionDraftStoragePolicy
} from '../../content/sessionDrafts/sessionDraftTypes';
import type {
  SessionDraftOperationContext,
  SessionDraftRepositoryResponse
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import { consumeRestoreStorageLease } from './restoreStorageLeaseStore';
import {
  cleanupJournal,
  finalizeJournal,
  SESSION_DRAFT_OUTCOME_TTL_MS,
  type SessionDraftCursor,
  type SessionDraftOutcome,
  type SessionDraftSaveJournal
} from './sessionDraftSaveJournal';
import type { SessionDraftRepositoryServiceDependencies } from './sessionDraftRepositoryServiceTypes';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import { executeImplicitSessionDraftDeletion } from './sessionDraftImplicitDeletion';

export async function commitSessionDraftSave(args: {
  context: SessionDraftOperationContext;
  normalizedEnvelope: SessionDraftEnvelope;
  protectedLocal: StorageAreaService;
  policy: SessionDraftStoragePolicy;
  journal: SessionDraftSaveJournal;
  derivedDraftKey: string;
  requestFingerprint: string;
  operationTime: number;
  dependencies: SessionDraftRepositoryServiceDependencies;
  replayed: boolean;
}): Promise<SessionDraftRepositoryResponse> {
  await createSessionDraftRepository(args.protectedLocal, {
    storagePolicy: args.policy,
    resolveOwnerContext: () => null,
    async deleteKeys(keys, cause) {
      const operationId = `implicit-${globalThis.crypto.randomUUID()}`;
      const fingerprint = await createSessionDraftProtocolFingerprint({
        operationId,
        parentOperationId: args.context.operationId,
        cause,
        keys: [...keys].sort()
      });
      await args.dependencies.deleteDraftCandidates({
        operationId,
        requestFingerprint: fingerprint,
        candidateKeys: keys
      });
    }
  }).save(args.normalizedEnvelope, { ownerContext: null });
  await repairSessionDraftIndex(args.dependencies.local, (keys) =>
    executeImplicitSessionDraftDeletion(
      args.dependencies,
      keys,
      'save-commit-index-repair',
      args.context.operationId
    )
  );
  const nextCursor: SessionDraftCursor = {
    schemaVersion: 1,
    epoch: args.context.epoch,
    state: 'present',
    draftKey: args.derivedDraftKey,
    revision: args.context.nextRevision,
    lastOperationId: args.context.operationId
  };
  const nextOutcome: SessionDraftOutcome = {
    schemaVersion: 1,
    kind: 'save',
    operationId: args.context.operationId,
    draftKey: args.derivedDraftKey,
    revision: args.context.nextRevision,
    requestFingerprint: args.requestFingerprint,
    createdAt: args.operationTime,
    expiresAt: args.operationTime + SESSION_DRAFT_OUTCOME_TTL_MS
  };
  await finalizeJournal(args.dependencies.local, args.journal, nextCursor, nextOutcome);
  await consumeRestoreStorageLease(args.dependencies.local, args.context.operationId);
  await cleanupJournal(args.dependencies.local, args.context.operationId).catch(() => undefined);
  return {
    success: true,
    operation: 'saveSessionDraft',
    revision: args.context.nextRevision,
    replayed: args.replayed
  };
}
