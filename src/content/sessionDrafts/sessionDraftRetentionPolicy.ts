import type {
  SessionCommentDraftSnapshot,
  SessionDraftIndexEntry,
  SessionDraftRetentionPolicy
} from './sessionDraftTypes';

export type { SessionDraftRetentionPolicy } from './sessionDraftTypes';

export const FREE_SESSION_DRAFT_RETENTION_MS = 48 * 60 * 60 * 1000;
export const FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES = 5;
export const FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE = 20;

export const FREE_SESSION_DRAFT_RETENTION_POLICY: SessionDraftRetentionPolicy = {
  retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
  maxRestorablePages: FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
  maxItemsPerPage: FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE
};

export const DEFAULT_SESSION_DRAFT_RETENTION_POLICY = FREE_SESSION_DRAFT_RETENTION_POLICY;
export const DEFAULT_SESSION_DRAFT_TTL_MS = FREE_SESSION_DRAFT_RETENTION_MS;

export function normalizeSessionDraftRetentionPolicy(
  policy?: Partial<SessionDraftRetentionPolicy> | null,
  fallbackRetentionMs?: number
): SessionDraftRetentionPolicy {
  const defaultRetentionMs = normalizePositiveFiniteNumber(
    fallbackRetentionMs,
    DEFAULT_SESSION_DRAFT_RETENTION_POLICY.retentionMs
  );

  return {
    retentionMs: normalizePositiveFiniteNumber(policy?.retentionMs, defaultRetentionMs),
    maxRestorablePages: normalizeNullablePositiveInteger(
      policy?.maxRestorablePages,
      DEFAULT_SESSION_DRAFT_RETENTION_POLICY.maxRestorablePages
    ),
    maxItemsPerPage: normalizeNullablePositiveInteger(
      policy?.maxItemsPerPage,
      DEFAULT_SESSION_DRAFT_RETENTION_POLICY.maxItemsPerPage
    )
  };
}

export function getSessionDraftEffectiveExpiresAt(
  value: Pick<SessionDraftIndexEntry, 'updatedAt' | 'expiresAt'>,
  policy?: Partial<SessionDraftRetentionPolicy> | null
): number {
  const normalizedPolicy = normalizeSessionDraftRetentionPolicy(policy);
  return Math.min(value.expiresAt, value.updatedAt + normalizedPolicy.retentionMs);
}

export function pruneSessionDraftIndexEntriesForRetentionPolicy(
  entries: readonly SessionDraftIndexEntry[],
  now: number,
  options: {
    policy?: Partial<SessionDraftRetentionPolicy> | null;
    maxEntries: number;
  }
): { entries: SessionDraftIndexEntry[]; removedKeys: string[]; dirty: boolean } {
  const policy = normalizeSessionDraftRetentionPolicy(options.policy);
  const sorted = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  const unique: SessionDraftIndexEntry[] = [];
  const removedKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const entry of sorted) {
    if (seenKeys.has(entry.key)) {
      continue;
    }
    seenKeys.add(entry.key);
    unique.push(entry);
  }

  const retainedUnexpired = unique.filter((entry) => {
    if (getSessionDraftEffectiveExpiresAt(entry, policy) <= now) {
      removedKeys.push(entry.key);
      return false;
    }
    return true;
  });

  const pagePruned = pruneRestorablePages(retainedUnexpired, policy, removedKeys);
  const next = applyTechnicalMaxEntries(pagePruned, options.maxEntries, removedKeys);

  return {
    entries: next,
    removedKeys: Array.from(new Set(removedKeys)),
    dirty: removedKeys.length > 0 || next.length !== entries.length
  };
}

export function selectRetainedSessionDraftItems<T extends { createdAt: number }>(
  items: readonly T[],
  policy:
    | Partial<SessionDraftRetentionPolicy>
    | number
    | null
    | undefined = DEFAULT_SESSION_DRAFT_RETENTION_POLICY
): T[] {
  const maxItems =
    typeof policy === 'number'
      ? normalizeNullablePositiveInteger(policy, null)
      : normalizeSessionDraftRetentionPolicy(policy).maxItemsPerPage;

  if (maxItems === null || items.length <= maxItems) {
    return [...items];
  }

  const retained = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const createdDiff = right.item.createdAt - left.item.createdAt;
      return createdDiff !== 0 ? createdDiff : right.index - left.index;
    })
    .slice(0, maxItems)
    .sort((left, right) => left.index - right.index);

  return retained.map(({ item }) => item);
}

export function filterSessionCommentDraftsForRetainedIds(
  commentDrafts: SessionCommentDraftSnapshot,
  retainedIds: Iterable<string>
): SessionCommentDraftSnapshot {
  const retainedIdSet = new Set(retainedIds);
  return Object.fromEntries(Object.entries(commentDrafts).filter(([id]) => retainedIdSet.has(id)));
}

function pruneRestorablePages(
  entries: readonly SessionDraftIndexEntry[],
  policy: SessionDraftRetentionPolicy,
  removedKeys: string[]
): SessionDraftIndexEntry[] {
  if (policy.maxRestorablePages === null) {
    return [...entries];
  }

  const pageRecency = new Map<string, number>();
  for (const entry of entries) {
    if (!isRestorableStatus(entry.status)) {
      continue;
    }
    const pageIdentity = createPageIdentity(entry);
    pageRecency.set(pageIdentity, Math.max(pageRecency.get(pageIdentity) ?? 0, entry.updatedAt));
  }

  if (pageRecency.size <= policy.maxRestorablePages) {
    return [...entries];
  }

  const retainedPages = new Set(
    [...pageRecency.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, policy.maxRestorablePages)
      .map(([pageIdentity]) => pageIdentity)
  );

  return entries.filter((entry) => {
    if (isRestorableStatus(entry.status) && !retainedPages.has(createPageIdentity(entry))) {
      removedKeys.push(entry.key);
      return false;
    }
    return true;
  });
}

function applyTechnicalMaxEntries(
  entries: readonly SessionDraftIndexEntry[],
  maxEntries: number,
  removedKeys: string[]
): SessionDraftIndexEntry[] {
  const next = [...entries].sort((left, right) => left.updatedAt - right.updatedAt);

  for (let index = 0; index < next.length && next.length > maxEntries; ) {
    const entry = next[index];
    if (!entry) {
      break;
    }
    if (entry.status === 'active') {
      index += 1;
      continue;
    }
    removedKeys.push(entry.key);
    next.splice(index, 1);
  }
  while (next.length > maxEntries) {
    const [removed] = next.splice(0, 1);
    if (removed) {
      removedKeys.push(removed.key);
    }
  }

  return next.sort((left, right) => right.updatedAt - left.updatedAt);
}

function createPageIdentity(entry: SessionDraftIndexEntry): string {
  return `${entry.mode}:${entry.pageKey}`;
}

function isRestorableStatus(status: SessionDraftIndexEntry['status']): boolean {
  return status === 'active' || status === 'restorable';
}

function normalizePositiveFiniteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeNullablePositiveInteger(
  value: number | null | undefined,
  fallback: number | null
): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
