import type { VideoTimestampCapture } from './types';
import type { VideoSessionOperationContext } from './videoSessionOperationContext';
import {
  requestRequestedScreenshotPreparation,
  restoreTimestampScreenshotState,
  saveVideoSessionCaptures,
  snapshotTimestampScreenshotState
} from './videoCaptureMutationTransaction';
import {
  clearRequestedTimestampScreenshot,
  hasRequestedTimestampScreenshot,
  setRequestedTimestampScreenshot
} from './screenshotIntent';

type TimestampScreenshotState = ReturnType<typeof snapshotTimestampScreenshotState>;

interface PendingScreenshotToggleState {
  latestRevision: number;
  pendingActions: number;
  preparationOwnerRevision: number | null;
  persistedScreenshotState: TimestampScreenshotState;
}

const pendingScreenshotToggleStates = new WeakMap<
  VideoTimestampCapture,
  PendingScreenshotToggleState
>();

function isCurrentTimestampCapture(
  context: VideoSessionOperationContext,
  target: VideoTimestampCapture,
  id: string
): boolean {
  return context.state.captures.some(
    (capture) => capture === target && capture.kind === 'timestamp' && capture.id === id
  );
}

function clearScreenshotPreparationOwner(
  toggleState: PendingScreenshotToggleState,
  revision: number
): void {
  if (toggleState.preparationOwnerRevision === revision) {
    toggleState.preparationOwnerRevision = null;
  }
}

export function hasScreenshotOwner(
  context: VideoSessionOperationContext,
  target: VideoTimestampCapture
): boolean {
  const toggleState = pendingScreenshotToggleStates.get(target);
  return (
    toggleState !== undefined &&
    toggleState.pendingActions > 0 &&
    toggleState.preparationOwnerRevision !== null &&
    toggleState.preparationOwnerRevision === toggleState.latestRevision &&
    isCurrentTimestampCapture(context, target, target.id) &&
    hasRequestedTimestampScreenshot(target)
  );
}

export async function toggleVideoSessionCaptureScreenshot(
  context: VideoSessionOperationContext,
  id: string
): Promise<void> {
  const target = context.state.captures.find(
    (capture): capture is VideoTimestampCapture => capture.kind === 'timestamp' && capture.id === id
  );
  if (!target) {
    return;
  }

  let toggleState = pendingScreenshotToggleStates.get(target);
  if (!toggleState) {
    toggleState = {
      latestRevision: 0,
      pendingActions: 0,
      preparationOwnerRevision: null,
      persistedScreenshotState: snapshotTimestampScreenshotState(target)
    };
    pendingScreenshotToggleStates.set(target, toggleState);
  }

  const revision = toggleState.latestRevision + 1;
  toggleState.latestRevision = revision;
  toggleState.pendingActions += 1;
  const shouldPrepareScreenshot = !hasRequestedTimestampScreenshot(target);
  if (shouldPrepareScreenshot) {
    toggleState.preparationOwnerRevision = revision;
    setRequestedTimestampScreenshot(target, null);
  } else {
    toggleState.preparationOwnerRevision = null;
    clearRequestedTimestampScreenshot(target);
  }
  context.syncPanel();

  let applied = false;
  let savedScreenshotState: TimestampScreenshotState | null = null;
  try {
    await context.runCaptureMutation({
      apply: () => {
        if (!isCurrentTimestampCapture(context, target, id)) {
          return null;
        }
        applied = true;
        return { target, shouldPrepareScreenshot };
      },
      afterApply: (result) => {
        if (result) {
          context.applyHint('saving');
        }
      },
      save: () => {
        if (!applied) {
          return Promise.resolve(null);
        }
        savedScreenshotState = snapshotTimestampScreenshotState(target);
        return saveVideoSessionCaptures(context);
      },
      commit: (result) => {
        clearScreenshotPreparationOwner(toggleState, revision);
        if (!result) {
          return;
        }
        if (savedScreenshotState) {
          toggleState.persistedScreenshotState = savedScreenshotState;
        }
        context.syncPanel();
        if (
          toggleState.latestRevision === revision &&
          result.shouldPrepareScreenshot &&
          isCurrentTimestampCapture(context, result.target, id) &&
          hasRequestedTimestampScreenshot(result.target)
        ) {
          requestRequestedScreenshotPreparation(context, result.target.id);
        }
      },
      rollback: (result) => {
        clearScreenshotPreparationOwner(toggleState, revision);
        if (!result) {
          return;
        }
        if (
          toggleState.latestRevision === revision &&
          isCurrentTimestampCapture(context, result.target, id)
        ) {
          restoreTimestampScreenshotState(result.target, toggleState.persistedScreenshotState);
        }
        context.syncPanel();
        context.applyHint('failure');
      },
      onSaveError: (error) => {
        console.warn('[VideoSession] Failed to save screenshot toggle:', error);
      }
    });
  } finally {
    clearScreenshotPreparationOwner(toggleState, revision);
    toggleState.pendingActions = Math.max(0, toggleState.pendingActions - 1);
    if (toggleState.pendingActions === 0) {
      pendingScreenshotToggleStates.delete(target);
    }
  }
}
