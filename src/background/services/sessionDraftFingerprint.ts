import type { SessionDraftOperationContext } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import type { SessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftTypes';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';

const textEncoder = new TextEncoder();

export function createRequestFingerprint(
  context: SessionDraftOperationContext,
  envelope: SessionDraftEnvelope
): Promise<string> {
  return digestValue({ context, envelope });
}

export function createEnvelopeFingerprint(envelope: SessionDraftEnvelope): Promise<string> {
  return digestValue(envelope);
}

async function digestValue(value: RuntimePropertyValue): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(canonicalJsonStringify(value))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createSessionDraftProtocolFingerprint(
  value: RuntimePropertyValue
): Promise<string> {
  return digestValue(value);
}
