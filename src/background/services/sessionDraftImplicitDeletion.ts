import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import type { SessionDraftRepositoryServiceDependencies } from './sessionDraftRepositoryServiceTypes';
import { repairSessionDraftIndex } from '../../content/sessionDrafts/sessionDraftReferenceIndex';

export async function executeImplicitSessionDraftDeletion(
  dependencies: Pick<SessionDraftRepositoryServiceDependencies, 'deleteDraftCandidates'>,
  keys: readonly string[],
  cause: string,
  parentOperationId?: string
): Promise<void> {
  if (keys.length === 0) return;
  const operationId = `implicit-${globalThis.crypto.randomUUID()}`;
  const candidateKeys = [...new Set(keys)].sort();
  await dependencies.deleteDraftCandidates({
    operationId,
    requestFingerprint: await createSessionDraftProtocolFingerprint({
      operationId,
      ...(parentOperationId ? { parentOperationId } : {}),
      cause,
      candidateKeys
    }),
    candidateKeys
  });
}

export async function repairSessionDraftIndexWithDeletionOwner(
  dependencies: SessionDraftRepositoryServiceDependencies,
  parentOperationId: string,
  cause: string
): Promise<void> {
  await repairSessionDraftIndex(dependencies.local, (keys) =>
    executeImplicitSessionDraftDeletion(dependencies, keys, cause, parentOperationId)
  );
}
