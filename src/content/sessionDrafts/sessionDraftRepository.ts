import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  createSessionDraftStorageKey,
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from './sessionDraftKeys';
import {
  SessionDraftIndexSchema,
  createSessionDraftIndex,
  createSessionDraftIndexEntry,
  normalizeSessionDraftEnvelopeForSave
} from './sessionDraftSchemas';
import { pruneSessionDraftIndexEntriesForRetentionPolicy } from './sessionDraftRetentionPolicy';
import { resolveSessionDraftRepositoryStoragePolicy } from './sessionDraftRepositoryPolicy';
import {
  getCurrentSessionDraftOwnerContext,
  isSessionDraftOwnerContextActive
} from './sessionDraftTabContext';
import {
  type SessionDraftEnvelope,
  type SessionDraftIndexEntry,
  type SessionDraftMode,
  type SessionDraftRepository,
  type SessionDraftRepositoryOptions,
  type SessionDraftRemovalTarget,
  type SessionDraftSaveOptions
} from './sessionDraftTypes';
import { readValidSessionDraftCandidates } from './sessionDraftRepositoryCandidates';
import {
  claimSessionDraftCandidate,
  pickPreferredSessionDraftCandidate,
  resolveSessionDraftOperationOwnerContext
} from './sessionDraftRepositorySelection';
import {
  applySessionDraftOwnerContext,
  ensureSessionDraftEnvelopeAllowed
} from './sessionDraftRepositoryEnvelope';

function omitUndefinedOptionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
export function createSessionDraftRepository(
  area: StorageAreaService,
  options: SessionDraftRepositoryOptions & {
    deleteKeys: NonNullable<SessionDraftRepositoryOptions['deleteKeys']>;
  }
): SessionDraftRepository {
  const storagePolicy = resolveSessionDraftRepositoryStoragePolicy(options);
  const retentionPolicy = storagePolicy.retentionPolicy;
  const maxEntries = storagePolicy.maxDraftEntries;
  const maxEnvelopeBytes = storagePolicy.maxEnvelopeBytes;
  const resolveOwnerContext = options.resolveOwnerContext ?? getCurrentSessionDraftOwnerContext;
  const isOwnerContextActive = options.isOwnerContextActive ?? isSessionDraftOwnerContextActive;
  const deleteKeys = options.deleteKeys;
  async function readIndex(now: number): Promise<{
    entries: SessionDraftIndexEntry[];
    removedKeys: string[];
    dirty: boolean;
  }> {
    const stored = await area.get<unknown>(SESSION_DRAFT_INDEX_KEY);
    if (stored === undefined) {
      return { entries: [], removedKeys: [], dirty: false };
    }
    const parsed = SessionDraftIndexSchema.safeParse(stored);
    if (!parsed.success) {
      return { entries: [], removedKeys: [], dirty: true };
    }
    const entries = parsed.data.entries.map(
      (entry) => omitUndefinedOptionalFields(entry) as SessionDraftIndexEntry
    );
    return pruneIndexEntries(entries, now);
  }

  function pruneIndexEntries(entries: readonly SessionDraftIndexEntry[], now: number) {
    return pruneSessionDraftIndexEntriesForRetentionPolicy(entries, now, {
      policy: retentionPolicy,
      maxEntries
    });
  }
  async function persistIndex(
    entries: SessionDraftIndexEntry[],
    removedKeys: string[],
    dirty: boolean,
    cause: 'repair' | 'remove' | 'prune' = 'repair'
  ): Promise<void> {
    const uniqueKeys = Array.from(new Set(removedKeys));
    if (uniqueKeys.length > 0) {
      await deleteKeys(uniqueKeys, cause);
    }
    if (dirty || uniqueKeys.length > 0) {
      await area.set(SESSION_DRAFT_INDEX_KEY, createSessionDraftIndex(entries));
    }
  }

  async function saveEnvelope(
    envelope: SessionDraftEnvelope,
    saveOptions?: SessionDraftSaveOptions
  ): Promise<SessionDraftEnvelope> {
    const now = Date.now();
    const operationOwnerContext = await resolveSessionDraftOperationOwnerContext(
      saveOptions,
      resolveOwnerContext
    );
    const normalized = normalizeSessionDraftEnvelopeForSave(
      applySessionDraftOwnerContext(envelope, operationOwnerContext),
      retentionPolicy.retentionMs
    );
    ensureSessionDraftEnvelopeAllowed(normalized, maxEnvelopeBytes);
    const nextEntry = createSessionDraftIndexEntry(normalized);

    const indexState = await readIndex(now);
    const nextState = pruneIndexEntries(
      [
        nextEntry,
        ...indexState.entries.filter(
          (entry) =>
            entry.key !== nextEntry.key &&
            !(
              entry.mode === normalized.mode &&
              entry.pageKey === normalized.pageKey &&
              entry.draftId === normalized.draftId
            )
        )
      ],
      now
    );
    const storageKey = createSessionDraftStorageKey({
      mode: normalized.mode,
      pageKey: normalized.pageKey,
      draftId: normalized.draftId
    });

    const keysToRemove = new Set([...indexState.removedKeys, ...nextState.removedKeys]);
    const retainCurrent = nextState.entries.some((entry) => entry.key === storageKey);
    if (retainCurrent) {
      keysToRemove.delete(storageKey);
    }
    if (keysToRemove.size > 0) {
      await deleteKeys(Array.from(keysToRemove), 'save-retention');
    }
    await area.setMany({
      ...(retainCurrent ? { [storageKey]: normalized } : {}),
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex(nextState.entries)
    });

    return normalized;
  }

  const readValidCandidates = (mode: SessionDraftMode, pageUrl: string, now: number) =>
    readValidSessionDraftCandidates({
      area,
      mode,
      pageUrl,
      now,
      maxEnvelopeBytes,
      retentionPolicy,
      readIndex,
      persistIndex: (entries, removedKeys) => persistIndex(entries, removedKeys, true)
    });

  return {
    async loadLatest(mode, pageUrl, now = Date.now(), selectionOptions) {
      const candidates = await readValidCandidates(mode, pageUrl, now);
      const ownerContext = await resolveSessionDraftOperationOwnerContext(
        selectionOptions,
        resolveOwnerContext
      );
      const selected = await pickPreferredSessionDraftCandidate(
        candidates,
        ownerContext,
        isOwnerContextActive
      );
      return claimSessionDraftCandidate(selected, ownerContext, saveEnvelope);
    },

    async save(envelope, saveOptions) {
      await saveEnvelope(envelope, saveOptions);
    },

    async remove(target: SessionDraftRemovalTarget): Promise<void> {
      const now = Date.now();
      const indexState = await readIndex(now);
      const keys = new Set<string>();
      if (typeof target === 'string' && isSessionDraftStorageKey(target)) {
        keys.add(target);
      } else if (typeof target === 'string') {
        indexState.entries
          .filter((entry) => entry.draftId === target)
          .forEach((entry) => keys.add(entry.key));
      } else {
        keys.add(target.key);
      }

      const nextEntries = indexState.entries.filter((entry) => !keys.has(entry.key));
      await persistIndex(
        nextEntries,
        [...indexState.removedKeys, ...keys],
        indexState.dirty || keys.size > 0,
        'remove'
      );
    },

    async listCandidates(mode, pageUrl, now = Date.now(), selectionOptions) {
      const candidates = await readValidCandidates(mode, pageUrl, now);
      const ownerContext = await resolveSessionDraftOperationOwnerContext(
        selectionOptions,
        resolveOwnerContext
      );
      if (!ownerContext) {
        return candidates;
      }

      const selected = await claimSessionDraftCandidate(
        await pickPreferredSessionDraftCandidate(candidates, ownerContext, isOwnerContextActive),
        ownerContext,
        saveEnvelope
      );
      return selected ? [selected] : [];
    },

    async pruneExpired(now = Date.now()): Promise<void> {
      const indexState = await readIndex(now);
      if (!indexState.dirty && indexState.removedKeys.length === 0) {
        return;
      }
      await persistIndex(indexState.entries, indexState.removedKeys, true, 'prune');
    }
  };
}

/** Direct storage deletion is restricted to tests and the local dev harness. */
export function createDirectSessionDraftRepository(
  area: StorageAreaService,
  options: Omit<SessionDraftRepositoryOptions, 'deleteKeys'> = {}
): SessionDraftRepository {
  return createSessionDraftRepository(area, {
    ...options,
    deleteKeys: (keys) => area.remove([...keys])
  });
}
