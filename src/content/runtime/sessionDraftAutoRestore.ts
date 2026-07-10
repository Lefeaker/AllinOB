import type { StorageService } from '../../platform/interfaces/storage';
import type {
  ReaderSessionAdapter,
  VideoSessionAdapter
} from '../clipper/services/selectionController';
import {
  createSessionDraftRepository,
  DEFAULT_SESSION_DRAFT_STORAGE_POLICY,
  type SessionDraftStoragePolicy
} from '../sessionDrafts';
import { watchVideoNavigation, type VideoNavigationWatcher } from '../video/videoNavigationWatcher';

const VIDEO_ELEMENT_WAIT_TIMEOUT_MS = 1_500;

export interface SessionDraftAutoRestoreOptions {
  document: Document;
  window: Window;
  storage: StorageService;
  currentUrl: () => string;
  createReaderSession: () => ReaderSessionAdapter;
  createVideoSession: () => VideoSessionAdapter;
  sessionDraftStoragePolicy?: SessionDraftStoragePolicy;
  getSessionDraftStoragePolicy?: () => SessionDraftStoragePolicy;
  isReaderSessionActive: () => boolean;
  isVideoSessionActive: () => boolean;
  isVideoCandidateUrl: (href: string) => boolean;
}

export type SessionDraftAutoRestoreDisposer = () => void;

export function startSessionDraftAutoRestore(
  options: SessionDraftAutoRestoreOptions
): SessionDraftAutoRestoreDisposer {
  const abortController = new AbortController();
  let stopped = false;
  let restoreRun: Promise<void> | null = null;
  let rerunRequested = false;

  const isSessionActive = (): boolean =>
    options.isReaderSessionActive() || options.isVideoSessionActive();

  const createRepository = () =>
    createSessionDraftRepository(options.storage.local, {
      storagePolicy:
        options.getSessionDraftStoragePolicy?.() ??
        options.sessionDraftStoragePolicy ??
        DEFAULT_SESSION_DRAFT_STORAGE_POLICY
    });

  const queueRestore = (): void => {
    if (stopped) {
      return;
    }
    if (restoreRun) {
      rerunRequested = true;
      return;
    }
    restoreRun = runRestoreLoop()
      .catch((error) => {
        console.warn('[content] Failed to auto-restore session draft:', error);
      })
      .finally(() => {
        restoreRun = null;
        if (rerunRequested && !stopped) {
          rerunRequested = false;
          queueRestore();
        }
      });
  };

  const navigationWatcher: VideoNavigationWatcher = watchVideoNavigation(options.document, () => {
    queueRestore();
  });

  async function runRestoreLoop(): Promise<void> {
    do {
      rerunRequested = false;
      await waitForDocumentBody(options.document, abortController.signal);
      if (stopped || abortController.signal.aborted || isSessionActive()) {
        return;
      }

      const href = options.currentUrl();
      const isVideoCandidate = options.isVideoCandidateUrl(href);
      const repository = createRepository();
      const [videoDraft, readerDraft] = await Promise.all([
        isVideoCandidate ? repository.loadLatest('video', href) : Promise.resolve(null),
        repository.loadLatest('reader', href)
      ]);

      if (stopped || abortController.signal.aborted || isSessionActive()) {
        return;
      }

      if (videoDraft) {
        const videoReady = await waitForVideoElement(
          options.document,
          options.window,
          abortController.signal,
          VIDEO_ELEMENT_WAIT_TIMEOUT_MS
        );
        if (!videoReady || stopped || abortController.signal.aborted || isSessionActive()) {
          return;
        }
        await options.createVideoSession().start();
        return;
      }

      if (readerDraft) {
        if (stopped || abortController.signal.aborted || isSessionActive()) {
          return;
        }
        await options.createReaderSession().start();
        return;
      }
    } while (rerunRequested && !stopped);
  }

  queueRestore();

  return () => {
    stopped = true;
    abortController.abort();
    navigationWatcher.stop();
  };
}

async function waitForDocumentBody(doc: Document, signal: AbortSignal): Promise<void> {
  if (doc.body) {
    return;
  }

  await new Promise<void>((resolve) => {
    const observer =
      doc.defaultView?.MutationObserver !== undefined
        ? new doc.defaultView.MutationObserver(finish)
        : new MutationObserver(finish);

    function finish(): void {
      observer.disconnect();
      doc.removeEventListener('DOMContentLoaded', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    }

    doc.addEventListener('DOMContentLoaded', finish, { once: true });
    signal.addEventListener('abort', finish, { once: true });
    if (doc.documentElement) {
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    } else {
      resolve();
      return;
    }
    if (doc.body) {
      finish();
    }
  });
}

async function waitForVideoElement(
  doc: Document,
  win: Window,
  signal: AbortSignal,
  timeoutMs: number
): Promise<boolean> {
  if (doc.querySelector('video')) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const observer =
      doc.defaultView?.MutationObserver !== undefined
        ? new doc.defaultView.MutationObserver(checkForVideo)
        : new MutationObserver(checkForVideo);
    let settled = false;
    const timeoutId = win.setTimeout(() => finish(false), timeoutMs);

    function finish(result: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      win.clearTimeout(timeoutId);
      signal.removeEventListener('abort', handleAbort);
      resolve(result);
    }

    function handleAbort(): void {
      finish(false);
    }

    function checkForVideo(): void {
      if (doc.querySelector('video')) {
        finish(true);
      }
    }

    signal.addEventListener('abort', handleAbort, { once: true });
    const root = doc.body ?? doc.documentElement;
    if (root) {
      observer.observe(root, { childList: true, subtree: true });
    }
    checkForVideo();
  });
}
