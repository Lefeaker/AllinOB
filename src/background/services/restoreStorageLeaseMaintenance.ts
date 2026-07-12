import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  normalizeRestoreStorageLease,
  RESTORE_STORAGE_LEASE_PREFIX
} from './restoreStorageLeaseStore';
import { quarantineMalformedSessionDraftProtocolRecords } from './sessionDraftProtocolCorruption';

const LEASE_GC_CURSOR_KEY = 'aiob.restoreStorage.leaseGcCursor.v1';
const LEASE_GC_BATCH_SIZE = 64;

export async function pruneRestoreStorageLeases(
  area: Pick<StorageAreaService, 'get' | 'getAll' | 'set' | 'remove'>,
  now = Date.now(),
  currentEpoch = 1
): Promise<void> {
  const values = await area.getAll();
  const leaseKeys = Object.keys(values)
    .filter((key) => key.startsWith(RESTORE_STORAGE_LEASE_PREFIX))
    .sort();
  const cursor = await area.get<string>(LEASE_GC_CURSOR_KEY);
  const start = cursor
    ? Math.max(
        0,
        leaseKeys.findIndex((key) => key > cursor)
      )
    : 0;
  const batch = leaseKeys.slice(start, start + LEASE_GC_BATCH_SIZE);
  const removeKeys: string[] = [];
  const quarantineKeys: string[] = [];
  for (const key of batch) {
    const raw = values[key];
    const lease = normalizeRestoreStorageLease(raw);
    if (
      !lease ||
      lease.createdAt > now ||
      key !== `${RESTORE_STORAGE_LEASE_PREFIX}${encodeURIComponent(lease.operationId)}`
    ) {
      quarantineKeys.push(key);
    } else if (lease.expiresAt <= now || lease.epoch !== currentEpoch) {
      removeKeys.push(key);
    }
  }
  if (removeKeys.length > 0) await area.remove(removeKeys);
  await quarantineMalformedSessionDraftProtocolRecords(area, quarantineKeys, now);
  if (start + batch.length < leaseKeys.length && batch.length > 0) {
    await area.set(LEASE_GC_CURSOR_KEY, batch[batch.length - 1]);
  } else {
    await area.remove(LEASE_GC_CURSOR_KEY);
  }
}
