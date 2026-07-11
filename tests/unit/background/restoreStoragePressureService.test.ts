import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from '@content/sessionDrafts/sessionDraftSchemas';
import {
  createSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from '@content/sessionDrafts/sessionDraftKeys';
import {
  createSessionDraftStoragePolicy,
  type SessionDraftStoragePolicy
} from '@content/sessionDrafts/sessionDraftStoragePolicy';
import type { VideoSessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import type { VideoScreenshotCacheBlobMetadata } from '@content/video/videoScreenshotCacheStore';
import {
  PRIVATE_STORAGE_PRESSURE_POLICY,
  RESTORE_STORAGE_PRESSURE_FAILED,
  createRestoreStoragePressureClient,
  createRestoreStoragePressureService,
  isStoragePressureTargetReached,
  isStoragePressureTriggered,
  type RestoreStoragePressureResult
} from '../../../src/background/services/restoreStoragePressureService';
import type { StorageEstimateSnapshot } from '../../../src/background/services/storageEstimateService';

const MIB = 1024 * 1024;
const BASE_TIME = 2_000_000_000_000;

function estimate(usage: number, quota = 1_000): StorageEstimateSnapshot {
  return { usage, quota, available: Math.max(0, quota - usage), supported: true };
}

function screenshotRef(id: string): VideoScreenshotCacheRef {
  const pageKey = `page-${id}`;
  const captureId = `capture-${id}`;
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({ pageKey, captureId, screenshotId: id }),
    pageKey,
    captureId,
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 10,
    capturedAt: BASE_TIME - 1_000,
    expiresAt: BASE_TIME + 100_000
  };
}

function metadata(
  id: string,
  options: { expiresAt?: number; lastAccessedAt?: number } = {}
): VideoScreenshotCacheBlobMetadata {
  const ref = screenshotRef(id);
  return {
    ...ref,
    createdAt: BASE_TIME - 900,
    updatedAt: BASE_TIME - 800,
    expiresAt: options.expiresAt ?? ref.expiresAt,
    lastAccessedAt: options.lastAccessedAt ?? BASE_TIME - 700
  };
}

function draft(
  id: string,
  ref: VideoScreenshotCacheRef,
  options: {
    pageKey?: string;
    updatedAt?: number;
    expiresAt?: number;
    status?: VideoSessionDraftEnvelope['status'];
  } = {}
): VideoSessionDraftEnvelope {
  const updatedAt = options.updatedAt ?? BASE_TIME - 100;
  return {
    schemaVersion: 1,
    draftId: id,
    mode: 'video',
    pageKey: options.pageKey ?? `draft-page-${id}`,
    pageUrl: `https://video.example/watch?v=${id}`,
    pageTitle: id,
    createdAt: updatedAt - 10,
    updatedAt,
    expiresAt: options.expiresAt ?? BASE_TIME + 100_000,
    status: options.status ?? 'restorable',
    payload: {
      captures: [
        {
          kind: 'timestamp',
          id: `capture-${id}`,
          timeSec: 1,
          url: `https://video.example/watch?v=${id}`,
          comment: '',
          createdAt: updatedAt,
          screenshotRequested: true,
          screenshotRef: ref
        }
      ]
    }
  };
}

function draftKey(value: VideoSessionDraftEnvelope): string {
  return createSessionDraftStorageKey({
    mode: value.mode,
    pageKey: value.pageKey,
    draftId: value.draftId
  });
}

class MetadataStore {
  readonly values = new Map<string, VideoScreenshotCacheBlobMetadata>();
  constructor(
    entries: readonly VideoScreenshotCacheBlobMetadata[],
    private readonly events: string[]
  ) {
    entries.forEach((entry) => this.values.set(entry.key, entry));
  }

  listAllMetadata(): Promise<VideoScreenshotCacheBlobMetadata[]> {
    return Promise.resolve([...this.values.values()]);
  }

  deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.events.push(`screenshot:${readId(key)}`);
      this.values.delete(key);
    }
    return Promise.resolve();
  }
}

function readId(key: string): string {
  return decodeURIComponent(key.split('.').at(-1) ?? key);
}

async function seedDrafts(
  area: ReturnType<typeof createMemoryStorageArea>,
  drafts: readonly VideoSessionDraftEnvelope[],
  events: string[]
): Promise<void> {
  await area.setMany({
    [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex(drafts.map(createSessionDraftIndexEntry)),
    ...Object.fromEntries(drafts.map((value) => [draftKey(value), value]))
  });
  const remove = area.remove.bind(area);
  area.remove = async (keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key.startsWith('aiob.sessionDraft.v1.')) {
        events.push(`draft:${decodeURIComponent(key.split('.').at(-1) ?? key)}`);
      }
    }
    await remove(keys);
  };
}

function createPolicy(): SessionDraftStoragePolicy {
  return createSessionDraftStoragePolicy({
    retentionPolicy: {
      retentionMs: 1_000,
      maxRestorablePages: 1,
      maxItemsPerPage: 20
    },
    maxDraftEntries: 10,
    maxEnvelopeBytes: 1024 * 1024,
    videoScreenshotCache: {
      ttlMs: 1_000,
      maxGlobalEntries: 100,
      maxPageEntries: 100,
      maxContentBytes: 1024 * 1024
    }
  });
}

describe('restoreStoragePressureService', () => {
  it('uses the exact inclusive ratio and absolute available thresholds', () => {
    expect(PRIVATE_STORAGE_PRESSURE_POLICY).toEqual({
      triggerRatio: 0.9,
      targetRatio: 0.8,
      triggerAvailableFraction: 0.15,
      targetAvailableFraction: 0.2,
      absoluteTargetBytes: 512 * MIB
    });
    expect(isStoragePressureTriggered(estimate(900))).toBe(true);
    expect(isStoragePressureTriggered(estimate(849))).toBe(false);
    expect(isStoragePressureTargetReached(estimate(800))).toBe(true);
    expect(isStoragePressureTargetReached(estimate(801))).toBe(false);

    const quota = 4 * 1024 * MIB;
    expect(
      isStoragePressureTriggered({
        usage: quota - 512 * MIB + 1,
        quota,
        available: 512 * MIB - 1,
        supported: true
      })
    ).toBe(true);
    expect(
      isStoragePressureTriggered({
        usage: quota - 512 * MIB,
        quota,
        available: 512 * MIB,
        supported: true
      })
    ).toBe(false);
    expect(
      isStoragePressureTargetReached({
        usage: quota - 512 * MIB,
        quota,
        available: 512 * MIB,
        supported: true
      })
    ).toBe(true);
  });

  it('returns fixed no-trigger results for below-threshold and sanitized invalid estimates', async () => {
    const area = createMemoryStorageArea();
    const screenshots = new MetadataStore([metadata('untouched')], []);
    const below = createRestoreStoragePressureService({
      drafts: area,
      screenshots,
      estimate: { getSnapshot: () => Promise.resolve(estimate(849)) },
      getStoragePolicy: createPolicy,
      now: () => BASE_TIME
    });
    await expect(below.runCleanup()).resolves.toMatchObject({
      triggered: false,
      reason: 'below-trigger',
      removed: {
        expiredScreenshots: 0,
        orphanScreenshots: 0,
        expiredDrafts: 0,
        excessDrafts: 0,
        newlyOrphanedScreenshots: 0
      }
    });
    await expect(below.inspect()).resolves.toMatchObject({
      triggered: false,
      reason: 'below-trigger'
    });

    const invalid = createRestoreStoragePressureService({
      drafts: area,
      screenshots,
      estimate: {
        getSnapshot: () =>
          Promise.resolve({ usage: null, quota: null, available: null, supported: true })
      },
      getStoragePolicy: createPolicy,
      now: () => BASE_TIME
    });
    await expect(invalid.runCleanup()).resolves.toEqual({
      triggered: false,
      reason: 'estimate-unavailable',
      initialEstimate: {
        usage: null,
        quota: null,
        available: null,
        supported: true
      },
      finalEstimate: {
        usage: null,
        quota: null,
        available: null,
        supported: true
      },
      removed: {
        expiredScreenshots: 0,
        orphanScreenshots: 0,
        expiredDrafts: 0,
        excessDrafts: 0,
        newlyOrphanedScreenshots: 0
      }
    });
  });

  it.each([
    [
      'unsupported',
      () => Promise.resolve({ usage: null, quota: null, available: null, supported: false })
    ],
    ['rejection', () => Promise.reject(new Error('/private/profile/path'))],
    [
      'non-finite',
      () =>
        Promise.resolve({
          usage: Number.POSITIVE_INFINITY,
          quota: 1_000,
          available: 0,
          supported: true
        })
    ],
    [
      'negative',
      () => Promise.resolve({ usage: -1, quota: 1_000, available: 1_001, supported: true })
    ],
    ['zero quota', () => Promise.resolve({ usage: 0, quota: 0, available: 0, supported: true })]
  ])(
    'returns the same sanitized no-trigger reason for %s estimates',
    async (_label, getSnapshot) => {
      const deleteMany = vi.fn();
      const service = createRestoreStoragePressureService({
        drafts: createMemoryStorageArea(),
        screenshots: { listAllMetadata: () => Promise.resolve([]), deleteMany },
        estimate: { getSnapshot },
        getStoragePolicy: createPolicy,
        now: () => BASE_TIME
      });

      const result = await service.runCleanup();

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('estimate-unavailable');
      expect(result.finalEstimate).not.toHaveProperty('error');
      expect(deleteMany).not.toHaveBeenCalled();
    }
  );

  it('runs the exact five stages, orders equal access times by key, and recomputes refs', async () => {
    const events: string[] = [];
    const area = createMemoryStorageArea();
    const retainedRef = screenshotRef('retained');
    const activeRef = screenshotRef('active-retained');
    const expiredDraftRef = screenshotRef('new-orphan-expired');
    const excessDraftRef = screenshotRef('new-orphan-excess');
    const expiredDraft = draft('expired-draft', expiredDraftRef, {
      expiresAt: BASE_TIME - 1,
      updatedAt: BASE_TIME - 2_000
    });
    const excessDraft = draft('excess-draft', excessDraftRef, {
      pageKey: 'draft-page-old',
      updatedAt: BASE_TIME - 200
    });
    const retainedDraft = draft('retained-draft', retainedRef, {
      pageKey: 'draft-page-new',
      updatedAt: BASE_TIME - 100
    });
    const activeDraft = draft('active-draft', activeRef, {
      status: 'active',
      expiresAt: BASE_TIME - 1,
      updatedAt: BASE_TIME - 3_000
    });
    await seedDrafts(area, [expiredDraft, excessDraft, retainedDraft, activeDraft], events);

    const equalAccess = BASE_TIME - 500;
    const screenshots = new MetadataStore(
      [
        metadata('expired-orphan', { expiresAt: BASE_TIME - 1 }),
        metadata('orphan-b', { lastAccessedAt: equalAccess }),
        metadata('orphan-a', { lastAccessedAt: equalAccess }),
        metadata('retained'),
        metadata('active-retained'),
        metadata('new-orphan-expired', { lastAccessedAt: BASE_TIME - 600 }),
        metadata('new-orphan-excess', { lastAccessedAt: BASE_TIME - 500 })
      ],
      events
    );
    const getSnapshot = vi.fn(() =>
      Promise.resolve(events.length >= 6 ? estimate(800) : estimate(950))
    );
    const service = createRestoreStoragePressureService({
      drafts: area,
      screenshots,
      estimate: { getSnapshot },
      getStoragePolicy: createPolicy,
      now: () => BASE_TIME
    });

    const result = await service.runCleanup();

    expect(events).toEqual([
      'screenshot:expired-orphan',
      'screenshot:orphan-a',
      'screenshot:orphan-b',
      'draft:expired-draft',
      'draft:excess-draft',
      'screenshot:new-orphan-expired'
    ]);
    expect(result).toMatchObject({
      triggered: true,
      reason: 'target-reached',
      removed: {
        expiredScreenshots: 1,
        orphanScreenshots: 2,
        expiredDrafts: 1,
        excessDrafts: 1,
        newlyOrphanedScreenshots: 1
      }
    });
    expect(screenshots.values.has(retainedRef.key)).toBe(true);
    expect(screenshots.values.has(activeRef.key)).toBe(true);
    expect(screenshots.values.has(excessDraftRef.key)).toBe(true);
    await expect(area.get(draftKey(activeDraft))).resolves.toEqual(activeDraft);
    await expect(area.get(draftKey(retainedDraft))).resolves.toEqual(retainedDraft);
    await expect(area.get(draftKey(expiredDraft))).resolves.toBeUndefined();
    await expect(area.get(draftKey(excessDraft))).resolves.toBeUndefined();
    expect(getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('deletes all newly orphaned screenshots deterministically when target is not reached', async () => {
    const events: string[] = [];
    const area = createMemoryStorageArea();
    const firstRef = screenshotRef('new-a');
    const secondRef = screenshotRef('new-b');
    const first = draft('expired-a', firstRef, {
      expiresAt: BASE_TIME - 1,
      updatedAt: BASE_TIME - 3_000
    });
    const second = draft('expired-b', secondRef, {
      expiresAt: BASE_TIME - 1,
      updatedAt: BASE_TIME - 2_000
    });
    await seedDrafts(area, [first, second], events);
    const screenshots = new MetadataStore(
      [
        metadata('new-b', { lastAccessedAt: BASE_TIME - 400 }),
        metadata('new-a', { lastAccessedAt: BASE_TIME - 400 })
      ],
      events
    );
    const service = createRestoreStoragePressureService({
      drafts: area,
      screenshots,
      estimate: { getSnapshot: () => Promise.resolve(estimate(950)) },
      getStoragePolicy: createPolicy,
      now: () => BASE_TIME
    });

    await expect(service.runCleanup()).resolves.toMatchObject({
      triggered: true,
      reason: 'cleanup-exhausted',
      removed: { expiredDrafts: 2, newlyOrphanedScreenshots: 2 }
    });
    expect(events).toEqual([
      'draft:expired-a',
      'draft:expired-b',
      'screenshot:new-a',
      'screenshot:new-b'
    ]);
  });

  it('provides a validated message client for inspection and cleanup', async () => {
    const response = {
      triggered: true,
      reason: 'pressure-detected',
      initialEstimate: estimate(950),
      finalEstimate: estimate(950),
      removed: {
        expiredScreenshots: 0,
        orphanScreenshots: 0,
        expiredDrafts: 0,
        excessDrafts: 0,
        newlyOrphanedScreenshots: 0
      }
    } satisfies RestoreStoragePressureResult;
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        operation: 'inspectStoragePressure',
        result: response
      })
      .mockResolvedValueOnce({
        success: true,
        operation: 'runStoragePressureCleanup',
        result: { ...response, reason: 'cleanup-exhausted' }
      });
    const client = createRestoreStoragePressureClient({ send });

    await expect(client.inspect()).resolves.toEqual(response);
    await expect(client.runCleanup()).resolves.toEqual({
      ...response,
      reason: 'cleanup-exhausted'
    });
    expect(send.mock.calls).toEqual([
      [
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'inspectStoragePressure'
        }
      ],
      [
        {
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'runStoragePressureCleanup'
        }
      ]
    ]);

    send.mockResolvedValueOnce({ success: true, result: { triggered: 'yes' } });
    await expect(client.inspect()).rejects.toThrow(RESTORE_STORAGE_PRESSURE_FAILED);
  });
});
