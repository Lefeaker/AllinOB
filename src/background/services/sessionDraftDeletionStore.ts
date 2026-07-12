import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { isSessionDraftDeletionRecordBounded } from './sessionDraftDeletionRecordBounds';
import {
  classifiesSessionDraftDeletionCandidates,
  normalizeSessionDraftDeletionKeys,
  normalizeSessionDraftDeletionRevisions
} from './sessionDraftDeletionRecordCodecs';
import type { SessionDraftDeletionRevision } from './sessionDraftDeletionTypes';
export type { SessionDraftDeletionRevision } from './sessionDraftDeletionTypes';
export {
  assertSessionDraftDeletionRecordBounded,
  SESSION_DRAFT_DELETE_RECORD_MAX_BYTES
} from './sessionDraftDeletionRecordBounds';
export {
  createSessionDraftTombstoneStorageKey,
  normalizeSessionDraftTombstone,
  type SessionDraftTombstone
} from '../../content/sessionDrafts/sessionDraftLifecycleRecords';

export const SESSION_DRAFT_DELETE_MAX_TARGETS = 2_048;
// At two keys, even JSON's six-byte escaping worst case remains bounded:
// 2 candidates * 2 appearances * 512 UTF-16 units * 6 bytes = 12 KiB.
export const SESSION_DRAFT_DELETE_CHUNK_SIZE = 2;
export const SESSION_DRAFT_DELETE_RECEIPT_TTL_MS = 15 * 60 * 1_000;
export const SESSION_DRAFT_DELETE_MANIFEST_PREFIX = 'aiob.restoreStorage.delete.v1.';
export const SESSION_DRAFT_DELETE_CHUNK_PREFIX = 'aiob.restoreStorage.deleteChunk.v1.';

export interface SessionDraftDeletionManifest {
  schemaVersion: 1;
  kind: 'delete';
  state: 'pending' | 'committed';
  operationId: string;
  epoch: number;
  requestFingerprint: string;
  candidateFingerprint: string;
  candidateCount: number;
  chunkCount: number;
  createdAt: number;
  expiresAt: number;
}

export interface SessionDraftDeletionChunk {
  schemaVersion: 1;
  kind: 'delete';
  state: 'selected' | 'prepared' | 'committed';
  operationId: string;
  epoch: number;
  chunkIndex: number;
  requestFingerprint: string;
  candidateFingerprint: string;
  candidateCount: number;
  candidateKeys: string[];
  revisions: SessionDraftDeletionRevision[];
  existingRevisions: SessionDraftDeletionRevision[];
  protectedKeys: string[];
  createdAt: number;
  expiresAt: number;
}

export function normalizeSessionDraftDeletionManifest<Value>(
  value: Value
): SessionDraftDeletionManifest | null {
  const manifest = readExactOwnDataRecord(value, [
    'schemaVersion',
    'kind',
    'state',
    'operationId',
    'epoch',
    'requestFingerprint',
    'candidateFingerprint',
    'candidateCount',
    'chunkCount',
    'createdAt',
    'expiresAt'
  ]);
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'delete' ||
    (manifest.state !== 'pending' && manifest.state !== 'committed') ||
    !isBoundedString(manifest.operationId, 128) ||
    !isNonNegativeInteger(manifest.epoch) ||
    !isFingerprint(manifest.requestFingerprint) ||
    !isFingerprint(manifest.candidateFingerprint) ||
    !isNonNegativeInteger(manifest.candidateCount) ||
    manifest.candidateCount > SESSION_DRAFT_DELETE_MAX_TARGETS ||
    !isNonNegativeInteger(manifest.chunkCount) ||
    manifest.chunkCount !== Math.ceil(manifest.candidateCount / SESSION_DRAFT_DELETE_CHUNK_SIZE) ||
    !isNonNegativeInteger(manifest.createdAt) ||
    !isNonNegativeInteger(manifest.expiresAt) ||
    !hasExactLifetime(manifest.createdAt, manifest.expiresAt)
  )
    return null;
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    state: manifest.state,
    operationId: manifest.operationId,
    epoch: manifest.epoch,
    requestFingerprint: manifest.requestFingerprint,
    candidateFingerprint: manifest.candidateFingerprint,
    candidateCount: manifest.candidateCount,
    chunkCount: manifest.chunkCount,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt
  };
}

export function normalizeSessionDraftDeletionOutcome<Value>(
  value: Value
): SessionDraftDeletionManifest | null {
  const manifest = normalizeSessionDraftDeletionManifest(value);
  return manifest?.state === 'committed' ? manifest : null;
}

export function normalizeSessionDraftDeletionChunk<Value>(
  value: Value
): SessionDraftDeletionChunk | null {
  const record = readExactOwnDataRecord(value, [
    'schemaVersion',
    'kind',
    'state',
    'operationId',
    'epoch',
    'chunkIndex',
    'requestFingerprint',
    'candidateFingerprint',
    'candidateCount',
    'candidateKeys',
    'revisions',
    'existingRevisions',
    'protectedKeys',
    'createdAt',
    'expiresAt'
  ]);
  if (!record) return null;
  const candidateKeys = normalizeSessionDraftDeletionKeys(record.candidateKeys);
  const protectedKeys = normalizeSessionDraftDeletionKeys(record.protectedKeys);
  const revisions = normalizeSessionDraftDeletionRevisions(record.revisions);
  const existingRevisions = normalizeSessionDraftDeletionRevisions(record.existingRevisions);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'delete' ||
    !isDeletionChunkState(record.state) ||
    !isBoundedString(record.operationId, 128) ||
    !isNonNegativeInteger(record.epoch) ||
    !isFingerprint(record.requestFingerprint) ||
    !isFingerprint(record.candidateFingerprint) ||
    !isNonNegativeInteger(record.candidateCount) ||
    record.candidateCount > SESSION_DRAFT_DELETE_MAX_TARGETS ||
    !isNonNegativeInteger(record.chunkIndex) ||
    !candidateKeys ||
    !protectedKeys ||
    !revisions ||
    !existingRevisions ||
    candidateKeys.length > SESSION_DRAFT_DELETE_CHUNK_SIZE ||
    !isNonNegativeInteger(record.createdAt) ||
    !isNonNegativeInteger(record.expiresAt) ||
    !hasExactLifetime(record.createdAt, record.expiresAt) ||
    (record.state === 'selected' &&
      (revisions.length > 0 || existingRevisions.length > 0 || protectedKeys.length > 0)) ||
    (record.state !== 'selected' &&
      !classifiesSessionDraftDeletionCandidates(
        candidateKeys,
        [...revisions, ...existingRevisions],
        protectedKeys
      ))
  )
    return null;
  const chunk: SessionDraftDeletionChunk = {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    state: record.state,
    operationId: record.operationId,
    epoch: record.epoch,
    chunkIndex: record.chunkIndex,
    requestFingerprint: record.requestFingerprint,
    candidateFingerprint: record.candidateFingerprint,
    candidateCount: record.candidateCount,
    candidateKeys,
    revisions,
    existingRevisions,
    protectedKeys,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
  return isSessionDraftDeletionRecordBounded(chunk) ? chunk : null;
}

function hasExactLifetime(
  createdAt: RuntimePropertyValue,
  expiresAt: RuntimePropertyValue
): boolean {
  return (
    isNonNegativeInteger(createdAt) &&
    isNonNegativeInteger(expiresAt) &&
    expiresAt - createdAt === SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
  );
}
function isBoundedString(value: RuntimePropertyValue, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isFingerprint(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function isDeletionChunkState(
  value: RuntimePropertyValue
): value is SessionDraftDeletionChunk['state'] {
  return value === 'selected' || value === 'prepared' || value === 'committed';
}
