import { bucketCount } from '../../shared/analytics';
import type { VideoCaptureMutationTransaction } from './videoCaptureMutationTypes';
import type { VideoSessionOperationContext } from './videoSessionOperationContext';
import {
  emitVideoUsageEvent,
  restoreRemovedFragmentHighlight,
  saveVideoSessionCaptures
} from './videoCaptureMutationTransaction';
import {
  collectVideoDraftScreenshotRefs,
  filterUnreferencedVideoDraftScreenshotRefs,
  removeVideoDraftCachedScreenshotRefs
} from './videoSessionDraftScreenshotCache';
import type { VideoScreenshotCacheRef } from './videoScreenshotCacheTypes';

export {
  hasScreenshotOwner,
  toggleVideoSessionCaptureScreenshot
} from './videoSessionScreenshotToggle';

export function runVideoSessionCaptureMutation<Result>(
  context: VideoSessionOperationContext,
  transaction: VideoCaptureMutationTransaction<Result>
): Promise<boolean> {
  return context.runCaptureMutation(transaction);
}

function cleanupRemovedCaptureScreenshotRefs(
  context: Pick<VideoSessionOperationContext, 'dependencies'>,
  refs: readonly VideoScreenshotCacheRef[]
): void {
  const screenshotCache = context.dependencies.screenshotCacheRepository;
  if (refs.length === 0 || !screenshotCache) {
    return;
  }

  void removeVideoDraftCachedScreenshotRefs(refs, screenshotCache).catch((error) => {
    console.warn(
      '[VideoSession] Failed to remove cached screenshot after capture deletion:',
      error
    );
  });
}

export async function submitVideoSessionCaptureEdit(
  context: VideoSessionOperationContext,
  id: string,
  comment: string
): Promise<void> {
  if (!context.state.captures.some((capture) => capture.id === id)) {
    return;
  }
  const nextComment = comment.trim();
  let applied = false;

  await runVideoSessionCaptureMutation(context, {
    apply: () => {
      const target = context.state.captures.find((capture) => capture.id === id);
      if (!target) {
        return null;
      }
      const previousDraft = context.state.commentDrafts[id];
      context.drafts.syncCommentDrafts();
      const syncedDraft = context.state.commentDrafts[id];
      const draftToRestore = syncedDraft ?? previousDraft;
      delete context.state.commentDrafts[id];
      const previousComment = target.comment;
      target.comment = nextComment;
      applied = true;
      return { target, previousComment, previousDraft: draftToRestore };
    },
    afterApply: (result) => {
      if (!result) {
        return;
      }
      context.syncPanel();
      context.applyHint('saving');
    },
    save: () => (applied ? saveVideoSessionCaptures(context) : Promise.resolve(null)),
    commit: (result) => {
      if (!result) {
        return;
      }
      context.playbackEditLease.release(id, true);
      context.dom.stopEditing(id);
      context.syncPanel();
    },
    rollback: (result) => {
      if (!result) {
        return;
      }
      const { target, previousComment, previousDraft: draftSnapshot } = result;
      target.comment = previousComment;
      if (draftSnapshot !== undefined) {
        context.state.commentDrafts[id] = draftSnapshot;
      }
      context.syncPanel();
      context.applyHint('failure');
    },
    onSaveError: (error) => {
      console.warn('[VideoSession] Failed to save capture edit:', error);
    }
  });
}

export function removeVideoSessionCapture(context: VideoSessionOperationContext, id: string): void {
  if (!context.state.captures.some((capture) => capture.id === id)) {
    return;
  }
  let applied = false;
  const saveTask = runVideoSessionCaptureMutation(context, {
    apply: () => {
      const index = context.state.captures.findIndex((capture) => capture.id === id);
      if (index === -1) {
        return null;
      }
      const previousDraft = context.state.commentDrafts[id];
      context.drafts.syncCommentDrafts();
      const syncedDraft = context.state.commentDrafts[id];
      const draftToRestore = syncedDraft ?? previousDraft;
      delete context.state.commentDrafts[id];
      const [removed] = context.state.captures.splice(index, 1);
      if (!removed) {
        return null;
      }
      const removedScreenshotRefs =
        removed.kind === 'timestamp' ? collectVideoDraftScreenshotRefs([removed]) : [];
      context.playbackEditLease.release(id, false);
      if (removed.kind === 'fragment' && removed.wrapperId) {
        context.fragmentHighlighter.removeById(removed.wrapperId);
      }
      context.fragmentHighlightCoordinator.stopIfNoFragments();
      applied = true;
      return { removed, previousDraft: draftToRestore, index, removedScreenshotRefs };
    },
    afterApply: (result) => {
      if (!result) {
        return;
      }
      context.syncPanel();
      context.applyHint('saving');
    },
    save: () => (applied ? saveVideoSessionCaptures(context) : Promise.resolve(null)),
    commit: (result) => {
      if (!result) {
        return;
      }
      context.syncPanel();
      emitVideoUsageEvent(context.dependencies, 'video_capture_removed', {
        capture_count_bucket: bucketCount(context.state.captures.length)
      });
      cleanupRemovedCaptureScreenshotRefs(
        context,
        filterUnreferencedVideoDraftScreenshotRefs(
          result.removedScreenshotRefs,
          context.state.captures
        )
      );
    },
    rollback: (result) => {
      if (!result) {
        return;
      }
      const { removed, previousDraft: draftSnapshot, index } = result;
      context.state.captures.splice(index, 0, removed);
      if (draftSnapshot !== undefined) {
        context.state.commentDrafts[id] = draftSnapshot;
      }
      restoreRemovedFragmentHighlight(context, removed);
      context.syncPanel();
      context.applyHint('failure');
    },
    onSaveError: (error) => {
      console.warn('[VideoSession] Failed to save captures after removal:', error);
    }
  });
  void saveTask;
}
