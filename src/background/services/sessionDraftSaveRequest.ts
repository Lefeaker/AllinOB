import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey
} from '../../content/sessionDrafts/sessionDraftKeys';
import { normalizeSessionDraftEnvelopeForSave } from '../../content/sessionDrafts/sessionDraftSchemas';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import type { SessionDraftOperationContext } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import { consumeMatchingRestoreStorageLease } from './restoreStorageLeaseStore';
import { createRequestFingerprint } from './sessionDraftFingerprint';
import {
  readSessionDraftEpoch,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';
import { validateSessionDraftEnvelopeBeforeWal } from './sessionDraftSaveValidation';
import { normalizeSessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftEnvelopeCodec';
import {
  getSessionDraftEnvelopeOwnerContext,
  isSameSessionDraftOwnerContext
} from '../../content/sessionDrafts/sessionDraftTabContext';
import { RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED } from './sessionDraftRepositoryServiceTypes';

export interface PreparedSessionDraftSaveRequest {
  policy: SessionDraftStoragePolicy;
  derivedDraftKey: string;
  normalizedEnvelope: SessionDraftEnvelope;
  requestFingerprint: string;
}

export async function prepareSessionDraftSaveRequest(
  context: SessionDraftOperationContext,
  envelope: SessionDraftEnvelope,
  dependencies: SessionDraftRepositoryServiceDependencies
): Promise<PreparedSessionDraftSaveRequest | null> {
  const policy = dependencies.getStoragePolicy();
  const derivedPageKey = createSessionDraftPageKey(envelope.mode, envelope.pageUrl);
  const derivedDraftKey = createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: derivedPageKey,
    draftId: envelope.draftId
  });
  if (
    envelope.pageKey !== derivedPageKey ||
    context.draftKey !== derivedDraftKey ||
    context.nextRevision !== context.baseRevision + 1 ||
    context.epoch !== (await readSessionDraftEpoch(dependencies))
  ) {
    await consumeMatchingRestoreStorageLease(dependencies.local, context);
    return null;
  }
  const candidateEnvelope = normalizeSessionDraftEnvelopeForSave(
    envelope,
    policy.retentionPolicy.retentionMs
  );
  const stored = await dependencies.local.get(derivedDraftKey);
  const storedEnvelope = normalizeSessionDraftEnvelope(stored);
  const previousOwner = storedEnvelope ? getSessionDraftEnvelopeOwnerContext(storedEnvelope) : null;
  const requestOwner = dependencies.requestOwnerContext ?? null;
  if (requestOwner && requestOwner.tabId === undefined) {
    throw new Error(RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED);
  }
  let authorizedTransfer = false;
  if (previousOwner && !isSameSessionDraftOwnerContext(previousOwner, requestOwner)) {
    const transfer = dependencies.claimTransfer;
    if (
      !transfer ||
      transfer.operationId !== context.operationId ||
      transfer.draftKey !== derivedDraftKey ||
      !isSameSessionDraftOwnerContext(transfer.previousOwner, previousOwner) ||
      !isSameSessionDraftOwnerContext(transfer.nextOwner, requestOwner)
    ) {
      throw new Error(RESTORE_STORAGE_VERSIONED_CLAIM_REQUIRED);
    }
    authorizedTransfer = true;
  }
  const ownerContext = authorizedTransfer ? requestOwner : (previousOwner ?? requestOwner);
  const payload = { ...candidateEnvelope.payload };
  if (ownerContext) payload.ownerContext = ownerContext;
  else delete payload.ownerContext;
  const normalizedEnvelope = { ...candidateEnvelope, payload };
  let requestFingerprint: string;
  try {
    validateSessionDraftEnvelopeBeforeWal(normalizedEnvelope, policy.maxEnvelopeBytes);
    requestFingerprint = await createRequestFingerprint(context, normalizedEnvelope);
  } catch (error) {
    await consumeMatchingRestoreStorageLease(dependencies.local, context);
    throw error;
  }
  return { policy, derivedDraftKey, normalizedEnvelope, requestFingerprint };
}
