import type { StorageAreaService } from '../../platform/interfaces/storage';
import { quarantineMalformedSessionDraftProtocolRecords } from './sessionDraftProtocolCorruption';
import {
  SESSION_DRAFT_OUTCOME_PREFIX,
  SESSION_DRAFT_PENDING_PREFIX,
  createSessionDraftCursorStorageKey,
  createSessionDraftOutcomeStorageKey,
  createSessionDraftPendingStorageKey,
  normalizeSessionDraftCursor,
  normalizeSessionDraftOutcome,
  normalizeSessionDraftSaveJournal,
  type SessionDraftOutcome,
  type SessionDraftSaveJournal
} from './sessionDraftSaveJournal';

export interface SessionDraftJournalInventory {
  journals: SessionDraftSaveJournal[];
  invalid: boolean;
  quarantinedKeys: string[];
}

export async function pruneSessionDraftOutcomes(
  area: Pick<StorageAreaService, 'get' | 'getAll' | 'set' | 'remove'>,
  now = Date.now()
): Promise<string[]> {
  const values = await area.getAll();
  const protocolOutcomes = Object.entries(values)
    .filter(([key]) => key.startsWith(SESSION_DRAFT_OUTCOME_PREFIX))
    .map(([key, value]) => {
      const outcome = normalizeSessionDraftOutcome(value);
      return { key, outcome: outcome && outcome.createdAt <= now ? outcome : null };
    });
  await quarantineMalformedSessionDraftProtocolRecords(
    area,
    protocolOutcomes.filter(({ outcome }) => outcome === null).map(({ key }) => key),
    now
  );
  const outcomes = protocolOutcomes.filter(
    (entry): entry is { key: string; outcome: SessionDraftOutcome } => entry.outcome !== null
  );
  const removeKeys = outcomes
    .filter((entry) => entry.outcome.expiresAt <= now)
    .map((entry) => entry.key);
  if (removeKeys.length > 0) await area.remove(removeKeys);
  return protocolOutcomes.filter(({ outcome }) => outcome === null).map(({ key }) => key);
}

export async function pruneCommittedSessionDraftJournals(
  area: Pick<StorageAreaService, 'getAll' | 'remove'>
): Promise<void> {
  const values = await area.getAll();
  const removeKeys: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(SESSION_DRAFT_PENDING_PREFIX)) continue;
    const journal = normalizeSessionDraftSaveJournal(raw);
    if (!journal || journal.state !== 'committed') continue;
    const cursor = normalizeSessionDraftCursor(
      values[createSessionDraftCursorStorageKey(journal.context.draftKey)]
    );
    const outcome = normalizeSessionDraftOutcome(
      values[createSessionDraftOutcomeStorageKey(journal.operationId)]
    );
    if (
      journal.operationId === journal.context.operationId &&
      cursor?.draftKey === journal.context.draftKey &&
      cursor.revision === journal.context.nextRevision &&
      cursor.lastOperationId === journal.operationId &&
      outcome?.operationId === journal.operationId &&
      outcome.draftKey === journal.context.draftKey &&
      outcome.revision === journal.context.nextRevision &&
      outcome.requestFingerprint === journal.requestFingerprint
    ) {
      removeKeys.push(key);
    }
  }
  if (removeKeys.length > 0) await area.remove(removeKeys);
}

export async function readSessionDraftJournalInventory(
  area: Pick<StorageAreaService, 'get' | 'getAll' | 'set' | 'remove'>,
  now = Date.now()
): Promise<SessionDraftJournalInventory> {
  const values = await area.getAll();
  const journals: SessionDraftSaveJournal[] = [];
  const malformedKeys: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(SESSION_DRAFT_PENDING_PREFIX)) continue;
    const journal = normalizeSessionDraftSaveJournal(raw);
    if (
      !journal ||
      journal.createdAt > now ||
      key !== createSessionDraftPendingStorageKey(journal.operationId)
    ) {
      malformedKeys.push(key);
    } else {
      journals.push(journal);
    }
  }
  await quarantineMalformedSessionDraftProtocolRecords(area, malformedKeys, now);
  return { journals, invalid: false, quarantinedKeys: malformedKeys };
}
