import {
  serializeBlobAttachmentContent,
  serializedAttachmentContentToBlob
} from '../../shared/attachments/clipAttachmentBinary';
import type { SerializedVideoScreenshotCacheScreenshot } from '../../content/video/videoScreenshotCacheMessages';
import type { VideoCaptureScreenshot } from '../../content/video/types';

export function deserializeVideoScreenshot(
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

export async function serializeVideoScreenshot(
  screenshot: VideoCaptureScreenshot
): Promise<SerializedVideoScreenshotCacheScreenshot> {
  if (screenshot.content?.kind !== 'blob') {
    throw new Error('Screenshot cache load returned missing blob content.');
  }
  return {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content: await serializeBlobAttachmentContent(screenshot.content.blob)
  };
}
