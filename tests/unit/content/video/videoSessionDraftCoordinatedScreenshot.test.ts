/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { createSessionDraftClientRepository } from '@content/sessionDrafts/sessionDraftClientRepository';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import { createSessionDraftPageKey } from '@content/sessionDrafts/sessionDraftKeys';
import { createDirectSessionDraftRepository as createSessionDraftRepository } from '@content/sessionDrafts/sessionDraftRepository';
import {
  buildVideoSessionDraftPayload,
  createVideoSessionDraftEnvelope
} from '@content/video/sessionDrafts';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import { createVideoScreenshotCacheClientRepository } from '@content/video/videoScreenshotCacheClientRepository';
import { VideoSessionDraftController } from '@content/video/videoSessionDraftController';
import { VideoSessionState } from '@content/video/sessionState';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobMaintenanceStore,
  VideoScreenshotCacheBlobReadResult
} from '@content/video/videoScreenshotCacheStore';
import type { VideoCaptureScreenshot, VideoTimestampCapture } from '@content/video/types';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import type { MessagingService } from '@platform/interfaces/messaging';
import { asType } from '../../../utils/typeHelpers';
import { createBackgroundVideoScreenshotCacheHandler } from '../../../../src/background/services/videoScreenshotCacheService';
import { normalizeVideoScreenshotCacheMessage } from '@content/video/videoScreenshotCacheMessages';
import { normalizeSessionDraftRepositoryMessage } from '@content/sessionDrafts/sessionDraftRepositoryMessages';
import { readSessionDraftReferenceIndex } from '@content/sessionDrafts/sessionDraftReferenceIndex';

function screenshot(): VideoCaptureScreenshot {
  return {
    id: 'shot-coordinated',
    fileName: 'shot-coordinated.jpg',
    mimeType: 'image/jpeg',
    capturedAt: Date.now(),
    dataUrl: 'data:image/jpeg;base64,Y29vcmRpbmF0ZWQtZnJhbWU='
  };
}

type RawScreenshotCacheMessage = Parameters<typeof normalizeVideoScreenshotCacheMessage>[0];

function readBlobEntry(
  blobs: ReadonlyMap<string, VideoScreenshotCacheBlobEntry>,
  key: string
): VideoScreenshotCacheBlobReadResult {
  const entry = blobs.get(key);
  return entry ? { status: 'found', entry } : { status: 'missing' };
}

describe('coordinated video screenshot draft persistence', () => {
  it('reuses one authoritative context and does not rewrite the blob after response loss', async () => {
    document.title = 'Coordinated video';
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.resolve(new TextEncoder().encode('coordinated-frame').buffer)
    });
    const local = createMemoryStorageArea();
    const blobs = new Map<string, VideoScreenshotCacheBlobEntry>();
    let putCount = 0;
    const blobStore: VideoScreenshotCacheBlobMaintenanceStore = {
      put(entry) {
        putCount += 1;
        blobs.set(entry.key, entry);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(readBlobEntry(blobs, key)),
      peek: (key) => Promise.resolve(readBlobEntry(blobs, key)),
      delete: (key) => {
        blobs.delete(key);
        return Promise.resolve();
      },
      deleteMany: (keys) => {
        keys.forEach((key) => blobs.delete(key));
        return Promise.resolve();
      },
      deleteAll: () => {
        const count = blobs.size;
        blobs.clear();
        return Promise.resolve(count);
      },
      listByPageKey: (pageKey) =>
        Promise.resolve({
          entries: [...blobs.values()].filter((entry) => entry.pageKey === pageKey),
          invalidKeys: []
        }),
      listAllMetadata: () =>
        Promise.resolve({
          entries: [...blobs.values()].map(({ blob: _blob, ...entry }) => entry),
          invalidKeys: []
        }),
      prune: () =>
        Promise.resolve({ entries: [], candidateKeys: [], invalidKeys: [], dirty: false })
    };
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    let loseScreenshotResponse = true;
    const screenshotOperationIds: string[] = [];
    const draftOperationIds: string[] = [];
    const sendRaw = async (message: RawScreenshotCacheMessage) => {
      const screenshotMessage = normalizeVideoScreenshotCacheMessage(message, {
        maxContentBytes: 64
      });
      const draftMessage = normalizeSessionDraftRepositoryMessage(message);
      const response = await handler(message);
      if (screenshotMessage?.operation === 'save' && screenshotMessage.input.operationContext) {
        screenshotOperationIds.push(screenshotMessage.input.operationContext.operationId);
        if (loseScreenshotResponse) {
          loseScreenshotResponse = false;
          throw new Error('simulated lost screenshot response');
        }
      }
      if (draftMessage?.operation === 'saveSessionDraft') {
        draftOperationIds.push(draftMessage.context.operationId);
      }
      return response;
    };
    const messaging = asType<Pick<MessagingService, 'send'>>({ send: sendRaw });
    const repository = createSessionDraftClientRepository({
      send: (message) => sendRaw(message)
    });
    const cache = createVideoScreenshotCacheClientRepository({ messaging });
    const state = new VideoSessionState('gradient');
    const frame = screenshot();
    const capture: VideoTimestampCapture = {
      kind: 'timestamp',
      id: 'capture-coordinated',
      timeSec: 1,
      url: document.location.href,
      comment: '',
      createdAt: Date.now(),
      screenshotRequested: true,
      screenshot: frame
    };
    state.captures = [capture];
    const controller = new VideoSessionDraftController({
      doc: document,
      state,
      destinationState: { metadata: undefined, applyMetadata: vi.fn() },
      storageArea: local,
      repository,
      screenshotCache: cache,
      dom: { readCommentDrafts: () => ({}), setCommentDrafts: vi.fn() },
      readCleanupState: () => ({ isCleaningUp: false, shouldTrackSavingState: true })
    });

    const result = await controller.persistPreparedScreenshot(capture, frame);
    if (result.status !== 'saved') throw new Error(JSON.stringify(result));
    expect(putCount).toBe(1);
    expect(screenshotOperationIds).toHaveLength(2);
    expect(new Set([...screenshotOperationIds, ...draftOperationIds]).size).toBe(1);
    const ref = capture.screenshotRef;
    if (!ref) throw new Error('expected persisted screenshot ref');
    const draftKey = createSessionDraftStorageKey({
      mode: 'video',
      pageKey: ref.pageKey,
      draftId: (await repository.loadLatest('video', document.location.href))?.draftId ?? ''
    });
    await expect(local.get(draftKey)).resolves.toMatchObject({
      payload: { captures: [expect.objectContaining({ screenshotRef: ref })] }
    });
  });

  it('keeps a restored old ref while adding a response-loss new ref under one context', async () => {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.resolve(new TextEncoder().encode('coordinated-frame').buffer)
    });
    const local = createMemoryStorageArea();
    const pageUrl = document.location.href;
    const pageKey = createSessionDraftPageKey('video', pageUrl);
    const oldKey = createVideoScreenshotCacheStorageKey({
      pageKey,
      captureId: 'old-capture',
      screenshotId: 'old-shot'
    });
    const oldRef: VideoScreenshotCacheRef = {
      schemaVersion: 1,
      key: oldKey,
      pageKey,
      captureId: 'old-capture',
      id: 'old-shot',
      fileName: 'old-shot.jpg',
      mimeType: 'image/jpeg',
      byteLength: new TextEncoder().encode('coordinated-frame').byteLength,
      capturedAt: Date.now() - 100,
      expiresAt: Date.now() + 60_000
    };
    const oldBlob = new Blob(['coordinated-frame'], { type: 'image/jpeg' });
    const blobs = new Map<string, VideoScreenshotCacheBlobEntry>([
      [
        oldKey,
        {
          ...oldRef,
          createdAt: oldRef.capturedAt,
          updatedAt: oldRef.capturedAt,
          lastAccessedAt: oldRef.capturedAt,
          blob: oldBlob
        }
      ]
    ]);
    let newPutCount = 0;
    let oldDeleteCount = 0;
    const blobStore: VideoScreenshotCacheBlobMaintenanceStore = {
      put(entry) {
        if (entry.key !== oldKey) newPutCount += 1;
        blobs.set(entry.key, entry);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(readBlobEntry(blobs, key)),
      peek: (key) => Promise.resolve(readBlobEntry(blobs, key)),
      delete: (key) => {
        if (key === oldKey) oldDeleteCount += 1;
        blobs.delete(key);
        return Promise.resolve();
      },
      deleteMany: (keys) => {
        keys.forEach((key) => {
          if (key === oldKey) oldDeleteCount += 1;
          blobs.delete(key);
        });
        return Promise.resolve();
      },
      deleteAll: () => Promise.resolve(0),
      listByPageKey: (key) =>
        Promise.resolve({
          entries: [...blobs.values()].filter((entry) => entry.pageKey === key),
          invalidKeys: []
        }),
      listAllMetadata: () =>
        Promise.resolve({
          entries: [...blobs.values()].map(({ blob: _blob, ...entry }) => entry),
          invalidKeys: []
        }),
      prune: () =>
        Promise.resolve({ entries: [], candidateKeys: [], invalidKeys: [], dirty: false })
    };
    const restored = createVideoSessionDraftEnvelope({
      draftId: 'restored-coordinated',
      pageUrl,
      pageTitle: 'Restored coordinated',
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'restorable',
      payload: buildVideoSessionDraftPayload({
        captures: [
          {
            kind: 'timestamp',
            id: 'old-capture',
            timeSec: 1,
            url: pageUrl,
            comment: '',
            createdAt: Date.now() - 100,
            screenshotRequested: true,
            screenshotRef: oldRef
          }
        ],
        commentDrafts: {},
        platform: 'youtube',
        videoId: 'restored-video',
        videoUrl: pageUrl,
        canonicalUrl: pageUrl,
        videoTitle: 'Restored coordinated'
      })
    });
    await createSessionDraftRepository(local).save(restored);
    const handler = createBackgroundVideoScreenshotCacheHandler(
      { local },
      { maxContentBytes: 64 },
      { blobStore }
    );
    let loseResponse = true;
    const screenshotIds: string[] = [];
    const draftIds: string[] = [];
    const sendRaw = async (message: RawScreenshotCacheMessage) => {
      const screenshotMessage = normalizeVideoScreenshotCacheMessage(message, {
        maxContentBytes: 64
      });
      const draftMessage = normalizeSessionDraftRepositoryMessage(message);
      const response = await handler(message, { tabId: 21, windowId: 8, frameId: 0 });
      if (screenshotMessage?.operation === 'save' && screenshotMessage.input.operationContext) {
        screenshotIds.push(screenshotMessage.input.operationContext.operationId);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('simulated restored screenshot response loss');
        }
      }
      if (draftMessage?.operation === 'saveSessionDraft') {
        draftIds.push(draftMessage.context.operationId);
      }
      return response;
    };
    const repository = createSessionDraftClientRepository({ send: (message) => sendRaw(message) });
    const candidate = await repository.loadLatest('video', pageUrl);
    if (!candidate) throw new Error('expected restored candidate');
    await repository.claim(candidate);
    const cache = createVideoScreenshotCacheClientRepository({
      messaging: asType<Pick<MessagingService, 'send'>>({ send: sendRaw })
    });
    const state = new VideoSessionState('gradient');
    const controller = new VideoSessionDraftController({
      doc: document,
      state,
      destinationState: { metadata: undefined, applyMetadata: vi.fn() },
      storageArea: local,
      repository,
      screenshotCache: cache,
      dom: { readCommentDrafts: () => ({}), setCommentDrafts: vi.fn() },
      readCleanupState: () => ({ isCleaningUp: false, shouldTrackSavingState: true })
    });
    await controller.restoreDraftState();
    const frame = screenshot();
    const newCapture: VideoTimestampCapture = {
      kind: 'timestamp',
      id: 'new-capture',
      timeSec: 2,
      url: pageUrl,
      comment: '',
      createdAt: Date.now(),
      screenshotRequested: true,
      screenshot: frame
    };
    state.captures.push(newCapture);
    await controller.persistPreparedScreenshot(newCapture, frame);

    expect(newPutCount).toBe(1);
    expect(oldDeleteCount).toBe(0);
    expect(new Set([...screenshotIds, ...draftIds]).size).toBe(1);
    const saved = await createSessionDraftRepository(local).loadLatest('video', pageUrl);
    expect(JSON.stringify(saved)).toContain(oldKey);
    expect(JSON.stringify(saved)).toContain(newCapture.screenshotRef?.key);

    await local.remove(createSessionDraftStorageKey(restored));
    const remaining = await readSessionDraftReferenceIndex(local);
    expect(remaining.drafts).toHaveLength(1);
    expect(remaining.referencedScreenshotKeys).toEqual(
      new Set([oldKey, newCapture.screenshotRef?.key])
    );
  });
});
