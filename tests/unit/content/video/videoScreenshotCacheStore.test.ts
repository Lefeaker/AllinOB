/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import {
  VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES,
  createVideoScreenshotCacheStorageKey
} from '@content/video/videoScreenshotCacheTypes';
import {
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME,
  VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME,
  normalizeVideoScreenshotCacheBlobEntry,
  normalizeVideoScreenshotCacheBlobMetadata,
  pruneVideoScreenshotCacheBlobMetadataEntries,
  type VideoScreenshotCacheBlobEntry,
  type VideoScreenshotCacheBlobMetadata
} from '@content/video/videoScreenshotCacheStore';

const BASE_TIME = 2_000_000_000_000;

function createMetadata(
  overrides: Partial<VideoScreenshotCacheBlobMetadata> = {}
): VideoScreenshotCacheBlobMetadata {
  const pageKey = overrides.pageKey ?? 'page-a';
  const captureId = overrides.captureId ?? 'capture-a';
  const id = overrides.id ?? 'shot-a';
  const capturedAt = overrides.capturedAt ?? BASE_TIME;
  const createdAt = overrides.createdAt ?? capturedAt + 10;
  const updatedAt = overrides.updatedAt ?? createdAt + 10;
  const expiresAt = overrides.expiresAt ?? updatedAt + 10_000;
  const byteLength = overrides.byteLength ?? 7;

  return {
    schemaVersion: 1,
    key:
      overrides.key ??
      createVideoScreenshotCacheStorageKey({
        pageKey,
        captureId,
        screenshotId: id
      }),
    pageKey,
    captureId,
    id,
    fileName: overrides.fileName ?? `${id}.jpg`,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    byteLength,
    capturedAt,
    createdAt,
    updatedAt,
    expiresAt
  };
}

function createEntry(
  overrides: Partial<VideoScreenshotCacheBlobMetadata> = {},
  content: BlobPart = 'frame-a'
): VideoScreenshotCacheBlobEntry {
  const blob = new Blob([content], { type: 'image/jpeg' });
  return {
    ...createMetadata({ ...overrides, byteLength: blob.size }),
    blob
  };
}

describe('videoScreenshotCacheStore', () => {
  it('exports the IndexedDB schema contract and normalizes valid blob entries', async () => {
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_NAME).toBe('aiob-video-screenshot-cache');
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_DB_VERSION).toBe(1);
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_OBJECT_STORE_NAME).toBe('entries');
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_KEY_INDEX_NAME).toBe('byPageKey');
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_EXPIRES_AT_INDEX_NAME).toBe('byExpiresAt');
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_UPDATED_AT_INDEX_NAME).toBe('byUpdatedAt');
    expect(VIDEO_SCREENSHOT_CACHE_BLOB_STORE_PAGE_CAPTURE_INDEX_NAME).toBe('byPageCapture');

    const entry = createEntry();
    expect(normalizeVideoScreenshotCacheBlobMetadata(entry)).toEqual(createMetadata());

    const normalizedEntry = normalizeVideoScreenshotCacheBlobEntry(entry);
    expect(normalizedEntry).not.toBeNull();
    expect(normalizedEntry?.blob.type).toBe('image/jpeg');
    await expect(normalizedEntry?.blob.text()).resolves.toBe('frame-a');
  });

  it('rejects corrupt blob rows when metadata or blob size is invalid', () => {
    const mismatchEntry = {
      ...createEntry(),
      byteLength: 99
    };
    expect(normalizeVideoScreenshotCacheBlobEntry(mismatchEntry)).toBeNull();

    expect(
      normalizeVideoScreenshotCacheBlobMetadata({
        ...createMetadata(),
        pageKey: 'https://example.com/video'
      })
    ).toBeNull();
  });

  it('uses an injected content byte cap when normalizing blob metadata and rows', () => {
    const maxContentBytes = VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 2_048;
    const content = new Uint8Array(VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1);
    const entry = createEntry({}, content);

    expect(normalizeVideoScreenshotCacheBlobMetadata(entry)).toBeNull();
    expect(normalizeVideoScreenshotCacheBlobEntry(entry)).toBeNull();
    expect(normalizeVideoScreenshotCacheBlobMetadata(entry, { maxContentBytes })).toMatchObject({
      key: entry.key,
      byteLength: VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
    });
    expect(normalizeVideoScreenshotCacheBlobEntry(entry, { maxContentBytes })?.blob.size).toBe(
      VIDEO_SCREENSHOT_CACHE_MAX_CONTENT_BYTES + 1
    );
  });

  it('prunes metadata with the same newest-first ordering as the storage cache index', () => {
    const newest = createMetadata({
      pageKey: 'page-a',
      captureId: 'capture-new',
      id: 'shot-new',
      capturedAt: BASE_TIME + 200,
      createdAt: BASE_TIME + 210,
      updatedAt: BASE_TIME + 220,
      expiresAt: BASE_TIME + 20_000
    });
    const pageOverflow = createMetadata({
      pageKey: 'page-a',
      captureId: 'capture-old',
      id: 'shot-old',
      capturedAt: BASE_TIME + 100,
      createdAt: BASE_TIME + 110,
      updatedAt: BASE_TIME + 120,
      expiresAt: BASE_TIME + 20_000
    });
    const globalKeep = createMetadata({
      pageKey: 'page-b',
      captureId: 'capture-b',
      id: 'shot-b',
      capturedAt: BASE_TIME + 180,
      createdAt: BASE_TIME + 190,
      updatedAt: BASE_TIME + 200,
      expiresAt: BASE_TIME + 20_000
    });
    const expired = createMetadata({
      pageKey: 'page-c',
      captureId: 'capture-expired',
      id: 'shot-expired',
      capturedAt: BASE_TIME + 50,
      createdAt: BASE_TIME + 60,
      updatedAt: BASE_TIME + 70,
      expiresAt: BASE_TIME + 75
    });

    const pruned = pruneVideoScreenshotCacheBlobMetadataEntries(
      [pageOverflow, expired, newest, globalKeep],
      {
        now: BASE_TIME + 100,
        maxGlobalEntries: 2,
        maxPageEntries: 1,
        applyLimits: true
      }
    );

    expect(pruned.entries.map((entry) => entry.key)).toEqual([newest.key, globalKeep.key]);
    expect(new Set(pruned.removedKeys)).toEqual(new Set([expired.key, pageOverflow.key]));
    expect(pruned.dirty).toBe(true);
  });
});
