/* @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import {
  VIDEO_SCREENSHOT_CACHE_MESSAGE,
  normalizeVideoScreenshotCacheMessage,
  type SerializedVideoScreenshotCacheScreenshot,
  type VideoScreenshotCacheMessage
} from '@content/video/videoScreenshotCacheMessages';
import {
  isVideoScreenshotCacheRefMessage,
  normalizeSerializedScreenshot
} from '@content/video/videoScreenshotCacheMessageCodecs';
import { normalizeVideoScreenshotCacheResponse } from '@content/video/videoScreenshotCacheResponses';
import type { VideoScreenshotCacheClientOperation } from '@content/video/videoScreenshotCacheResponses';
import type { VideoScreenshotCacheRef } from '@content/video/videoScreenshotCacheTypes';

const validation = { maxContentBytes: 1_024 };
const ref: VideoScreenshotCacheRef = {
  schemaVersion: 1,
  key: 'aiob.videoScreenshotCache.v1.page.capture.shot',
  pageKey: 'page',
  captureId: 'capture',
  id: 'shot',
  fileName: 'shot.jpg',
  mimeType: 'image/jpeg',
  byteLength: 1,
  capturedAt: 1,
  expiresAt: 2
};
const screenshot: SerializedVideoScreenshotCacheScreenshot = {
  id: 'shot',
  fileName: 'shot.jpg',
  mimeType: 'image/jpeg',
  capturedAt: 1,
  content: {
    encoding: 'base64',
    data: 'YQ==',
    byteLength: 1
  }
};

function asArrayRecord(value: object): unknown[] {
  return Object.assign([], value);
}

describe('video screenshot protocol record codecs', () => {
  it.each([
    {
      name: 'save',
      message: {
        type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
        operation: 'save',
        input: { pageKey: 'page', captureId: 'capture', screenshot }
      }
    },
    {
      name: 'load',
      message: { type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: 'load', ref }
    },
    {
      name: 'remove',
      message: { type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: 'remove', ref }
    }
  ])('rejects an array-backed $name message', ({ message }) => {
    expect(normalizeVideoScreenshotCacheMessage(asArrayRecord(message), validation)).toBeNull();
  });

  it('rejects array-backed nested save input and load/remove refs', () => {
    expect(
      normalizeVideoScreenshotCacheMessage(
        {
          type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
          operation: 'save',
          input: asArrayRecord({ pageKey: 'page', captureId: 'capture', screenshot })
        },
        validation
      )
    ).toBeNull();
    const operations: Array<'load' | 'remove'> = ['load', 'remove'];
    for (const operation of operations) {
      expect(
        normalizeVideoScreenshotCacheMessage(
          {
            type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
            operation,
            ref: asArrayRecord(ref)
          },
          validation
        )
      ).toBeNull();
    }
  });

  it('rejects sparse, accessor-backed, and extended removeMany ref arrays', () => {
    const sparse = Array<VideoScreenshotCacheRef>(1);
    const accessorBacked = [ref];
    Reflect.defineProperty(accessorBacked, '0', { enumerable: true, get: () => ref });
    const extended = [ref];
    Reflect.defineProperty(extended, 'extra', { value: true, enumerable: true });

    for (const refs of [sparse, accessorBacked, extended]) {
      expect(
        normalizeVideoScreenshotCacheMessage(
          { type: VIDEO_SCREENSHOT_CACHE_MESSAGE, operation: 'removeMany', refs },
          validation
        )
      ).toBeNull();
    }
  });

  const responseCases: Array<{
    name: VideoScreenshotCacheClientOperation;
    response: object;
  }> = [
    {
      name: 'save',
      response: { success: true, operation: 'save', result: { status: 'saved', ref } }
    },
    {
      name: 'load',
      response: { success: true, operation: 'load', status: 'loaded', screenshot }
    },
    {
      name: 'remove',
      response: { success: true, operation: 'remove' }
    }
  ];

  it.each(responseCases)('rejects an array-backed $name response', ({ name, response }) => {
    expect(normalizeVideoScreenshotCacheResponse(asArrayRecord(response), name)).toBeNull();
  });

  it('rejects array-backed nested response results and refs', () => {
    expect(
      normalizeVideoScreenshotCacheResponse(
        {
          success: true,
          operation: 'save',
          result: asArrayRecord({ status: 'saved', ref })
        },
        'save'
      )
    ).toBeNull();
    expect(
      normalizeVideoScreenshotCacheResponse(
        {
          success: true,
          operation: 'save',
          result: { status: 'saved', ref: asArrayRecord(ref) }
        },
        'save'
      )
    ).toBeNull();
  });

  it('rejects inherited, symbol-keyed, non-enumerable, and accessor-backed refs', () => {
    const inherited = {};
    Reflect.setPrototypeOf(inherited, ref);
    const symbolKeyed = { ...ref };
    Reflect.defineProperty(symbolKeyed, Symbol('extra'), { value: true, enumerable: true });
    const hidden = { ...ref };
    Reflect.defineProperty(hidden, 'extra', { value: true, enumerable: false });
    let capturedAtReads = 0;
    const accessor = { ...ref };
    Reflect.defineProperty(accessor, 'capturedAt', {
      enumerable: true,
      get() {
        capturedAtReads += 1;
        return capturedAtReads === 1 ? 1 : -1;
      }
    });

    for (const value of [inherited, symbolKeyed, hidden, accessor]) {
      expect(isVideoScreenshotCacheRefMessage(value, validation)).toBe(false);
    }
  });

  it('rejects accessor-backed nested screenshots and binary content', () => {
    const accessorScreenshot = { ...screenshot };
    Reflect.defineProperty(accessorScreenshot, 'capturedAt', {
      enumerable: true,
      get: () => 1
    });
    const accessorContent = { ...screenshot.content };
    Reflect.defineProperty(accessorContent, 'byteLength', {
      enumerable: true,
      get: () => 1
    });

    expect(normalizeSerializedScreenshot(accessorScreenshot, validation)).toBeNull();
    expect(
      normalizeSerializedScreenshot({ ...screenshot, content: accessorContent }, validation)
    ).toBeNull();
  });

  it('returns detached stable snapshots for valid current and legacy payloads', () => {
    const currentMessage: VideoScreenshotCacheMessage = {
      type: VIDEO_SCREENSHOT_CACHE_MESSAGE,
      operation: 'save',
      input: { pageKey: 'page', captureId: 'capture', screenshot: structuredClone(screenshot) }
    };
    const normalizedMessage = normalizeVideoScreenshotCacheMessage(currentMessage, validation);
    expect(normalizedMessage).not.toBe(currentMessage);
    expect(normalizedMessage).toEqual(currentMessage);

    const legacyScreenshot = {
      id: 'legacy',
      fileName: 'legacy.jpg',
      mimeType: 'image/jpeg',
      capturedAt: 1,
      dataUrl: 'data:image/jpeg;base64,YQ=='
    };
    expect(normalizeSerializedScreenshot(legacyScreenshot, validation)).toEqual(legacyScreenshot);
  });

  it('rejects oversized base64 before invoking the decoder', () => {
    const atob = vi.spyOn(globalThis, 'atob');
    const oversized = 'YWFh'.repeat(10_000);
    try {
      expect(
        normalizeSerializedScreenshot(
          {
            ...screenshot,
            content: { encoding: 'base64', data: oversized, byteLength: 1 }
          },
          { maxContentBytes: 1 }
        )
      ).toBeNull();
      expect(
        normalizeSerializedScreenshot(
          {
            id: 'legacy',
            fileName: 'legacy.jpg',
            mimeType: 'image/jpeg',
            capturedAt: 1,
            dataUrl: `data:image/jpeg;base64,${oversized}`
          },
          { maxContentBytes: 1 }
        )
      ).toBeNull();
      expect(atob).not.toHaveBeenCalled();
    } finally {
      atob.mockRestore();
    }
  });
});
