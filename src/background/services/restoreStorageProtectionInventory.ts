import type { StorageAreaService } from '../../platform/interfaces/storage';
import { isSessionDraftStorageKey } from '../../content/sessionDrafts/sessionDraftKeys';
import { buildSessionDraftReferenceIndexSnapshot } from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import { isVideoScreenshotCacheStorageKey } from '../../content/video/videoScreenshotCacheTypes';
import {
  normalizeRestoreStorageLease,
  RESTORE_STORAGE_LEASE_PREFIX
} from './restoreStorageLeaseStore';
import {
  createSessionDraftPendingStorageKey,
  normalizeSessionDraftSaveJournal,
  SESSION_DRAFT_PENDING_PREFIX
} from './sessionDraftSaveJournal';

export interface RestoreStorageProtectionInventory {
  screenshotKeys: string[];
  pendingDraftKeys: string[];
}

export async function buildRestoreStorageProtectionInventory(
  area: Pick<StorageAreaService, 'getAll'>,
  options: { now?: number; currentEpoch?: number } = {}
): Promise<RestoreStorageProtectionInventory> {
  const now = options.now ?? Date.now();
  const currentEpoch = options.currentEpoch ?? 1;
  const values = await area.getAll();
  const draftSnapshot = buildSessionDraftReferenceIndexSnapshot(values);
  const screenshotKeys = new Set<string>();
  const pendingDraftKeys = new Set<string>();
  const draftsByKey = new Map(draftSnapshot.drafts.map((draft) => [draft.key, draft]));

  for (const draft of draftSnapshot.drafts) {
    addScreenshotKeys(screenshotKeys, draft.screenshotKeys);
  }

  for (const [storageKey, raw] of Object.entries(values)) {
    if (storageKey.startsWith(RESTORE_STORAGE_LEASE_PREFIX)) {
      const lease = normalizeRestoreStorageLease(raw);
      if (
        lease &&
        storageKey === `${RESTORE_STORAGE_LEASE_PREFIX}${encodeURIComponent(lease.operationId)}` &&
        lease.createdAt <= now &&
        lease.expiresAt > now &&
        lease.epoch === currentEpoch &&
        isSessionDraftStorageKey(lease.draftKey)
      ) {
        addScreenshotKeys(screenshotKeys, lease.screenshotKeys);
      }
      continue;
    }
    if (!storageKey.startsWith(SESSION_DRAFT_PENDING_PREFIX)) continue;
    const journal = normalizeSessionDraftSaveJournal(raw);
    if (
      !journal ||
      journal.state !== 'pending' ||
      storageKey !== createSessionDraftPendingStorageKey(journal.operationId) ||
      journal.operationId !== journal.context.operationId ||
      journal.createdAt > now ||
      journal.expiresAt <= now ||
      journal.context.epoch !== currentEpoch ||
      !isSessionDraftStorageKey(journal.context.draftKey)
    ) {
      continue;
    }
    const draft = draftsByKey.get(journal.context.draftKey);
    if (!draft) continue;
    pendingDraftKeys.add(journal.context.draftKey);
    addScreenshotKeys(screenshotKeys, draft.screenshotKeys);
  }

  return {
    screenshotKeys: [...screenshotKeys].sort(),
    pendingDraftKeys: [...pendingDraftKeys].sort()
  };
}

function addScreenshotKeys(target: Set<string>, keys: readonly string[]): void {
  for (const key of keys) {
    if (isVideoScreenshotCacheStorageKey(key)) target.add(key);
  }
}
