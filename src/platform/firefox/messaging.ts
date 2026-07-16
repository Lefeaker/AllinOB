import type {
  MessageListener,
  MessageSenderInfo,
  MessagingService,
  MessageSendOptions
} from '../interfaces/messaging';
import { ensureFirefox } from './utils';

function mapSender(sender: browser.runtime.MessageSender): MessageSenderInfo {
  return {
    ...(sender.id !== undefined && { id: sender.id }),
    ...(sender.tab?.id !== undefined && { tabId: sender.tab.id }),
    ...(sender.tab?.windowId !== undefined && { windowId: sender.tab.windowId }),
    ...(sender.frameId !== undefined && { frameId: sender.frameId }),
    ...(sender.url !== undefined && { url: sender.url })
  };
}

const messageListeners = new Set<MessageListener>();
let registeredFirefoxApi: typeof browser | undefined;

const nativeMessageListener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
  message,
  sender,
  sendResponse
) => {
  const listeners = [...messageListeners];
  const senderInfo = mapSender(sender);
  let pending = listeners.length;
  let completed = false;

  const complete = (response: unknown): void => {
    if (completed) {
      return;
    }
    completed = true;
    sendResponse(response);
  };

  const completeOneWithoutResponse = (): void => {
    if (completed) {
      return;
    }
    pending -= 1;
    if (pending === 0) {
      complete(undefined);
    }
  };

  if (pending === 0) {
    complete(undefined);
    return true;
  }

  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(message, senderInfo))
      .then((response) => {
        if (response === undefined) {
          completeOneWithoutResponse();
          return;
        }
        complete(response);
      }, completeOneWithoutResponse);
  }

  return true;
};

export const firefoxMessagingService: MessagingService = {
  async send<TResult = unknown>(message: unknown): Promise<TResult> {
    const firefoxApi = ensureFirefox();
    const response: unknown = await firefoxApi.runtime.sendMessage(message);
    return response as TResult;
  },

  async sendToTab<TResult = unknown>(
    tabId: number,
    message: unknown,
    options?: MessageSendOptions
  ): Promise<TResult> {
    const firefoxApi = ensureFirefox();
    const response: unknown = await firefoxApi.tabs.sendMessage(tabId, message, options);
    return response as TResult;
  },

  addListener(listener: MessageListener): () => void {
    const firefoxApi = ensureFirefox();
    messageListeners.add(listener);
    if (registeredFirefoxApi === undefined) {
      firefoxApi.runtime.onMessage.addListener(nativeMessageListener);
      registeredFirefoxApi = firefoxApi;
    }

    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      messageListeners.delete(listener);
      if (messageListeners.size === 0 && registeredFirefoxApi !== undefined) {
        const api = registeredFirefoxApi;
        registeredFirefoxApi = undefined;
        api.runtime.onMessage.removeListener(nativeMessageListener);
      }
    };
  }
};
