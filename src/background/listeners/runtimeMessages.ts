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
import type { ClipPayload } from '../../shared/types';
import type { MessagePayload } from '../../platform/interfaces/messaging';
import { isObjectRecord } from '../../shared/guards/object';
import {
  CAPTURE_VISIBLE_TAB_SCREENSHOT_MESSAGE,
  type CaptureVisibleTabScreenshotResponse
} from '../../shared/types/videoScreenshotMessages';
import {
  createBackgroundVideoScreenshotCacheHandler as createScreenshotCacheHandler,
  type BackgroundVideoScreenshotCacheHandler
} from '../services/videoScreenshotCacheService';
import type { BackgroundVideoScreenshotCachePolicyInput } from '../services/videoScreenshotCachePolicyRuntime';
import { defaultRestoreCapabilityPolicyProvider } from '../../shared/capabilities/capabilityPolicy';
import type { StorageService } from '../../platform/interfaces/storage';
import {
  isGetTabContextMessage,
  isOpenOptionsPageMessage,
  isTabContextActiveMessage,
  toRuntimeMessageSender,
  type RuntimeMessageSender,
  type RuntimeTabContextPayload
} from './runtimeMessageContracts';
import { createRuntimeMessageComposition } from './runtimeMessageComposition';

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
  runtime: Parameters<typeof createRuntimeMessageComposition>[1],
  storage: Pick<StorageService, 'local'>,
  restoreStoragePolicyProvider: BackgroundVideoScreenshotCachePolicyInput = defaultRestoreCapabilityPolicyProvider
): RuntimeMessageListenerDependencies {
  const composition = createRuntimeMessageComposition(tabs, runtime);
  return {
    messaging,
    clipPipeline: createClipPipelineDependencies(tabs),
    handleVideoScreenshotCacheMessage: createScreenshotCacheHandler(
      storage,
      restoreStoragePolicyProvider,
      {
        isOwnerContextActive: (owner) => composition.isOwnerContextActive(owner)
      }
    ),
    openOptionsPage: (section) => composition.openOptionsPage(section),
    getTabContext: (sender) => composition.getTabContext(sender),
    isTabContextActive: (owner) => composition.isTabContextActive(owner),
    captureVisibleTabScreenshot: (sender) => composition.captureVisibleTabScreenshot(sender)
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

    const screenshotCacheResponse = await dependencies.handleVideoScreenshotCacheMessage(
      message,
      toRuntimeMessageSender(sender)
    );
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
