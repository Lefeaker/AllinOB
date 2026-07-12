import {
  readExactOwnDataRecord,
  readOwnJsonDataValue
} from '../../shared/guards/exactOwnDataRecord';
import { SessionDraftEnvelopeSchema } from './sessionDraftSchemas';
import type { SessionDraftEnvelope } from './sessionDraftTypes';

const SESSION_DRAFT_ENVELOPE_KEYS: readonly string[] = [
  'schemaVersion',
  'draftId',
  'mode',
  'pageKey',
  'pageUrl',
  'pageTitle',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'status',
  'payload'
];

export function normalizeSessionDraftEnvelope<Value>(value: Value): SessionDraftEnvelope | null {
  const data = readOwnJsonDataValue(value);
  const snapshot = readExactOwnDataRecord(data, SESSION_DRAFT_ENVELOPE_KEYS);
  if (!snapshot) return null;
  const parsed = SessionDraftEnvelopeSchema.safeParse(snapshot);
  return parsed.success && isSessionDraftEnvelope(parsed.data) ? parsed.data : null;
}

function isSessionDraftEnvelope(value: object): value is SessionDraftEnvelope {
  return SessionDraftEnvelopeSchema.safeParse(value).success;
}
