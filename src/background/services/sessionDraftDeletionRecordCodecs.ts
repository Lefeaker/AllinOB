import { isSessionDraftStorageKey } from '../../content/sessionDrafts/sessionDraftKeys';
import { SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH } from '../../content/sessionDrafts/sessionDraftRepositoryProtocol';
import { readExactOwnDataRecord, readOwnDataArray } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import type { SessionDraftDeletionRevision } from './sessionDraftDeletionTypes';

export function classifiesSessionDraftDeletionCandidates(
  candidates: string[],
  revisions: SessionDraftDeletionRevision[],
  protectedKeys: string[]
): boolean {
  const classified = [...revisions.map((entry) => entry.draftKey), ...protectedKeys].sort();
  return (
    classified.length === candidates.length &&
    new Set(classified).size === classified.length &&
    classified.every((key, index) => key === candidates[index])
  );
}

export function normalizeSessionDraftDeletionKeys(value: RuntimePropertyValue): string[] | null {
  const values = readOwnDataArray(value);
  if (!values) return null;
  const normalized: string[] = [];
  for (const key of values) {
    if (!isBoundedDraftKey(key)) return null;
    normalized.push(key);
  }
  const keys = [...new Set(normalized)].sort();
  return keys.length === values.length && keys.every((key, index) => key === values[index])
    ? keys
    : null;
}

export function normalizeSessionDraftDeletionRevisions(
  value: RuntimePropertyValue
): SessionDraftDeletionRevision[] | null {
  const values = readOwnDataArray(value);
  if (!values) return null;
  const revisions: SessionDraftDeletionRevision[] = [];
  for (const entry of values) {
    const revision = readExactOwnDataRecord(entry, ['draftKey', 'revision']);
    if (
      !revision ||
      !isBoundedDraftKey(revision.draftKey) ||
      !isNonNegativeInteger(revision.revision)
    ) {
      return null;
    }
    revisions.push({ draftKey: revision.draftKey, revision: revision.revision });
  }
  const sorted = [...revisions].sort((left, right) => left.draftKey.localeCompare(right.draftKey));
  return sorted.length === revisions.length &&
    new Set(sorted.map((entry) => entry.draftKey)).size === sorted.length &&
    sorted.every((entry, index) => entry.draftKey === revisions[index]?.draftKey)
    ? revisions
    : null;
}

function isNonNegativeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedDraftKey(value: RuntimePropertyValue): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SESSION_DRAFT_STORAGE_KEY_MAX_LENGTH &&
    isSessionDraftStorageKey(value)
  );
}
