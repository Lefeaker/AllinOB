/* @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import type { StorageAreaService } from '@platform/interfaces/storage';
import type { RestoreStorageMaintenanceMessage } from '@content/sessionDrafts/restoreStorageMaintenanceMessages';
import type { SessionDraftRepositoryMessage } from '@content/sessionDrafts/sessionDraftRepositoryMessages';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import type {
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobStore
} from '@content/video/videoScreenshotCacheStore';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import {
  createRestoreStorageClearPlan,
  RESTORE_STORAGE_CLEAR_TTL_MS,
  type RestoreStorageClearReceipt
} from '../../../src/background/services/restoreStorageClearPlanStore';
import { SESSION_DRAFT_RETIRED_OPERATION_TTL_MS } from '../../../src/background/services/sessionDraftRetiredOperationStore';

const NOW = 2_000_000_000_000;
const CLEAR_PREFIX = 'aiob.restoreStorage.clear.v1.';
const RETIRED_PREFIX = 'aiob.restoreStorage.retiredOperation.v1.';

class ReceiptBlobStore implements VideoScreenshotCacheBlobMaintenanceStore {
  visible = 2;
  failDeleteOnce = false;
  countAll(): Promise<number> {
    return Promise.resolve(this.visible);
  }
  deleteAll(): Promise<number> {
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false;
      return Promise.reject(new Error('idb unavailable'));
    }
    const count = this.visible;
    this.visible = 0;
    return Promise.resolve(count);
  }
  put(): Promise<void> {
    return Promise.resolve();
  }
  get(): ReturnType<VideoScreenshotCacheBlobStore['get']> {
    return Promise.resolve({ status: 'missing' });
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  deleteMany(): Promise<void> {
    return Promise.resolve();
  }
  listByPageKey(): ReturnType<VideoScreenshotCacheBlobStore['listByPageKey']> {
    return Promise.resolve({ entries: [], invalidKeys: [] });
  }
  listAllMetadata(): ReturnType<VideoScreenshotCacheBlobStore['listAllMetadata']> {
    return Promise.resolve({ entries: [], invalidKeys: [] });
  }
  prune(): ReturnType<VideoScreenshotCacheBlobStore['prune']> {
    return Promise.resolve({ entries: [], candidateKeys: [], invalidKeys: [], dirty: false });
  }
}

function handler(local: StorageAreaService, blobStore: ReceiptBlobStore) {
  return createBackgroundVideoScreenshotCacheHandler({ local }, {}, { blobStore });
}

function clear(
  operationId: string
): Extract<RestoreStorageMaintenanceMessage, { operation: 'clearAllRestoreData' }> {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'clearAllRestoreData',
    operationId
  };
}

function inspect(): RestoreStorageMaintenanceMessage & { operation: 'inspectStoragePressure' } {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'inspectStoragePressure'
  };
}

function prepare(
  operationId: string
): Extract<SessionDraftRepositoryMessage, { operation: 'prepareSessionDraftOperation' }> {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'prepareSessionDraftOperation',
    operationId,
    draftKey: 'aiob.sessionDraft.v1.reader.retired.collision'
  };
}

function remove(
  operationId: string
): Extract<SessionDraftRepositoryMessage, { operation: 'removeSessionDraft' }> {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'removeSessionDraft',
    operationId,
    target: 'aiob.sessionDraft.v1.reader.retired.collision'
  };
}

interface ReceiptTamperCase {
  label: string;
  tamper(receipt: RestoreStorageClearReceipt): RestoreStorageClearReceipt;
}

const RECEIPT_TAMPER_CASES: ReceiptTamperCase[] = [
  {
    label: 'IDB counts',
    tamper: (receipt) => ({
      ...receipt,
      screenshotEntriesPlanned: 1,
      screenshotEntriesRemoved: 1
    })
  },
  {
    label: 'state',
    tamper: (receipt) => ({ ...receipt, state: 'idb' })
  }
];

afterEach(() => vi.useRealTimers());

describe('restore storage clear receipt maintenance', () => {
  it.each(RECEIPT_TAMPER_CASES)(
    'rejects a structurally valid $label tamper without recomputed record authority or mutation',
    async (testCase) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const local = createMemoryStorageArea();
      const blobStore = new ReceiptBlobStore();
      const operationId = 'clear-count-tamper';
      const clearHandler = handler(local, blobStore);
      await clearHandler(clear(operationId));
      const key = `${CLEAR_PREFIX}${operationId}`;
      const receipt = await local.get<RestoreStorageClearReceipt>(key);
      if (!receipt) throw new Error('expected committed receipt');
      await local.set(key, testCase.tamper(receipt));
      const before = await local.getAll();
      const deleteAll = vi.spyOn(blobStore, 'deleteAll');

      await expect(handler(local, blobStore)(clear(operationId))).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.getAll()).resolves.toEqual(before);
      expect(deleteAll).not.toHaveBeenCalled();
    }
  );

  it('retires an expired committed receipt before removing it and rejects operation reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const operationId = 'clear-expired';
    await handler(local, blobStore)(clear(operationId));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);

    await handler(
      local,
      blobStore
    )({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'inspectStoragePressure'
    });

    await expect(local.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toBeUndefined();
    await expect(local.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toMatchObject({
      schemaVersion: 1,
      operationId
    });
    await expect(handler(local, blobStore)(clear(operationId))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it('replays a committed receipt exactly until the 15 minute receipt boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const clearHandler = handler(local, blobStore);
    const message = clear('clear-replay-window');
    const first = await clearHandler(message);
    const deleteAll = vi.spyOn(blobStore, 'deleteAll');

    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS - 1);

    await expect(clearHandler(message)).resolves.toEqual(first);
    expect(deleteAll).not.toHaveBeenCalled();
    await expect(local.get('aiob.restoreStorage.barrier.v1')).resolves.toMatchObject({
      state: 'ready',
      epoch: 2
    });
  });

  it('rejects committed replay while a different receipt-first clear is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const clearHandler = handler(local, blobStore);
    const operationA = 'clear-committed-before-pending';
    await clearHandler(clear(operationA));
    await createRestoreStorageClearPlan(
      local,
      'clear-pending-after-committed',
      3,
      { targetKeys: [], draftKeysRemoved: 0, legacyScreenshotKeysRemoved: 0 },
      NOW
    );
    const before = await local.getAll();
    const deleteAll = vi.spyOn(blobStore, 'deleteAll');

    await expect(clearHandler(clear(operationA))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(before);
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it('keeps a retired clear operation authoritative across a later clear', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const clearHandler = handler(local, blobStore);
    const operationA = 'clear-retired-before-b';
    await clearHandler(clear(operationA));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);
    await clearHandler(inspect());
    const retiredA = await local.get(`${RETIRED_PREFIX}${operationA}`);
    expect(retiredA).toMatchObject({ schemaVersion: 1, operationId: operationA });
    const beforeCollisions = await local.getAll();

    await expect(clearHandler(prepare(operationA))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });
    await expect(clearHandler(remove(operationA))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(beforeCollisions);

    blobStore.visible = 1;
    await expect(clearHandler(clear('clear-b-after-retired-a'))).resolves.toMatchObject({
      success: true,
      operation: 'clearAllRestoreData'
    });
    await expect(local.get(`${RETIRED_PREFIX}${operationA}`)).resolves.toEqual(retiredA);
    const deleteAll = vi.spyOn(blobStore, 'deleteAll');

    await expect(clearHandler(clear(operationA))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    expect(deleteAll).not.toHaveBeenCalled();
    await expect(local.get('aiob.restoreStorage.barrier.v1')).resolves.toMatchObject({
      state: 'ready',
      epoch: 3
    });
  });

  it('allows an operation id again only after its retired authority also expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const clearHandler = handler(local, blobStore);
    const operationId = 'clear-after-retired-expiry';
    await clearHandler(clear(operationId));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);
    await clearHandler(inspect());
    const retired = await local.get<{ expiresAt?: number }>(`${RETIRED_PREFIX}${operationId}`);
    expect(retired?.expiresAt).toBe(
      NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1 + SESSION_DRAFT_RETIRED_OPERATION_TTL_MS
    );

    vi.setSystemTime((retired?.expiresAt ?? 0) + 1);
    blobStore.visible = 1;

    await expect(clearHandler(clear(operationId))).resolves.toMatchObject({
      success: true,
      operation: 'clearAllRestoreData',
      result: { screenshotEntriesRemoved: 1 }
    });
    await expect(local.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toBeUndefined();
    await expect(local.get('aiob.restoreStorage.barrier.v1')).resolves.toMatchObject({
      state: 'ready',
      epoch: 3
    });
  });

  it('recovers an expired pending receipt instead of deleting its authority', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const local = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    blobStore.failDeleteOnce = true;
    const operationId = 'clear-expired-pending';
    await handler(local, blobStore)(clear(operationId));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);

    blobStore.failDeleteOnce = true;
    await expect(handler(local, blobStore)(inspect())).resolves.toEqual({
      success: false,
      error: 'idb unavailable'
    });
    await expect(local.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toMatchObject({
      state: 'local'
    });
    await expect(local.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toBeUndefined();

    await expect(handler(local, blobStore)(inspect())).resolves.toMatchObject({ success: true });
    await expect(local.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toMatchObject({
      state: 'committed',
      screenshotEntriesRemoved: 2
    });
  });

  it('preserves a committed receipt when retirement persistence fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const base = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const operationId = 'clear-retirement-write-failure';
    await handler(base, blobStore)(clear(operationId));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);
    let failRetirement = true;
    const failing: StorageAreaService = {
      ...base,
      async set(key, value) {
        if (failRetirement && key === `${RETIRED_PREFIX}${operationId}`) {
          failRetirement = false;
          throw new Error('retirement write failed');
        }
        await base.set(key, value);
      }
    };

    await expect(handler(failing, blobStore)(inspect())).resolves.toEqual({
      success: false,
      error: 'retirement write failed'
    });
    await expect(base.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toMatchObject({
      state: 'committed'
    });
    await expect(base.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toBeUndefined();

    await expect(handler(base, blobStore)(inspect())).resolves.toMatchObject({ success: true });
    await expect(base.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toBeUndefined();
    await expect(base.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toMatchObject({
      operationId
    });
  });

  it('leaves both authorities safe when committed receipt removal fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const base = createMemoryStorageArea();
    const blobStore = new ReceiptBlobStore();
    const operationId = 'clear-retirement-remove-failure';
    await handler(base, blobStore)(clear(operationId));
    vi.setSystemTime(NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1);
    let failRemoval = true;
    const failing: StorageAreaService = {
      ...base,
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        if (failRemoval && list.includes(`${CLEAR_PREFIX}${operationId}`)) {
          failRemoval = false;
          throw new Error('receipt removal failed');
        }
        await base.remove(keys);
      }
    };

    await expect(handler(failing, blobStore)(inspect())).resolves.toEqual({
      success: false,
      error: 'receipt removal failed'
    });
    await expect(base.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toMatchObject({
      state: 'committed'
    });
    await expect(base.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toMatchObject({
      operationId
    });

    await expect(handler(base, blobStore)(inspect())).resolves.toMatchObject({ success: true });
    await expect(base.get(`${CLEAR_PREFIX}${operationId}`)).resolves.toBeUndefined();
    await expect(base.get(`${RETIRED_PREFIX}${operationId}`)).resolves.toMatchObject({
      operationId
    });
    await expect(handler(base, blobStore)(clear(operationId))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
  });

  it.each([
    { label: 'malformed', receipt: { schemaVersion: 1, kind: 'clear' } },
    {
      label: 'future',
      receipt: {
        schemaVersion: 2,
        kind: 'clear',
        state: 'committed',
        operationId: 'future-clear-receipt'
      }
    }
  ])(
    'fails closed on a $label clear receipt without mutating storage or IDB',
    async ({ receipt }) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const local = createMemoryStorageArea();
      const blobStore = new ReceiptBlobStore();
      await local.setMany({
        [`${CLEAR_PREFIX}${receipt.operationId ?? 'malformed-clear-receipt'}`]: receipt,
        ordinaryOptions: { theme: 'dark' }
      });
      const before = await local.getAll();
      const deleteAll = vi.spyOn(blobStore, 'deleteAll');

      await expect(handler(local, blobStore)(inspect())).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.getAll()).resolves.toEqual(before);
      expect(deleteAll).not.toHaveBeenCalled();
      expect(blobStore.visible).toBe(2);
    }
  );
});
