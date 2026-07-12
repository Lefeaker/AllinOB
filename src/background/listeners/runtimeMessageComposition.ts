import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { TabsService } from '../../platform/interfaces/tabs';
import type { CaptureVisibleTabScreenshotResponse } from '../../shared/types/videoScreenshotMessages';
import { captureVisibleTabScreenshotForSender } from './visibleTabScreenshot';
import type { RuntimeMessageSender, RuntimeTabContextPayload } from './runtimeMessageContracts';

export function createRuntimeMessageComposition(
  tabs: Pick<TabsService, 'create' | 'get' | 'sendMessage' | 'captureVisibleTab'>,
  runtime: Pick<RuntimeService, 'getURL'>
) {
  return {
    async isOwnerContextActive(owner: RuntimeMessageSender): Promise<boolean> {
      if (owner.tabId === undefined) return false;
      try {
        const tab = await tabs.get(owner.tabId);
        return Boolean(tab && (owner.windowId === undefined || tab.windowId === owner.windowId));
      } catch {
        return false;
      }
    },
    async openOptionsPage(section?: string): Promise<void> {
      const optionsUrl = runtime.getURL('options/index.html');
      const normalizedSection = section?.trim();
      const url = normalizedSection ? `${optionsUrl}#${normalizedSection}` : optionsUrl;
      await tabs.create({ url });
    },
    async getTabContext(sender: RuntimeMessageSender): Promise<RuntimeTabContextPayload> {
      const tabId = typeof sender.tabId === 'number' ? sender.tabId : undefined;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : undefined;
      let windowId = typeof sender.windowId === 'number' ? sender.windowId : undefined;
      if (windowId === undefined && tabId !== undefined) {
        try {
          windowId = (await tabs.get(tabId))?.windowId;
        } catch {
          windowId = undefined;
        }
      }
      return {
        success: true,
        ...(tabId !== undefined ? { tabId } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...(frameId !== undefined ? { frameId } : {})
      };
    },
    async isTabContextActive(owner: RuntimeMessageSender): Promise<RuntimeTabContextPayload> {
      if (owner.tabId === undefined) return { success: true, active: false };
      try {
        const tab = await tabs.get(owner.tabId);
        return {
          success: true,
          active:
            tab !== undefined && (owner.windowId === undefined || tab.windowId === owner.windowId)
        };
      } catch {
        return { success: true, active: false };
      }
    },
    captureVisibleTabScreenshot(
      sender: RuntimeMessageSender
    ): Promise<CaptureVisibleTabScreenshotResponse> {
      return captureVisibleTabScreenshotForSender(tabs, sender);
    }
  };
}
