import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  getSessionDraftProtocolQuarantineCollisionStatus,
  isSessionDraftProtocolKeyQuarantined
} from './sessionDraftProtocolCorruption';
import {
  normalizeSessionDraftDeletionChunk,
  normalizeSessionDraftDeletionManifest,
  SESSION_DRAFT_DELETE_CHUNK_PREFIX,
  SESSION_DRAFT_DELETE_MANIFEST_PREFIX,
  type SessionDraftDeletionChunk,
  type SessionDraftDeletionManifest
} from './sessionDraftDeletionStore';

export function createSessionDraftDeletionManifestStorageKey(operationId: string): string {
  return `${SESSION_DRAFT_DELETE_MANIFEST_PREFIX}${encodeURIComponent(operationId)}`;
}

export function createSessionDraftDeletionChunkStorageKey(
  operationId: string,
  chunkIndex: number
): string {
  return `${SESSION_DRAFT_DELETE_CHUNK_PREFIX}${encodeURIComponent(operationId)}.${chunkIndex}`;
}

export async function readSessionDraftDeletionManifest(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string
): Promise<SessionDraftDeletionManifest | null | 'invalid'> {
  const key = createSessionDraftDeletionManifestStorageKey(operationId);
  if (await isSessionDraftProtocolKeyQuarantined(area, key)) return 'invalid';
  const raw = await area.get(key);
  if (raw === undefined) return null;
  const manifest = normalizeSessionDraftDeletionManifest(raw);
  return manifest?.operationId === operationId ? manifest : 'invalid';
}

export async function readSessionDraftDeletionChunk(
  area: Pick<StorageAreaService, 'get'>,
  operationId: string,
  chunkIndex: number
): Promise<SessionDraftDeletionChunk | null | 'invalid'> {
  const key = createSessionDraftDeletionChunkStorageKey(operationId, chunkIndex);
  if (await isSessionDraftProtocolKeyQuarantined(area, key)) return 'invalid';
  const raw = await area.get(key);
  if (raw === undefined) return null;
  const chunk = normalizeSessionDraftDeletionChunk(raw);
  return chunk?.operationId === operationId && chunk.chunkIndex === chunkIndex ? chunk : 'invalid';
}

export async function hasAnySessionDraftDeletionRecord(
  area: Pick<StorageAreaService, 'get' | 'getAll'>,
  operationId: string
): Promise<boolean> {
  const manifestKey = createSessionDraftDeletionManifestStorageKey(operationId);
  const prefix = `${SESSION_DRAFT_DELETE_CHUNK_PREFIX}${encodeURIComponent(operationId)}.`;
  const quarantine = await getSessionDraftProtocolQuarantineCollisionStatus(
    area,
    { exactSourceKeys: [manifestKey], numericSourcePrefix: prefix },
    Date.now()
  );
  if (quarantine !== 'none') return true;
  const values = await area.getAll();
  return manifestKey in values || Object.keys(values).some((key) => key.startsWith(prefix));
}
