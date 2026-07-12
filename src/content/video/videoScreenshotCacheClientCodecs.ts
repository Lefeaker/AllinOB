import { serializedAttachmentContentToBlob } from '../../shared/attachments/clipAttachmentBinary';
import type { VideoCaptureScreenshot } from './types';
import type { VideoScreenshotCacheSaveInput } from './videoScreenshotCacheRepository';
import type { SerializedVideoScreenshotCacheScreenshot } from './videoScreenshotCacheMessages';
import type { VideoScreenshotCacheRef } from './videoScreenshotCacheTypes';
import { serializeVideoScreenshotAttachment } from './videoScreenshotAttachmentSerialization';

export async function serializeScreenshotForCache(
  screenshot: VideoCaptureScreenshot
): Promise<SerializedVideoScreenshotCacheScreenshot | null> {
  const attachment = await serializeVideoScreenshotAttachment(screenshot);
  if (!attachment) return null;
  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    ...('content' in attachment ? { content: attachment.content } : { dataUrl: attachment.dataUrl })
  };
}

export function deserializeScreenshotFromCache(
  screenshot: SerializedVideoScreenshotCacheScreenshot
): VideoCaptureScreenshot {
  const blob = serializedAttachmentContentToBlob(
    screenshot.content
      ? { kind: 'base64', binary: screenshot.content }
      : { kind: 'legacyDataUrl', dataUrl: screenshot.dataUrl ?? '' },
    screenshot.mimeType
  );
  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content: { kind: 'blob', blob, byteLength: blob.size }
  };
}

export function matchesScreenshotLoadRequest(
  screenshot: SerializedVideoScreenshotCacheScreenshot,
  ref: VideoScreenshotCacheRef
): boolean {
  return (
    screenshot.id === ref.id &&
    screenshot.fileName === ref.fileName &&
    screenshot.mimeType === ref.mimeType &&
    screenshot.capturedAt === ref.capturedAt &&
    serializedByteLength(screenshot) === ref.byteLength
  );
}

export function matchesScreenshotSaveRequest(
  ref: VideoScreenshotCacheRef,
  input: VideoScreenshotCacheSaveInput,
  screenshot: SerializedVideoScreenshotCacheScreenshot
): boolean {
  return (
    ref.pageKey === input.pageKey &&
    ref.captureId === input.captureId &&
    ref.id === screenshot.id &&
    ref.fileName === screenshot.fileName &&
    ref.mimeType === screenshot.mimeType &&
    ref.capturedAt === screenshot.capturedAt &&
    ref.byteLength === serializedByteLength(screenshot)
  );
}

function serializedByteLength(screenshot: SerializedVideoScreenshotCacheScreenshot): number {
  if (screenshot.content) return screenshot.content.byteLength;
  const marker = ';base64,';
  const dataUrl = screenshot.dataUrl;
  return dataUrl
    ? globalThis.atob(dataUrl.slice(dataUrl.indexOf(marker) + marker.length)).length
    : -1;
}
