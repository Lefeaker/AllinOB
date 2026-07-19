import { generateTextFragmentUrl } from '../clipper/utils/textFragment';
import { bucketCount, createFeatureTimer, type AnalyticsSource } from '../../shared/analytics';
import type { VideoFragmentCapture, VideoTimestampCapture } from './types';
import type { VideoSessionDependencies } from './sessionTypes';
import type { VideoSessionState } from './sessionState';
import type { FragmentHighlighter } from './fragmentHighlighter';
import { clearVideoSession } from '../runtime/contentSessionRegistry';
import { resolveHighlightTheme, DEFAULT_HIGHLIGHT_THEME } from './fragmentHighlighter';
import type { ReaderHighlightTheme, StoredOptions } from '../../shared/types/options';
import { focusFragmentCapture, focusTimestampCapture } from './videoSessionCaptureFocus';
import {
  createVideoTimestampCapture,
  rollbackVideoTimestampCaptureMutation
} from './videoTimestampCaptureTransaction';
import type { VideoSessionOperationContext } from './videoSessionOperationContext';
import {
  emitVideoUsageEvent,
  countVideoRequestedScreenshots,
  createVideoExportFailure,
  mapVideoAnalyticsPlatform,
  requestRequestedScreenshotPreparation,
  resolveVideoExportDestination,
  resolveVideoFailureCategory,
  resolveVideoSessionDurationBucket,
  rollbackVideoSessionFragmentAdd,
  saveVideoSessionCaptures
} from './videoCaptureMutationTransaction';
import { hasScreenshotOwner, runVideoSessionCaptureMutation } from './videoSessionCaptureMutations';

export function beginVideoSessionAnalytics(
  context: VideoSessionOperationContext,
  source: AnalyticsSource = 'unknown'
): void {
  context.state.analyticsTimer = createFeatureTimer();
  emitVideoUsageEvent(context.dependencies, 'video_session_started', {
    platform: mapVideoAnalyticsPlatform(context.state.platform),
    source
  });
}

export async function handleVideoSessionAddCapture(
  context: VideoSessionOperationContext,
  options: {
    comment?: string;
    captureScreenshot?: boolean;
    pauseVideo?: boolean;
    beginEditing?: boolean;
    resumePlayback?: boolean;
    collapseAfterCapture?: boolean;
  } = {}
): Promise<VideoTimestampCapture | null> {
  if (context.state.exporting) {
    return null;
  }

  context.drafts.syncCommentDrafts();
  context.updateVideoContext();

  const video = context.state.videoElement ?? context.findVideoElement();
  if (!video) {
    context.applyHint('noVideo');
    return null;
  }

  const shouldLeasePlayback = Boolean(options.pauseVideo && options.beginEditing !== false);
  if (options.pauseVideo && !shouldLeasePlayback && typeof video.pause === 'function') {
    video.pause();
  }

  const currentTime = Math.floor(video.currentTime || 0);
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    context.applyHint('failure');
    return null;
  }

  const shareUrl = context.buildTimestampUrl(currentTime);
  if (!shareUrl) {
    context.applyHint('failure');
    return null;
  }

  const capture = createVideoTimestampCapture({
    video,
    currentTime,
    shareUrl,
    comment: options.comment,
    captureScreenshot: options.captureScreenshot
  });

  const saved = await runVideoSessionCaptureMutation(context, {
    apply: () => {
      context.state.captures.push(capture);
      if (shouldLeasePlayback) {
        context.playbackEditLease.begin(capture.id);
      }
      if (options.collapseAfterCapture) {
        context.dom.collapsePanel();
      }
      return capture;
    },
    afterApply: () => {
      context.syncPanel();
      context.applyHint('saving');
    },
    save: () => saveVideoSessionCaptures(context),
    commit: () => {
      if (!capture.screenshot && !hasScreenshotOwner(context, capture)) {
        requestRequestedScreenshotPreparation(context, capture.id);
      }
      emitVideoUsageEvent(context.dependencies, 'video_timestamp_added', {
        capture_count_bucket: bucketCount(context.state.captures.length)
      });
      context.syncPanel();
      if (options.beginEditing !== false) {
        context.dom.beginEditingCapture(capture.id, capture.comment);
      } else {
        context.dom.stopEditing(capture.id);
      }
      if (options.resumePlayback && typeof video.play === 'function') {
        void Promise.resolve(video.play()).catch(() => undefined);
      }
    },
    rollback: () => {
      rollbackVideoTimestampCaptureMutation(context, capture, shouldLeasePlayback);
    },
    onSaveError: (error) => {
      console.warn('[VideoSession] Failed to save timestamp capture:', error);
    }
  });
  if (!saved) {
    return null;
  }
  return capture;
}

export function ingestVideoSessionTextCapture(
  context: VideoSessionOperationContext,
  selectedHtml: string,
  selectedText: string,
  comment: string,
  selectionRange?: Range
): void {
  context.drafts.syncCommentDrafts();
  context.updateVideoContext();
  const normalizedText = selectedText.replace(/\s+/g, ' ').trim();
  if (!normalizedText) {
    return;
  }

  const commentTrimmed = comment.trim();
  const now = Date.now();
  const fragmentUrl = generateTextFragmentUrl(
    context.state.canonicalUrl || context.doc.location.href,
    normalizedText
  );
  const capture: VideoFragmentCapture = {
    kind: 'fragment',
    id: `aiob-video-fragment-${now}-${Math.random().toString(16).slice(2)}`,
    comment: commentTrimmed,
    selectedText: normalizedText,
    selectedHtml,
    fragmentUrl,
    createdAt: now
  };

  if (selectionRange) {
    try {
      const cloned = selectionRange.cloneRange();
      const wrapperId =
        context.state.platformAdapter?.highlight(cloned, capture.id, fragmentUrl) ??
        context.fragmentHighlighter.highlightRange(cloned, capture.id, fragmentUrl);
      if (wrapperId !== undefined) {
        capture.wrapperId = wrapperId;
      }
    } catch (error) {
      console.warn('[VideoSession] Failed to highlight selection range:', error);
    }
  }
  if (!capture.wrapperId) {
    try {
      const newWrapperId = context.state.platformAdapter?.restoreHighlight(capture);
      if (newWrapperId !== undefined) {
        capture.wrapperId = newWrapperId;
      }
    } catch (error) {
      console.warn('[VideoSession] Failed to ensure fragment highlight:', error);
    }
  }

  const saveTask = runVideoSessionCaptureMutation(context, {
    apply: () => {
      context.state.captures.push(capture);
      context.fragmentHighlightCoordinator.ensureStartedForFragments();
      context.fragmentHighlightCoordinator.scheduleRestore();
      return capture;
    },
    afterApply: () => {
      context.syncPanel();
      focusVideoSessionCapture(context, capture.id);
      context.applyHint('saving');
      context.dom.beginEditingCapture(capture.id, capture.comment);
    },
    save: () => saveVideoSessionCaptures(context),
    commit: () => {
      context.syncPanel();
      emitVideoUsageEvent(context.dependencies, 'video_fragment_added', {
        capture_count_bucket: bucketCount(context.state.captures.length)
      });
    },
    rollback: () => {
      rollbackVideoSessionFragmentAdd(context, capture);
      context.fragmentHighlightCoordinator.stopIfNoFragments();
    },
    onSaveError: (error) => {
      console.warn('[VideoSession] Failed to save fragment capture:', error);
    }
  });
  void saveTask;
}

export function focusVideoSessionCapture(context: VideoSessionOperationContext, id: string): void {
  const target = context.state.captures.find((capture) => capture.id === id);
  if (!target) {
    return;
  }
  if (target.kind === 'timestamp') {
    focusTimestampCapture(context, target);
  } else {
    focusFragmentCapture(context, target);
  }
}

export async function finishVideoSession(
  context: VideoSessionOperationContext,
  onCleanup: () => void
): Promise<void> {
  if (context.state.exporting || context.state.saving) {
    return;
  }
  if (!context.state.captures.length) {
    context.applyHint('noCaptures');
    return;
  }

  context.drafts.syncCommentDrafts();
  context.updateVideoContext();
  const exportDestination = context.getExportDestinationMetadata?.();
  context.state.exporting = true;
  context.applyHint('exporting');
  context.dependencies.showSupportProgress?.({
    value: 10,
    message: {
      key: 'supportProgressVideoPreparing',
      fallback: 'Preparing video export'
    }
  });

  try {
    context.dependencies.showSupportProgress?.({
      value: 34,
      message: {
        key: 'supportProgressVideoGenerating',
        fallback: 'Generating video note'
      }
    });
    context.dependencies.showSupportProgress?.({
      value: 70,
      message: {
        key: 'supportProgressVideoWriting',
        fallback: 'Writing to Obsidian'
      }
    });
    const result = await context.exporter.export({
      captures: context.state.captures,
      videoTitle: context.state.videoTitle,
      canonicalUrl: context.state.canonicalUrl || '',
      videoUrl: context.state.videoUrl,
      platform: context.state.platform,
      messages: context.messages,
      storageKey: context.state.storageKey,
      ...(exportDestination ? { exportDestination } : {})
    });
    if (typeof result !== 'object' || result === null || typeof result.success !== 'boolean') {
      throw createVideoExportFailure('Invalid video export response', 'validation');
    }
    if (!result.success) {
      throw createVideoExportFailure(result.error ?? 'Video clip failed', result.failureCategory);
    }
    const terminalized = await context.drafts.finalizeTerminal('exported');
    if (!terminalized) {
      context.dependencies.showSupportProgress?.({
        value: 100,
        variant: 'failure'
      });
      context.applyHint('failure');
      context.state.exporting = false;
      return;
    }
    context.dependencies.showSupportProgress?.({
      value: 100,
      variant: 'success'
    });
    emitVideoUsageEvent(context.dependencies, 'video_exported', {
      platform: mapVideoAnalyticsPlatform(context.state.platform),
      destination: resolveVideoExportDestination(exportDestination),
      duration_bucket: resolveVideoSessionDurationBucket(context.state),
      capture_count_bucket: bucketCount(context.state.captures.length),
      screenshot_count_bucket: bucketCount(countVideoRequestedScreenshots(context.state.captures))
    });
    onCleanup();
  } catch (error) {
    console.error('[VideoSession] Export failed:', error);
    context.dependencies.showSupportProgress?.({
      value: 100,
      variant: 'failure'
    });
    emitVideoUsageEvent(context.dependencies, 'video_export_failed', {
      platform: mapVideoAnalyticsPlatform(context.state.platform),
      destination: resolveVideoExportDestination(exportDestination),
      failure_category: resolveVideoFailureCategory(error)
    });
    context.applyHint('failure');
    context.state.exporting = false;
  }
}

export async function cancelVideoSession(
  context: VideoSessionOperationContext,
  onCleanup: () => void
): Promise<void> {
  if (context.state.exporting) {
    return;
  }
  const terminalized = await context.drafts.finalizeTerminal('discarded');
  if (!terminalized) {
    context.applyHint('failure');
    return;
  }
  emitVideoUsageEvent(context.dependencies, 'video_session_cancelled', {
    platform: mapVideoAnalyticsPlatform(context.state.platform),
    duration_bucket: resolveVideoSessionDurationBucket(context.state)
  });
  onCleanup();
}

export function cleanupVideoSession(context: VideoSessionOperationContext): void {
  context.playbackEditLease.reset();
  context.lifecycle.stop();
  context.state.stopOptionsWatcher?.();
  context.state.stopOptionsWatcher = null;
  context.state.stopLanguageWatcher?.();
  context.state.stopLanguageWatcher = null;
  context.state.controller = null;
  context.fragmentHighlightCoordinator.updateAdapter(null);
  context.fragmentHighlightCoordinator.stop();
  context.platformController.dispose();
  context.fragmentHighlighter.reset();
  context.shadowSelectionBridge.reset();
  context.pendingSelection.reset();
  context.state.suppressSelectionCapture = false;
  context.selectionCaptureController.stop();
  context.fragmentSelectionController.handleWindowBlur();
  context.dom.destroy();

  clearVideoSession(context.session, context.doc);
  context.state.videoElement = null;
  context.state.exporting = false;
  context.state.saving = false;
  context.state.analyticsTimer = null;
  context.state.commentDrafts = {};
  context.hintManager.apply('noVideo', { videoAvailable: false, hasCaptures: false });

  for (const capture of context.state.captures) {
    if (capture.kind === 'fragment' && capture.wrapperId) {
      context.fragmentHighlighter.removeById(capture.wrapperId);
    }
  }
  context.state.captures = [];
}

export async function loadVideoSessionHighlightTheme(
  dependencies: VideoSessionDependencies
): Promise<ReaderHighlightTheme> {
  try {
    const options = await dependencies.optionsRepository.get();
    const highlightTheme = options.readingSession?.highlightTheme;
    return resolveHighlightTheme(highlightTheme);
  } catch (error) {
    console.warn('[VideoSession] Failed to load highlight theme, using default:', error);
    return DEFAULT_HIGHLIGHT_THEME;
  }
}

export function applyVideoSessionHighlightTheme(
  state: VideoSessionState,
  fragmentHighlighter: FragmentHighlighter,
  theme: ReaderHighlightTheme
): void {
  fragmentHighlighter.setTheme(theme);
  const wrapperIds = state.captures
    .filter((capture): capture is VideoFragmentCapture => capture.kind === 'fragment')
    .map((capture) => capture.wrapperId)
    .filter((id): id is string => Boolean(id));
  if (wrapperIds.length) {
    fragmentHighlighter.decorateExisting(wrapperIds);
  }
}

export function watchVideoSessionHighlightTheme(
  context: VideoSessionOperationContext,
  applyHighlightTheme: (theme: ReaderHighlightTheme) => void
): void {
  const applyOptions = (nextOptions?: StoredOptions) => {
    if (!nextOptions || !Object.prototype.hasOwnProperty.call(nextOptions, 'readingSession')) {
      return;
    }
    const highlightTheme = resolveHighlightTheme(nextOptions.readingSession?.highlightTheme);
    context.state.highlightTheme = highlightTheme;
    applyHighlightTheme(highlightTheme);
    context.fragmentHighlightCoordinator.scheduleRestore();
  };

  void context.dependencies.optionsRepository
    .get()
    .then((value) => {
      applyOptions(value);
    })
    .catch((error) => {
      console.warn('[VideoSession] Failed to preload highlight theme options:', error);
    });
  context.state.stopOptionsWatcher = context.dependencies.optionsRepository.onChange(applyOptions);
}
