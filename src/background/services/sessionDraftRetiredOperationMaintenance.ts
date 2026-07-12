import type { StorageAreaService } from '../../platform/interfaces/storage';
import { quarantineMalformedSessionDraftProtocolRecords } from './sessionDraftProtocolCorruption';
import {
  normalizeSessionDraftRetiredOperation,
  SESSION_DRAFT_RETIRED_OPERATION_PREFIX
} from './sessionDraftRetiredOperationStore';

const CURSOR_KEY = 'aiob.restoreStorage.retiredOperationGcCursor.v1';
const BATCH_SIZE = 64;

export async function pruneSessionDraftRetiredOperations(
  area: Pick<StorageAreaService, 'get' | 'getAll' | 'set' | 'remove'>,
  now = Date.now()
): Promise<void> {
  const values = await area.getAll();
  const keys = Object.keys(values)
    .filter((key) => key.startsWith(SESSION_DRAFT_RETIRED_OPERATION_PREFIX))
    .sort();
  const cursor = await area.get<string>(CURSOR_KEY);
  const found = cursor ? keys.findIndex((key) => key > cursor) : 0;
  const start = found < 0 ? 0 : found;
  const batch = keys.slice(start, start + BATCH_SIZE);
  const removeKeys: string[] = [];
  const quarantineKeys: string[] = [];
  for (const key of batch) {
    const retired = normalizeSessionDraftRetiredOperation(values[key]);
    if (
      !retired ||
      retired.retiredAt > now ||
      key !== `${SESSION_DRAFT_RETIRED_OPERATION_PREFIX}${encodeURIComponent(retired.operationId)}`
    ) {
      quarantineKeys.push(key);
    } else if (retired.expiresAt <= now) {
      removeKeys.push(key);
    }
  }
  if (removeKeys.length > 0) await area.remove(removeKeys);
  await quarantineMalformedSessionDraftProtocolRecords(area, quarantineKeys, now);
  if (start + batch.length < keys.length && batch.length > 0) {
    await area.set(CURSOR_KEY, batch[batch.length - 1]);
  } else {
    await area.remove(CURSOR_KEY);
  }
}
