import {
  createClipPipelineDependencies,
  handleClipResult,
  type ClipPipelineDependencies
} from '../pipelines/clipPipeline';
import { handleConnectionTest, handleVaultConnectionTest } from '../pipelines/connectionTest';
import { toConnectionTestPayload } from './connectionTestPayload';
import { notifyClipFailure, notifyExtractionError } from '../services/notifications';
import {
  isClipErrorMessage,
  isClipResultMessage,
  isTestConnectionMessage,
  isTestVaultConnectionMessage
} from '../../shared/types';
import { ClipPayloadSchema } from '../../shared/schemas';
import { createAnalyticsEventAck, isTrackUsageEventMessage } from '../../shared/types/analytics';
import {
  errorHandler,
  isAppError,
  normalizeToAppError,
  notificationErrors
} from '../../shared/errors';
import { trackActivationMilestoneIfNeeded, trackUsageEvent } from '../services/analyticsEvents';
import {
  processClipPayload,
  readClipProcessingFailureCategory
} from '../application/clipProcessor';
import type { MessagingService } from '../../platform/interfaces/messaging';
import type { TabsService } from '../../platform/interfaces/tabs';
import type { RuntimeService } from '../../platform/interfaces/runtime';
import type { ClipPayload } from '../../shared/types';
import type { MessagePayload } from '../../platform/interfaces/messaging';
import { isObjectRecord } from '../../shared/guards/object';
import {
  CAPTURE_VISIBLE_TAB_SCREENSHOT_MESSAGE,
  type CaptureVisibleTabScreenshotResponse
} from '../../shared/types/videoScreenshotMessages';
import { captureVisibleTabScreenshotForSender } from './visibleTabScreenshot';
import {
  createBackgroundVideoScreenshotCacheHandler as createScreenshotCacheHandler,
  type BackgroundVideoScreenshotCacheHandler
} from '../services/videoScreenshotCacheService';
import {
  defaultRestoreCapabilityPolicyProvider,
  type RestoreCapabilityPolicyProvider
} from '../../shared/capabilities/capabilityPolicy';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts';
import type { StorageService } from '../../platform/interfaces/storage';
import {
  isGetTabContextMessage,
  isOpenOptionsPageMessage,
  isTabContextActiveMessage,
  toRuntimeMessageSender,
  type RuntimeMessageSender,
  type RuntimeTabContextPayload
} from './runtimeMessageContracts';

const INVALID_CLIP_PAYLOAD_ERROR = 'Invalid clip payload received.';
function isRepositoryContentMessage(
  message: unknown,
  type: 'clip' | 'readingClip' | 'videoClip',
  contentField: 'markdown' | 'content'
): message is { data: Record<string, unknown>; type: string } {
  return (
    isObjectRecord(message) &&
    message.type === type &&
    isObjectRecord(message.data) &&
    typeof message.data[contentField] === 'string'
  );
}
function toMessagePayload(value: unknown): MessagePayload {
  return value as MessagePayload;
}
function toReadingClipPayload(data: Record<string, unknown>): unknown {
  return {
    markdown: data.content,
    title: data.title,
    type: 'clipper',
    meta: {
      url: data.url,
      readerMode: true,
      exportMode: data.exportMode
    }
  };
}
function toVideoClipPayload(data: Record<string, unknown>): unknown {
  return {
    markdown: data.content,
    title: data.title,
    type: 'video',
    meta: {
      url: data.url || data.videoUrl,
      sourceUrl: data.videoUrl || data.url,
      platform: data.platform,
      ...(data.attachments ? { attachments: data.attachments } : {}),
      ...(data.exportDestination ? { exportDestination: data.exportDestination } : {})
    }
  };
}

function parseClipPayloadForBoundary(payload: unknown): ClipPayload | null {
  const parsed = ClipPayloadSchema.safeParse(payload);
  return parsed.success ? (parsed.data as ClipPayload) : null;
}

async function processRepositoryClipPayload(payload: unknown): Promise<MessagePayload> {
  const parsedPayload = parseClipPayloadForBoundary(payload);
  if (!parsedPayload) {
    return {
      success: false,
      error: INVALID_CLIP_PAYLOAD_ERROR
    };
  }

  try {
    const result = await processClipPayload(parsedPayload);
    return { success: true, filePath: result.filePath };
  } catch (error) {
    const failureCategory = readClipProcessingFailureCategory(error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(failureCategory ? { failureCategory } : {})
    };
  }
}

export interface RuntimeMessageListenerDependencies {
  messaging: Pick<MessagingService, 'addListener'>;
  clipPipeline: ClipPipelineDependencies;
  openOptionsPage(section?: string): Promise<void>;
  getTabContext(sender: RuntimeMessageSender): Promise<RuntimeTabContextPayload>;
  isTabContextActive(ownerContext: RuntimeMessageSender): Promise<RuntimeTabContextPayload>;
  captureVisibleTabScreenshot(
    sender: RuntimeMessageSender
  ): Promise<CaptureVisibleTabScreenshotResponse>;
  handleVideoScreenshotCacheMessage: BackgroundVideoScreenshotCacheHandler;
}
function resolveActivationMilestone(
  eventName: string
): 'onboarding_completed' | 'first_reader_exported' | 'first_video_exported' | null {
  switch (eventName) {
    case 'onboarding_completed':
      return 'onboarding_completed';
    case 'reader_exported':
      return 'first_reader_exported';
    case 'video_exported':
      return 'first_video_exported';
    default:
      return null;
  }
}
export function createRuntimeMessageListenerDependencies(
  messaging: Pick<MessagingService, 'addListener'>,
  tabs: Pick<TabsService, 'create' | 'get' | 'sendMessage' | 'captureVisibleTab'>,
  runtime: Pick<RuntimeService, 'getURL'>,
  storage: Pick<StorageService, 'local'>,
  restoreStoragePolicyProvider:
    | RestoreCapabilityPolicyProvider
    | SessionDraftStoragePolicy['videoScreenshotCache'] = defaultRestoreCapabilityPolicyProvider
): RuntimeMessageListenerDependencies {
  return {
    messaging,
    clipPipeline: createClipPipelineDependencies(tabs),
    handleVideoScreenshotCacheMessage: createScreenshotCacheHandler(
      storage,
      restoreStoragePolicyProvider
    ),
    async openOptionsPage(section) {
      const optionsUrl = runtime.getURL('options/index.html');
      const normalizedSection = section?.trim();
      const url = normalizedSection ? `${optionsUrl}#${normalizedSection}` : optionsUrl;
      await tabs.create({ url });
    },
    async getTabContext(sender) {
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
    async isTabContextActive(ownerContext) {
      const tabId = typeof ownerContext.tabId === 'number' ? ownerContext.tabId : undefined;
      if (tabId === undefined) {
        return { success: true, active: false };
      }

      try {
        const tab = await tabs.get(tabId);
        const expectedWindowId =
          typeof ownerContext.windowId === 'number' ? ownerContext.windowId : undefined;
        const active =
          tab !== undefined &&
          (expectedWindowId === undefined || tab.windowId === expectedWindowId);
        return { success: true, active };
      } catch {
        return { success: true, active: false };
      }
    },
    captureVisibleTabScreenshot(sender) {
      return captureVisibleTabScreenshotForSender(tabs, sender);
    }
  };
}

async function safeNotifyExtraction(message: string): Promise<void> {
  try {
    await notifyExtractionError(message);
  } catch (error) {
    const appError = notificationErrors.dispatchFailed(
      message,
      { channel: 'clipper.error', title: 'notifyExtractionError' },
      { cause: error }
    );
    await errorHandler.handle(appError, { suppressNotifications: true });
  }
}

async function safeNotifyClipFailure(
  error: Parameters<typeof notifyClipFailure>[0]
): Promise<void> {
  try {
    await notifyClipFailure(error);
  } catch (notifyError) {
    await errorHandler.handle(
      notificationErrors.dispatchFailed(
        typeof error === 'string' ? error : (error.userMessage ?? error.message),
        { channel: 'clipper.error', title: 'notifyClipFailure' },
        { cause: notifyError }
      ),
      { suppressNotifications: true }
    );
  }
}

export function registerRuntimeMessageListener(
  dependencies: RuntimeMessageListenerDependencies
): void {
  dependencies.messaging.addListener(async (message, sender) => {
    // Handle analytics messages before clip result messages so the generic
    // clip branch cannot swallow other payload shapes that also carry `event`.
    if (isTrackUsageEventMessage(message)) {
      await trackUsageEvent(message.event, message.params);
      const activationMilestone = resolveActivationMilestone(message.event);
      if (activationMilestone) {
        void trackActivationMilestoneIfNeeded(activationMilestone);
      }
      return createAnalyticsEventAck();
    }

    if (isGetTabContextMessage(message)) {
      return dependencies.getTabContext(toRuntimeMessageSender(sender));
    }

    if (isTabContextActiveMessage(message)) {
      return dependencies.isTabContextActive(toRuntimeMessageSender(message.ownerContext));
    }

    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === CAPTURE_VISIBLE_TAB_SCREENSHOT_MESSAGE
    ) {
      return dependencies.captureVisibleTabScreenshot(toRuntimeMessageSender(sender));
    }

    const screenshotCacheResponse = await dependencies.handleVideoScreenshotCacheMessage(message);
    if (screenshotCacheResponse !== undefined) {
      return toMessagePayload(screenshotCacheResponse);
    }

    if (isRepositoryContentMessage(message, 'clip', 'markdown')) {
      return processRepositoryClipPayload(message.data);
    }

    if (isRepositoryContentMessage(message, 'readingClip', 'content')) {
      return processRepositoryClipPayload(toReadingClipPayload(message.data));
    }

    if (isRepositoryContentMessage(message, 'videoClip', 'content')) {
      return processRepositoryClipPayload(toVideoClipPayload(message.data));
    }

    if (isTestConnectionMessage(message)) {
      return handleConnectionTest(message.rest)
        .then(toConnectionTestPayload)
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: msg,
            errorDescriptor: {
              key: 'connectionRestFailure',
              values: { reason: msg }
            },
            message: '',
            messageDescriptor: {
              key: 'connectionFailureWithReason',
              values: { reason: msg }
            }
          } satisfies MessagePayload;
        });
    }

    if (isTestVaultConnectionMessage(message)) {
      return handleVaultConnectionTest(message)
        .then(toConnectionTestPayload)
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: msg,
            errorDescriptor: {
              key: 'connectionRestFailure',
              values: { reason: msg }
            },
            message: '',
            messageDescriptor: {
              key: 'connectionFailureWithReason',
              values: { reason: msg }
            }
          } satisfies MessagePayload;
        });
    }

    if (isClipErrorMessage(message)) {
      const appError = isAppError(message.error)
        ? message.error
        : normalizeToAppError(message.error, {
            code: 'CONTENT_CLIP_FAILURE',
            domain: 'content',
            userMessageDescriptor: { key: 'clipFailed' }
          });
      await errorHandler.handle(appError, { suppressNotifications: true });
      await safeNotifyClipFailure(appError);
      return;
    }

    if (isClipResultMessage(message)) {
      const parsedPayload = parseClipPayloadForBoundary(message.payload);
      if (!parsedPayload) {
        await safeNotifyExtraction(INVALID_CLIP_PAYLOAD_ERROR);
        return;
      }
      await handleClipResult(
        { ...message, payload: parsedPayload },
        sender.tabId,
        dependencies.clipPipeline
      );
      return;
    }

    if (isOpenOptionsPageMessage(message)) {
      try {
        await dependencies.openOptionsPage(message.section);
        return { success: true };
      } catch (error) {
        console.error('Failed to open options page:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    return undefined;
  });
}
