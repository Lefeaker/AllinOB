import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  createLocalRestoreDataClient,
  createLocalRestoreDataService,
  LOCAL_RESTORE_DATA_CLEAR_FAILED
} from '../../../src/background/services/localRestoreDataService';
import { SESSION_DRAFT_INDEX_KEY } from '@content/sessionDrafts/sessionDraftKeys';
import {
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  createVideoScreenshotCacheStorageKey
} from '@content/video/videoScreenshotCacheTypes';

describe('localRestoreDataService', () => {
  it('removes only draft, IndexedDB screenshot, and legacy screenshot data with exact counts', async () => {
    const local = createMemoryStorageArea();
    const draftA = 'aiob.sessionDraft.v1.reader.page-a.draft-a';
    const malformedDraft = 'aiob.sessionDraft.v1.video.page-b.malformed';
    const legacyScreenshot = createVideoScreenshotCacheStorageKey({
      pageKey: 'page-a',
      captureId: 'capture-a',
      screenshotId: 'shot-a'
    });
    await local.setMany({
      [SESSION_DRAFT_INDEX_KEY]: { schemaVersion: 1, entries: [] },
      [draftA]: { schemaVersion: 1 },
      [malformedDraft]: 'malformed',
      [VIDEO_SCREENSHOT_CACHE_INDEX_KEY]: { schemaVersion: 1, entries: [] },
      [legacyScreenshot]: { legacy: true },
      options: { theme: 'dark' },
      vaultConfig: { id: 'vault-a' },
      'private.policy.cache': { plan: 'pro' },
      'private.auth.token': 'opaque'
    });
    const deleteAll = vi.fn().mockResolvedValue(3);
    const clear = vi.spyOn(local, 'clear');
    const liveEditorState = { captures: [{ id: 'live' }] };

    const service = createLocalRestoreDataService({ local, screenshots: { deleteAll } });
    await expect(service.clearAll()).resolves.toEqual({
      draftKeysRemoved: 3,
      screenshotEntriesRemoved: 3,
      legacyScreenshotKeysRemoved: 2
    });

    expect(clear).not.toHaveBeenCalled();
    expect(liveEditorState).toEqual({ captures: [{ id: 'live' }] });
    expect(await local.getAll()).toEqual({
      options: { theme: 'dark' },
      vaultConfig: { id: 'vault-a' },
      'private.policy.cache': { plan: 'pro' },
      'private.auth.token': 'opaque'
    });
  });

  it('is idempotent for empty restore storage', async () => {
    const local = createMemoryStorageArea();
    await local.set('ordinary', true);
    const deleteAll = vi.fn().mockResolvedValue(0);
    const service = createLocalRestoreDataService({ local, screenshots: { deleteAll } });

    await expect(service.clearAll()).resolves.toEqual({
      draftKeysRemoved: 0,
      screenshotEntriesRemoved: 0,
      legacyScreenshotKeysRemoved: 0
    });
    await expect(service.clearAll()).resolves.toEqual({
      draftKeysRemoved: 0,
      screenshotEntriesRemoved: 0,
      legacyScreenshotKeysRemoved: 0
    });
    await expect(local.get('ordinary')).resolves.toBe(true);
  });

  it('attempts every independent cleanup phase and fails with a fixed code on partial failure', async () => {
    const local = createMemoryStorageArea();
    const draftKey = 'aiob.sessionDraft.v1.reader.page-a.draft-a';
    await local.setMany({
      [draftKey]: { schemaVersion: 1 },
      ordinary: true
    });
    const deleteAll = vi.fn().mockRejectedValue(new Error('sensitive database path'));
    const service = createLocalRestoreDataService({ local, screenshots: { deleteAll } });

    await expect(service.clearAll()).rejects.toThrow(LOCAL_RESTORE_DATA_CLEAR_FAILED);
    expect(deleteAll).toHaveBeenCalledTimes(1);
    await expect(local.get(draftKey)).resolves.toBeUndefined();
    await expect(local.get('ordinary')).resolves.toBe(true);
  });

  it('exposes a message-backed controller and rejects malformed responses with a fixed code', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      success: true,
      operation: 'clearAllRestoreData',
      result: {
        draftKeysRemoved: 2,
        screenshotEntriesRemoved: 3,
        legacyScreenshotKeysRemoved: 1
      }
    });
    const client = createLocalRestoreDataClient({ send });

    await expect(client.clearAll()).resolves.toEqual({
      draftKeysRemoved: 2,
      screenshotEntriesRemoved: 3,
      legacyScreenshotKeysRemoved: 1
    });
    expect(send).toHaveBeenCalledWith({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'clearAllRestoreData'
    });

    send.mockResolvedValueOnce({ success: true, result: { draftKeysRemoved: -1 } });
    await expect(client.clearAll()).rejects.toThrow(LOCAL_RESTORE_DATA_CLEAR_FAILED);
  });
});
