import type { StorageAreaService } from '../../platform/interfaces/storage';
import { readExactOwnDataRecord } from '../../shared/guards/exactOwnDataRecord';
import type { RuntimePropertyValue } from '../../shared/guards/object';
import { RESTORE_STORAGE_PROTOCOL_STATE_INVALID } from './sessionDraftRepositoryServiceTypes';
import { readProtocolDataArray } from './sessionDraftProtocolValueGuards';

const CORRUPTION_KEY = 'aiob.restoreStorage.corruption.v1';
const MAX_CORRUPTION_ENTRIES = 128;
const CORRUPTION_AUTHORITY_TTL_MS = 15 * 60 * 1_000;

export type SessionDraftProtocolQuarantineCollisionStatus = 'none' | 'key' | 'global';

interface SessionDraftProtocolCorruptionEntry {
  sourceKey: string;
  quarantinedAt: number;
}

interface SessionDraftProtocolCorruptionLedger {
  schemaVersion: 1;
  recoveryRequiredUntil: number | null;
  entries: SessionDraftProtocolCorruptionEntry[];
}

export async function quarantineMalformedSessionDraftProtocolRecords(
  area: Pick<StorageAreaService, 'get' | 'set' | 'remove'>,
  sourceKeys: string[],
  now = Date.now()
): Promise<void> {
  if (sourceKeys.length === 0) return;
  const ledger = await readLedger(area);
  const entriesByKey = new Map<string, SessionDraftProtocolCorruptionEntry>();
  for (const entry of activeEntries(ledger, now)) entriesByKey.set(entry.sourceKey, entry);
  for (const sourceKey of sourceKeys) {
    entriesByKey.delete(sourceKey);
    entriesByKey.set(sourceKey, { sourceKey, quarantinedAt: now });
  }
  const allEntries = Array.from(entriesByKey.values());
  const entries = allEntries.slice(-MAX_CORRUPTION_ENTRIES);
  await area.set(CORRUPTION_KEY, {
    schemaVersion: 1,
    recoveryRequiredUntil:
      allEntries.length > MAX_CORRUPTION_ENTRIES
        ? Math.max(ledger.recoveryRequiredUntil ?? 0, now + CORRUPTION_AUTHORITY_TTL_MS)
        : activeRecoveryUntil(ledger, now),
    entries
  });
  await area.remove(sourceKeys);
}

export async function isSessionDraftProtocolKeyQuarantined(
  area: Pick<StorageAreaService, 'get'>,
  sourceKey: string
): Promise<boolean> {
  return (await getSessionDraftProtocolKeyQuarantineStatus(area, sourceKey)) !== 'none';
}

export async function getSessionDraftProtocolKeyQuarantineStatus(
  area: Pick<StorageAreaService, 'get'>,
  sourceKey: string
): Promise<'none' | 'key' | 'global'> {
  const ledger = await readLedger(area);
  const now = Date.now();
  if (activeRecoveryUntil(ledger, now) !== null) return 'global';
  return activeEntries(ledger, now).some((entry) => entry.sourceKey === sourceKey) ? 'key' : 'none';
}

export async function getSessionDraftProtocolQuarantineCollisionStatus(
  area: Pick<StorageAreaService, 'get'>,
  options: {
    exactSourceKeys: readonly string[];
    numericSourcePrefix: string;
  },
  now: number
): Promise<SessionDraftProtocolQuarantineCollisionStatus> {
  const raw = await area.get(CORRUPTION_KEY);
  if (raw === undefined) return 'none';
  const ledger = normalizeLedger(raw);
  if (!ledger) return 'none';
  if (
    ledger.recoveryRequiredUntil !== null &&
    ledger.recoveryRequiredUntil > now &&
    ledger.recoveryRequiredUntil <= now + CORRUPTION_AUTHORITY_TTL_MS
  ) {
    return 'global';
  }
  const exactKeys = new Set(options.exactSourceKeys);
  const matches = ledger.entries.some(
    (entry) =>
      entry.quarantinedAt <= now &&
      entry.quarantinedAt + CORRUPTION_AUTHORITY_TTL_MS > now &&
      (exactKeys.has(entry.sourceKey) ||
        (entry.sourceKey.startsWith(options.numericSourcePrefix) &&
          /^\d+$/u.test(entry.sourceKey.slice(options.numericSourcePrefix.length))))
  );
  return matches ? 'key' : 'none';
}

export async function recoverMalformedSessionDraftCorruptionLedger(
  area: Pick<StorageAreaService, 'get' | 'set' | 'remove'>,
  now = Date.now()
): Promise<boolean> {
  const raw = await area.get(CORRUPTION_KEY);
  if (raw === undefined) return false;
  const ledger = normalizeLedger(raw);
  if (!ledger) {
    await writeRecoveryWindow(area, now);
    return true;
  }
  if (
    (ledger.recoveryRequiredUntil !== null &&
      ledger.recoveryRequiredUntil > now + CORRUPTION_AUTHORITY_TTL_MS) ||
    ledger.entries.some((entry) => entry.quarantinedAt > now)
  ) {
    await writeRecoveryWindow(area, now);
    return true;
  }
  const entries = activeEntries(ledger, now);
  const recoveryRequiredUntil = activeRecoveryUntil(ledger, now);
  if (entries.length === 0 && recoveryRequiredUntil === null) {
    await area.remove(CORRUPTION_KEY);
  } else if (
    entries.length !== ledger.entries.length ||
    recoveryRequiredUntil !== ledger.recoveryRequiredUntil
  ) {
    await area.set(CORRUPTION_KEY, {
      schemaVersion: 1,
      recoveryRequiredUntil,
      entries
    });
  }
  return false;
}

async function readLedger(
  area: Pick<StorageAreaService, 'get'>
): Promise<SessionDraftProtocolCorruptionLedger> {
  const raw = await area.get(CORRUPTION_KEY);
  if (raw === undefined) {
    return { schemaVersion: 1, recoveryRequiredUntil: null, entries: [] };
  }
  const ledger = normalizeLedger(raw);
  if (!ledger) throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  return ledger;
}

function normalizeLedger<Value>(value: Value): SessionDraftProtocolCorruptionLedger | null {
  const ledger = readExactOwnDataRecord(value, [
    'schemaVersion',
    'recoveryRequiredUntil',
    'entries'
  ]);
  const rawEntries = ledger ? readProtocolDataArray(ledger.entries) : null;
  if (
    !ledger ||
    ledger.schemaVersion !== 1 ||
    !isNullableTimestamp(ledger.recoveryRequiredUntil) ||
    !rawEntries
  ) {
    return null;
  }
  const entries: SessionDraftProtocolCorruptionEntry[] = [];
  for (const rawEntry of rawEntries) {
    const entry = normalizeEntry(rawEntry);
    if (!entry || entries.some(({ sourceKey }) => sourceKey === entry.sourceKey)) return null;
    entries.push(entry);
  }
  return entries.length <= MAX_CORRUPTION_ENTRIES
    ? {
        schemaVersion: 1,
        recoveryRequiredUntil: ledger.recoveryRequiredUntil,
        entries
      }
    : null;
}

function normalizeEntry(value: RuntimePropertyValue): SessionDraftProtocolCorruptionEntry | null {
  const entry = readExactOwnDataRecord(value, ['sourceKey', 'quarantinedAt']);
  return entry &&
    typeof entry.sourceKey === 'string' &&
    entry.sourceKey.length > 0 &&
    typeof entry.quarantinedAt === 'number' &&
    Number.isInteger(entry.quarantinedAt) &&
    entry.quarantinedAt >= 0
    ? { sourceKey: entry.sourceKey, quarantinedAt: entry.quarantinedAt }
    : null;
}

function activeEntries(
  ledger: SessionDraftProtocolCorruptionLedger,
  now: number
): SessionDraftProtocolCorruptionEntry[] {
  return ledger.entries.filter((entry) => entry.quarantinedAt + CORRUPTION_AUTHORITY_TTL_MS > now);
}

function activeRecoveryUntil(
  ledger: SessionDraftProtocolCorruptionLedger,
  now: number
): number | null {
  return ledger.recoveryRequiredUntil !== null && ledger.recoveryRequiredUntil > now
    ? ledger.recoveryRequiredUntil
    : null;
}

function isNullableTimestamp(value: RuntimePropertyValue): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function writeRecoveryWindow(area: Pick<StorageAreaService, 'set'>, now: number): Promise<void> {
  return area.set(CORRUPTION_KEY, {
    schemaVersion: 1,
    recoveryRequiredUntil: now + CORRUPTION_AUTHORITY_TTL_MS,
    entries: []
  });
}
