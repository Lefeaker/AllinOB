import type { StorageAreaService, StorageRecord } from '../../platform/interfaces/storage';
import { isObjectRecord } from '../../shared/guards/object';
import { normalizeVideoScreenshotCacheRef } from '../video/videoScreenshotCacheTypes';
import type { VideoScreenshotCacheRef } from '../video/videoScreenshotCacheTypes';
import {
  createSessionDraftStorageKey,
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from './sessionDraftKeys';
import {
  SessionDraftEnvelopeSchema,
  SessionDraftIndexSchema,
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from './sessionDraftSchemas';
import { pruneSessionDraftIndexEntriesForRetentionPolicy } from './sessionDraftRetentionPolicy';
import type { SessionDraftStoragePolicy } from './sessionDraftStoragePolicy';
import type { SessionDraftEnvelope } from './sessionDraftTypes';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';
import { getSessionDraftLifecycleRecordStatus } from './sessionDraftLifecycleRecords';

export interface SessionDraftReferenceRecord {
  key: string;
  envelope: SessionDraftEnvelope;
  screenshotKeys: string[];
}

export interface SessionDraftReferenceIndexSnapshot {
  allDraftKeys: string[];
  drafts: SessionDraftReferenceRecord[];
  referencedScreenshotKeys: Set<string>;
}

export function readSessionDraftReferenceIndex(
  area: Pick<StorageAreaService, 'getAll'>
): Promise<SessionDraftReferenceIndexSnapshot> {
  return area.getAll().then(buildSessionDraftReferenceIndexSnapshot);
}

export async function repairSessionDraftStorage(
  area: Pick<StorageAreaService, 'getAll' | 'set'>,
  policy: SessionDraftStoragePolicy,
  now: number,
  deleteKeys: (keys: readonly string[]) => Promise<void>
): Promise<void> {
  const snapshot = await readSessionDraftReferenceIndex(area);
  const repaired = pruneSessionDraftIndexEntriesForRetentionPolicy(
    snapshot.drafts.map(({ envelope }) => createSessionDraftIndexEntry(envelope)),
    now,
    { policy: policy.retentionPolicy, maxEntries: policy.maxDraftEntries }
  );
  const retainedKeys = new Set(repaired.entries.map((entry) => entry.key));
  const removeKeys = snapshot.allDraftKeys.filter(
    (key) => key !== SESSION_DRAFT_INDEX_KEY && !retainedKeys.has(key)
  );
  if (removeKeys.length > 0) await deleteKeys(removeKeys);
  await area.set(SESSION_DRAFT_INDEX_KEY, createSessionDraftIndex(repaired.entries));
}

export async function repairSessionDraftIndex(
  area: Pick<StorageAreaService, 'getAll' | 'set'>,
  deleteKeys: (keys: readonly string[]) => Promise<void>
): Promise<void> {
  const values = await area.getAll();
  const snapshot = buildSessionDraftReferenceIndexSnapshot(values);
  const validKeys = new Set(snapshot.drafts.map(({ key }) => key));
  const invalidKeys = snapshot.allDraftKeys.filter(
    (key) => key !== SESSION_DRAFT_INDEX_KEY && !validKeys.has(key)
  );
  if (invalidKeys.length > 0) {
    await deleteKeys(invalidKeys);
    return rebuildSessionDraftIndex(area);
  }
  await writeSessionDraftIndex(area, values);
}

export async function rebuildSessionDraftIndex(
  area: Pick<StorageAreaService, 'getAll' | 'set'>
): Promise<void> {
  await writeSessionDraftIndex(area, await area.getAll());
}

async function writeSessionDraftIndex(
  area: Pick<StorageAreaService, 'set'>,
  values: StorageRecord
): Promise<void> {
  const snapshot = buildSessionDraftReferenceIndexSnapshot(values);
  const entries = snapshot.drafts
    .map(({ envelope }) => createSessionDraftIndexEntry(envelope))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
  const repairedIndex = createSessionDraftIndex(entries);
  const storedIndex = SessionDraftIndexSchema.safeParse(values[SESSION_DRAFT_INDEX_KEY]);
  if (
    storedIndex.success &&
    canonicalJsonStringify(storedIndex.data) === canonicalJsonStringify(repairedIndex)
  ) {
    return;
  }
  await area.set(SESSION_DRAFT_INDEX_KEY, repairedIndex);
}

export function buildSessionDraftReferenceIndexSnapshot(
  values: StorageRecord
): SessionDraftReferenceIndexSnapshot {
  const allDraftKeys = Object.keys(values)
    .filter((key) => key === SESSION_DRAFT_INDEX_KEY || isSessionDraftStorageKey(key))
    .sort();
  const drafts: SessionDraftReferenceRecord[] = [];
  const referencedScreenshotKeys = new Set<string>();

  for (const key of allDraftKeys) {
    if (!isSessionDraftStorageKey(key)) {
      continue;
    }
    const lifecycleStatus = getSessionDraftLifecycleRecordStatus(values, key);
    if (lifecycleStatus === 'deleted' || lifecycleStatus === 'invalid') {
      continue;
    }
    const parsed = SessionDraftEnvelopeSchema.safeParse(values[key]);
    if (!parsed.success) {
      continue;
    }
    const envelope = parsed.data as SessionDraftEnvelope;
    if (createEnvelopeStorageKey(envelope) !== key) {
      continue;
    }
    const screenshotKeys = collectSessionDraftScreenshotRefs(envelope).map((ref) => ref.key);
    screenshotKeys.forEach((screenshotKey) => referencedScreenshotKeys.add(screenshotKey));
    drafts.push({ key, envelope, screenshotKeys });
  }

  return { allDraftKeys, drafts, referencedScreenshotKeys };
}

function createEnvelopeStorageKey(envelope: SessionDraftEnvelope): string {
  return createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    draftId: envelope.draftId
  });
}

export function collectSessionDraftScreenshotRefs(
  envelope: SessionDraftEnvelope
): VideoScreenshotCacheRef[] {
  if (envelope.mode !== 'video') {
    return [];
  }
  const captures = envelope.payload.captures;
  if (!Array.isArray(captures)) {
    return [];
  }
  const refs = new Map<string, VideoScreenshotCacheRef>();
  for (const capture of captures) {
    if (!isObjectRecord(capture)) {
      continue;
    }
    const ref = normalizeVideoScreenshotCacheRef(capture.screenshotRef);
    if (ref) {
      refs.set(ref.key, ref);
    }
  }
  return [...refs.values()].sort((left, right) => left.key.localeCompare(right.key));
}
