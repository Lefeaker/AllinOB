import { bucketCount, type FeatureTimer } from '../../shared/analytics';
import type { VideoSessionDraftEnvelope } from '../sessionDrafts';
import type { VideoCapture } from './types';
import { hasRequestedTimestampScreenshot } from './screenshotIntent';
import type { VideoSessionDraftPayloadShape } from './sessionDrafts';
import type { VideoSessionDraftControllerOptions } from './videoSessionRuntimePorts';

export type VideoDraftRestoreTelemetryParams = Parameters<
  NonNullable<VideoSessionDraftControllerOptions['trackDraftRestoreEvent']>
>[0];

export function buildDraftRestoreTelemetryParams(args: {
  captures: readonly VideoCapture[];
  outcome: VideoDraftRestoreTelemetryParams['outcome'];
  restoreTimer: FeatureTimer;
  staleRefCount?: number;
}): VideoDraftRestoreTelemetryParams {
  return {
    capture_count_bucket: bucketCount(args.captures.length),
    screenshot_count_bucket: bucketCount(countRequestedDraftScreenshots(args.captures)),
    outcome: args.outcome,
    ...(args.staleRefCount && args.staleRefCount > 0
      ? { stale_screenshot_ref_count_bucket: bucketCount(args.staleRefCount) }
      : {}),
    duration_bucket: args.restoreTimer.durationBucket()
  };
}

export function readDraftRestoreTelemetryCaptures(
  draft: VideoSessionDraftEnvelope
): readonly VideoCapture[] {
  const payload = draft.payload as Partial<VideoSessionDraftPayloadShape>;
  return Array.isArray(payload.captures) ? (payload.captures as VideoCapture[]) : [];
}

function countRequestedDraftScreenshots(captures: readonly VideoCapture[]): number {
  return captures.filter(
    (capture): capture is Extract<VideoCapture, { kind: 'timestamp' }> =>
      capture.kind === 'timestamp' &&
      (hasRequestedTimestampScreenshot(capture) ||
        capture.screenshot !== undefined ||
        capture.screenshotRef !== undefined)
  ).length;
}
