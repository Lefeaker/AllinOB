/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import type { StorageAreaService } from '@platform/interfaces/storage';
import type { MessagePayload } from '@platform/interfaces/messaging';
import { asType } from '../../utils/typeHelpers';
import type { ReaderSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import {
  isRestoreStorageMaintenanceMessage,
  type RestoreStorageMaintenanceMessage
} from '@content/sessionDrafts/restoreStorageMaintenanceMessages';
import { normalizeSessionDraftCursor } from '@content/sessionDrafts/sessionDraftLifecycleRecords';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMetadata,
  VideoScreenshotCacheBlobStore
} from '@content/video/videoScreenshotCacheStore';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import {
  createClearingRestoreStorageBarrier,
  createReadyRestoreStorageBarrier,
  normalizeRestoreStorageBarrier
} from '../../../src/background/services/restoreStorageEpochStore';
import {
  normalizeRestoreStorageClearReceipt,
  RESTORE_STORAGE_CLEAR_TTL_MS,
  type RestoreStorageClearReceipt
} from '../../../src/background/services/restoreStorageClearPlanStore';
import { signRestoreStorageClearReceipt } from '../../../src/background/services/restoreStorageClearReceiptCodec';
import { createLocalRestoreDataClient } from '../../../src/background/services/localRestoreDataService';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import {
  normalizeSessionDraftDeletionManifest,
  SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
} from '../../../src/background/services/sessionDraftDeletionStore';

const BARRIER_KEY = 'aiob.restoreStorage.barrier.v1';
const CLEAR_RECEIPT_PREFIX = 'aiob.restoreStorage.clear.v1.';
const DRAFT_KEY = 'aiob.sessionDraft.v1.reader.page-epoch.draft-epoch';
const OTHER_DRAFT_KEY = 'aiob.sessionDraft.v1.video.page-epoch.other-epoch';
const NOW = 2_000_000_000_000;

function envelope(draftId = 'draft-epoch'): ReaderSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId,
    mode: 'reader',
    pageKey: 'page-epoch',
    pageUrl: 'https://example.com/epoch',
    pageTitle: 'epoch',
    createdAt: NOW - 10,
    updatedAt: NOW,
    expiresAt: NOW + 100_000,
    status: 'restorable',
    payload: { highlights: [] }
  };
}

function metadata(id: string): VideoScreenshotCacheBlobMetadata {
  return {
    schemaVersion: 1,
    key: `aiob.videoScreenshotCache.v1.page.capture.${id}`,
    pageKey: 'page',
    captureId: 'capture',
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 1,
    capturedAt: NOW,
    expiresAt: NOW + 100_000,
    createdAt: NOW,
    updatedAt: NOW
  };
}

class RestartBlobStore implements VideoScreenshotCacheBlobStore {
  readonly entries = new Map<string, VideoScreenshotCacheBlobMetadata>();
  readonly invalidKeys = new Set<string>();
  failBeforeDeleteOnce = false;
  failCountOnce = false;
  readonly countAll = vi.fn(() => {
    if (this.failCountOnce) {
      this.failCountOnce = false;
      return Promise.reject(new Error('idb count unavailable'));
    }
    return Promise.resolve(this.entries.size + this.invalidKeys.size);
  });
  readonly deleteAll = vi.fn(() => {
    if (this.failBeforeDeleteOnce) {
      this.failBeforeDeleteOnce = false;
      return Promise.reject(new Error('idb unavailable'));
    }
    const count = this.entries.size + this.invalidKeys.size;
    this.entries.clear();
    this.invalidKeys.clear();
    return Promise.resolve(count);
  });

  constructor(ids: readonly string[] = ['one']) {
    ids.forEach((id) => this.entries.set(metadata(id).key, metadata(id)));
  }

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    this.entries.set(entry.key, entry);
    return Promise.resolve();
  }
  get(): ReturnType<VideoScreenshotCacheBlobStore['get']> {
    return Promise.resolve({ status: 'missing' });
  }
  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
  deleteMany(keys: readonly string[]): Promise<void> {
    keys.forEach((key) => this.entries.delete(key));
    return Promise.resolve();
  }
  listByPageKey(): ReturnType<VideoScreenshotCacheBlobStore['listByPageKey']> {
    return Promise.resolve({ entries: [], invalidKeys: [] });
  }
  listAllMetadata(): ReturnType<VideoScreenshotCacheBlobStore['listAllMetadata']> {
    return Promise.resolve({
      entries: [...this.entries.values()],
      invalidKeys: [...this.invalidKeys]
    });
  }
  prune(): ReturnType<VideoScreenshotCacheBlobStore['prune']> {
    return Promise.resolve({
      entries: [...this.entries.values()],
      candidateKeys: [],
      invalidKeys: [],
      dirty: false
    });
  }
}

function createHandler(local: StorageAreaService, blobStore: RestartBlobStore, epoch = 1) {
  return createBackgroundVideoScreenshotCacheHandler(
    { local },
    { maxContentBytes: 64 },
    {
      blobStore,
      getEpoch: () => epoch,
      storageEstimate: {
        getSnapshot: () =>
          Promise.resolve({ usage: null, quota: null, available: null, supported: false })
      }
    }
  );
}

function createDurableEpochHandler(local: StorageAreaService, blobStore: RestartBlobStore) {
  return createBackgroundVideoScreenshotCacheHandler(
    { local },
    { maxContentBytes: 64 },
    {
      blobStore,
      storageEstimate: {
        getSnapshot: () =>
          Promise.resolve({ usage: null, quota: null, available: null, supported: false })
      }
    }
  );
}

function clearMessage(
  operationId: string
): Extract<RestoreStorageMaintenanceMessage, { operation: 'clearAllRestoreData' }> {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'clearAllRestoreData',
    operationId
  };
}

function inspectMessage(): RestoreStorageMaintenanceMessage & {
  operation: 'inspectStoragePressure';
} {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'inspectStoragePressure'
  };
}

function isReadyBarrier<Value>(value: Value): boolean {
  return typeof value === 'object' && value !== null && 'state' in value && value.state === 'ready';
}

interface StorageValuePredicate {
  <Value>(value: Value): boolean;
}

function failOneBarrierWrite(
  area: StorageAreaService,
  shouldFail: StorageValuePredicate,
  errorMessage: string
): StorageAreaService {
  let failed = false;
  return {
    ...area,
    async set(key, value) {
      if (!failed && key === BARRIER_KEY && shouldFail(value)) {
        failed = true;
        throw new Error(errorMessage);
      }
      await area.set(key, value);
    },
    async setMany(entries) {
      if (!failed && BARRIER_KEY in entries && shouldFail(entries[BARRIER_KEY])) {
        failed = true;
        throw new Error(errorMessage);
      }
      await area.setMany(entries);
    }
  };
}

function failOneReadyWrite(area: StorageAreaService, after: () => boolean): StorageAreaService {
  return failOneBarrierWrite(
    area,
    (value) => isReadyBarrier(value) && after(),
    'service worker stopped before ready persistence'
  );
}

async function waitForBarrier<Expected>(
  local: Pick<StorageAreaService, 'get'>,
  expected: Expected
): Promise<void> {
  await vi.waitFor(async () => expect(await local.get(BARRIER_KEY)).toEqual(expected));
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve() {
      if (!complete) throw new Error('deferred resolver was not initialized');
      complete();
    }
  };
}

describe('restore storage barrier codec', () => {
  it('accepts only the exact ready and clearing union', () => {
    expect(createReadyRestoreStorageBarrier(1)).toEqual({
      schemaVersion: 1,
      epoch: 1,
      state: 'ready'
    });
    expect(createClearingRestoreStorageBarrier(2, 'clear-codec', 'local')).toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-codec',
      phase: 'local'
    });
    expect(createClearingRestoreStorageBarrier(2, 'clear-codec', 'idb')).toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-codec',
      phase: 'idb'
    });

    const invalid = [
      { schemaVersion: 2, epoch: 1, state: 'ready' },
      { schemaVersion: 1, epoch: -1, state: 'ready' },
      { schemaVersion: 1, epoch: 1.5, state: 'ready' },
      { schemaVersion: 1, epoch: Number.MAX_SAFE_INTEGER + 1, state: 'ready' },
      { schemaVersion: 1, epoch: 1, state: 'ready', operationId: 'extra' },
      { schemaVersion: 1, epoch: 2, state: 'clearing', operationId: '', phase: 'local' },
      {
        schemaVersion: 1,
        epoch: 2,
        state: 'clearing',
        operationId: 'clear-codec',
        phase: 'future'
      },
      {
        schemaVersion: 1,
        epoch: 2,
        state: 'clearing',
        operationId: 'clear-codec',
        phase: 'idb',
        result: {}
      }
    ];
    invalid.forEach((value) => expect(normalizeRestoreStorageBarrier(value)).toBeNull());
  });

  it('rejects non-plain, inherited, hidden, and accessor-backed authority records', () => {
    const arrayBarrier = Object.assign([], { schemaVersion: 1, epoch: 1, state: 'ready' });
    const inheritedBarrier = {};
    Reflect.setPrototypeOf(inheritedBarrier, { schemaVersion: 1, epoch: 1, state: 'ready' });
    const symbolBarrier = { schemaVersion: 1, epoch: 1, state: 'ready' };
    Reflect.defineProperty(symbolBarrier, Symbol('extra'), { value: true, enumerable: true });
    const hiddenBarrier = { schemaVersion: 1, epoch: 1, state: 'ready' };
    Reflect.defineProperty(hiddenBarrier, 'extra', { value: true, enumerable: false });
    let epochReads = 0;
    const accessorBarrier = { schemaVersion: 1, state: 'ready' };
    Reflect.defineProperty(accessorBarrier, 'epoch', {
      enumerable: true,
      get() {
        epochReads += 1;
        return epochReads === 1 ? 1 : 0;
      }
    });

    for (const value of [
      arrayBarrier,
      inheritedBarrier,
      symbolBarrier,
      hiddenBarrier,
      accessorBarrier
    ]) {
      expect(normalizeRestoreStorageBarrier(value)).toBeNull();
    }

    expect(
      isRestoreStorageMaintenanceMessage(
        Object.assign([], {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'clearAllRestoreData',
          operationId: 'array-maintenance'
        })
      )
    ).toBe(false);
    expect(
      normalizeSessionDraftCursor(
        Object.assign([], {
          schemaVersion: 1,
          epoch: 1,
          state: 'present',
          draftKey: DRAFT_KEY,
          revision: 1,
          lastOperationId: 'array-cursor'
        })
      )
    ).toBeNull();
    expect(
      normalizeSessionDraftDeletionManifest(
        Object.assign([], {
          schemaVersion: 1,
          kind: 'delete',
          state: 'pending',
          operationId: 'array-manifest',
          epoch: 1,
          requestFingerprint: 'a'.repeat(64),
          candidateFingerprint: 'b'.repeat(64),
          candidateCount: 0,
          chunkCount: 0,
          createdAt: NOW,
          expiresAt: NOW + SESSION_DRAFT_DELETE_RECEIPT_TTL_MS
        })
      )
    ).toBeNull();
  });
});

describe('restore storage clear receipt codec', () => {
  const unsignedPlanned: Omit<RestoreStorageClearReceipt, 'recordFingerprint'> = {
    schemaVersion: 1,
    kind: 'clear',
    state: 'planned',
    operationId: 'clear-receipt-codec',
    epoch: 2,
    planFingerprint: 'a'.repeat(64),
    targetCount: 3,
    draftKeysRemoved: 2,
    legacyScreenshotKeysRemoved: 1,
    screenshotEntriesPlanned: null,
    screenshotEntriesRemoved: null,
    createdAt: NOW,
    expiresAt: NOW + RESTORE_STORAGE_CLEAR_TTL_MS
  };

  it('accepts exact state/count combinations only', async () => {
    const planned = await signRestoreStorageClearReceipt(unsignedPlanned);
    expect(normalizeRestoreStorageClearReceipt(planned)).toEqual(planned);
    expect(normalizeRestoreStorageClearReceipt(Object.assign([], planned))).toBeNull();
    expect(
      normalizeRestoreStorageClearReceipt({
        ...planned,
        state: 'local',
        screenshotEntriesPlanned: 4
      })
    ).not.toBeNull();
    expect(
      normalizeRestoreStorageClearReceipt({
        ...planned,
        state: 'idb',
        screenshotEntriesPlanned: 4,
        screenshotEntriesRemoved: 4
      })
    ).not.toBeNull();
    expect(
      normalizeRestoreStorageClearReceipt({
        ...planned,
        state: 'committed',
        screenshotEntriesPlanned: 4,
        screenshotEntriesRemoved: 4
      })
    ).not.toBeNull();
  });

  it.each([
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), schemaVersion: 2 },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), extra: true },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), operationId: '' },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      epoch: Number.MAX_SAFE_INTEGER + 1
    },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), planFingerprint: 'future' },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), targetCount: -1 },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), targetCount: 1.5 },
    { ...unsignedPlanned, recordFingerprint: 'a'.repeat(64), draftKeysRemoved: 4 },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      state: 'planned',
      screenshotEntriesPlanned: 0
    },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      state: 'local',
      screenshotEntriesPlanned: null
    },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      state: 'idb',
      screenshotEntriesPlanned: 2,
      screenshotEntriesRemoved: 1
    },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      createdAt: Number.MAX_SAFE_INTEGER
    },
    {
      ...unsignedPlanned,
      recordFingerprint: 'a'.repeat(64),
      expiresAt: NOW + RESTORE_STORAGE_CLEAR_TTL_MS + 1
    }
  ])('rejects malformed, future, unsafe, or state-incoherent receipt %#', (value) => {
    expect(normalizeRestoreStorageClearReceipt(value)).toBeNull();
  });
});

describe('restore storage epoch restart recovery', () => {
  it('fails closed on invalid persisted barriers without local or IDB side effects', async () => {
    const barriers = [
      { schemaVersion: 2, epoch: 2, state: 'ready' },
      { schemaVersion: 1, epoch: -1, state: 'ready' },
      { schemaVersion: 1, epoch: 1.5, state: 'ready' },
      { schemaVersion: 1, epoch: Number.MAX_SAFE_INTEGER + 1, state: 'ready' },
      { schemaVersion: 1, epoch: 2, state: 'ready', future: true }
    ];

    for (const barrier of barriers) {
      const local = createMemoryStorageArea();
      const blobStore = new RestartBlobStore(['invalid']);
      await local.setMany({ [BARRIER_KEY]: barrier, [DRAFT_KEY]: envelope() });
      const before = await local.getAll();

      await expect(createHandler(local, blobStore)(inspectMessage())).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.getAll()).resolves.toEqual(before);
      expect(blobStore.deleteAll).not.toHaveBeenCalled();
      expect(blobStore.entries.size).toBe(1);
    }
  });

  it('rejects a clear at MAX_SAFE_INTEGER without wrapping or deleting data', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['max']);
    await local.setMany({
      [BARRIER_KEY]: {
        schemaVersion: 1,
        epoch: Number.MAX_SAFE_INTEGER,
        state: 'ready'
      },
      [DRAFT_KEY]: envelope()
    });

    await expect(createHandler(local, blobStore)(clearMessage('clear-overflow'))).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.get(DRAFT_KEY)).resolves.toEqual(envelope());
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: Number.MAX_SAFE_INTEGER,
      state: 'ready'
    });
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it('fails closed when a clearing barrier has no cross-bound clear receipt', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['missing-receipt']);
    await local.setMany({
      [BARRIER_KEY]: {
        schemaVersion: 1,
        epoch: 2,
        state: 'clearing',
        operationId: 'clear-missing-receipt',
        phase: 'local'
      },
      [DRAFT_KEY]: envelope(),
      ordinaryOptions: { theme: 'dark' }
    });
    const before = await local.getAll();

    await expect(createHandler(local, blobStore)(inspectMessage())).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(before);
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it('fails closed with multiple pending clear receipts instead of choosing one', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['multiple-pending']);
    const receipt: Omit<RestoreStorageClearReceipt, 'operationId' | 'recordFingerprint'> = {
      schemaVersion: 1,
      kind: 'clear',
      state: 'planned',
      epoch: 2,
      planFingerprint: 'a'.repeat(64),
      targetCount: 0,
      draftKeysRemoved: 0,
      legacyScreenshotKeysRemoved: 0,
      screenshotEntriesPlanned: null,
      screenshotEntriesRemoved: null,
      createdAt: NOW,
      expiresAt: NOW + RESTORE_STORAGE_CLEAR_TTL_MS
    };
    await local.setMany({
      [BARRIER_KEY]: { schemaVersion: 1, epoch: 1, state: 'ready' },
      [`${CLEAR_RECEIPT_PREFIX}pending-a`]: { ...receipt, operationId: 'pending-a' },
      [`${CLEAR_RECEIPT_PREFIX}pending-b`]: {
        ...receipt,
        operationId: 'pending-b',
        planFingerprint: 'b'.repeat(64)
      },
      ordinaryOptions: { theme: 'dark' }
    });
    const before = await local.getAll();

    await expect(createHandler(local, blobStore)(inspectMessage())).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(before);
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted receipt is not cross-bound to the barrier operation', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['cross-bound']);
    await local.setMany({ [DRAFT_KEY]: envelope(), ordinaryOptions: { theme: 'dark' } });
    const remove = local.remove.bind(local);
    vi.spyOn(local, 'remove')
      .mockRejectedValueOnce(new Error('stop after receipt and barrier'))
      .mockImplementation(remove);
    await createHandler(local, blobStore)(clearMessage('clear-cross-bound'));
    const receiptKey = `${CLEAR_RECEIPT_PREFIX}clear-cross-bound`;
    const receipt = await local.get(receiptKey);
    expect(receipt).toEqual(
      expect.objectContaining({ operationId: 'clear-cross-bound', epoch: 2 })
    );
    if (typeof receipt !== 'object' || receipt === null) return;
    await local.set(receiptKey, { ...receipt, operationId: 'different-clear' });
    const before = await local.getAll();

    await expect(createHandler(local, blobStore)(inspectMessage())).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(before);
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it('recovers the only ahead-one planned receipt when barrier persistence failed', async () => {
    const base = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['planned-ahead']);
    await base.set(DRAFT_KEY, envelope());
    const local = failOneBarrierWrite(
      base,
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'state' in value &&
        value.state === 'clearing' &&
        'phase' in value &&
        value.phase === 'local',
      'service worker stopped before clearing barrier persistence'
    );

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-planned-ahead'))
    ).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 1,
      state: 'ready'
    });
    expect(
      normalizeRestoreStorageClearReceipt(
        await base.get(`${CLEAR_RECEIPT_PREFIX}clear-planned-ahead`)
      )?.state
    ).toBe('planned');
    await expect(base.get(DRAFT_KEY)).resolves.toEqual(envelope());

    const beforeDifferentOperation = await base.getAll();
    await expect(
      createHandler(base, blobStore)(clearMessage('clear-different-while-receipt-pending'))
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(base.getAll()).resolves.toEqual(beforeDifferentOperation);
    await expect(
      base.get(`${CLEAR_RECEIPT_PREFIX}clear-different-while-receipt-pending`)
    ).resolves.toBeUndefined();

    await expect(createHandler(base, blobStore)(inspectMessage())).resolves.toMatchObject({
      success: true,
      operation: 'inspectStoragePressure'
    });
    await expect(base.get(DRAFT_KEY)).resolves.toBeUndefined();
    expect(blobStore.entries.size).toBe(0);
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('recovers a local receipt when idb-phase barrier persistence failed', async () => {
    const base = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['local-receipt']);
    await base.set(DRAFT_KEY, envelope());
    const local = failOneBarrierWrite(
      base,
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'state' in value &&
        value.state === 'clearing' &&
        'phase' in value &&
        value.phase === 'idb',
      'service worker stopped before idb barrier persistence'
    );

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-local-receipt'))
    ).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(base.get(DRAFT_KEY)).resolves.toBeUndefined();
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-local-receipt',
      phase: 'local'
    });
    expect(
      normalizeRestoreStorageClearReceipt(
        await base.get(`${CLEAR_RECEIPT_PREFIX}clear-local-receipt`)
      )
    ).toMatchObject({ state: 'local', draftKeysRemoved: 1, screenshotEntriesPlanned: 1 });
    expect(blobStore.deleteAll).not.toHaveBeenCalled();

    await expect(createHandler(base, blobStore)(inspectMessage())).resolves.toMatchObject({
      success: true,
      operation: 'inspectStoragePressure'
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('keeps the original local counts after a partial remove and restart', async () => {
    const base = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    await base.setMany({
      [DRAFT_KEY]: envelope(),
      [OTHER_DRAFT_KEY]: envelope('other-epoch'),
      'aiob.sessionDraft.index.v1': { schemaVersion: 1, entries: [] }
    });
    let failed = false;
    const local: StorageAreaService = {
      ...base,
      async remove(keys) {
        if (!failed && Array.isArray(keys) && keys.length > 1) {
          failed = true;
          await base.remove(keys[0] ?? []);
          throw new Error('service worker stopped during local remove');
        }
        await base.remove(keys);
      }
    };

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-partial-local'))
    ).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    expect(
      normalizeRestoreStorageClearReceipt(
        await base.get(`${CLEAR_RECEIPT_PREFIX}clear-partial-local`)
      )
    ).toMatchObject({ state: 'planned', draftKeysRemoved: 3 });

    await expect(
      createHandler(base, blobStore)(clearMessage('clear-partial-local'))
    ).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 3,
        screenshotEntriesRemoved: 0,
        legacyScreenshotKeysRemoved: 0
      }
    });
  });

  it('stays in local phase when planning the IDB count fails and never calls deleteAll', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['count-failure']);
    blobStore.failCountOnce = true;
    await local.set(DRAFT_KEY, envelope());

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-count-failure'))
    ).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-count-failure',
      phase: 'local'
    });
    expect(
      normalizeRestoreStorageClearReceipt(
        await local.get(`${CLEAR_RECEIPT_PREFIX}clear-count-failure`)
      )?.state
    ).toBe('planned');
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
    expect(blobStore.entries.size).toBe(1);
  });

  it('recovers local -> idb -> ready before accepting the first later mutation', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['restart-local']);
    await local.setMany({ [DRAFT_KEY]: envelope(), ordinaryOptions: { theme: 'dark' } });
    const remove = local.remove.bind(local);
    vi.spyOn(local, 'remove')
      .mockRejectedValueOnce(new Error('service worker stopped after barrier'))
      .mockImplementation(remove);

    await expect(createHandler(local, blobStore)(clearMessage('clear-local'))).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-local',
      phase: 'local'
    });

    const restarted = createHandler(local, blobStore);
    const prepare = await restarted({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'writer-after-restart',
      draftKey: DRAFT_KEY
    });

    expect(prepare).toMatchObject({ success: true, context: { epoch: 2 } });
    expect(blobStore.entries.size).toBe(0);
    await expect(local.get(DRAFT_KEY)).resolves.toBeUndefined();
    await expect(local.get('ordinaryOptions')).resolves.toEqual({ theme: 'dark' });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('resumes phase=idb after local deletion and an unavailable IDB', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['restart-idb']);
    blobStore.failBeforeDeleteOnce = true;
    await local.setMany({ [DRAFT_KEY]: envelope(), ordinaryOptions: { theme: 'light' } });

    await expect(createHandler(local, blobStore)(clearMessage('clear-idb'))).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(local.get(DRAFT_KEY)).resolves.toBeUndefined();
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-idb',
      phase: 'idb'
    });

    await expect(createHandler(local, blobStore)(inspectMessage())).resolves.toMatchObject({
      success: true,
      operation: 'inspectStoragePressure'
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(2);
    expect(blobStore.entries.size).toBe(0);
    await expect(local.get('ordinaryOptions')).resolves.toEqual({ theme: 'light' });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('retains the planned IDB count when ready persistence fails after the IDB commit', async () => {
    const base = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['committed-a', 'committed-b']);
    await base.set(DRAFT_KEY, envelope());
    const local = failOneReadyWrite(base, () => blobStore.entries.size === 0);
    const message = clearMessage('clear-after-idb-commit');

    await expect(createHandler(local, blobStore)(message)).resolves.toEqual({
      success: false,
      error: 'LOCAL_RESTORE_DATA_CLEAR_FAILED'
    });
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-after-idb-commit',
      phase: 'idb'
    });
    expect(blobStore.entries.size).toBe(0);

    await expect(createHandler(local, blobStore)(message)).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 1,
        screenshotEntriesRemoved: 2,
        legacyScreenshotKeysRemoved: 0
      }
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    await expect(base.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });
});

describe('restore storage clear epoch authority', () => {
  it.each([
    {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData'
    },
    {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: ''
    },
    {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: 'x'.repeat(129)
    },
    {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData',
      operationId: 'clear-extra',
      extra: true
    }
  ])('rejects malformed clear request %# before any side effect', async (message) => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['request-codec']);
    await local.set(DRAFT_KEY, envelope());
    const before = await local.getAll();

    await expect(createHandler(local, blobStore)(message)).resolves.toBeUndefined();
    await expect(local.getAll()).resolves.toEqual(before);
    expect(blobStore.countAll).not.toHaveBeenCalled();
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it('generates a bounded clear operation id in the production client', async () => {
    let sent: MessagePayload | undefined;
    const client = createLocalRestoreDataClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({
        send(message: MessagePayload) {
          sent = message;
          return Promise.resolve({
            success: true,
            operation: 'clearAllRestoreData',
            result: {
              draftKeysRemoved: 0,
              screenshotEntriesRemoved: 0,
              legacyScreenshotKeysRemoved: 0
            }
          });
        }
      })
    );

    await expect(client.clearAll()).resolves.toEqual({
      draftKeysRemoved: 0,
      screenshotEntriesRemoved: 0,
      legacyScreenshotKeysRemoved: 0
    });
    expect(sent).toMatchObject({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'clearAllRestoreData'
    });
    if (typeof sent !== 'object' || sent === null || !('operationId' in sent)) return;
    expect(typeof sent.operationId).toBe('string');
    if (typeof sent.operationId === 'string') {
      expect(sent.operationId.length).toBeGreaterThan(0);
      expect(sent.operationId.length).toBeLessThanOrEqual(128);
    }
  });

  it('uses the persisted barrier epoch when production composition has no injected epoch', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    await local.set(BARRIER_KEY, { schemaVersion: 1, epoch: 7, state: 'ready' });

    await expect(
      createDurableEpochHandler(
        local,
        blobStore
      )({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId: 'durable-epoch-writer',
        draftKey: DRAFT_KEY
      })
    ).resolves.toMatchObject({
      success: true,
      context: { epoch: 7, baseRevision: 0, nextRevision: 1 }
    });
  });

  it('removes every typed restore namespace but preserves configuration and lookalikes', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['typed-a', 'typed-b']);
    const retiredAt = Date.now();
    const protocolKeys = [
      `aiob.restoreStorage.cursor.v1.${encodeURIComponent(DRAFT_KEY)}`,
      `aiob.restoreStorage.tombstone.v1.${encodeURIComponent(DRAFT_KEY)}`,
      'aiob.restoreStorage.lease.v1.lease-clear',
      'aiob.restoreStorage.pending.v1.save-clear',
      'aiob.restoreStorage.outcome.v1.save-clear',
      'aiob.restoreStorage.delete.v1.delete-clear',
      'aiob.restoreStorage.deleteChunk.v1.delete-clear.0',
      'aiob.restoreStorage.corruption.v1',
      'aiob.restoreStorage.leaseGcCursor.v1',
      'aiob.restoreStorage.deleteGcCursor.v1'
    ];
    const legacyVideoDraftKeys = ['bili:BV1-clear-malformed', 'yt:clear-malformed'];
    const preserved = {
      ordinaryOptions: { theme: 'dark' },
      options: { language: 'zh-CN' },
      vaultConfig: { id: 'vault' },
      'private.policy.cache': { plan: 'pro' },
      'private.auth.token': 'opaque',
      'prefix.aiob.sessionDraft.v1.reader.lookalike': { keep: true },
      'aiob.restoreStorage.cursor.v1': { keep: true },
      'aiob.restoreStorage.cursor.v2.x': { keep: true },
      'aiob.restoreStorage.future.v1.x': { keep: true },
      'aiob.restoreStorage.barrier.v2': { keep: true },
      'aiob.restoreStorage.clearChunk.v1.rejected-design.0': { keep: true },
      'xbili:BV1-lookalike': { keep: true },
      yt: { keep: true },
      'bili:': { keep: true },
      'video:bili:future': { keep: true },
      'aiob.restoreStorage.retiredOperation.v1.retired-clear': {
        schemaVersion: 1,
        operationId: 'retired-clear',
        retiredAt,
        expiresAt: retiredAt + 15 * 60 * 1_000
      },
      'aiob.restoreStorage.retiredOperationGcCursor.v1':
        'aiob.restoreStorage.retiredOperation.v1.retired-clear'
    };
    await local.setMany({
      [DRAFT_KEY]: envelope(),
      [OTHER_DRAFT_KEY]: envelope('other-epoch'),
      'aiob.sessionDraft.index.v1': { schemaVersion: 1, entries: [] },
      'aiob.videoScreenshotCache.index.v1': { schemaVersion: 1, entries: [] },
      'aiob.videoScreenshotCache.v1.page.capture.legacy': { legacy: true },
      ...Object.fromEntries(legacyVideoDraftKeys.map((key) => [key, 'malformed legacy value'])),
      ...Object.fromEntries(protocolKeys.map((key) => [key, { restore: true }])),
      ...preserved
    });
    const clear = vi.spyOn(local, 'clear');

    await expect(createHandler(local, blobStore)(clearMessage('clear-typed'))).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 3,
        screenshotEntriesRemoved: 2,
        legacyScreenshotKeysRemoved: 2
      }
    });

    for (const key of [
      DRAFT_KEY,
      OTHER_DRAFT_KEY,
      'aiob.sessionDraft.index.v1',
      'aiob.videoScreenshotCache.index.v1',
      'aiob.videoScreenshotCache.v1.page.capture.legacy',
      ...legacyVideoDraftKeys,
      ...protocolKeys
    ]) {
      await expect(local.get(key), key).resolves.toBeUndefined();
    }
    for (const [key, value] of Object.entries(preserved)) {
      await expect(local.get(key), key).resolves.toEqual(value);
    }
    expect(clear).not.toHaveBeenCalled();
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
    const receipt = normalizeRestoreStorageClearReceipt(
      await local.get(`${CLEAR_RECEIPT_PREFIX}clear-typed`)
    );
    expect(receipt?.planFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: 'clear',
      state: 'committed',
      operationId: 'clear-typed',
      epoch: 2,
      planFingerprint: receipt?.planFingerprint,
      recordFingerprint: receipt?.recordFingerprint,
      targetCount: 17,
      draftKeysRemoved: 3,
      legacyScreenshotKeysRemoved: 2,
      screenshotEntriesPlanned: 2,
      screenshotEntriesRemoved: 2,
      createdAt: receipt?.createdAt,
      expiresAt: receipt?.expiresAt
    });
    expect((receipt?.expiresAt ?? 0) - (receipt?.createdAt ?? 0)).toBe(
      RESTORE_STORAGE_CLEAR_TTL_MS
    );
  });

  it('returns exact zero counts and exactly replays one operation across restart', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const message = clearMessage('clear-empty-replay');
    const first = await createHandler(local, blobStore)(message);

    expect(first).toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 0,
        screenshotEntriesRemoved: 0,
        legacyScreenshotKeysRemoved: 0
      }
    });
    await expect(createHandler(local, blobStore)(message)).resolves.toEqual(first);
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('includes invalid raw IDB rows in the planned and returned deletion count', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    blobStore.invalidKeys.add('invalid-raw-idb-row');

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-invalid-idb-row'))
    ).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 0,
        screenshotEntriesRemoved: 1,
        legacyScreenshotKeysRemoved: 0
      }
    });
    expect(blobStore.countAll).toHaveBeenCalledTimes(1);
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    expect(blobStore.invalidKeys.size).toBe(0);
  });

  it('replays clear A exactly after clear B without deleting again or changing epoch', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['clear-a']);
    await local.set(DRAFT_KEY, envelope());
    const messageA = clearMessage('clear-a-then-b');
    const resultA = await createHandler(local, blobStore)(messageA);
    expect(resultA).toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 1,
        screenshotEntriesRemoved: 1,
        legacyScreenshotKeysRemoved: 0
      }
    });

    await local.set(OTHER_DRAFT_KEY, envelope('after-clear-a'));
    blobStore.entries.set(metadata('clear-b').key, metadata('clear-b'));
    await expect(createHandler(local, blobStore)(clearMessage('clear-b-after-a'))).resolves.toEqual(
      {
        success: true,
        operation: 'clearAllRestoreData',
        result: {
          draftKeysRemoved: 1,
          screenshotEntriesRemoved: 1,
          legacyScreenshotKeysRemoved: 0
        }
      }
    );
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(2);
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 3,
      state: 'ready'
    });

    await expect(createHandler(local, blobStore)(messageA)).resolves.toEqual(resultA);
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(2);
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 3,
      state: 'ready'
    });
  });

  it('rejects exact-operation replay when its durable plan fingerprint was changed', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const message = clearMessage('clear-fingerprint-replay');
    await expect(createHandler(local, blobStore)(message)).resolves.toMatchObject({
      success: true
    });
    const receiptKey = `${CLEAR_RECEIPT_PREFIX}clear-fingerprint-replay`;
    const receipt = normalizeRestoreStorageClearReceipt(await local.get(receiptKey));
    expect(receipt?.operationId).toBe('clear-fingerprint-replay');
    expect(receipt?.planFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    if (!receipt) return;
    const changedFingerprint = receipt.planFingerprint === 'f'.repeat(64) ? 'e' : 'f';
    await local.set(receiptKey, {
      ...receipt,
      planFingerprint: changedFingerprint.repeat(64)
    });

    await expect(createHandler(local, blobStore)(message)).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it.each([
    {
      label: 'valid screenshot lease',
      operationId: 'clear-collision-lease',
      key: 'aiob.restoreStorage.lease.v1.clear-collision-lease',
      value: {
        schemaVersion: 1,
        operationId: 'clear-collision-lease',
        epoch: 1,
        draftKey: DRAFT_KEY,
        baseRevision: 0,
        draftRevision: 1,
        screenshotKeys: ['visible-before-save-journal'],
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    },
    {
      label: 'malformed screenshot lease',
      operationId: 'clear-collision-malformed-lease',
      key: 'aiob.restoreStorage.lease.v1.clear-collision-malformed-lease',
      value: 'malformed lease authority'
    },
    {
      label: 'save journal',
      operationId: 'clear-collision-pending',
      key: 'aiob.restoreStorage.pending.v1.clear-collision-pending',
      value: {
        schemaVersion: 1,
        state: 'pending',
        operationId: 'clear-collision-pending',
        context: {
          operationId: 'clear-collision-pending',
          epoch: 1,
          draftKey: DRAFT_KEY,
          baseRevision: 0,
          nextRevision: 1
        },
        requestFingerprint: 'd'.repeat(64),
        desiredEnvelopeFingerprint: 'e'.repeat(64),
        previousEnvelopeFingerprint: null,
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    },
    {
      label: 'save outcome',
      operationId: 'clear-collision-save',
      key: 'aiob.restoreStorage.outcome.v1.clear-collision-save',
      value: {
        schemaVersion: 1,
        kind: 'save',
        operationId: 'clear-collision-save',
        draftKey: DRAFT_KEY,
        revision: 1,
        requestFingerprint: 'a'.repeat(64),
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    },
    {
      label: 'delete manifest',
      operationId: 'clear-collision-delete',
      key: 'aiob.restoreStorage.delete.v1.clear-collision-delete',
      value: {
        schemaVersion: 1,
        kind: 'delete',
        state: 'committed',
        operationId: 'clear-collision-delete',
        epoch: 1,
        requestFingerprint: 'b'.repeat(64),
        candidateFingerprint: 'c'.repeat(64),
        candidateCount: 0,
        chunkCount: 0,
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    },
    {
      label: 'retired tombstone',
      operationId: 'clear-collision-retired',
      key: 'aiob.restoreStorage.retiredOperation.v1.clear-collision-retired',
      value: {
        schemaVersion: 1,
        operationId: 'clear-collision-retired',
        retiredAt: NOW,
        expiresAt: NOW + 15 * 60 * 1_000
      }
    }
  ])(
    'rejects a clear operation id colliding with a $label',
    async ({ operationId, key, value }) => {
      const local = createMemoryStorageArea();
      const blobStore = new RestartBlobStore(['collision']);
      await local.setMany({ [key]: value, ordinaryOptions: { theme: 'dark' } });
      const before = await local.getAll();

      await expect(createHandler(local, blobStore)(clearMessage(operationId))).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.getAll()).resolves.toEqual(before);
      await expect(local.get(BARRIER_KEY)).resolves.toBeUndefined();
      expect(blobStore.deleteAll).not.toHaveBeenCalled();
      expect(blobStore.entries.size).toBe(1);
    }
  );

  it.each([
    { label: 'lease', source: (id: string) => `aiob.restoreStorage.lease.v1.${id}` },
    { label: 'pending', source: (id: string) => `aiob.restoreStorage.pending.v1.${id}` },
    { label: 'outcome', source: (id: string) => `aiob.restoreStorage.outcome.v1.${id}` },
    { label: 'delete manifest', source: (id: string) => `aiob.restoreStorage.delete.v1.${id}` },
    {
      label: 'numeric delete chunk',
      source: (id: string) => `aiob.restoreStorage.deleteChunk.v1.${id}.0`
    },
    {
      label: 'retired operation',
      source: (id: string) => `aiob.restoreStorage.retiredOperation.v1.${id}`
    }
  ])(
    'rejects a clear id retained only by a quarantined $label source key',
    async ({ label, source }) => {
      const operationId = `clear-quarantined-${label.replaceAll(' ', '-')}`;
      const sourceKey = source(operationId);
      const local = createMemoryStorageArea();
      const blobStore = new RestartBlobStore(['quarantined-collision']);
      await local.setMany({
        'aiob.restoreStorage.corruption.v1': {
          schemaVersion: 1,
          recoveryRequiredUntil: null,
          entries: [{ sourceKey, quarantinedAt: Date.now() }]
        },
        ordinaryOptions: { theme: 'dark' }
      });
      const before = await local.getAll();

      await expect(createHandler(local, blobStore)(clearMessage(operationId))).resolves.toEqual({
        success: false,
        error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
      });
      await expect(local.getAll()).resolves.toEqual(before);
      await expect(local.get(BARRIER_KEY)).resolves.toBeUndefined();
      expect(blobStore.deleteAll).not.toHaveBeenCalled();
      expect(blobStore.entries.size).toBe(1);
    }
  );

  it('rejects every clear while a valid global quarantine window is active', async () => {
    const now = Date.now();
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['global-quarantine']);
    await local.setMany({
      'aiob.restoreStorage.corruption.v1': {
        schemaVersion: 1,
        recoveryRequiredUntil: now + 15 * 60 * 1_000,
        entries: []
      },
      ordinaryOptions: { theme: 'dark' }
    });
    const before = await local.getAll();

    await expect(
      createHandler(local, blobStore)(clearMessage('clear-global-quarantine'))
    ).resolves.toEqual({ success: false, error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID' });
    await expect(local.getAll()).resolves.toEqual(before);
    await expect(local.get(BARRIER_KEY)).resolves.toBeUndefined();
    expect(blobStore.deleteAll).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'malformed ledger',
      ledger: 'malformed ledger'
    },
    {
      label: 'future-created entry',
      ledger: (now: number, operationId: string) => ({
        schemaVersion: 1,
        recoveryRequiredUntil: null,
        entries: [
          {
            sourceKey: `aiob.restoreStorage.lease.v1.${operationId}`,
            quarantinedAt: now + 60_000
          }
        ]
      })
    },
    {
      label: 'expired entry',
      ledger: (now: number, operationId: string) => ({
        schemaVersion: 1,
        recoveryRequiredUntil: null,
        entries: [
          {
            sourceKey: `aiob.restoreStorage.pending.v1.${operationId}`,
            quarantinedAt: now - 15 * 60 * 1_000 - 1
          }
        ]
      })
    },
    {
      label: 'far-future global window',
      ledger: (now: number) => ({
        schemaVersion: 1,
        recoveryRequiredUntil: now + 16 * 60 * 1_000,
        entries: []
      })
    }
  ])('allows explicit clear to repair a $label', async ({ label, ledger }) => {
    const now = Date.now();
    const operationId = `clear-repair-${label.replaceAll(' ', '-')}`;
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore(['repairable-quarantine']);
    await local.setMany({
      'aiob.restoreStorage.corruption.v1':
        typeof ledger === 'function' ? ledger(now, operationId) : ledger,
      ordinaryOptions: { theme: 'dark' }
    });

    await expect(createHandler(local, blobStore)(clearMessage(operationId))).resolves.toEqual({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 0,
        screenshotEntriesRemoved: 1,
        legacyScreenshotKeysRemoved: 0
      }
    });
    await expect(local.get('aiob.restoreStorage.corruption.v1')).resolves.toBeUndefined();
    await expect(local.get('ordinaryOptions')).resolves.toEqual({ theme: 'dark' });
  });

  it('rejects reverse save and delete collisions with an existing clear receipt', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const operationId = 'clear-reverse-collision';
    const handler = createHandler(local, blobStore);
    await expect(handler(clearMessage(operationId))).resolves.toMatchObject({ success: true });
    const before = await local.getAll();

    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId,
        draftKey: DRAFT_KEY
      })
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'removeSessionDraft',
        operationId,
        target: DRAFT_KEY
      })
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.getAll()).resolves.toEqual(before);
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('rejects an old-epoch queued save without upgrading or writing any save state', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const handler = createHandler(local, blobStore);
    const prepared = await handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'old-writer',
      draftKey: DRAFT_KEY
    });
    if (!prepared || !('context' in prepared)) throw new Error('expected prepared context');

    await expect(handler(clearMessage('clear-before-old-writer'))).resolves.toMatchObject({
      success: true
    });
    await expect(
      handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'saveSessionDraft',
        context: prepared.context,
        envelope: envelope()
      })
    ).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_REVISION_CONFLICT'
    });

    const values = await local.getAll();
    expect(values[DRAFT_KEY]).toBeUndefined();
    expect(values['aiob.sessionDraft.index.v1']).toBeUndefined();
    expect(values[`aiob.restoreStorage.pending.v1.old-writer`]).toBeUndefined();
    expect(values[`aiob.restoreStorage.outcome.v1.old-writer`]).toBeUndefined();
    expect(values[`aiob.restoreStorage.lease.v1.old-writer`]).toBeUndefined();
    expect(
      Object.values(values).some(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'lastOperationId' in value &&
          value.lastOperationId === 'old-writer'
      )
    ).toBe(false);
    expect(blobStore.entries.size).toBe(0);
    expect(values[BARRIER_KEY]).toEqual({ schemaVersion: 1, epoch: 2, state: 'ready' });
  });

  it('does not let a new writer start until the incremented epoch is ready', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const idbGate = createDeferred();
    blobStore.deleteAll.mockImplementationOnce(async () => {
      await idbGate.promise;
      return 0;
    });
    const handler = createHandler(local, blobStore);
    const clear = handler(clearMessage('clear-gates-new-writer'));
    await waitForBarrier(local, {
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-gates-new-writer',
      phase: 'idb'
    });

    let settled = false;
    const prepare = handler({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'new-writer',
      draftKey: DRAFT_KEY
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-gates-new-writer',
      phase: 'idb'
    });

    idbGate.resolve();
    await expect(clear).resolves.toMatchObject({ success: true });
    await expect(prepare).resolves.toMatchObject({
      success: true,
      context: { epoch: 2, baseRevision: 0, nextRevision: 1 }
    });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
  });

  it('keeps two restarted handlers from mutating across one shared clearing barrier', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const idbGate = createDeferred();
    blobStore.deleteAll.mockImplementationOnce(async () => {
      await idbGate.promise;
      return 0;
    });
    const oldHandler = createHandler(local, blobStore);
    const clear = oldHandler(clearMessage('clear-shared-handlers'));
    await waitForBarrier(local, {
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-shared-handlers',
      phase: 'idb'
    });

    let settled = false;
    const restartedPrepare = createDurableEpochHandler(
      local,
      blobStore
    )({
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'prepareSessionDraftOperation',
      operationId: 'writer-in-restarted-handler',
      draftKey: DRAFT_KEY
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
    await expect(local.get(DRAFT_KEY)).resolves.toBeUndefined();

    idbGate.resolve();
    await expect(clear).resolves.toMatchObject({ success: true });
    await expect(restartedPrepare).resolves.toMatchObject({
      success: true,
      context: { epoch: 2 }
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('does not let a different clear operation overwrite an in-progress barrier', async () => {
    const local = createMemoryStorageArea();
    const blobStore = new RestartBlobStore([]);
    const idbGate = createDeferred();
    blobStore.deleteAll.mockImplementationOnce(async () => {
      await idbGate.promise;
      return 0;
    });
    const first = createHandler(local, blobStore)(clearMessage('clear-first-pending'));
    await waitForBarrier(local, {
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-first-pending',
      phase: 'idb'
    });

    const second = createDurableEpochHandler(
      local,
      blobStore
    )(clearMessage('clear-second-pending'));
    await Promise.resolve();
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'clearing',
      operationId: 'clear-first-pending',
      phase: 'idb'
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);

    idbGate.resolve();
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toEqual({
      success: false,
      error: 'RESTORE_STORAGE_PROTOCOL_STATE_INVALID'
    });
    await expect(local.get(BARRIER_KEY)).resolves.toEqual({
      schemaVersion: 1,
      epoch: 2,
      state: 'ready'
    });
    expect(blobStore.deleteAll).toHaveBeenCalledTimes(1);
  });
});
