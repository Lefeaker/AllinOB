import { describe, expect, it } from 'vitest';
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
  readSessionDraftReferenceIndex,
  repairSessionDraftIndex
} from '@content/sessionDrafts/sessionDraftReferenceIndex';
import type {
  SessionDraftEnvelope,
  VideoSessionDraftEnvelope
} from '@content/sessionDrafts/sessionDraftTypes';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';

const BASE_TIME = 2_000_000_000_000;

function createScreenshotRef(id: string): VideoScreenshotCacheRef {
  const pageKey = 'page-a';
  const captureId = `capture-${id}`;
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({ pageKey, captureId, screenshotId: id }),
    pageKey,
    captureId,
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 8,
    capturedAt: BASE_TIME,
    expiresAt: BASE_TIME + 100_000
  };
}

function createVideoDraft(
  draftId: string,
  screenshotRefs: readonly VideoScreenshotCacheRef[],
  overrides: Partial<VideoSessionDraftEnvelope> = {}
): VideoSessionDraftEnvelope {
  const pageKey = 'draft-page';
  return {
    schemaVersion: 1,
    draftId,
    mode: 'video',
    pageKey,
    pageUrl: 'https://video.example/watch?v=1',
    pageTitle: 'Video',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 10,
    expiresAt: BASE_TIME + 100_000,
    status: 'restorable',
    payload: {
      captures: screenshotRefs.map((screenshotRef, index) => ({
        kind: 'timestamp',
        id: `capture-${index}`,
        timeSec: index,
        url: 'https://video.example/watch?v=1',
        comment: '',
        createdAt: BASE_TIME + index,
        screenshotRequested: true,
        screenshotRef
      }))
    },
    ...overrides
  };
}

function storageKey(envelope: SessionDraftEnvelope): string {
  return createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    draftId: envelope.draftId
  });
}

describe('sessionDraftReferenceIndex', () => {
  it('discovers indexed and orphan valid drafts while ignoring malformed refs', async () => {
    const area = createMemoryStorageArea();
    const indexedRef = createScreenshotRef('indexed');
    const orphanRef = createScreenshotRef('orphan');
    const indexedDraft = createVideoDraft('indexed', [indexedRef]);
    const orphanDraft = createVideoDraft('orphan', [orphanRef], {
      updatedAt: BASE_TIME + 20
    });
    const indexedKey = storageKey(indexedDraft);
    const orphanKey = storageKey(orphanDraft);

    await area.setMany({
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([
        createSessionDraftIndexEntry(indexedDraft)
      ]),
      [indexedKey]: indexedDraft,
      [orphanKey]: orphanDraft,
      'aiob.sessionDraft.v1.video.broken.bad': { payload: { screenshotRef: indexedRef } },
      ordinaryConfig: { retained: true }
    });

    const snapshot = await readSessionDraftReferenceIndex(area);

    expect(snapshot.drafts.map((draft) => draft.key)).toEqual([indexedKey, orphanKey]);
    expect(snapshot.allDraftKeys).toEqual([
      SESSION_DRAFT_INDEX_KEY,
      'aiob.sessionDraft.v1.video.broken.bad',
      indexedKey,
      orphanKey
    ]);
    expect([...snapshot.referencedScreenshotKeys].sort()).toEqual(
      [indexedRef.key, orphanRef.key].sort()
    );
  });

  it('removes exact draft keys and repairs the durable index without touching ordinary data', async () => {
    const area = createMemoryStorageArea();
    const first = createVideoDraft('first', [createScreenshotRef('first')]);
    const second = createVideoDraft('second', [createScreenshotRef('second')], {
      updatedAt: BASE_TIME + 20
    });
    const firstKey = storageKey(first);
    const secondKey = storageKey(second);
    await area.setMany({
      [SESSION_DRAFT_INDEX_KEY]: createSessionDraftIndex([
        createSessionDraftIndexEntry(first),
        createSessionDraftIndexEntry(second)
      ]),
      [firstKey]: first,
      [secondKey]: second,
      ordinaryConfig: { retained: true }
    });

    await area.remove(firstKey);
    await repairSessionDraftIndex(area, (keys) => area.remove([...keys]));

    const snapshot = await readSessionDraftReferenceIndex(area);
    expect(snapshot.drafts.map((draft) => draft.key)).toEqual([secondKey]);
    await expect(area.get(firstKey)).resolves.toBeUndefined();
    await expect(area.get('ordinaryConfig')).resolves.toEqual({ retained: true });
  });
});
