import {
  containsDisallowedSessionDraftPayloadValue,
  measureSessionDraftValueBytes
} from './sessionDraftSchemas';
import { getSessionDraftEnvelopeOwnerContext } from './sessionDraftTabContext';
import type { SessionDraftEnvelope, SessionDraftOwnerContext } from './sessionDraftTypes';

export function ensureSessionDraftEnvelopeAllowed(
  envelope: SessionDraftEnvelope,
  maxEnvelopeBytes: number
): void {
  if (containsDisallowedSessionDraftPayloadValue(envelope.payload)) {
    throw new Error('Session draft payload must not contain data:image/ strings or binary data.');
  }
  if (measureSessionDraftValueBytes(envelope) > maxEnvelopeBytes) {
    throw new Error('Session draft envelope exceeds the configured storage limit.');
  }
}

export function applySessionDraftOwnerContext(
  envelope: SessionDraftEnvelope,
  ownerContext: SessionDraftOwnerContext | null
): SessionDraftEnvelope {
  const payload = { ...envelope.payload };
  const nextOwnerContext = ownerContext ?? getSessionDraftEnvelopeOwnerContext(envelope);
  if (nextOwnerContext) payload.ownerContext = nextOwnerContext;
  else delete payload.ownerContext;
  return { ...envelope, payload };
}
