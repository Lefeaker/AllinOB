import type { SerializedVideoScreenshotCacheScreenshot } from '../../content/video/videoScreenshotCacheMessages';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';

const encoder = new TextEncoder();

export async function createVideoScreenshotRequestFingerprint(
  screenshot: SerializedVideoScreenshotCacheScreenshot
): Promise<string> {
  const content = screenshot.content ?? normalizeDataUrl(screenshot.dataUrl ?? '');
  const normalized = {
    id: screenshot.id,
    fileName: screenshot.fileName,
    mimeType: screenshot.mimeType,
    capturedAt: screenshot.capturedAt,
    content
  };
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalJsonStringify(normalized))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeDataUrl(dataUrl: string): {
  encoding: 'base64';
  data: string;
  byteLength: number;
} {
  const marker = ';base64,';
  const index = dataUrl.indexOf(marker);
  if (index < 0) throw new Error('Invalid screenshot data URL.');
  const data = dataUrl.slice(index + marker.length);
  return {
    encoding: 'base64',
    data,
    byteLength: globalThis.atob(data).length
  };
}
