import type { StorageAreaService } from '../../platform/interfaces/storage';
import { quarantineMalformedSessionDraftProtocolRecords } from './sessionDraftProtocolCorruption';
import {
  createSessionDraftDeletionChunkStorageKey,
  createSessionDraftDeletionManifestStorageKey
} from './sessionDraftDeletionRecordAccess';
import {
  normalizeSessionDraftDeletionChunk,
  normalizeSessionDraftDeletionManifest,
  SESSION_DRAFT_DELETE_CHUNK_PREFIX,
  SESSION_DRAFT_DELETE_MANIFEST_PREFIX,
  type SessionDraftDeletionManifest
} from './sessionDraftDeletionStore';
import { retireSessionDraftOperation } from './sessionDraftRetiredOperationStore';

const CURSOR_KEY = 'aiob.restoreStorage.deleteGcCursor.v1';
const BATCH_SIZE = 64;
const INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';

export async function maintainSessionDraftDeletionReceipts(
  area: StorageAreaService,
  now: number,
  resume: (manifest: SessionDraftDeletionManifest) => Promise<boolean>
): Promise<void> {
  const values = await area.getAll();
  const keys = Object.keys(values)
    .filter(
      (key) =>
        key.startsWith(SESSION_DRAFT_DELETE_MANIFEST_PREFIX) ||
        key.startsWith(SESSION_DRAFT_DELETE_CHUNK_PREFIX)
    )
    .sort();
  const rawCursor = await area.get<unknown>(CURSOR_KEY);
  if (rawCursor !== undefined && typeof rawCursor !== 'string') {
    await quarantineMalformedSessionDraftProtocolRecords(area, [CURSOR_KEY], now);
    throw new Error(INVALID);
  }
  const cursor = rawCursor;
  const found = cursor ? keys.findIndex((key) => key > cursor) : 0;
  const start = found < 0 ? 0 : found;
  const batch = keys.slice(start, start + BATCH_SIZE);
  const quarantine: string[] = [];
  for (const key of batch) {
    if (key.startsWith(SESSION_DRAFT_DELETE_MANIFEST_PREFIX)) {
      const manifest = normalizeSessionDraftDeletionManifest(values[key]);
      if (
        !manifest ||
        manifest.createdAt > now ||
        key !== createSessionDraftDeletionManifestStorageKey(manifest.operationId)
      ) {
        quarantine.push(key);
        continue;
      }
      const complete = manifest.state === 'committed' || (await resume(manifest));
      if (manifest.expiresAt <= now && complete) {
        await retireSessionDraftOperation(area, manifest.operationId, now);
        await area.remove([
          createSessionDraftDeletionManifestStorageKey(manifest.operationId),
          ...Array.from({ length: manifest.chunkCount }, (_, index) =>
            createSessionDraftDeletionChunkStorageKey(manifest.operationId, index)
          )
        ]);
      }
      continue;
    }
    const chunk = normalizeSessionDraftDeletionChunk(values[key]);
    if (
      !chunk ||
      chunk.createdAt > now ||
      key !== createSessionDraftDeletionChunkStorageKey(chunk.operationId, chunk.chunkIndex)
    ) {
      quarantine.push(key, ...getMalformedChunkOperationAuthorityKeys(key, chunk?.operationId));
      continue;
    }
    const manifestKey = createSessionDraftDeletionManifestStorageKey(chunk.operationId);
    if (values[manifestKey] === undefined && chunk.expiresAt <= now) {
      await retireSessionDraftOperation(area, chunk.operationId, now);
      await area.remove(key);
    }
  }
  await quarantineMalformedSessionDraftProtocolRecords(area, quarantine, now);
  if (start + batch.length < keys.length && batch.length > 0) {
    await area.set(CURSOR_KEY, batch[batch.length - 1]);
  } else {
    await area.remove(CURSOR_KEY);
  }
  if (quarantine.length > 0) throw new Error(INVALID);
}

function getMalformedChunkOperationAuthorityKeys(
  key: string,
  recordOperationId: string | undefined
): string[] {
  const operationIds = new Set<string>();
  if (recordOperationId) operationIds.add(recordOperationId);
  const suffix = key.slice(SESSION_DRAFT_DELETE_CHUNK_PREFIX.length);
  const separator = suffix.lastIndexOf('.');
  if (separator > 0) {
    try {
      const operationId = decodeURIComponent(suffix.slice(0, separator));
      if (operationId.length > 0 && operationId.length <= 128) operationIds.add(operationId);
    } catch {
      // The malformed source key itself is still quarantined below.
    }
  }
  return Array.from(operationIds, createSessionDraftDeletionManifestStorageKey);
}
