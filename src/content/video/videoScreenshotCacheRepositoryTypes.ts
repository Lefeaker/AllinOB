import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { VideoCaptureScreenshot } from './types';
import type {
  VideoScreenshotCacheBlobEntry,
  VideoScreenshotCacheBlobObservationStore
} from './videoScreenshotCacheStore';
import type { VideoScreenshotCacheRef } from './videoScreenshotCacheTypes';

export interface VideoScreenshotCacheRepositoryOptions {
  ttlMs?: number;
  maxGlobalEntries?: number;
  maxPageEntries?: number;
  maxContentBytes?: number;
  now?: () => number;
}

export interface VideoScreenshotCacheRepositoryDependencies {
  blobStore: VideoScreenshotCacheBlobObservationStore & {
    put(entry: VideoScreenshotCacheBlobEntry): Promise<void>;
  };
  legacyArea?: StorageAreaService;
  deleteCandidates(keys: readonly string[]): Promise<{ deletedKeys: string[] }>;
}

export interface VideoScreenshotCacheSaveInput {
  pageKey: string;
  captureId: string;
  screenshot: VideoCaptureScreenshot;
}

export type VideoScreenshotCacheBlobSaveInput = {
  pageKey: string;
  captureId: string;
  screenshot: VideoCaptureScreenshot & {
    content: Extract<NonNullable<VideoCaptureScreenshot['content']>, { kind: 'blob' }>;
  };
};

export type VideoScreenshotCacheSaveResult =
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

export interface VideoScreenshotCacheRepository {
  save(input: VideoScreenshotCacheSaveInput): Promise<VideoScreenshotCacheSaveResult>;
  load(ref: VideoScreenshotCacheRef): Promise<VideoCaptureScreenshot | null>;
  remove(ref: VideoScreenshotCacheRef): Promise<void>;
  removeMany(refs: readonly VideoScreenshotCacheRef[]): Promise<void>;
  pruneExpired(): Promise<void>;
  pruneToLimits(): Promise<void>;
}

export interface ResolvedVideoScreenshotCacheRepositoryOptions {
  ttlMs: number;
  maxGlobalEntries: number;
  maxPageEntries: number;
  maxContentBytes: number;
  now: () => number;
}
