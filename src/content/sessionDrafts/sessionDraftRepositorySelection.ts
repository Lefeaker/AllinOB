import {
  getSessionDraftEnvelopeOwnerContext,
  isSameSessionDraftOwnerContext,
  normalizeSessionDraftOwnerContext
} from './sessionDraftTabContext';
import type {
  SessionDraftEnvelope,
  SessionDraftOwnerContext,
  SessionDraftSaveOptions,
  SessionDraftSelectionOptions
} from './sessionDraftTypes';

type OwnerOptions = SessionDraftSaveOptions | SessionDraftSelectionOptions;
type MaybeOwner = SessionDraftOwnerContext | null | undefined;
type MaybePromise<T> = T | Promise<T>;

export async function resolveSessionDraftOperationOwnerContext(
  options: OwnerOptions | undefined,
  resolveCurrent: () => MaybePromise<MaybeOwner>
): Promise<SessionDraftOwnerContext | null> {
  if (options && Object.prototype.hasOwnProperty.call(options, 'ownerContext')) {
    return normalizeSessionDraftOwnerContext(options.ownerContext);
  }
  return normalizeSessionDraftOwnerContext(await resolveCurrent());
}

export async function pickPreferredSessionDraftCandidate(
  candidates: SessionDraftEnvelope[],
  ownerContext: SessionDraftOwnerContext | null,
  isOwnerContextActive: (ownerContext: SessionDraftOwnerContext) => MaybePromise<boolean>
): Promise<SessionDraftEnvelope | null> {
  if (candidates.length === 0) return null;
  if (!ownerContext) return candidates[0] ?? null;

  const sameOwner = candidates.find((candidate) =>
    isSameSessionDraftOwnerContext(getSessionDraftEnvelopeOwnerContext(candidate), ownerContext)
  );
  if (sameOwner) return sameOwner;

  const claimable = candidates.find(
    (candidate) =>
      candidate.status === 'restorable' || getSessionDraftEnvelopeOwnerContext(candidate) === null
  );
  if (claimable) return claimable;

  for (const candidate of candidates) {
    const candidateOwner = getSessionDraftEnvelopeOwnerContext(candidate);
    if (
      candidate.status === 'active' &&
      candidateOwner &&
      !(await isOwnerContextActive(candidateOwner))
    ) {
      return candidate;
    }
  }
  return null;
}

export async function claimSessionDraftCandidate(
  candidate: SessionDraftEnvelope | null,
  ownerContext: SessionDraftOwnerContext | null,
  save: (
    envelope: SessionDraftEnvelope,
    options: SessionDraftSaveOptions
  ) => Promise<SessionDraftEnvelope>
): Promise<SessionDraftEnvelope | null> {
  if (
    !candidate ||
    !ownerContext ||
    isSameSessionDraftOwnerContext(getSessionDraftEnvelopeOwnerContext(candidate), ownerContext)
  )
    return candidate;
  return save(candidate, { ownerContext });
}
