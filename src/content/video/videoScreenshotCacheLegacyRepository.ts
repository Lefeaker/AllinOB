import {
  serializeBlobAttachmentContent,
  serializedAttachmentContentToBlob
} from '../../shared/attachments/clipAttachmentBinary';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoCaptureScreenshot } from './types';
import { runSerializedVideoScreenshotCacheIndexMutation } from './videoScreenshotCacheIndexMutationQueue';
import {
  buildVideoScreenshotCacheRef,
  matchesVideoScreenshotCacheRef,
  persistVideoScreenshotCacheIndex,
  pruneVideoScreenshotCacheIndexEntries,
  readVideoScreenshotCacheIndexState
} from './videoScreenshotCacheIndex';
import {
  VIDEO_SCREENSHOT_CACHE_INDEX_KEY,
  createVideoScreenshotCacheIndex,
  normalizeVideoScreenshotCacheEntry,
  type VideoScreenshotCacheEntry,
  type VideoScreenshotCacheIndexEntry,
  type VideoScreenshotCacheRef
} from './videoScreenshotCacheTypes';

const VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED = 'VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED';
const VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED = 'VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED';

export type VideoScreenshotCacheLegacySaveResult =
  | { status: 'saved'; ref: VideoScreenshotCacheRef }
  | { status: 'skipped'; reason: 'missing-blob-content' }
  | { status: 'skipped'; reason: 'invalid-metadata'; field: 'pageKey' }
  | {
      status: 'skipped';
      reason: 'content-too-large';
      byteLength: number;
      maxContentBytes: number;
    }
  | { status: 'skipped'; reason: 'serialize-failed'; error: string };

export interface VideoScreenshotCacheLegacyRepositoryOptions {
  ttlMs: number;
  maxGlobalEntries: number;
  maxPageEntries: number;
  maxContentBytes: number;
  now: () => number;
}

export type VideoScreenshotCacheLegacyLoadResult = { entry: VideoScreenshotCacheEntry; blob: Blob };

export type VideoScreenshotCacheBlobSaveInput = {
  pageKey: string;
  captureId: string;
  screenshot: VideoCaptureScreenshot & {
    content: Extract<NonNullable<VideoCaptureScreenshot['content']>, { kind: 'blob' }>;
  };
};

export async function removeLegacyVideoScreenshotCacheKeys(
  area: StorageAreaService | undefined,
  keys: Iterable<string>,
  options?: Pick<VideoScreenshotCacheLegacyRepositoryOptions, 'maxContentBytes'>
): Promise<void> {
  if (!area) {
    return;
  }
  const keySet = new Set([...keys].filter((key) => typeof key === 'string' && key.length > 0));
  if (keySet.size === 0) {
    return;
  }

  await runSerializedVideoScreenshotCacheIndexMutation(area, async () => {
    const indexState = await readVideoScreenshotCacheIndexState(area, options);
    const nextEntries = indexState.entries.filter((entry) => !keySet.has(entry.key));
    await persistVideoScreenshotCacheIndex(
      area,
      nextEntries,
      [...keySet],
      indexState.dirty || nextEntries.length !== indexState.entries.length
    );
  });
}

export async function pruneLegacyVideoScreenshotCache(
  area: StorageAreaService,
  options: VideoScreenshotCacheLegacyRepositoryOptions,
  applyLimits: boolean
): Promise<void> {
  await runSerializedVideoScreenshotCacheIndexMutation(area, async () => {
    const indexState = await readVideoScreenshotCacheIndexState(area, options);
    const nextState = pruneLegacyEntries(indexState.entries, options, applyLimits);
    if (!indexState.dirty && !nextState.dirty && nextState.removedKeys.length === 0) {
      return;
    }
    await persistVideoScreenshotCacheIndex(area, nextState.entries, nextState.removedKeys, true);
  });
}

export async function loadLegacyVideoScreenshotCacheEntry(
  area: StorageAreaService | undefined,
  ref: VideoScreenshotCacheRef,
  operationTime: number,
  options: Pick<VideoScreenshotCacheLegacyRepositoryOptions, 'maxContentBytes'>
): Promise<VideoScreenshotCacheLegacyLoadResult | null> {
  if (!area) {
    return null;
  }

  const rawEntry = await area.get(ref.key);
  if (rawEntry === undefined) {
    await removeLegacyVideoScreenshotCacheKeys(area, [ref.key], options);
    return null;
  }

  const entry = normalizeVideoScreenshotCacheEntry(rawEntry, options);
  if (
    entry === null ||
    entry.expiresAt <= operationTime ||
    !matchesVideoScreenshotCacheRef(entry, ref)
  ) {
    await removeLegacyVideoScreenshotCacheKeys(area, [ref.key], options);
    return null;
  }

  try {
    return {
      entry,
      blob: serializedAttachmentContentToBlob(
        {
          kind: 'base64',
          binary: entry.content
        },
        entry.mimeType
      )
    };
  } catch {
    await removeLegacyVideoScreenshotCacheKeys(area, [ref.key], options);
    return null;
  }
}

export async function saveLegacyVideoScreenshotCacheEntry(
  area: StorageAreaService,
  input: VideoScreenshotCacheBlobSaveInput,
  options: VideoScreenshotCacheLegacyRepositoryOptions,
  operationTime: number,
  buildEntryMetadata: (byteLength: number) => VideoScreenshotCacheIndexEntry | null
): Promise<VideoScreenshotCacheLegacySaveResult> {
  if (input.screenshot.content.byteLength > options.maxContentBytes) {
    return {
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: input.screenshot.content.byteLength,
      maxContentBytes: options.maxContentBytes
    };
  }

  let serializedContent;
  try {
    serializedContent = await serializeBlobAttachmentContent(input.screenshot.content.blob);
  } catch {
    return {
      status: 'skipped',
      reason: 'serialize-failed',
      error: VIDEO_SCREENSHOT_CACHE_SERIALIZE_FAILED
    };
  }

  if (serializedContent.byteLength > options.maxContentBytes) {
    return {
      status: 'skipped',
      reason: 'content-too-large',
      byteLength: serializedContent.byteLength,
      maxContentBytes: options.maxContentBytes
    };
  }

  const metadata = buildEntryMetadata(serializedContent.byteLength);
  const entry =
    metadata === null
      ? null
      : normalizeVideoScreenshotCacheEntry(
          {
            ...metadata,
            content: serializedContent
          },
          options
        );
  if (entry === null) {
    return {
      status: 'skipped',
      reason: 'serialize-failed',
      error: VIDEO_SCREENSHOT_CACHE_ENTRY_REJECTED
    };
  }

  const ref = buildVideoScreenshotCacheRef(entry, options);
  await runSerializedVideoScreenshotCacheIndexMutation(area, async () => {
    const indexState = await readVideoScreenshotCacheIndexState(area, options);
    const replacedKeys = indexState.entries
      .filter(
        (currentEntry) =>
          currentEntry.key !== entry.key &&
          currentEntry.pageKey === entry.pageKey &&
          currentEntry.captureId === entry.captureId
      )
      .map((currentEntry) => currentEntry.key);
    const nextState = pruneLegacyEntries(
      [
        entry,
        ...indexState.entries.filter(
          (currentEntry) =>
            currentEntry.key !== entry.key &&
            !(currentEntry.pageKey === entry.pageKey && currentEntry.captureId === entry.captureId)
        )
      ],
      options,
      true,
      operationTime
    );

    await area.setMany({
      [entry.key]: entry,
      [VIDEO_SCREENSHOT_CACHE_INDEX_KEY]: createVideoScreenshotCacheIndex(nextState.entries)
    });

    const removedKeys = Array.from(
      new Set([...replacedKeys, ...nextState.removedKeys.filter((key) => key !== entry.key)])
    );
    if (removedKeys.length > 0) {
      await area.remove(removedKeys);
    }
  });

  return { status: 'saved', ref };
}

function pruneLegacyEntries(
  entries: readonly VideoScreenshotCacheIndexEntry[],
  options: VideoScreenshotCacheLegacyRepositoryOptions,
  applyLimits: boolean,
  now = options.now()
) {
  return pruneVideoScreenshotCacheIndexEntries(entries, {
    now,
    maxGlobalEntries: options.maxGlobalEntries,
    maxPageEntries: options.maxPageEntries,
    applyLimits
  });
}
