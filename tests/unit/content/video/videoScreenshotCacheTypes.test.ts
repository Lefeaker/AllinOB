/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  SESSION_DRAFT_MAX_ENTRIES,
  createSessionDraftStoragePolicy
} from '@content/sessionDrafts';
import {
  clearTimestampScreenshot,
  clearTimestampScreenshotRef,
  setTimestampScreenshotRef
} from '@content/video/screenshotIntent';
import type { VideoCaptureScreenshot, VideoTimestampCapture } from '@content/video/types';
import {
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  VIDEO_SCREENSHOT_CACHE_KEY_PREFIX,
  VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES,
  VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
  VIDEO_SCREENSHOT_CACHE_TTL_MS,
  createVideoScreenshotCacheStorageKey,
  isVideoScreenshotCacheEntry,
  isVideoScreenshotCacheIndex,
  isVideoScreenshotCacheIndexEntry,
  isVideoScreenshotCacheRef,
  normalizeVideoScreenshotCacheEntry,
  normalizeVideoScreenshotCacheIndex,
  normalizeVideoScreenshotCacheIndexEntry,
  normalizeVideoScreenshotCacheRef,
  type VideoScreenshotCacheIndex,
  type VideoScreenshotCacheEntry,
  type VideoScreenshotCacheIndexEntry,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';

const BASE_TIME = 2_000_000_000_000;
const BASE_PAGE_KEY = 'page-1';
const BASE_CAPTURE_ID = 'capture-1';

function createCacheRef(overrides: Partial<VideoScreenshotCacheRef> = {}): VideoScreenshotCacheRef {
  const screenshotId = overrides.id ?? 'shot-1';
  const pageKey = overrides.pageKey ?? BASE_PAGE_KEY;
  const captureId = overrides.captureId ?? BASE_CAPTURE_ID;
  const capturedAt = overrides.capturedAt ?? BASE_TIME;
  return {
    schemaVersion: VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
    key:
      overrides.key ??
      createVideoScreenshotCacheStorageKey({
        pageKey,
        captureId,
        screenshotId
      }),
    pageKey,
    captureId,
    id: screenshotId,
    fileName: overrides.fileName ?? 'file-1.jpg',
    mimeType: overrides.mimeType ?? 'image/jpeg',
    byteLength: overrides.byteLength ?? 128,
    capturedAt,
    expiresAt: overrides.expiresAt ?? capturedAt + VIDEO_SCREENSHOT_CACHE_TTL_MS
  };
}

function createCacheEntry(
  overrides: Partial<VideoScreenshotCacheEntry> = {}
): VideoScreenshotCacheEntry {
  const ref = createCacheRef(overrides);
  const createdAt = overrides.createdAt ?? BASE_TIME + 1;
  const updatedAt = overrides.updatedAt ?? createdAt;
  return {
    schemaVersion: VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
    key: overrides.key ?? ref.key,
    pageKey: overrides.pageKey ?? BASE_PAGE_KEY,
    captureId: overrides.captureId ?? BASE_CAPTURE_ID,
    id: overrides.id ?? ref.id,
    fileName: overrides.fileName ?? ref.fileName,
    mimeType: overrides.mimeType ?? ref.mimeType,
    byteLength: overrides.byteLength ?? ref.byteLength,
    capturedAt: overrides.capturedAt ?? ref.capturedAt,
    createdAt,
    updatedAt,
    expiresAt: overrides.expiresAt ?? ref.expiresAt,
    content: overrides.content ?? {
      encoding: 'base64',
      data: 'ZmFrZS1qcGVn',
      byteLength: overrides.byteLength ?? ref.byteLength
    }
  };
}

function createIndexEntry(
  overrides: Partial<VideoScreenshotCacheIndexEntry> = {}
): VideoScreenshotCacheIndexEntry {
  const entry = createCacheEntry(overrides);
  return {
    schemaVersion: overrides.schemaVersion ?? entry.schemaVersion,
    key: overrides.key ?? entry.key,
    pageKey: overrides.pageKey ?? entry.pageKey,
    captureId: overrides.captureId ?? entry.captureId,
    id: overrides.id ?? entry.id,
    fileName: overrides.fileName ?? entry.fileName,
    mimeType: overrides.mimeType ?? entry.mimeType,
    capturedAt: overrides.capturedAt ?? entry.capturedAt,
    createdAt: overrides.createdAt ?? entry.createdAt,
    updatedAt: overrides.updatedAt ?? entry.updatedAt,
    expiresAt: overrides.expiresAt ?? entry.expiresAt,
    byteLength: overrides.byteLength ?? entry.byteLength
  };
}

function createIndex(
  overrides: Partial<VideoScreenshotCacheIndex> = {}
): VideoScreenshotCacheIndex {
  return {
    schemaVersion: overrides.schemaVersion ?? VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
    entries: overrides.entries ?? [createIndexEntry()]
  };
}

function createScreenshot(id = 'shot-runtime'): VideoCaptureScreenshot {
  const blob = new Blob([`frame-${id}`], { type: 'image/jpeg' });
  return {
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    capturedAt: BASE_TIME,
    content: {
      kind: 'blob',
      blob,
      byteLength: blob.size
    }
  };
}

function createCapture(): VideoTimestampCapture {
  return {
    kind: 'timestamp',
    id: 'capture-1',
    timeSec: 42,
    url: 'https://video.example/watch?t=42',
    comment: '',
    createdAt: BASE_TIME,
    screenshotRequested: true
  };
}

describe('videoScreenshotCacheTypes', () => {
  it('keeps cache defaults aligned with session draft limits', () => {
    expect(VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION).toBe(1);
    expect(VIDEO_SCREENSHOT_CACHE_KEY_PREFIX).toBe('aiob.videoScreenshotCache');
    expect(VIDEO_SCREENSHOT_CACHE_INDEX_KEY).toBe('aiob.videoScreenshotCache.index.v1');
    expect(VIDEO_SCREENSHOT_CACHE_TTL_MS).toBe(
      DEFAULT_SESSION_DRAFT_STORAGE_POLICY.videoScreenshotCache.ttlMs
    );
    expect(VIDEO_SCREENSHOT_CACHE_MAX_GLOBAL_ENTRIES).toBe(SESSION_DRAFT_MAX_ENTRIES);
    expect(VIDEO_SCREENSHOT_CACHE_MAX_PAGE_ENTRIES).toBe(50);
    expect(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES).toBe(1024 * 1024);
  });

  it('maps custom session draft retention to screenshot cache ttl through the storage policy', () => {
    const customStoragePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 987_654,
        maxRestorablePages: null,
        maxItemsPerPage: null
      }
    });

    expect(customStoragePolicy.videoScreenshotCache.ttlMs).toBe(987_654);
  });

  it('maps custom screenshot cache caps through the storage policy', () => {
    const customStoragePolicy = createSessionDraftStoragePolicy({
      videoScreenshotCache: {
        ttlMs: 123_456,
        maxGlobalEntries: 12,
        maxPageEntries: 6,
        maxContentBytes: 256 * 1024
      }
    });

    expect(customStoragePolicy.videoScreenshotCache).toEqual({
      ttlMs: 123_456,
      maxGlobalEntries: 12,
      maxPageEntries: 6,
      maxContentBytes: 256 * 1024
    });
  });

  it('accepts a metadata-only cache ref', () => {
    const refFixture = {
      ...createCacheRef()
    } satisfies VideoScreenshotCacheRef;

    expect(isVideoScreenshotCacheRef(refFixture)).toBe(true);
    expect(normalizeVideoScreenshotCacheRef(refFixture)).toEqual(refFixture);
    expect(refFixture).not.toHaveProperty('dataUrl');
    expect(refFixture).not.toHaveProperty('content');
    expect(refFixture).not.toHaveProperty('blob');
    expect(
      Object.values(refFixture as Record<string, unknown>).some(
        (value) => Object.prototype.toString.call(value) === '[object ArrayBuffer]'
      )
    ).toBe(false);
  });

  it('rejects invalid cache refs for key, schema, mime type, byte length, and expiry', () => {
    expect(
      normalizeVideoScreenshotCacheRef({
        ...createCacheRef(),
        key: 'aiob.sessionDraft.v1.video.page.capture'
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheRef({
        ...createCacheRef(),
        schemaVersion: 2
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheRef({
        ...createCacheRef(),
        mimeType: 'image/png'
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheRef({
        ...createCacheRef(),
        byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheRef({
        ...createCacheRef(),
        expiresAt: BASE_TIME
      })
    ).toBeNull();
  });

  it('accepts valid cache entries and index entries', () => {
    const entry = createCacheEntry();
    const indexEntry = createIndexEntry();
    const index = createIndex({
      entries: [indexEntry]
    });

    expect(isVideoScreenshotCacheEntry(entry)).toBe(true);
    expect(normalizeVideoScreenshotCacheEntry(entry)).toEqual(entry);
    expect(isVideoScreenshotCacheIndexEntry(indexEntry)).toBe(true);
    expect(normalizeVideoScreenshotCacheIndexEntry(indexEntry)).toEqual(indexEntry);
    expect(isVideoScreenshotCacheIndex(index)).toBe(true);
    expect(normalizeVideoScreenshotCacheIndex(index)).toEqual(index);
  });

  it('rejects invalid cache entries when content is malformed, oversized, or stale', () => {
    expect(
      normalizeVideoScreenshotCacheEntry({
        ...createCacheEntry(),
        content: {
          encoding: 'base64',
          data: '*** not base64 ***',
          byteLength: 128
        }
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheEntry({
        ...createCacheEntry(),
        byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1,
        content: {
          encoding: 'base64',
          data: 'ZmFrZS1qcGVn',
          byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
        }
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheIndexEntry({
        ...createIndexEntry(),
        byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheEntry({
        ...createCacheEntry(),
        expiresAt: BASE_TIME + 1
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheIndexEntry({
        ...createIndexEntry(),
        updatedAt: BASE_TIME + 10,
        expiresAt: BASE_TIME + 10
      })
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheIndex({
        schemaVersion: VIDEO_SCREENSHOT_CACHE_SCHEMA_VERSION,
        entries: [
          createIndexEntry(),
          {
            ...createIndexEntry({
              id: 'broken'
            }),
            fileName: ''
          }
        ]
      })
    ).toBeNull();
  });

  it('updates screenshot refs without deleting existing runtime screenshot bytes', () => {
    const capture = createCapture();
    const screenshot = createScreenshot();
    const screenshotRef = createCacheRef();
    const replacementRef = createCacheRef({
      id: 'shot-2',
      fileName: 'file-2.jpg',
      pageKey: BASE_PAGE_KEY,
      captureId: BASE_CAPTURE_ID,
      key: createVideoScreenshotCacheStorageKey({
        pageKey: BASE_PAGE_KEY,
        captureId: BASE_CAPTURE_ID,
        screenshotId: 'shot-2'
      })
    });

    capture.screenshot = screenshot;
    setTimestampScreenshotRef(capture, screenshotRef);
    setTimestampScreenshotRef(capture, replacementRef);

    expect(capture.screenshot).toEqual(screenshot);
    expect(capture.screenshotRef).toEqual(replacementRef);

    clearTimestampScreenshotRef(capture);

    expect(capture.screenshot).toEqual(screenshot);
    expect(capture).not.toHaveProperty('screenshotRef');

    setTimestampScreenshotRef(capture, replacementRef);
    clearTimestampScreenshot(capture, { keepRef: true });

    expect(capture.screenshotRequested).toBe(true);
    expect(capture).not.toHaveProperty('screenshot');
    expect(capture.screenshotRef).toEqual(replacementRef);

    capture.screenshot = screenshot;
    clearTimestampScreenshot(capture);

    expect(capture.screenshotRequested).toBe(true);
    expect(capture).not.toHaveProperty('screenshot');
    expect(capture).not.toHaveProperty('screenshotRef');
  });
});
