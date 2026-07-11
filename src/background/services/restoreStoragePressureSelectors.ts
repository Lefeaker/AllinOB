import type { SessionDraftRetentionPolicy } from '../../content/sessionDrafts/sessionDraftRetentionPolicy';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import type {
  SessionDraftReferenceIndexSnapshot,
  SessionDraftReferenceRecord
} from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type { VideoScreenshotCacheBlobMetadata } from '../../content/video/videoScreenshotCacheStore';

export function sortScreenshotMetadataOldestFirst<T extends VideoScreenshotCacheBlobMetadata>(
  entries: readonly T[]
): T[] {
  return [...entries].sort(
    (left, right) =>
      (left.lastAccessedAt ?? left.updatedAt) - (right.lastAccessedAt ?? right.updatedAt) ||
      left.key.localeCompare(right.key)
  );
}

export function sortDraftsOldestFirst(
  drafts: readonly SessionDraftReferenceRecord[]
): SessionDraftReferenceRecord[] {
  return [...drafts].sort(
    (left, right) =>
      left.envelope.updatedAt - right.envelope.updatedAt || left.key.localeCompare(right.key)
  );
}

export function selectExcessDraftKeys(
  snapshot: SessionDraftReferenceIndexSnapshot,
  policy: SessionDraftStoragePolicy
): string[] {
  const removable = sortDraftsOldestFirst(snapshot.drafts).filter(
    ({ envelope }) => envelope.status !== 'active'
  );
  const removed = new Set<string>();
  selectExcessPages(snapshot.drafts, policy.retentionPolicy).forEach((key) => removed.add(key));
  let retainedCount = snapshot.drafts.length - removed.size;
  for (const draft of removable) {
    if (retainedCount <= policy.maxDraftEntries) break;
    if (!removed.has(draft.key)) {
      removed.add(draft.key);
      retainedCount -= 1;
    }
  }
  return removable.filter(({ key }) => removed.has(key)).map(({ key }) => key);
}

function selectExcessPages(
  drafts: readonly SessionDraftReferenceRecord[],
  policy: SessionDraftRetentionPolicy
): string[] {
  if (policy.maxRestorablePages === null) return [];
  const recency = new Map<string, number>();
  for (const { envelope } of drafts) {
    if (envelope.status !== 'active' && envelope.status !== 'restorable') continue;
    const id = `${envelope.mode}:${envelope.pageKey}`;
    recency.set(id, Math.max(recency.get(id) ?? 0, envelope.updatedAt));
  }
  const retained = new Set(
    [...recency]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, policy.maxRestorablePages)
      .map(([id]) => id)
  );
  return drafts
    .filter(
      ({ envelope }) =>
        envelope.status === 'restorable' && !retained.has(`${envelope.mode}:${envelope.pageKey}`)
    )
    .map(({ key }) => key);
}
