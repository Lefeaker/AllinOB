import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey,
  isSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from './sessionDraftKeys';
import {
  SessionDraftEnvelopeSchema,
  SessionDraftIndexSchema,
  containsDisallowedSessionDraftPayloadValue,
  createSessionDraftIndex,
  createSessionDraftIndexEntry,
  measureSessionDraftValueBytes,
  normalizeSessionDraftEnvelopeForSave
} from './sessionDraftSchemas';
import {
  getSessionDraftEffectiveExpiresAt,
  pruneSessionDraftIndexEntriesForRetentionPolicy
} from './sessionDraftRetentionPolicy';
import { resolveSessionDraftRepositoryStoragePolicy } from './sessionDraftRepositoryPolicy';
import {
  getCurrentSessionDraftOwnerContext,
  getSessionDraftEnvelopeOwnerContext,
  isSessionDraftOwnerContextActive,
  isSameSessionDraftOwnerContext,
  normalizeSessionDraftOwnerContext
} from './sessionDraftTabContext';
import {
  isRestorableSessionDraftStatus,
  type SessionDraftEnvelope,
  type SessionDraftIndexEntry,
  type SessionDraftMode,
  type SessionDraftOwnerContext,
  type SessionDraftRepository,
  type SessionDraftRepositoryOptions,
  type SessionDraftRemovalTarget,
  type SessionDraftSaveOptions,
  type SessionDraftSelectionOptions
} from './sessionDraftTypes';

type OwnerContextOptions = SessionDraftSaveOptions | SessionDraftSelectionOptions;
function omitUndefinedOptionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
function hasOwnerContextOverride(
  options: OwnerContextOptions | undefined
): options is { ownerContext: SessionDraftOwnerContext | null } {
  return Boolean(options) && Object.prototype.hasOwnProperty.call(options, 'ownerContext');
}
function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === 'function');
}
export function createSessionDraftRepository(
  area: StorageAreaService,
  options: SessionDraftRepositoryOptions = {}
): SessionDraftRepository {
  const storagePolicy = resolveSessionDraftRepositoryStoragePolicy(options);
  const retentionPolicy = storagePolicy.retentionPolicy;
  const maxEntries = storagePolicy.maxDraftEntries;
  const maxEnvelopeBytes = storagePolicy.maxEnvelopeBytes;
  const resolveOwnerContext = options.resolveOwnerContext ?? getCurrentSessionDraftOwnerContext;
  const isOwnerContextActive = options.isOwnerContextActive ?? isSessionDraftOwnerContextActive;
  function resolveOperationOwnerContext(operationOptions?: OwnerContextOptions) {
    if (hasOwnerContextOverride(operationOptions)) {
      return normalizeSessionDraftOwnerContext(operationOptions.ownerContext);
    }
    const currentOwnerContext = resolveOwnerContext();
    if (isPromiseLike<SessionDraftOwnerContext | null | undefined>(currentOwnerContext)) {
      return currentOwnerContext.then((value) => normalizeSessionDraftOwnerContext(value));
    }
    return normalizeSessionDraftOwnerContext(currentOwnerContext);
  }

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
    dirty: boolean
  ): Promise<void> {
    const uniqueKeys = Array.from(new Set(removedKeys));
    if (uniqueKeys.length > 0) {
      await area.remove(uniqueKeys);
    }
    if (dirty || uniqueKeys.length > 0) {
      await area.set(SESSION_DRAFT_INDEX_KEY, createSessionDraftIndex(entries));
    }
  }

  function ensureEnvelopeAllowed(envelope: SessionDraftEnvelope): void {
    if (containsDisallowedSessionDraftPayloadValue(envelope.payload)) {
      throw new Error('Session draft payload must not contain data:image/ strings or binary data.');
    }
    if (measureSessionDraftValueBytes(envelope) > maxEnvelopeBytes) {
      throw new Error('Session draft envelope exceeds the configured storage limit.');
    }
  }

  function applyOwnerContext(
    envelope: SessionDraftEnvelope,
    ownerContext: SessionDraftOwnerContext | null
  ): SessionDraftEnvelope {
    const payload = { ...envelope.payload };
    const existingOwnerContext = getSessionDraftEnvelopeOwnerContext(envelope);
    const nextOwnerContext = ownerContext ?? existingOwnerContext;

    if (nextOwnerContext) {
      payload.ownerContext = nextOwnerContext;
    } else {
      delete payload.ownerContext;
    }

    return { ...envelope, payload };
  }

  async function saveEnvelope(
    envelope: SessionDraftEnvelope,
    saveOptions?: SessionDraftSaveOptions
  ): Promise<SessionDraftEnvelope> {
    const now = Date.now();
    const pendingOwnerContext = resolveOperationOwnerContext(saveOptions);
    const operationOwnerContext = isPromiseLike<SessionDraftOwnerContext | null>(
      pendingOwnerContext
    )
      ? await pendingOwnerContext
      : pendingOwnerContext;
    const normalized = normalizeSessionDraftEnvelopeForSave(
      applyOwnerContext(envelope, operationOwnerContext),
      retentionPolicy.retentionMs
    );
    ensureEnvelopeAllowed(normalized);
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

    await area.setMany({
      [storageKey]: normalized,
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex(nextState.entries)
    });

    const keysToRemove = new Set([...indexState.removedKeys, ...nextState.removedKeys]);
    if (nextState.entries.some((entry) => entry.key === storageKey)) {
      keysToRemove.delete(storageKey);
    }
    if (keysToRemove.size > 0) {
      await area.remove(Array.from(keysToRemove));
    }

    return normalized;
  }

  async function readValidCandidates(
    mode: SessionDraftMode,
    pageUrl: string,
    now: number
  ): Promise<SessionDraftEnvelope[]> {
    const pageKey = createSessionDraftPageKey(mode, pageUrl);
    const indexState = await readIndex(now);
    const candidateEntries = indexState.entries.filter(
      (entry) => entry.mode === mode && entry.pageKey === pageKey
    );

    if (candidateEntries.length === 0) {
      if (indexState.dirty || indexState.removedKeys.length > 0) {
        await persistIndex(indexState.entries, indexState.removedKeys, true);
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

      if (!isRestorableSessionDraftStatus(envelope.status)) {
        continue;
      }

      valid.push(envelope);
    }

    if (invalidKeys.length > 0 || indexState.dirty) {
      const invalidSet = new Set(invalidKeys);
      const nextEntries = indexState.entries.filter((entry) => !invalidSet.has(entry.key));
      await persistIndex(nextEntries, invalidKeys, true);
    }

    return valid.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function isClaimableWithoutOwnerMatch(envelope: SessionDraftEnvelope): boolean {
    return (
      envelope.status === 'restorable' || getSessionDraftEnvelopeOwnerContext(envelope) === null
    );
  }

  async function isInactiveOwnerCandidate(envelope: SessionDraftEnvelope): Promise<boolean> {
    if (envelope.status !== 'active') return false;
    const ownerContext = getSessionDraftEnvelopeOwnerContext(envelope);
    return ownerContext ? !(await isOwnerContextActive(ownerContext)) : false;
  }

  async function pickPreferredCandidate(
    candidates: SessionDraftEnvelope[],
    ownerContext: SessionDraftOwnerContext | null
  ): Promise<SessionDraftEnvelope | null> {
    if (candidates.length === 0) {
      return null;
    }
    if (!ownerContext) {
      return candidates[0] ?? null;
    }

    const sameOwnerCandidate =
      candidates.find((candidate) =>
        isSameSessionDraftOwnerContext(getSessionDraftEnvelopeOwnerContext(candidate), ownerContext)
      ) ?? null;
    if (sameOwnerCandidate) {
      return sameOwnerCandidate;
    }

    const claimableCandidate =
      candidates.find((candidate) => isClaimableWithoutOwnerMatch(candidate)) ?? null;
    if (claimableCandidate) {
      return claimableCandidate;
    }

    for (const candidate of candidates) {
      if (await isInactiveOwnerCandidate(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  async function maybeClaimCandidate(
    candidate: SessionDraftEnvelope | null,
    ownerContext: SessionDraftOwnerContext | null
  ): Promise<SessionDraftEnvelope | null> {
    if (
      !candidate ||
      !ownerContext ||
      isSameSessionDraftOwnerContext(getSessionDraftEnvelopeOwnerContext(candidate), ownerContext)
    ) {
      return candidate;
    }

    return saveEnvelope(candidate, { ownerContext });
  }

  return {
    async loadLatest(mode, pageUrl, now = Date.now(), selectionOptions) {
      const candidates = await readValidCandidates(mode, pageUrl, now);
      const pendingOwnerContext = resolveOperationOwnerContext(selectionOptions);
      const ownerContext = isPromiseLike<SessionDraftOwnerContext | null>(pendingOwnerContext)
        ? await pendingOwnerContext
        : pendingOwnerContext;
      const selected = await pickPreferredCandidate(candidates, ownerContext);
      return maybeClaimCandidate(selected, ownerContext);
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
        indexState.dirty || keys.size > 0
      );
    },

    async listCandidates(mode, pageUrl, now = Date.now(), selectionOptions) {
      const candidates = await readValidCandidates(mode, pageUrl, now);
      const pendingOwnerContext = resolveOperationOwnerContext(selectionOptions);
      const ownerContext = isPromiseLike<SessionDraftOwnerContext | null>(pendingOwnerContext)
        ? await pendingOwnerContext
        : pendingOwnerContext;
      if (!ownerContext) {
        return candidates;
      }

      const selected = await maybeClaimCandidate(
        await pickPreferredCandidate(candidates, ownerContext),
        ownerContext
      );
      return selected ? [selected] : [];
    },

    async pruneExpired(now = Date.now()): Promise<void> {
      const indexState = await readIndex(now);
      if (!indexState.dirty && indexState.removedKeys.length === 0) {
        return;
      }
      await persistIndex(indexState.entries, indexState.removedKeys, true);
    }
  };
}
