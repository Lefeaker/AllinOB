import type { Options } from '../store';
import type { RestClient, RestConnection } from '../../shared/interfaces/restClient';
import { getService } from '../../shared/di';
import { TOKENS } from '../../shared/di/tokens';
import type { PlatformServices } from '../../platform/types';
import { ErrorSeverity, handleError, type AppError } from '../../shared/errors';
import { restErrors } from '../../shared/errors/restErrors';
import type { UserVisibleMessageDescriptor } from '../../shared/i18n/userVisibleMessageDescriptor';
import type { LocalVaultPermissionState } from '../../platform/interfaces/fileSystemAccess';
import { normalizeLocalFolderWritePath } from '../../shared/paths/vaultWritePath';
import {
  trackLocalVaultPermissionPrompted,
  trackLocalVaultPermissionResolved,
  trackVaultWriteCompleted,
  trackVaultWriteFailed
} from './vaultWriteAnalytics';

export type VaultStorageTarget = 'local-folder' | 'rest-api';
export type LocalVaultFallbackReason =
  | 'permission-denied'
  | 'folder-missing'
  | 'unsupported'
  | 'write-preflight-failed';

export interface VaultWriteTargetInfo {
  storageTarget: VaultStorageTarget;
  localFolderName?: string;
  fallbackReason?: LocalVaultFallbackReason;
}

export interface VaultWriteSession {
  target: VaultWriteTargetInfo;
  writeMarkdown(filePath: string, markdown: string): Promise<void>;
  writeAttachment(filePath: string, content: BodyInit | Blob, mimeType: string): Promise<void>;
}

export interface LocalVaultPermissionPromptRequest {
  folderId: string;
  folderName?: string;
  vaultName?: string;
}

export interface LocalVaultPermissionPromptResult {
  action: 'granted' | 'use-rest' | 'cancelled';
  permissionState?: LocalVaultPermissionState;
  persistRest?: boolean;
  errorMessage?: string;
}

export interface VaultWriteSessionOptions {
  requestLocalVaultPermission?: (
    request: LocalVaultPermissionPromptRequest
  ) => Promise<LocalVaultPermissionPromptResult>;
}

type LocalVaultUserMessageKey = 'localVaultWriteFailed' | 'localVaultWriteReauthorizationRequired';

function getObsidianRestClient(): RestClient {
  return getService<PlatformServices>(TOKENS.platformServices).restClient;
}

function resolvePlatformServicesFromDi(): PlatformServices {
  return getService<PlatformServices>(TOKENS.platformServices);
}

export async function writeMarkdownToVault(
  rest: Options['rest'],
  filePath: string,
  markdown: string
): Promise<void> {
  const session = await createVaultWriteSession(rest);
  await session.writeMarkdown(filePath, markdown);
}

export async function writeAttachmentToVault(
  rest: Options['rest'],
  filePath: string,
  content: BodyInit | Blob,
  mimeType: string
): Promise<void> {
  const session = await createVaultWriteSession(rest);
  await session.writeAttachment(filePath, content, mimeType);
}

export async function createVaultWriteSession(
  rest: Options['rest'],
  options: VaultWriteSessionOptions = {}
): Promise<VaultWriteSession> {
  const platform = resolvePlatformServicesFromDi();
  const restClient = platform.restClient ?? getObsidianRestClient();
  const connection = toRestConnection(rest);

  if (!rest.localFolderId) {
    return createRestWriteSession(restClient, connection, { storageTarget: 'rest-api' });
  }

  try {
    const permission = await platform.fileSystemAccess.queryPermission(rest.localFolderId);
    if (permission === 'granted') {
      return createLocalWriteSession(platform, rest, {
        storageTarget: 'local-folder',
        ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {})
      });
    }

    if (permission === 'prompt' && options.requestLocalVaultPermission) {
      trackLocalVaultPermissionPrompted();
      const reauthResult = await options.requestLocalVaultPermission({
        folderId: rest.localFolderId,
        ...(rest.localFolderName ? { folderName: rest.localFolderName } : {}),
        ...(rest.vault ? { vaultName: rest.vault } : {})
      });
      if (reauthResult.action === 'granted') {
        const verified = await platform.fileSystemAccess.queryPermission(rest.localFolderId);
        if (verified === 'granted') {
          trackLocalVaultPermissionResolved('completed');
          return createLocalWriteSession(platform, rest, {
            storageTarget: 'local-folder',
            ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {})
          });
        }
        trackLocalVaultPermissionResolved('failed');
        console.warn(
          '[obsidianWriter] Local vault reauthorization did not verify as granted; using REST:',
          verified
        );
        return createRestWriteSession(restClient, connection, {
          storageTarget: 'rest-api',
          ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {}),
          fallbackReason: mapPermissionFallbackReason(verified)
        });
      }

      const fallbackPermission = reauthResult.permissionState ?? permission;
      trackLocalVaultPermissionResolved(
        reauthResult.action === 'cancelled' ? 'cancelled' : 'failed'
      );
      console.warn(
        '[obsidianWriter] Local vault reauthorization was not granted; using REST:',
        fallbackPermission
      );
      return createRestWriteSession(restClient, connection, {
        storageTarget: 'rest-api',
        ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {}),
        fallbackReason: mapPermissionFallbackReason(fallbackPermission)
      });
    }

    console.warn(
      '[obsidianWriter] Local vault unavailable before writing; using REST:',
      permission
    );
    return createRestWriteSession(restClient, connection, {
      storageTarget: 'rest-api',
      ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {}),
      fallbackReason: mapPermissionFallbackReason(permission)
    });
  } catch (error) {
    console.warn('[obsidianWriter] Local vault permission preflight failed; using REST:', error);
    return createRestWriteSession(restClient, connection, {
      storageTarget: 'rest-api',
      ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {}),
      fallbackReason: 'write-preflight-failed'
    });
  }
}

function createLocalWriteSession(
  platform: PlatformServices,
  rest: Options['rest'],
  target: VaultWriteTargetInfo
): VaultWriteSession {
  const folderId = rest.localFolderId;
  if (folderId === undefined || folderId.length === 0) {
    throw new Error('Cannot create a local write session without a local folder id.');
  }
  const localFolderId = folderId;

  async function writeLocalFile(
    filePath: string,
    content: BodyInit,
    contentType: string
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const normalizedFilePath = normalizeLocalFolderWritePath(filePath, {
        selectedVaultName: rest.vault
      }).path;
      await platform.fileSystemAccess.writeFile({
        folderId: localFolderId,
        filePath: normalizedFilePath,
        content: normalizeLocalContent(content),
        contentType
      });
      trackVaultWriteCompleted(target, startedAt);
    } catch (error) {
      trackVaultWriteFailed(target, 'write');
      throw createLocalWriteFailedError(rest, filePath, error);
    }
  }

  return {
    target,
    writeMarkdown(filePath: string, markdown: string): Promise<void> {
      return writeLocalFile(filePath, markdown, 'text/markdown; charset=utf-8');
    },
    writeAttachment(filePath: string, content: BodyInit | Blob, mimeType: string): Promise<void> {
      return writeLocalFile(filePath, content, mimeType);
    }
  };
}

function createRestWriteSession(
  restClient: RestClient,
  connection: RestConnection,
  target: VaultWriteTargetInfo
): VaultWriteSession {
  return {
    target,
    writeMarkdown(filePath: string, markdown: string): Promise<void> {
      return writeVaultFile(
        restClient,
        connection,
        target,
        filePath,
        markdown,
        'text/markdown; charset=utf-8'
      );
    },
    writeAttachment(filePath: string, content: BodyInit | Blob, mimeType: string): Promise<void> {
      return writeVaultFile(restClient, connection, target, filePath, content, mimeType);
    }
  };
}

async function writeVaultFile(
  restClient: RestClient,
  connection: RestConnection,
  target: VaultWriteTargetInfo,
  filePath: string,
  content: BodyInit,
  contentType: string
): Promise<void> {
  const startedAt = Date.now();
  const targetFilePath = target.fallbackReason
    ? normalizeLocalFolderWritePath(filePath, { selectedVaultName: connection.vault }).path
    : filePath;
  try {
    await restClient.writeFile(connection, targetFilePath, content, { contentType });
    trackVaultWriteCompleted(target, startedAt);
  } catch (error) {
    trackVaultWriteFailed(target, 'connection');
    await handleError(
      restErrors.requestFailed(
        `Failed to write file to vault: ${targetFilePath}`,
        {
          endpoint: connection.baseUrl,
          vault: connection.vault,
          method: 'PUT',
          filePath: targetFilePath
        },
        { cause: error }
      ),
      { suppressNotifications: true }
    );
    if (target.fallbackReason) {
      throw createLocalFallbackRestFailedError(connection, target, targetFilePath, error);
    }
    throw error;
  }
}

function toRestConnection(rest: Options['rest']): RestConnection {
  return {
    baseUrl: rest.baseUrl,
    vault: rest.vault,
    apiKey: rest.apiKey,
    ...(rest.httpsUrl !== undefined && { httpsUrl: rest.httpsUrl }),
    ...(rest.httpUrl !== undefined && { httpUrl: rest.httpUrl })
  };
}

function mapPermissionFallbackReason(
  permission: LocalVaultPermissionState
): LocalVaultFallbackReason {
  if (permission === 'granted') {
    return 'write-preflight-failed';
  }
  if (permission === 'missing') {
    return 'folder-missing';
  }
  if (permission === 'unsupported') {
    return 'unsupported';
  }
  if (permission === 'prompt') {
    return 'write-preflight-failed';
  }
  return 'permission-denied';
}

function createLocalVaultUserMessage(
  key: LocalVaultUserMessageKey,
  folderName: string
): {
  userMessageDescriptor: UserVisibleMessageDescriptor<LocalVaultUserMessageKey>;
} {
  return {
    userMessageDescriptor: {
      key,
      values: { folderName }
    }
  };
}

function createLocalFallbackRestFailedError(
  connection: RestConnection,
  target: VaultWriteTargetInfo,
  filePath: string,
  cause: unknown
): AppError {
  const folderName = target.localFolderName ?? connection.vault;
  const userVisibleMessage = createLocalVaultUserMessage(
    'localVaultWriteReauthorizationRequired',
    folderName
  );
  return {
    code: 'LOCAL_VAULT_REAUTH_REQUIRED',
    domain: 'background',
    message: `Local vault permission is not granted and REST fallback failed: ${filePath}`,
    ...userVisibleMessage,
    severity: ErrorSeverity.ERROR,
    recoverable: true,
    context: {
      filePath,
      vault: connection.vault,
      localFolderName: folderName,
      fallbackReason: target.fallbackReason
    },
    cause
  };
}

function createLocalWriteFailedError(
  rest: Options['rest'],
  filePath: string,
  cause: unknown
): AppError {
  const folderName = rest.localFolderName ?? rest.vault;
  const userVisibleMessage = createLocalVaultUserMessage('localVaultWriteFailed', folderName);
  return {
    code: 'LOCAL_VAULT_WRITE_FAILED',
    domain: 'background',
    message: `Local vault write failed: ${filePath}`,
    ...userVisibleMessage,
    severity: ErrorSeverity.ERROR,
    recoverable: true,
    context: {
      filePath,
      localFolderName: folderName,
      vault: rest.vault
    },
    cause
  };
}

function normalizeLocalContent(content: BodyInit | Blob): string | Blob | ArrayBuffer | Uint8Array {
  if (
    typeof content === 'string' ||
    content instanceof Blob ||
    content instanceof ArrayBuffer ||
    content instanceof Uint8Array
  ) {
    return content;
  }
  throw new Error('Unsupported local vault content body.');
}
