import type { StorageAreaService, StorageRecord } from '../../platform/interfaces/storage';
import { isObjectRecord } from '../../shared/guards/object';
import { normalizeVideoScreenshotCacheRef } from '../video/videoScreenshotCacheTypes';
import {
  createSessionDraftStorageKey,
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from './sessionDraftKeys';
import {
  SessionDraftEnvelopeSchema,
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from './sessionDraftSchemas';
import type { SessionDraftEnvelope } from './sessionDraftTypes';

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
  return area.getAll().then(buildSnapshot);
}

export async function removeSessionDraftStorageKeys(
  area: Pick<StorageAreaService, 'getAll' | 'remove' | 'set'>,
  keys: readonly string[]
): Promise<void> {
  const removableKeys = Array.from(new Set(keys.filter(isSessionDraftStorageKey))).sort();
  if (removableKeys.length === 0) {
    return;
  }

  await area.remove(removableKeys);
  const snapshot = await readSessionDraftReferenceIndex(area);
  const entries = snapshot.drafts
    .map(({ envelope }) => createSessionDraftIndexEntry(envelope))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
  await area.set(SESSION_DRAFT_INDEX_KEY, createSessionDraftIndex(entries));
}

function buildSnapshot(values: StorageRecord): SessionDraftReferenceIndexSnapshot {
  const allDraftKeys = Object.keys(values)
    .filter((key) => key === SESSION_DRAFT_INDEX_KEY || isSessionDraftStorageKey(key))
    .sort();
  const drafts: SessionDraftReferenceRecord[] = [];
  const referencedScreenshotKeys = new Set<string>();

  for (const key of allDraftKeys) {
    if (!isSessionDraftStorageKey(key)) {
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
    const screenshotKeys = collectScreenshotKeys(envelope);
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

function collectScreenshotKeys(envelope: SessionDraftEnvelope): string[] {
  if (envelope.mode !== 'video') {
    return [];
  }
  const captures = envelope.payload.captures;
  if (!Array.isArray(captures)) {
    return [];
  }
  const keys = new Set<string>();
  for (const capture of captures) {
    if (!isObjectRecord(capture)) {
      continue;
    }
    const ref = normalizeVideoScreenshotCacheRef(capture.screenshotRef);
    if (ref) {
      keys.add(ref.key);
    }
  }
  return [...keys].sort();
}
