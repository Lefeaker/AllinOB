import type { StorageAreaService } from '../../platform/interfaces/storage';
import { createSessionDraftPageKey, createSessionDraftStorageKey } from './sessionDraftKeys';
import {
  SessionDraftEnvelopeSchema,
  containsDisallowedSessionDraftPayloadValue,
  measureSessionDraftValueBytes
} from './sessionDraftSchemas';
import { getSessionDraftEffectiveExpiresAt } from './sessionDraftRetentionPolicy';
import {
  isRestorableSessionDraftStatus,
  type SessionDraftEnvelope,
  type SessionDraftIndexEntry,
  type SessionDraftMode,
  type SessionDraftRetentionPolicy
} from './sessionDraftTypes';

interface IndexState {
  entries: SessionDraftIndexEntry[];
  removedKeys: string[];
  dirty: boolean;
}

export async function readValidSessionDraftCandidates(dependencies: {
  area: StorageAreaService;
  mode: SessionDraftMode;
  pageUrl: string;
  now: number;
  maxEnvelopeBytes: number;
  retentionPolicy: SessionDraftRetentionPolicy;
  readIndex(now: number): Promise<IndexState>;
  persistIndex(entries: SessionDraftIndexEntry[], removedKeys: string[]): Promise<void>;
}): Promise<SessionDraftEnvelope[]> {
  const { area, mode, pageUrl, now, maxEnvelopeBytes, retentionPolicy } = dependencies;
  const pageKey = createSessionDraftPageKey(mode, pageUrl);
  const indexState = await dependencies.readIndex(now);
  const candidateEntries = indexState.entries.filter(
    (entry) => entry.mode === mode && entry.pageKey === pageKey
  );
  if (candidateEntries.length === 0) {
    if (indexState.dirty || indexState.removedKeys.length > 0) {
      await dependencies.persistIndex(indexState.entries, indexState.removedKeys);
    }
    return [];
  }

  const stored = await area.getMany<unknown>(candidateEntries.map((entry) => entry.key));
  const valid: SessionDraftEnvelope[] = [];
  const invalidKeys = [...indexState.removedKeys];
  for (const entry of candidateEntries) {
    const raw = stored[entry.key];
    if (raw === undefined || measureSessionDraftValueBytes(raw) > maxEnvelopeBytes) {
      invalidKeys.push(entry.key);
      continue;
    }
    const parsed = SessionDraftEnvelopeSchema.safeParse(raw);
    if (!parsed.success || containsDisallowedSessionDraftPayloadValue(parsed.data.payload)) {
      invalidKeys.push(entry.key);
      continue;
    }
    const envelope = parsed.data as SessionDraftEnvelope;
    const expectedPageKey = createSessionDraftPageKey(envelope.mode, envelope.pageUrl);
    const expectedKey = createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: expectedPageKey,
      draftId: envelope.draftId
    });
    if (
      envelope.mode !== mode ||
      getSessionDraftEffectiveExpiresAt(envelope, retentionPolicy) <= now ||
      expectedPageKey !== pageKey ||
      envelope.pageKey !== expectedPageKey ||
      expectedKey !== entry.key
    ) {
      invalidKeys.push(entry.key);
      continue;
    }
    if (isRestorableSessionDraftStatus(envelope.status)) valid.push(envelope);
  }
  if (invalidKeys.length > 0 || indexState.dirty) {
    const invalidSet = new Set(invalidKeys);
    await dependencies.persistIndex(
      indexState.entries.filter((entry) => !invalidSet.has(entry.key)),
      invalidKeys
    );
  }
  return valid.sort((left, right) => right.updatedAt - left.updatedAt);
}
