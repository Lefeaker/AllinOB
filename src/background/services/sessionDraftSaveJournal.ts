import type { StorageAreaService } from '../../platform/interfaces/storage';
import { readExactOwnDataRecord, readOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import {
  normalizeSessionDraftOperationContext,
  type SessionDraftOperationContext
} from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';
import {
  hasOwnProtocolKey as hasOwn,
  isNonEmptyProtocolString as isNonEmptyString,
  isNonNegativeSafeInteger as isNonNegativeInteger,
  isProtocolFingerprint as isFingerprint
} from './sessionDraftProtocolValueGuards';
import { isSessionDraftProtocolKeyQuarantined } from './sessionDraftProtocolCorruption';
import {
  createSessionDraftCursorStorageKey,
  normalizeSessionDraftCursor,
  type SessionDraftCursor
} from '../../content/sessionDrafts/sessionDraftLifecycleRecords';
export {
  createSessionDraftCursorStorageKey,
  normalizeSessionDraftCursor,
  type SessionDraftCursor
} from '../../content/sessionDrafts/sessionDraftLifecycleRecords';

export const SESSION_DRAFT_OUTCOME_PREFIX = 'aiob.restoreStorage.outcome.v1.';
export const SESSION_DRAFT_PENDING_PREFIX = 'aiob.restoreStorage.pending.v1.';
export const SESSION_DRAFT_OUTCOME_TTL_MS = 15 * 60 * 1_000;
export const SESSION_DRAFT_JOURNAL_TTL_MS = 15 * 60 * 1_000;
export const RESTORE_STORAGE_PENDING_WAL_TOO_LARGE = 'RESTORE_STORAGE_PENDING_WAL_TOO_LARGE';
export const SESSION_DRAFT_PENDING_WAL_MAX_BYTES = 2_048;
const textEncoder = new TextEncoder();

export interface SessionDraftOutcome {
  schemaVersion: 1;
  kind: 'save';
  operationId: string;
  draftKey: string;
  revision: number;
  requestFingerprint: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionDraftSaveJournal {
  schemaVersion: 1;
  state: 'pending' | 'committed';
  operationId: string;
  context: SessionDraftOperationContext;
  requestFingerprint: string;
  desiredEnvelopeFingerprint: string;
  previousEnvelopeFingerprint: string | null;
  createdAt: number;
  expiresAt: number;
}

export type ProtocolRecordState<Value> =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: Value };

export function readCursorState(
  area: Pick<StorageAreaService, 'get'>,
  draftKey: string
): Promise<ProtocolRecordState<SessionDraftCursor>> {
  return readRecord(
    area,
    createSessionDraftCursorStorageKey(draftKey),
    normalizeSessionDraftCursor
  );
}

export function readOutcomeState(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string
): Promise<ProtocolRecordState<SessionDraftOutcome>> {
  return readRecord(
    area,
    createSessionDraftOutcomeStorageKey(operationId),
    normalizeSessionDraftOutcome
  );
}

export function readJournalState(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string
): Promise<ProtocolRecordState<SessionDraftSaveJournal>> {
  return readRecord(
    area,
    createSessionDraftPendingStorageKey(operationId),
    normalizeSessionDraftSaveJournal
  );
}

export function writePendingJournal(
  area: Pick<StorageAreaService, 'set'>,
  journal: SessionDraftSaveJournal
): Promise<void> {
  assertSessionDraftJournalSize(journal);
  return area.set(createSessionDraftPendingStorageKey(journal.operationId), journal);
}

export function finalizeJournal(
  area: Pick<StorageAreaService, 'setMany'>,
  journal: SessionDraftSaveJournal,
  cursor: SessionDraftCursor,
  outcome: SessionDraftOutcome
): Promise<void> {
  const committedJournal = { ...journal, state: 'committed' as const };
  assertSessionDraftJournalSize(committedJournal);
  return area.setMany({
    [createSessionDraftCursorStorageKey(journal.context.draftKey)]: cursor,
    [createSessionDraftOutcomeStorageKey(journal.operationId)]: outcome,
    [createSessionDraftPendingStorageKey(journal.operationId)]: committedJournal
  });
}

function assertSessionDraftJournalSize(journal: SessionDraftSaveJournal): void {
  if (
    textEncoder.encode(canonicalJsonStringify(journal)).byteLength >
    SESSION_DRAFT_PENDING_WAL_MAX_BYTES
  ) {
    throw new Error(RESTORE_STORAGE_PENDING_WAL_TOO_LARGE);
  }
}

export async function cleanupJournal(
  area: Pick<StorageAreaService, 'remove'>,
  operationId: string
): Promise<void> {
  await area.remove(createSessionDraftPendingStorageKey(operationId));
}

async function readRecord<Value>(
  area: Pick<StorageAreaService, 'get'>,
  key: string,
  normalize: (value: RuntimePropertyValue) => Value | null
): Promise<ProtocolRecordState<Value>> {
  if (await isSessionDraftProtocolKeyQuarantined(area, key)) return { kind: 'invalid' };
  const raw = await area.get(key);
  if (raw === undefined) return { kind: 'missing' };
  const value = normalize(raw);
  return value ? { kind: 'valid', value } : { kind: 'invalid' };
}

export function createSessionDraftOutcomeStorageKey(operationId: string): string {
  return `${SESSION_DRAFT_OUTCOME_PREFIX}${encodeURIComponent(operationId)}`;
}

export function createSessionDraftPendingStorageKey(operationId: string): string {
  return `${SESSION_DRAFT_PENDING_PREFIX}${encodeURIComponent(operationId)}`;
}

export function normalizeSessionDraftOutcome<Value>(value: Value): SessionDraftOutcome | null {
  const snapshot = readOwnDataRecord(value);
  if (!snapshot) return null;
  const isCurrent = hasOwn(snapshot, 'kind');
  const outcome = readExactOwnDataRecord(snapshot, [
    'schemaVersion',
    ...(isCurrent ? ['kind'] : []),
    'operationId',
    'draftKey',
    'revision',
    'requestFingerprint',
    'createdAt',
    'expiresAt'
  ]);
  return outcome &&
    outcome.schemaVersion === 1 &&
    (!isCurrent || outcome.kind === 'save') &&
    isNonEmptyString(outcome.operationId) &&
    isNonEmptyString(outcome.draftKey) &&
    isNonNegativeInteger(outcome.revision) &&
    isFingerprint(outcome.requestFingerprint) &&
    isNonNegativeInteger(outcome.createdAt) &&
    isNonNegativeInteger(outcome.expiresAt) &&
    outcome.expiresAt - outcome.createdAt === SESSION_DRAFT_OUTCOME_TTL_MS
    ? {
        schemaVersion: 1,
        kind: 'save',
        operationId: outcome.operationId,
        draftKey: outcome.draftKey,
        revision: outcome.revision,
        requestFingerprint: outcome.requestFingerprint,
        createdAt: outcome.createdAt,
        expiresAt: outcome.expiresAt
      }
    : null;
}

export function normalizeSessionDraftSaveJournal<Value>(
  value: Value
): SessionDraftSaveJournal | null {
  const journal = readExactOwnDataRecord(value, [
    'schemaVersion',
    'state',
    'operationId',
    'context',
    'requestFingerprint',
    'desiredEnvelopeFingerprint',
    'previousEnvelopeFingerprint',
    'createdAt',
    'expiresAt'
  ]);
  if (
    !journal ||
    journal.schemaVersion !== 1 ||
    (journal.state !== 'pending' && journal.state !== 'committed') ||
    !isNonEmptyString(journal.operationId) ||
    !isFingerprint(journal.requestFingerprint) ||
    !isFingerprint(journal.desiredEnvelopeFingerprint) ||
    !isNonNegativeInteger(journal.createdAt) ||
    !isNonNegativeInteger(journal.expiresAt) ||
    journal.expiresAt - journal.createdAt !== SESSION_DRAFT_JOURNAL_TTL_MS ||
    (journal.previousEnvelopeFingerprint !== null &&
      !isFingerprint(journal.previousEnvelopeFingerprint))
  ) {
    return null;
  }
  const contextRecord = readExactOwnDataRecord(journal.context, [
    'operationId',
    'epoch',
    'draftKey',
    'baseRevision',
    'nextRevision'
  ]);
  const context = contextRecord && normalizeSessionDraftOperationContext(contextRecord);
  return context
    ? {
        schemaVersion: 1,
        state: journal.state,
        operationId: journal.operationId,
        context,
        requestFingerprint: journal.requestFingerprint,
        desiredEnvelopeFingerprint: journal.desiredEnvelopeFingerprint,
        previousEnvelopeFingerprint: journal.previousEnvelopeFingerprint,
        createdAt: journal.createdAt,
        expiresAt: journal.expiresAt
      }
    : null;
}
