import {
  readExactOwnDataRecord,
  readOwnDataArray,
  readOwnDataRecord
} from '../../shared/guards/exactOwnDataRecord';
import { type ObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import { normalizeSessionDraftEnvelope } from './sessionDraftEnvelopeCodec';
import type {
  SessionDraftCandidateSnapshot,
  SessionDraftLoadSnapshot,
  SessionDraftRepositoryOperation,
  SessionDraftRepositoryResponse
} from './sessionDraftRepositoryMessages';
import { normalizeSessionDraftOperationContext } from './sessionDraftRepositoryMessages';
import { isBoundedSessionDraftStorageKey } from './sessionDraftLifecycleRecords';
import { SESSION_DRAFT_DELETION_MAX_TARGETS } from './sessionDraftRepositoryProtocol';

export function normalizeSessionDraftRepositoryResponse<Value>(
  value: Value,
  expectedOperation: SessionDraftRepositoryOperation
): SessionDraftRepositoryResponse | null {
  const response = readOwnDataRecord(value);
  if (!response || typeof response.success !== 'boolean') return null;
  if (response.success === false) {
    return hasExactKeys(response, ['success', 'error']) && isNonEmptyString(response.error)
      ? { success: false, error: response.error }
      : null;
  }
  if (response.operation !== expectedOperation) return null;
  if (expectedOperation === 'prepareSessionDraftOperation') {
    const context = normalizeSessionDraftOperationContext(response.context);
    return hasExactKeys(response, ['success', 'operation', 'context', 'replayed', 'status']) &&
      context &&
      typeof response.replayed === 'boolean' &&
      (response.status === 'prepared' || response.status === 'completed')
      ? {
          success: true,
          operation: expectedOperation,
          context,
          replayed: response.replayed,
          status: response.status
        }
      : null;
  }
  if (expectedOperation === 'saveSessionDraft') {
    return hasExactKeys(response, ['success', 'operation', 'revision', 'replayed']) &&
      isNonNegativeInteger(response.revision) &&
      typeof response.replayed === 'boolean'
      ? {
          success: true,
          operation: expectedOperation,
          revision: response.revision,
          replayed: response.replayed
        }
      : null;
  }
  if (expectedOperation === 'claimSessionDraft') {
    const context = normalizeSessionDraftOperationContext(response.context);
    return hasExactKeys(response, ['success', 'operation', 'context', 'revision', 'replayed']) &&
      context &&
      isNonNegativeInteger(response.revision) &&
      typeof response.replayed === 'boolean'
      ? {
          success: true,
          operation: expectedOperation,
          context,
          revision: response.revision,
          replayed: response.replayed
        }
      : null;
  }
  if (expectedOperation === 'cancelSessionDraftOperation') {
    const context = normalizeSessionDraftOperationContext(response.context);
    return hasExactKeys(response, ['success', 'operation', 'context']) && context
      ? { success: true, operation: expectedOperation, context }
      : null;
  }
  if (expectedOperation === 'loadLatestSessionDraft') {
    const result = normalizeLoadSnapshot(response.result);
    return hasExactKeys(response, ['success', 'operation', 'result']) && result
      ? { success: true, operation: expectedOperation, result }
      : null;
  }
  if (expectedOperation === 'listSessionDraftCandidates') {
    const result = normalizeCandidateResult(response.result);
    return hasExactKeys(response, ['success', 'operation', 'result']) && result
      ? { success: true, operation: expectedOperation, result }
      : null;
  }
  if (
    expectedOperation === 'removeSessionDraft' ||
    expectedOperation === 'pruneExpiredSessionDrafts'
  ) {
    const result = normalizeDeletionSnapshot(response.result);
    return hasExactKeys(response, ['success', 'operation', 'result']) && result
      ? { success: true, operation: expectedOperation, result }
      : null;
  }
  return null;
}

function normalizeDeletionSnapshot(value: RuntimePropertyValue) {
  const snapshot = readExactOwnDataRecord(value, [
    'epoch',
    'revisions',
    'protectedKeys',
    'replayed'
  ]);
  if (
    !snapshot ||
    !isNonNegativeInteger(snapshot.epoch) ||
    !readOwnDataArray(snapshot.revisions) ||
    !readOwnDataArray(snapshot.protectedKeys) ||
    typeof snapshot.replayed !== 'boolean'
  )
    return null;
  const rawRevisions = readOwnDataArray(snapshot.revisions);
  const rawProtectedKeys = readOwnDataArray(snapshot.protectedKeys);
  if (!rawRevisions || !rawProtectedKeys) return null;
  const revisions: Array<{ draftKey: string; revision: number }> = [];
  for (const rawEntry of rawRevisions) {
    const entry = readExactOwnDataRecord(rawEntry, ['draftKey', 'revision']);
    if (
      !entry ||
      !isBoundedSessionDraftStorageKey(entry.draftKey) ||
      !isNonNegativeInteger(entry.revision)
    )
      return null;
    revisions.push({ draftKey: entry.draftKey, revision: entry.revision });
  }
  if (rawProtectedKeys.some((key) => !isBoundedSessionDraftStorageKey(key))) return null;
  const protectedKeys = rawProtectedKeys.filter(isBoundedSessionDraftStorageKey);
  const revisionKeys = revisions.map(({ draftKey }) => draftKey);
  if (
    revisions.length + protectedKeys.length > SESSION_DRAFT_DELETION_MAX_TARGETS ||
    new Set(revisionKeys).size !== revisionKeys.length ||
    new Set(protectedKeys).size !== protectedKeys.length ||
    revisionKeys.some((key, index) => index > 0 && key <= (revisionKeys[index - 1] ?? '')) ||
    protectedKeys.some((key, index) => index > 0 && key <= (protectedKeys[index - 1] ?? '')) ||
    protectedKeys.some((key) => revisionKeys.includes(key))
  )
    return null;
  return { epoch: snapshot.epoch, revisions, protectedKeys, replayed: snapshot.replayed };
}

function normalizeLoadSnapshot(value: RuntimePropertyValue): SessionDraftLoadSnapshot | null {
  const snapshot = readExactOwnDataRecord(value, ['envelope', 'epoch', 'revision']);
  if (
    !snapshot ||
    !isNonNegativeInteger(snapshot.epoch) ||
    !isNonNegativeInteger(snapshot.revision)
  ) {
    return null;
  }
  if (snapshot.envelope === null) {
    return { envelope: null, epoch: snapshot.epoch, revision: snapshot.revision };
  }
  const envelope = normalizeSessionDraftEnvelope(snapshot.envelope);
  return envelope ? { envelope, epoch: snapshot.epoch, revision: snapshot.revision } : null;
}

function normalizeCandidateResult(
  value: RuntimePropertyValue
): { candidates: SessionDraftCandidateSnapshot[]; epoch: number } | null {
  const result = readExactOwnDataRecord(value, ['candidates', 'epoch']);
  const rawCandidates = result ? readOwnDataArray(result.candidates) : null;
  if (!result || !rawCandidates || !isNonNegativeInteger(result.epoch)) {
    return null;
  }
  const candidates: SessionDraftCandidateSnapshot[] = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = readExactOwnDataRecord(rawCandidate, ['envelope', 'revision']);
    const envelope = candidate ? normalizeSessionDraftEnvelope(candidate.envelope) : null;
    if (!candidate || !isNonNegativeInteger(candidate.revision) || !envelope) {
      return null;
    }
    candidates.push({ envelope, revision: candidate.revision });
  }
  return { candidates, epoch: result.epoch };
}

function hasExactKeys(value: ObjectRecord, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    expected.size === keys.length &&
    actual.length === expected.size &&
    actual.every((key) => expected.has(key))
  );
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0;
}
