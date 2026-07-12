import type { StorageAreaService } from '../../platform/interfaces/storage';
import { rebuildSessionDraftIndex } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import { readSessionDraftJournalInventory } from './sessionDraftSaveJournalMaintenance';
import {
  createSessionDraftCursorStorageKey,
  readCursorState,
  type SessionDraftCursor
} from './sessionDraftSaveJournal';
import { createSessionDraftDeletionChunkStorageKey } from './sessionDraftDeletionRecordAccess';
import {
  assertSessionDraftDeletionRecordBounded,
  createSessionDraftTombstoneStorageKey,
  normalizeSessionDraftTombstone,
  type SessionDraftDeletionChunk,
  type SessionDraftTombstone
} from './sessionDraftDeletionStore';

const INVALID = 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID';

export async function prepareSessionDraftDeletionChunk(
  area: StorageAreaService,
  chunk: SessionDraftDeletionChunk,
  now: number
): Promise<SessionDraftDeletionChunk> {
  const cursors = await Promise.all(
    chunk.candidateKeys.map(async (draftKey) => ({
      draftKey,
      state: await readCursorState(area, draftKey)
    }))
  );
  if (
    cursors.some(
      ({ draftKey, state }) =>
        state.kind === 'invalid' || (state.kind === 'valid' && state.value.draftKey !== draftKey)
    )
  )
    throw new Error(INVALID);
  for (const { draftKey, state } of cursors) {
    if (state.kind !== 'valid') continue;
    if (state.value.epoch !== chunk.epoch) throw new Error(INVALID);
    if (state.value.revision === Number.MAX_SAFE_INTEGER) throw new Error(INVALID);
    if (state.value.state === 'deleted') {
      const tombstone = normalizeSessionDraftTombstone(
        await area.get(createSessionDraftTombstoneStorageKey(draftKey))
      );
      if (
        !tombstone ||
        tombstone.draftKey !== draftKey ||
        tombstone.epoch !== chunk.epoch ||
        tombstone.revision !== state.value.revision ||
        tombstone.operationId !== state.value.lastOperationId
      )
        throw new Error(INVALID);
    }
  }
  const inventory = await readSessionDraftJournalInventory(area, now);
  if (inventory.invalid || inventory.quarantinedKeys.length > 0) throw new Error(INVALID);
  const protectedSet = new Set(
    inventory.journals
      .filter(
        (journal) =>
          journal.state === 'pending' &&
          journal.context.epoch === chunk.epoch &&
          journal.expiresAt > now
      )
      .map((journal) => journal.context.draftKey)
  );
  const prepared: SessionDraftDeletionChunk = {
    ...chunk,
    state: 'prepared',
    revisions: cursors
      .filter(
        ({ draftKey, state }) =>
          !protectedSet.has(draftKey) &&
          !(state.kind === 'valid' && state.value.state === 'deleted')
      )
      .map(({ draftKey, state }) => ({
        draftKey,
        revision: state.kind === 'valid' ? state.value.revision + 1 : 1
      })),
    existingRevisions: cursors
      .filter(
        ({ draftKey, state }) =>
          !protectedSet.has(draftKey) && state.kind === 'valid' && state.value.state === 'deleted'
      )
      .map(({ draftKey, state }) => ({
        draftKey,
        revision: state.kind === 'valid' ? state.value.revision : 0
      })),
    protectedKeys: chunk.candidateKeys.filter((key) => protectedSet.has(key))
  };
  const authority: Record<
    string,
    SessionDraftDeletionChunk | SessionDraftCursor | SessionDraftTombstone
  > = {
    [createSessionDraftDeletionChunkStorageKey(chunk.operationId, chunk.chunkIndex)]: prepared
  };
  assertSessionDraftDeletionRecordBounded(prepared);
  for (const revision of prepared.revisions) {
    authority[createSessionDraftCursorStorageKey(revision.draftKey)] = {
      schemaVersion: 1,
      epoch: chunk.epoch,
      state: 'deleted',
      draftKey: revision.draftKey,
      revision: revision.revision,
      lastOperationId: chunk.operationId
    };
    authority[createSessionDraftTombstoneStorageKey(revision.draftKey)] = {
      schemaVersion: 1,
      epoch: chunk.epoch,
      state: 'deleted',
      draftKey: revision.draftKey,
      revision: revision.revision,
      operationId: chunk.operationId
    };
  }
  await area.setMany(authority);
  return prepared;
}

export async function assertSessionDraftDeletionAuthority(
  area: Pick<StorageAreaService, 'get'>,
  chunk: SessionDraftDeletionChunk
): Promise<void> {
  for (const revision of chunk.revisions) {
    const [cursorState, rawTombstone] = await Promise.all([
      readCursorState(area, revision.draftKey),
      area.get(createSessionDraftTombstoneStorageKey(revision.draftKey))
    ]);
    const cursor = cursorState.kind === 'valid' ? cursorState.value : null;
    const tombstone = normalizeSessionDraftTombstone(rawTombstone);
    if (
      !cursor ||
      cursor.draftKey !== revision.draftKey ||
      cursor.epoch !== chunk.epoch ||
      cursor.state !== 'deleted' ||
      cursor.revision !== revision.revision ||
      cursor.lastOperationId !== chunk.operationId ||
      !tombstone ||
      tombstone.draftKey !== revision.draftKey ||
      tombstone.epoch !== chunk.epoch ||
      tombstone.revision !== revision.revision ||
      tombstone.operationId !== chunk.operationId
    ) {
      throw new Error(INVALID);
    }
  }
}

export async function completeSessionDraftDeletionChunk(
  area: StorageAreaService,
  chunk: SessionDraftDeletionChunk
): Promise<SessionDraftDeletionChunk> {
  await assertSessionDraftDeletionAuthority(area, chunk);
  for (const revision of chunk.existingRevisions) {
    const cursorState = await readCursorState(area, revision.draftKey);
    const tombstone = normalizeSessionDraftTombstone(
      await area.get(createSessionDraftTombstoneStorageKey(revision.draftKey))
    );
    if (
      cursorState.kind !== 'valid' ||
      cursorState.value.draftKey !== revision.draftKey ||
      cursorState.value.epoch !== chunk.epoch ||
      cursorState.value.state !== 'deleted' ||
      cursorState.value.revision !== revision.revision ||
      !tombstone ||
      tombstone.draftKey !== revision.draftKey ||
      tombstone.epoch !== chunk.epoch ||
      tombstone.revision !== revision.revision ||
      tombstone.operationId !== cursorState.value.lastOperationId
    )
      throw new Error(INVALID);
  }
  const keys = [...chunk.revisions, ...chunk.existingRevisions].map(({ draftKey }) => draftKey);
  if (keys.length > 0) await area.remove(keys);
  await rebuildSessionDraftIndex(area);
  const committed: SessionDraftDeletionChunk = { ...chunk, state: 'committed' };
  assertSessionDraftDeletionRecordBounded(committed);
  await area.set(
    createSessionDraftDeletionChunkStorageKey(chunk.operationId, chunk.chunkIndex),
    committed
  );
  return committed;
}
