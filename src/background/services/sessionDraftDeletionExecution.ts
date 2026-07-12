import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  completeSessionDraftDeletionChunk,
  prepareSessionDraftDeletionChunk
} from './sessionDraftDeletionAuthority';
import {
  createSessionDraftDeletionChunkStorageKey,
  createSessionDraftDeletionManifestStorageKey,
  readSessionDraftDeletionChunk
} from './sessionDraftDeletionRecordAccess';
import {
  assertSessionDraftDeletionRecordBounded,
  SESSION_DRAFT_DELETE_CHUNK_SIZE,
  SESSION_DRAFT_DELETE_RECEIPT_TTL_MS,
  type SessionDraftDeletionChunk,
  type SessionDraftDeletionManifest,
  type SessionDraftDeletionRevision
} from './sessionDraftDeletionStore';
import type {
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionTypes';

const INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';

export async function createSessionDraftDeletionManifest(
  area: StorageAreaService,
  request: SessionDraftDeletionRequest,
  candidateKeys: string[],
  candidateFingerprint: string,
  epoch: number,
  now: number
): Promise<SessionDraftDeletionManifest> {
  const groups = chunkKeys(candidateKeys);
  const expiresAt = now + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS;
  const chunks = groups.map(
    (candidateGroup, index): SessionDraftDeletionChunk => ({
      schemaVersion: 1,
      kind: 'delete',
      state: 'selected',
      operationId: request.operationId,
      epoch,
      chunkIndex: index,
      requestFingerprint: request.requestFingerprint,
      candidateFingerprint,
      candidateCount: candidateKeys.length,
      candidateKeys: candidateGroup,
      revisions: [],
      existingRevisions: [],
      protectedKeys: [],
      createdAt: now,
      expiresAt
    })
  );
  for (const chunk of chunks) preflightChunkRecords(chunk);
  for (const chunk of chunks) {
    assertSessionDraftDeletionRecordBounded(chunk);
    const existing = await readSessionDraftDeletionChunk(
      area,
      request.operationId,
      chunk.chunkIndex
    );
    if (existing === 'invalid') throw new Error(INVALID);
    if (
      existing &&
      (!sameKeys(existing.candidateKeys, chunk.candidateKeys) ||
        existing.requestFingerprint !== request.requestFingerprint ||
        existing.candidateFingerprint !== candidateFingerprint ||
        existing.candidateCount !== candidateKeys.length)
    )
      throw new Error(INVALID);
    await area.set(
      createSessionDraftDeletionChunkStorageKey(request.operationId, chunk.chunkIndex),
      chunk
    );
  }
  const manifest: SessionDraftDeletionManifest = {
    schemaVersion: 1,
    kind: 'delete',
    state: 'pending',
    operationId: request.operationId,
    epoch,
    requestFingerprint: request.requestFingerprint,
    candidateFingerprint,
    candidateCount: candidateKeys.length,
    chunkCount: groups.length,
    createdAt: now,
    expiresAt
  };
  assertSessionDraftDeletionRecordBounded(manifest);
  await area.set(createSessionDraftDeletionManifestStorageKey(request.operationId), manifest);
  return manifest;
}

function preflightChunkRecords(chunk: SessionDraftDeletionChunk): void {
  assertSessionDraftDeletionRecordBounded(chunk);
  assertSessionDraftDeletionRecordBounded({
    ...chunk,
    state: 'committed',
    revisions: chunk.candidateKeys.map((draftKey) => ({
      draftKey,
      revision: Number.MAX_SAFE_INTEGER
    })),
    existingRevisions: [],
    protectedKeys: []
  });
}

export async function completeSessionDraftDeletionChunks(
  area: StorageAreaService,
  manifest: SessionDraftDeletionManifest,
  candidateKeys: string[],
  now: number,
  maxIncompleteChunks = Number.POSITIVE_INFINITY
): Promise<SessionDraftDeletionChunk[]> {
  const chunks: SessionDraftDeletionChunk[] = [];
  let completedIncompleteChunks = 0;
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const state = await readSessionDraftDeletionChunk(area, manifest.operationId, index);
    if (state === 'invalid' || state === null || state.epoch !== manifest.epoch) {
      throw new Error(INVALID);
    }
    const expectedKeys = candidateKeys.slice(
      index * SESSION_DRAFT_DELETE_CHUNK_SIZE,
      (index + 1) * SESSION_DRAFT_DELETE_CHUNK_SIZE
    );
    if (!chunkMatchesManifest(state, manifest, expectedKeys)) throw new Error(INVALID);
    let chunk = state;
    if (chunk.state !== 'committed' && completedIncompleteChunks >= maxIncompleteChunks) {
      chunks.push(chunk);
      continue;
    }
    if (chunk.state === 'selected') {
      chunk = await prepareSessionDraftDeletionChunk(area, chunk, now);
    }
    if (chunk.state === 'prepared') {
      chunk = await completeSessionDraftDeletionChunk(area, chunk);
    }
    if (state.state !== 'committed') completedIncompleteChunks += 1;
    chunks.push(chunk);
  }
  return chunks;
}

export async function readSessionDraftManifestCandidateKeys(
  area: Pick<StorageAreaService, 'get'>,
  manifest: SessionDraftDeletionManifest
): Promise<string[]> {
  const keys: string[] = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const chunk = await readSessionDraftDeletionChunk(area, manifest.operationId, index);
    if (chunk === 'invalid' || !chunk || !chunkMatchesManifest(chunk, manifest)) {
      throw new Error(INVALID);
    }
    const expectedSize =
      index < manifest.chunkCount - 1
        ? SESSION_DRAFT_DELETE_CHUNK_SIZE
        : manifest.candidateCount - index * SESSION_DRAFT_DELETE_CHUNK_SIZE;
    if (chunk.candidateKeys.length !== expectedSize) throw new Error(INVALID);
    keys.push(...chunk.candidateKeys);
  }
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => index > 0 && key <= (keys[index - 1] ?? ''))
  )
    throw new Error(INVALID);
  return keys;
}

export function collectSessionDraftDeletionResult(
  manifest: SessionDraftDeletionManifest,
  chunks: SessionDraftDeletionChunk[],
  replayed: boolean
): SessionDraftDeletionResult {
  return {
    epoch: manifest.epoch,
    revisions: chunks
      .flatMap((chunk) => [...chunk.revisions, ...chunk.existingRevisions])
      .sort(byDraftKey),
    protectedKeys: chunks.flatMap((chunk) => chunk.protectedKeys).sort(),
    replayed
  };
}

function chunkMatchesManifest(
  chunk: SessionDraftDeletionChunk,
  manifest: SessionDraftDeletionManifest,
  expectedKeys?: string[]
): boolean {
  return (
    chunk.epoch === manifest.epoch &&
    chunk.createdAt === manifest.createdAt &&
    chunk.expiresAt === manifest.expiresAt &&
    chunk.requestFingerprint === manifest.requestFingerprint &&
    chunk.candidateFingerprint === manifest.candidateFingerprint &&
    chunk.candidateCount === manifest.candidateCount &&
    (expectedKeys === undefined || sameKeys(chunk.candidateKeys, expectedKeys))
  );
}

function chunkKeys(keys: string[]): string[][] {
  return Array.from(
    { length: Math.ceil(keys.length / SESSION_DRAFT_DELETE_CHUNK_SIZE) },
    (_, index) =>
      keys.slice(
        index * SESSION_DRAFT_DELETE_CHUNK_SIZE,
        (index + 1) * SESSION_DRAFT_DELETE_CHUNK_SIZE
      )
  );
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function byDraftKey(
  left: SessionDraftDeletionRevision,
  right: SessionDraftDeletionRevision
): number {
  return left.draftKey.localeCompare(right.draftKey);
}
