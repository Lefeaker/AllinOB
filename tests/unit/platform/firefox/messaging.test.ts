import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePayload } from '../../../../src/platform/interfaces/messaging';

type NativeMessageListener = Parameters<typeof browser.runtime.onMessage.addListener>[0];

const nativeListeners: NativeMessageListener[] = [];

const firefoxApi = vi.hoisted(() => ({
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener: NativeMessageListener) => {
        nativeListeners.push(listener);
      }),
      removeListener: vi.fn((listener: NativeMessageListener) => {
        const index = nativeListeners.indexOf(listener);
        if (index >= 0) {
          nativeListeners.splice(index, 1);
        }
      })
    }
  },
  tabs: { sendMessage: vi.fn() }
}));

vi.mock('../../../../src/platform/firefox/utils', () => ({
  ensureFirefox: (): typeof firefoxApi => firefoxApi
}));

describe('firefoxMessagingService listener multiplexer', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    nativeListeners.length = 0;
  });

  it('registers one native listener for multiple application listeners', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    const first = vi.fn(() => Promise.resolve(undefined));
    const second = vi.fn(() => Promise.resolve({ ok: true }));

    firefoxMessagingService.addListener(first);
    firefoxMessagingService.addListener(second);

    expect(firefoxApi.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    const sendResponse = invokeNative({ request: true });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('settles a synchronous defined response exactly once', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    firefoxMessagingService.addListener(() => ({ source: 'sync' }));
    firefoxMessagingService.addListener(() => Promise.resolve({ source: 'async' }));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ source: 'sync' }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('settles the first asynchronous defined response rather than registration order', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    let resolveSlow: ((value: { source: string }) => void) | undefined;
    const slow = new Promise<{ source: string }>((resolve) => {
      resolveSlow = resolve;
    });
    firefoxMessagingService.addListener(() => slow);
    firefoxMessagingService.addListener(() => Promise.resolve({ source: 'fast' }));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ source: 'fast' }));
    resolveSlow?.({ source: 'slow' });
    await slow;
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('waits past an asynchronous undefined result for a defined peer response', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    let resolveDefined: ((value: { ok: boolean }) => void) | undefined;
    const defined = new Promise<{ ok: boolean }>((resolve) => {
      resolveDefined = resolve;
    });
    firefoxMessagingService.addListener(() => Promise.resolve(undefined));
    firefoxMessagingService.addListener(() => defined);

    const sendResponse = invokeNative({ request: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendResponse).not.toHaveBeenCalled();

    resolveDefined?.({ ok: true });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('waits past a rejection for a defined peer response', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    firefoxMessagingService.addListener(() => Promise.reject(new Error('private rejection')));
    firefoxMessagingService.addListener(() => Promise.resolve({ ok: true }));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('contains a synchronous throw and preserves a defined peer response', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    firefoxMessagingService.addListener(() => {
      throw new Error('private synchronous throw');
    });
    firefoxMessagingService.addListener(() => Promise.resolve({ ok: true }));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('completes exactly once with undefined when all listeners return undefined', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    firefoxMessagingService.addListener(() => undefined);
    firefoxMessagingService.addListener(() => Promise.resolve(undefined));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(undefined));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('completes exactly once with undefined when all listeners reject or throw', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    firefoxMessagingService.addListener(() => {
      throw new Error('private synchronous throw');
    });
    firefoxMessagingService.addListener(() => Promise.reject(new Error('private rejection')));

    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(undefined));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('maps the native Firefox sender for every application listener', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    const first = vi.fn(() => undefined);
    const second = vi.fn(() => ({ ok: true }));
    firefoxMessagingService.addListener(first);
    firefoxMessagingService.addListener(second);
    const tab: browser.tabs.Tab = {
      id: 7,
      index: 0,
      windowId: 11,
      highlighted: false,
      active: false,
      pinned: false,
      incognito: false
    };
    const sender: browser.runtime.MessageSender = {
      id: 'extension-id',
      tab,
      frameId: 3,
      url: 'https://example.com/frame'
    };

    invokeNative({ request: true }, sender);

    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    const expectedSender = {
      id: 'extension-id',
      tabId: 7,
      windowId: 11,
      frameId: 3,
      url: 'https://example.com/frame'
    };
    expect(first).toHaveBeenCalledWith({ request: true }, expectedSender);
    expect(second).toHaveBeenCalledWith({ request: true }, expectedSender);
  });

  it('removes one application listener without unregistering the native listener', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    const first = vi.fn(() => ({ source: 'first' }));
    const second = vi.fn(() => ({ source: 'second' }));
    const removeFirst = firefoxMessagingService.addListener(first);
    firefoxMessagingService.addListener(second);

    removeFirst();
    const sendResponse = invokeNative({ request: true });

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ source: 'second' }));
    expect(first).not.toHaveBeenCalled();
    expect(firefoxApi.runtime.onMessage.removeListener).not.toHaveBeenCalled();
  });

  it('unregisters the native listener once when final disposal is repeated', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    const dispose = firefoxMessagingService.addListener(() => undefined);

    dispose();
    dispose();

    expect(firefoxApi.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(nativeListeners).toHaveLength(0);
  });

  it('registers a fresh native listener after the application listener set becomes empty', async () => {
    const { firefoxMessagingService } = await import('../../../../src/platform/firefox/messaging');
    const dispose = firefoxMessagingService.addListener(() => undefined);
    dispose();
    firefoxMessagingService.addListener(() => ({ fresh: true }));

    expect(firefoxApi.runtime.onMessage.addListener).toHaveBeenCalledTimes(2);
    expect(firefoxApi.runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
    const sendResponse = invokeNative({ request: true });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ fresh: true }));
  });
});

function invokeNative(
  message: MessagePayload,
  sender: browser.runtime.MessageSender = {}
): ReturnType<typeof vi.fn<(response?: MessagePayload) => void>> {
  const nativeListener = nativeListeners[0];
  expect(nativeListener).toBeDefined();
  const sendResponse = vi.fn<(response?: MessagePayload) => void>();

  expect(nativeListener?.(message, sender, sendResponse)).toBe(true);

  return sendResponse;
}
