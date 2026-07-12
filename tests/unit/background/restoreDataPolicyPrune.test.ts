/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import { isObjectRecord } from '@shared/guards/object';
import { serializeBlobAttachmentContent } from '@shared/attachments/clipAttachmentBinary';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  createSessionDraftIndex,
  createSessionDraftIndexEntry
} from '@content/sessionDrafts/sessionDraftSchemas';
import {
  createSessionDraftPageKey,
  createSessionDraftStorageKey,
  SESSION_DRAFT_INDEX_KEY
} from '@content/sessionDrafts/sessionDraftKeys';
import { readSessionDraftReferenceIndex } from '@content/sessionDrafts/sessionDraftReferenceIndex';
import {
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES,
  FREE_SESSION_DRAFT_RETENTION_MS,
  createSessionDraftStoragePolicy
} from '@content/sessionDrafts';
import type {
  ReaderSessionDraftEnvelope,
  VideoSessionDraftEnvelope
} from '@content/sessionDrafts/sessionDraftTypes';
import { createSessionDraftClientRepository } from '@content/sessionDrafts/sessionDraftClientRepository';
import { VIDEO_SCREENSHOT_CACHE_MESSAGE } from '@content/video/videoScreenshotCacheMessages';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobMetadata
} from '@content/video/videoScreenshotCacheStore';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../src/background/services/videoScreenshotCacheService';
import { createRestoreDataPolicyPruneService } from '../../../src/background/services/restoreDataPolicyPruneService';
import {
  SESSION_DRAFT_JOURNAL_TTL_MS,
  writePendingJournal
} from '../../../src/background/services/sessionDraftSaveJournal';
import type { SessionDraftDeletionRequest } from '../../../src/background/services/sessionDraftDeletionOwner';
import type { RestoreStorageMaintenanceMessage } from '@content/sessionDrafts/restoreStorageMaintenanceMessages';

const NOW = 2_000_000_000_000;

function ref(id: string): VideoScreenshotCacheRef {
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
    byteLength: 5,
    capturedAt: NOW - 1_000,
    expiresAt: NOW + FREE_SESSION_DRAFT_RETENTION_MS
  };
}

function draft(
  id: string,
  options: {
    status?: VideoSessionDraftEnvelope['status'];
    updatedAt?: number;
    pageKey?: string;
  } = {}
): VideoSessionDraftEnvelope {
  const screenshotRef = ref(id);
  const updatedAt = options.updatedAt ?? NOW - 1_000;
  return {
    schemaVersion: 1,
    draftId: `draft-${id}`,
    mode: 'video',
    pageKey: options.pageKey ?? `draft-page-${id}`,
    pageUrl: `https://video.example/watch?v=${id}`,
    pageTitle: id,
    createdAt: updatedAt - 1,
    updatedAt,
    expiresAt: NOW + FREE_SESSION_DRAFT_RETENTION_MS,
    status: options.status ?? 'restorable',
    payload: {
      captures: [
        {
          kind: 'timestamp',
          id: screenshotRef.captureId,
          timeSec: 1,
          url: `https://video.example/watch?v=${id}`,
          comment: '',
          createdAt: updatedAt,
          screenshotRequested: true,
          screenshotRef
        }
      ]
    }
  };
}

function key(value: VideoSessionDraftEnvelope): string {
  return createSessionDraftStorageKey(value);
}

function readerDraft(options: {
  draftId: string;
  pageUrl: string;
  itemCount: number;
  status?: ReaderSessionDraftEnvelope['status'];
  selectedText?: string;
}): ReaderSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: options.draftId,
    mode: 'reader',
    pageKey: createSessionDraftPageKey('reader', options.pageUrl),
    pageUrl: options.pageUrl,
    pageTitle: options.draftId,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 500,
    expiresAt: NOW + FREE_SESSION_DRAFT_RETENTION_MS,
    status: options.status ?? 'restorable',
    payload: {
      highlights: Array.from({ length: options.itemCount }, (_, index) => ({
        id: `highlight-${index}`,
        selectedHtml: '',
        selectedText: options.selectedText ?? `selection-${index}`,
        comment: '',
        fragmentUrl: `${options.pageUrl}#:~:text=${index}`,
        createdAt: NOW - 500 + index
      }))
    }
  };
}

function videoDraftWithCaptures(options: {
  draftId: string;
  pageUrl: string;
  itemCount: number;
  screenshotRef?: VideoScreenshotCacheRef;
}): VideoSessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId: options.draftId,
    mode: 'video',
    pageKey: createSessionDraftPageKey('video', options.pageUrl),
    pageUrl: options.pageUrl,
    pageTitle: options.draftId,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 500,
    expiresAt: NOW + FREE_SESSION_DRAFT_RETENTION_MS,
    status: 'restorable',
    payload: {
      captures: Array.from({ length: options.itemCount }, (_, index) => ({
        kind: 'timestamp',
        id: `capture-${index}`,
        timeSec: index,
        url: options.pageUrl,
        comment: '',
        createdAt: NOW - 500 + index,
        screenshotRequested: index === 0 && options.screenshotRef !== undefined,
        ...(index === 0 && options.screenshotRef ? { screenshotRef: options.screenshotRef } : {})
      }))
    }
  };
}

function metadata(value: VideoScreenshotCacheRef): VideoScreenshotCacheBlobMetadata {
  return {
    ...value,
    createdAt: NOW - 500,
    updatedAt: NOW - 400,
    lastAccessedAt: NOW - 300
  };
}

class MemoryBlobStore implements VideoScreenshotCacheBlobMaintenanceStore {
  readonly values = new Map<string, VideoScreenshotCacheBlobEntry>();

  constructor(refs: readonly VideoScreenshotCacheRef[]) {
    for (const value of refs) {
      this.values.set(value.key, {
        ...metadata(value),
        blob: new Blob(['frame'], { type: value.mimeType })
      });
    }
  }

  put(entry: VideoScreenshotCacheBlobEntry): Promise<void> {
    this.values.set(entry.key, entry);
    return Promise.resolve();
  }
  get(key: string): ReturnType<VideoScreenshotCacheBlobMaintenanceStore['get']> {
    const entry = this.values.get(key);
    return Promise.resolve(entry ? { status: 'found', entry } : { status: 'missing' });
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  deleteMany(keys: readonly string[]): Promise<void> {
    keys.forEach((entryKey) => this.values.delete(entryKey));
    return Promise.resolve();
  }
  deleteAll(): Promise<number> {
    const count = this.values.size;
    this.values.clear();
    return Promise.resolve(count);
  }
  listByPageKey(
    pageKey: string
  ): ReturnType<VideoScreenshotCacheBlobMaintenanceStore['listByPageKey']> {
    return Promise.resolve({
      entries: [...this.values.values()].filter((entry) => entry.pageKey === pageKey),
      invalidKeys: []
    });
  }
  listAllMetadata(): ReturnType<VideoScreenshotCacheBlobMaintenanceStore['listAllMetadata']> {
    return Promise.resolve({
      entries: [...this.values.values()].map(({ blob, ...entry }) => {
        void blob;
        return entry;
      }),
      invalidKeys: []
    });
  }
  prune(): ReturnType<VideoScreenshotCacheBlobMaintenanceStore['prune']> {
    return this.listAllMetadata().then((observation) => ({
      ...observation,
      candidateKeys: [],
      dirty: false
    }));
  }
}

async function seed(
  area: ReturnType<typeof createMemoryStorageArea>,
  drafts: readonly VideoSessionDraftEnvelope[]
): Promise<void> {
  await area.setMany({
    [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex(drafts.map(createSessionDraftIndexEntry)),
    ...Object.fromEntries(drafts.map((value) => [key(value), value]))
  });
}

function prune(
  operationId: string
): Extract<RestoreStorageMaintenanceMessage, { operation: 'pruneRestoreDataToCurrentPolicy' }> {
  return {
    type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
    operation: 'pruneRestoreDataToCurrentPolicy',
    operationId
  };
}

interface TestDeletionManifest {
  operationId: string;
  requestFingerprint: string;
  state: string;
}

function isTestDeletionManifest<Value>(value: Value): value is Value & TestDeletionManifest {
  return (
    isObjectRecord(value) &&
    value.kind === 'delete' &&
    value.chunkCount === 1 &&
    typeof value.operationId === 'string' &&
    typeof value.requestFingerprint === 'string' &&
    typeof value.state === 'string'
  );
}

describe('restore-data policy prune production operation', () => {
  it('deletes inactive drafts over current item or envelope caps without crossing identity or page boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const blobStore = new MemoryBlobStore([]);
      let currentPolicy = createSessionDraftStoragePolicy({
        retentionPolicy: {
          retentionMs: FREE_SESSION_DRAFT_RETENTION_MS,
          maxRestorablePages: null,
          maxItemsPerPage: null
        },
        maxDraftEntries: 100,
        maxEnvelopeBytes: 1024 * 1024
      });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { getCurrentPolicy: () => currentPolicy },
        { blobStore, getEpoch: () => 7 }
      );
      let clientOperation = 0;
      const repository = createSessionDraftClientRepository(
        { send: (message) => handler(message) },
        { createOperationId: () => `wide-save-${clientOperation++}` }
      );
      const sharedDraftId = 'same-identity';
      const tooManyReader = readerDraft({
        draftId: sharedDraftId,
        pageUrl: 'https://reader.example/policy/too-many',
        itemCount: 21
      });
      const legalSameIdentity = readerDraft({
        draftId: sharedDraftId,
        pageUrl: 'https://reader.example/policy/legal-other-page',
        itemCount: 20
      });
      const oversized = readerDraft({
        draftId: 'oversized',
        pageUrl: 'https://reader.example/policy/too-many',
        itemCount: 1,
        selectedText: 'x'.repeat(600 * 1024)
      });
      const activeTooMany = readerDraft({
        draftId: 'active-too-many',
        pageUrl: 'https://reader.example/policy/active',
        itemCount: 21,
        status: 'active'
      });
      const pendingTooMany = readerDraft({
        draftId: 'pending-too-many',
        pageUrl: 'https://reader.example/policy/pending',
        itemCount: 21
      });
      await repository.save(tooManyReader);
      await repository.save(legalSameIdentity);
      await repository.save(oversized);
      await repository.save(activeTooMany);
      await repository.save(pendingTooMany);
      const pendingKey = createSessionDraftStorageKey(pendingTooMany);
      await writePendingJournal(local, {
        schemaVersion: 1,
        state: 'pending',
        operationId: 'pending-policy-cap-save',
        context: {
          operationId: 'pending-policy-cap-save',
          epoch: 7,
          draftKey: pendingKey,
          baseRevision: 0,
          nextRevision: 1
        },
        requestFingerprint: 'a'.repeat(64),
        desiredEnvelopeFingerprint: 'b'.repeat(64),
        previousEnvelopeFingerprint: null,
        createdAt: NOW - 1,
        expiresAt: NOW - 1 + SESSION_DRAFT_JOURNAL_TTL_MS
      });

      const videoPageUrl = 'https://video.example/watch?v=policy-caps';
      const videoKey = createSessionDraftStorageKey({
        mode: 'video',
        pageKey: createSessionDraftPageKey('video', videoPageUrl),
        draftId: 'too-many-video'
      });
      const prepared = await handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'prepareSessionDraftOperation',
        operationId: 'wide-save-video',
        draftKey: videoKey
      });
      if (!prepared || !('context' in prepared)) throw new Error('expected video save context');
      const screenshot = await handler({
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'save',
        input: {
          pageKey: 'policy-video-page',
          captureId: 'capture-0',
          operationContext: prepared.context,
          screenshot: {
            id: 'policy-video-shot',
            fileName: 'policy-video-shot.jpg',
            mimeType: 'image/jpeg',
            capturedAt: NOW - 500,
            content: await serializeBlobAttachmentContent(
              new Blob(['frame'], { type: 'image/jpeg' })
            )
          }
        }
      });
      if (
        !screenshot ||
        !('result' in screenshot) ||
        !screenshot.result ||
        !('status' in screenshot.result) ||
        screenshot.result.status !== 'saved'
      ) {
        throw new Error('expected saved screenshot');
      }
      const tooManyVideo = videoDraftWithCaptures({
        draftId: 'too-many-video',
        pageUrl: videoPageUrl,
        itemCount: 21,
        screenshotRef: screenshot.result.ref
      });
      await expect(
        handler({
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'saveSessionDraft',
          context: prepared.context,
          envelope: tooManyVideo
        })
      ).resolves.toMatchObject({ success: true });

      currentPolicy = DEFAULT_SESSION_DRAFT_STORAGE_POLICY;
      await expect(handler(prune('free-current-caps'))).resolves.toEqual({
        success: true,
        operation: 'pruneRestoreDataToCurrentPolicy',
        result: {
          expiredDrafts: 0,
          excessDrafts: 3,
          newlyOrphanedScreenshots: 1
        }
      });

      for (const removed of [tooManyReader, oversized, tooManyVideo]) {
        const removedKey = createSessionDraftStorageKey(removed);
        await expect(local.get(removedKey)).resolves.toBeUndefined();
        await expect(
          local.get(`aiob.restoreStorage.tombstone.v1.${encodeURIComponent(removedKey)}`)
        ).resolves.toMatchObject({ state: 'deleted', epoch: 7 });
      }
      for (const preserved of [legalSameIdentity, activeTooMany, pendingTooMany]) {
        await expect(local.get(createSessionDraftStorageKey(preserved))).resolves.toMatchObject({
          draftId: preserved.draftId,
          mode: preserved.mode,
          pageKey: preserved.pageKey,
          pageUrl: preserved.pageUrl,
          status: preserved.status,
          payload: preserved.payload
        });
      }
      expect(blobStore.values.has(screenshot.result.ref.key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances a stable derived attempt after replaying a previously protected candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const expired = draft('protected-replay', {
        updatedAt: NOW - FREE_SESSION_DRAFT_RETENTION_MS - 1
      });
      const expiredKey = key(expired);
      await seed(local, [expired]);
      const requests: SessionDraftDeletionRequest[] = [];
      const deleteDraftCandidates = vi.fn(async (request: SessionDraftDeletionRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return { epoch: 7, revisions: [], protectedKeys: [expiredKey], replayed: false };
        }
        if (requests.length === 2) {
          return { epoch: 7, revisions: [], protectedKeys: [expiredKey], replayed: true };
        }
        await local.remove(expiredKey);
        return {
          epoch: 7,
          revisions: [{ draftKey: expiredKey, revision: 1 }],
          protectedKeys: [],
          replayed: false
        };
      });
      const service = createRestoreDataPolicyPruneService({
        drafts: local,
        screenshots: { listAllMetadata: () => Promise.resolve({ entries: [], invalidKeys: [] }) },
        deleteScreenshotCandidates: () => Promise.resolve({ deletedKeys: [] }),
        deleteDraftCandidates,
        getProtectedDraftKeys: () => Promise.resolve([]),
        getStoragePolicy: () => DEFAULT_SESSION_DRAFT_STORAGE_POLICY
      });

      await expect(service.prune('protected-replay-root')).resolves.toMatchObject({
        expiredDrafts: 0
      });
      await expect(service.prune('protected-replay-root')).resolves.toMatchObject({
        expiredDrafts: 1
      });

      expect(requests).toHaveLength(3);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[2]?.operationId).not.toBe(requests[0]?.operationId);
      expect(requests[2]?.operationId).toMatch(/^policy-prune-expired-[0-9a-f]{64}$/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs below pressure, preserves active data, and enforces the exact Free page cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const local = createMemoryStorageArea();
      const active = draft('active', {
        status: 'active',
        updatedAt: NOW - FREE_SESSION_DRAFT_RETENTION_MS - 10
      });
      const expired = draft('expired', {
        updatedAt: NOW - FREE_SESSION_DRAFT_RETENTION_MS - 1
      });
      const restorable = Array.from(
        { length: FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES + 1 },
        (_, index) => draft(`restorable-${index}`, { updatedAt: NOW - 100 + index })
      );
      const all = [active, expired, ...restorable];
      await seed(local, all);
      const observed = await readSessionDraftReferenceIndex(local);
      expect(observed.drafts.map((value) => value.key).sort()).toEqual(
        all.map((value) => key(value)).sort()
      );
      const blobStore = new MemoryBlobStore(
        all.map((value) => ref(value.draftId.slice('draft-'.length)))
      );
      let releaseEstimate!: () => void;
      const estimateGate = new Promise<void>((resolve) => {
        releaseEstimate = resolve;
      });
      const getSnapshot = vi.fn(async () => {
        await estimateGate;
        return { usage: 100, quota: 1_000, available: 900, supported: true };
      });
      const handler = createBackgroundVideoScreenshotCacheHandler(
        { local },
        { getCurrentPolicy: () => DEFAULT_SESSION_DRAFT_STORAGE_POLICY },
        { blobStore, getEpoch: () => 7, storageEstimate: { getSnapshot } }
      );

      const operation = handler(prune('free-policy-below-pressure'));
      releaseEstimate();
      await expect(operation).resolves.toEqual({
        success: true,
        operation: 'pruneRestoreDataToCurrentPolicy',
        result: {
          expiredDrafts: 1,
          excessDrafts: 1,
          newlyOrphanedScreenshots: 2
        }
      });
      expect(getSnapshot).not.toHaveBeenCalled();
      await expect(local.get(key(active))).resolves.toEqual(active);
      expect(blobStore.values.has(ref('active').key)).toBe(true);
      const stored = await local.getAll();
      const remainingRestorable = restorable.filter((value) => stored[key(value)] !== undefined);
      expect(remainingRestorable).toHaveLength(FREE_SESSION_DRAFT_MAX_RESTORABLE_PAGES);
      expect(stored[key(expired)]).toBeUndefined();
      const oldestRestorable = restorable[0];
      if (!oldestRestorable) throw new Error('missing oldest restorable fixture');
      expect(stored[key(oldestRestorable)]).toBeUndefined();
      expect(blobStore.values.has(ref('expired').key)).toBe(false);
      expect(blobStore.values.has(ref('restorable-0').key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('converges after a partial failure, replay, and background restart with stable stage authority', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const base = createMemoryStorageArea();
      const expired = draft('restart-expired', {
        updatedAt: NOW - FREE_SESSION_DRAFT_RETENTION_MS - 1
      });
      const expiredKey = key(expired);
      await seed(base, [expired]);
      await expect(readSessionDraftReferenceIndex(base)).resolves.toMatchObject({
        drafts: [expect.objectContaining({ key: expiredKey })]
      });
      let failDraftRemoval = true;
      const local = {
        ...base,
        async remove(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          if (failDraftRemoval && list.includes(expiredKey)) {
            failDraftRemoval = false;
            throw new Error('injected draft deletion failure');
          }
          await base.remove(keys);
        }
      };
      const blobStore = new MemoryBlobStore([ref('restart-expired')]);
      const createHandler = () =>
        createBackgroundVideoScreenshotCacheHandler(
          { local },
          { getCurrentPolicy: () => DEFAULT_SESSION_DRAFT_STORAGE_POLICY },
          { blobStore, getEpoch: () => 7 }
        );
      const message = prune('restart-stable-root-operation');

      await expect(createHandler()(message)).resolves.toEqual({
        success: false,
        error: 'injected draft deletion failure'
      });
      const pendingValues = await base.getAll();
      const pendingManifest = Object.values(pendingValues).find(isTestDeletionManifest);
      expect(pendingManifest).toMatchObject({ state: 'pending' });
      if (!pendingManifest) throw new Error('missing pending policy-prune manifest');
      expect(pendingManifest.operationId).toMatch(/^policy-prune-expired-[0-9a-f]{64}$/u);
      expect(pendingManifest.operationId.length).toBeLessThanOrEqual(128);
      expect(pendingManifest.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);

      const restarted = createHandler();
      await expect(restarted(message)).resolves.toEqual({
        success: true,
        operation: 'pruneRestoreDataToCurrentPolicy',
        result: {
          expiredDrafts: 0,
          excessDrafts: 0,
          newlyOrphanedScreenshots: 1
        }
      });
      await expect(restarted(message)).resolves.toEqual({
        success: true,
        operation: 'pruneRestoreDataToCurrentPolicy',
        result: {
          expiredDrafts: 0,
          excessDrafts: 0,
          newlyOrphanedScreenshots: 0
        }
      });

      await expect(base.get(expiredKey)).resolves.toBeUndefined();
      expect(blobStore.values.has(ref('restart-expired').key)).toBe(false);
      const finalManifest = await base.get<{
        operationId: string;
        requestFingerprint: string;
      }>(`aiob.restoreStorage.delete.v1.${encodeURIComponent(pendingManifest.operationId)}`);
      expect(finalManifest).toMatchObject({
        operationId: pendingManifest.operationId,
        requestFingerprint: pendingManifest.requestFingerprint
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
