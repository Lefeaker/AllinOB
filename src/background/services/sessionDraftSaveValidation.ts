import {
  containsDisallowedSessionDraftPayloadValue,
  measureSessionDraftValueBytes
} from '../../content/sessionDrafts/sessionDraftSchemas';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';

export function validateSessionDraftEnvelopeBeforeWal(
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
