import type { MessageListener, MessagingService } from '../../platform/interfaces/messaging';
import type { ActiveSelectionInfo, SelectionSnapshot } from './contentSelectionTracker';
import {
  isLocalVaultPermissionPromptMessage,
  isSupportPromptMessage
} from './contentMessageGuards';
import {
  handleContentAction,
  requestLocalVaultPermission,
  showSupportPrompt,
  type ClipMode,
  type LocalVaultPermissionPromptLike,
  type SupportPromptLike,
  type VideoSelectionController,
  type VideoSessionLike
} from './contentMessageHandlers';

export interface CreateContentMessageRouterOptions {
  readonly document: Document;
  readonly window: Window;
  readonly messaging: Pick<MessagingService, 'addListener' | 'send'>;
  readonly supportPrompt: SupportPromptLike;
  readonly localVaultPermissionPrompt: LocalVaultPermissionPromptLike;
  readonly setClipMode: (mode: ClipMode) => void;
  readonly runClip: () => void;
  readonly selectionController: VideoSelectionController;
  readonly createVideoSession: () => VideoSessionLike;
  readonly isVideoSessionActive: () => boolean;
  readonly getVideoSession: () => VideoSessionLike | null;
  readonly resolveActiveSelection: () => ActiveSelectionInfo | null;
  readonly restoreSelectionFromSnapshot: (
    snapshot: SelectionSnapshot | null
  ) => ActiveSelectionInfo | null;
  readonly getLastSelectionSnapshot: () => SelectionSnapshot | null;
  readonly clearLastSelectionSnapshot: () => void;
}

export interface ContentMessageRouter {
  attach(): () => void;
  handleMessage: MessageListener;
}

export function createContentMessageRouter(
  options: CreateContentMessageRouterOptions
): ContentMessageRouter {
  const { messaging, supportPrompt, localVaultPermissionPrompt } = options;

  const handleMessage: MessageListener = (rawMessage) => {
    if (!rawMessage || typeof rawMessage !== 'object') {
      return;
    }

    if (isSupportPromptMessage(rawMessage)) {
      showSupportPrompt(supportPrompt, rawMessage);
      return;
    }

    if (isLocalVaultPermissionPromptMessage(rawMessage)) {
      return requestLocalVaultPermission(localVaultPermissionPrompt, rawMessage);
    }

    return handleContentAction(options, rawMessage as Record<string, unknown>);
  };

  return {
    attach: () => messaging.addListener(handleMessage),
    handleMessage
  };
}
