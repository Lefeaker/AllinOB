import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServiceMock = vi.hoisted(() => vi.fn());
const handleErrorMock = vi.hoisted(() =>
  vi.fn<
    (
      error: {
        domain?: string;
        message?: string;
        context?: {
          endpoint?: string;
          vault?: string;
          method?: string;
          filePath?: string;
        };
        cause?: Error;
      },
      options?: { suppressNotifications?: boolean }
    ) => Promise<void>
  >(() => Promise.resolve(undefined))
);
const trackUsageEventMock = vi.hoisted(() => vi.fn());

vi.mock('@shared/di', () => ({
  getService: getServiceMock
}));
vi.mock('@shared/errors', () => ({
  ErrorSeverity: {
    ERROR: 'error'
  },
  handleError: handleErrorMock
}));
vi.mock('../../../src/background/services/analyticsEvents', () => ({
  trackUsageEvent: trackUsageEventMock
}));

const FORBIDDEN_ANALYTICS_KEYS = new Set([
  'apiKey',
  'baseUrl',
  'duration_ms',
  'endpoint',
  'fallback_reason',
  'failure_count_bucket',
  'filePath',
  'folderId',
  'folderName',
  'localFolderName',
  'noteName',
  'permission_state',
  'response',
  'responseBody',
  'success_count_bucket',
  'test_scope',
  'vault',
  'vaultName',
  'vault_count_bucket'
]);

interface TestUserMessageDescriptor {
  key?: string;
  values?: {
    folderName?: string;
  };
  fallback?: string;
}

interface TestWriteError {
  code?: string;
  userMessage?: string;
  userMessageDescriptor?: TestUserMessageDescriptor;
}

describe('obsidianWriter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('writes markdown through the injected rest client with mapped connection fields', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    getServiceMock.mockReturnValue({ restClient: { writeFile: writeFileMock } });

    const { writeMarkdownToVault } =
      await import('../../../src/background/services/obsidianWriter');
    await writeMarkdownToVault(
      {
        baseUrl: 'https://vault.example',
        httpsUrl: 'https://vault.example',
        httpUrl: 'http://vault.example',
        vault: 'Main',
        apiKey: 'secret'
      },
      'Articles/test.md',
      '# Hello'
    );

    expect(writeFileMock).toHaveBeenCalledWith(
      {
        baseUrl: 'https://vault.example',
        httpsUrl: 'https://vault.example',
        httpUrl: 'http://vault.example',
        vault: 'Main',
        apiKey: 'secret'
      },
      'Articles/test.md',
      '# Hello',
      { contentType: 'text/markdown; charset=utf-8' }
    );
  });

  it('propagates rest client write failures', async () => {
    const error = new Error('network failed');
    const writeFileMock = vi.fn(() => Promise.reject(error));
    getServiceMock.mockReturnValue({ restClient: { writeFile: writeFileMock } });

    const { writeMarkdownToVault } =
      await import('../../../src/background/services/obsidianWriter');

    await expect(
      writeMarkdownToVault(
        {
          baseUrl: 'https://vault.example',
          vault: 'Main',
          apiKey: 'secret'
        } as never,
        'Articles/test.md',
        '# Hello'
      )
    ).rejects.toThrow('network failed');

    const firstHandleErrorCall = handleErrorMock.mock.calls.at(0);
    expect(firstHandleErrorCall?.[0]).toMatchObject({
      domain: 'rest',
      message: 'Failed to write file to vault: Articles/test.md',
      context: {
        endpoint: 'https://vault.example',
        vault: 'Main',
        method: 'PUT',
        filePath: 'Articles/test.md'
      },
      cause: error
    });
    expect(handleErrorMock).toHaveBeenCalledWith(expect.anything(), {
      suppressNotifications: true
    });
  });

  it('passes through fallback connection fields when optional urls are absent', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    getServiceMock.mockReturnValue({ restClient: { writeFile: writeFileMock } });

    const { writeMarkdownToVault } =
      await import('../../../src/background/services/obsidianWriter');
    await writeMarkdownToVault(
      {
        baseUrl: 'http://fallback.example',
        vault: 'Inbox',
        apiKey: 'secret'
      } as never,
      'Inbox/test.md',
      'content'
    );

    expect(writeFileMock).toHaveBeenCalledWith(
      {
        baseUrl: 'http://fallback.example',
        vault: 'Inbox',
        apiKey: 'secret'
      },
      'Inbox/test.md',
      'content',
      { contentType: 'text/markdown; charset=utf-8' }
    );
  });

  it('decodes serialized attachment content into blobs for binary and legacy inputs', async () => {
    const { serializedAttachmentContentToBlob } =
      await import('../../../src/shared/attachments/clipAttachmentBinary');

    const binaryBlob = serializedAttachmentContentToBlob(
      {
        kind: 'base64',
        binary: {
          encoding: 'base64',
          data: 'YWFh',
          byteLength: 3
        }
      },
      'image/jpeg'
    );
    const legacyBlob = serializedAttachmentContentToBlob(
      {
        kind: 'legacyDataUrl',
        dataUrl: 'data:image/png;base64,YmJi'
      },
      'image/png'
    );

    expect(binaryBlob.type).toBe('image/jpeg');
    await expect(binaryBlob.text()).resolves.toBe('aaa');
    expect(legacyBlob.type).toBe('image/png');
    await expect(legacyBlob.text()).resolves.toBe('bbb');
  });

  it('throws deterministic errors for invalid serialized attachment content', async () => {
    const { serializedAttachmentContentToBlob } =
      await import('../../../src/shared/attachments/clipAttachmentBinary');

    expect(() =>
      serializedAttachmentContentToBlob(
        {
          kind: 'base64',
          binary: {
            encoding: 'base64',
            data: '%%%bad%%%',
            byteLength: 3
          }
        },
        'image/jpeg'
      )
    ).toThrow('Invalid base64 attachment content.');

    expect(() =>
      serializedAttachmentContentToBlob(
        {
          kind: 'legacyDataUrl',
          dataUrl: 'not-a-data-url'
        },
        'image/jpeg'
      )
    ).toThrow('Invalid attachment data URL.');
  });

  it('creates a local write session and writes every file to the same target-root path policy', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    const queryPermissionMock = vi.fn(() => Promise.resolve('granted'));
    const ensurePermissionMock = vi.fn(() => Promise.resolve('granted'));
    const writeLocalFileMock = vi.fn(() => Promise.resolve(undefined));
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: ensurePermissionMock,
        writeFile: writeLocalFileMock
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession({
      baseUrl: 'https://vault.example',
      vault: 'Main',
      apiKey: 'secret',
      localFolderId: 'folder-main',
      localFolderName: 'Main'
    });
    const attachmentBlob = new Blob(['png-data'], { type: 'image/png' });

    await session.writeAttachment(
      'Main/Articles/assets/test/image.png',
      attachmentBlob,
      'image/png'
    );
    await session.writeMarkdown('Main/Articles/test.md', '# Hello');

    expect(session.target).toEqual({
      storageTarget: 'local-folder',
      localFolderName: 'Main'
    });
    expect(queryPermissionMock).toHaveBeenCalledTimes(1);
    expect(queryPermissionMock).toHaveBeenCalledWith('folder-main');
    expect(ensurePermissionMock).not.toHaveBeenCalled();
    expect(writeLocalFileMock).toHaveBeenNthCalledWith(1, {
      folderId: 'folder-main',
      filePath: 'Articles/assets/test/image.png',
      content: attachmentBlob,
      contentType: 'image/png'
    });
    expect(writeLocalFileMock).toHaveBeenNthCalledWith(2, {
      folderId: 'folder-main',
      filePath: 'Articles/test.md',
      content: '# Hello',
      contentType: 'text/markdown; charset=utf-8'
    });
    expect(writeFileMock).not.toHaveBeenCalled();
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'vault_write_completed',
      {
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'storage_target']
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[1],
      'vault_write_completed',
      {
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'storage_target']
    );
  });

  it('preserves case-mismatched and repeated vault-like prefixes for local sessions', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    const queryPermissionMock = vi.fn(() => Promise.resolve('granted'));
    const writeLocalFileMock = vi.fn(() => Promise.resolve(undefined));
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: vi.fn(() => Promise.resolve('granted')),
        writeFile: writeLocalFileMock
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession({
      baseUrl: 'https://vault.example',
      vault: 'Main',
      apiKey: 'secret',
      localFolderId: 'folder-main',
      localFolderName: 'Main'
    } as never);

    await session.writeMarkdown('main/Articles/test.md', '# case mismatch');
    await session.writeMarkdown('Main/Main/Articles/test.md', '# repeated');

    expect(writeLocalFileMock).toHaveBeenNthCalledWith(1, {
      folderId: 'folder-main',
      filePath: 'main/Articles/test.md',
      content: '# case mismatch',
      contentType: 'text/markdown; charset=utf-8'
    });
    expect(writeLocalFileMock).toHaveBeenNthCalledWith(2, {
      folderId: 'folder-main',
      filePath: 'Main/Articles/test.md',
      content: '# repeated',
      contentType: 'text/markdown; charset=utf-8'
    });
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('falls back to REST with the same target-root path when local preflight is denied', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    const queryPermissionMock = vi.fn(() => Promise.resolve('denied'));
    const ensurePermissionMock = vi.fn(() => Promise.resolve('denied'));
    const writeLocalFileMock = vi.fn(() => Promise.resolve(undefined));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: ensurePermissionMock,
        writeFile: writeLocalFileMock
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession({
      baseUrl: 'https://vault.example',
      vault: 'Main',
      apiKey: 'secret',
      localFolderId: 'folder-main',
      localFolderName: 'Main'
    } as never);
    const attachmentBlob = new Blob(['png-data'], { type: 'image/png' });

    await session.writeAttachment(
      'Main/Articles/assets/test/image.png',
      attachmentBlob,
      'image/png'
    );
    await session.writeMarkdown('Main/Articles/test.md', '# Hello');

    expect(session.target).toEqual({
      storageTarget: 'rest-api',
      localFolderName: 'Main',
      fallbackReason: 'permission-denied'
    });
    expect(writeLocalFileMock).not.toHaveBeenCalled();
    expect(ensurePermissionMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[obsidianWriter] Local vault unavailable before writing; using REST:',
      'denied'
    );
    expect(writeFileMock).toHaveBeenNthCalledWith(
      1,
      {
        baseUrl: 'https://vault.example',
        vault: 'Main',
        apiKey: 'secret'
      },
      'Articles/assets/test/image.png',
      attachmentBlob,
      { contentType: 'image/png' }
    );
    expect(writeFileMock).toHaveBeenNthCalledWith(
      2,
      {
        baseUrl: 'https://vault.example',
        vault: 'Main',
        apiKey: 'secret'
      },
      'Articles/test.md',
      '# Hello',
      { contentType: 'text/markdown; charset=utf-8' }
    );
    expect(trackUsageEventMock).not.toHaveBeenCalledWith(
      'local_vault_permission_prompted',
      expect.anything()
    );
    expect(trackUsageEventMock).not.toHaveBeenCalledWith(
      'local_vault_permission_resolved',
      expect.anything()
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'vault_write_completed',
      {
        storage_target: 'rest_api'
      },
      ['duration_bucket', 'storage_target']
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[1],
      'vault_write_completed',
      {
        storage_target: 'rest_api'
      },
      ['duration_bucket', 'storage_target']
    );
  });

  it('fails the session without REST fallback when local writing fails after preflight succeeds', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    const queryPermissionMock = vi.fn(() => Promise.resolve('granted'));
    const ensurePermissionMock = vi.fn(() => Promise.resolve('granted'));
    const writeLocalFileMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'));
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: ensurePermissionMock,
        writeFile: writeLocalFileMock
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession({
      baseUrl: 'https://vault.example',
      vault: 'Main',
      apiKey: 'secret',
      localFolderId: 'folder-main',
      localFolderName: 'Main'
    } as never);
    const attachmentBlob = new Blob(['png-data'], { type: 'image/png' });

    await session.writeAttachment('Articles/assets/test/image.png', attachmentBlob, 'image/png');
    const writeError = await session.writeMarkdown('Articles/test.md', '# Hello').then(
      () => null,
      (error: TestWriteError) => error
    );
    expect(writeError).toMatchObject({
      code: 'LOCAL_VAULT_WRITE_FAILED',
      userMessageDescriptor: {
        key: 'localVaultWriteFailed',
        values: { folderName: 'Main' }
      }
    });
    expect(writeError?.userMessage).toBeUndefined();
    expect(writeError?.userMessageDescriptor?.fallback).toBeUndefined();
    expect(writeFileMock).not.toHaveBeenCalled();
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'vault_write_completed',
      {
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'storage_target']
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[1],
      'vault_write_failed',
      {
        failure_category: 'write',
        storage_target: 'local_folder'
      },
      ['failure_category', 'storage_target']
    );
  });

  it('uses current-page reauthorization when local permission is prompt before writing', async () => {
    const writeFileMock = vi.fn(() => Promise.resolve(undefined));
    const queryPermissionMock = vi
      .fn()
      .mockResolvedValueOnce('prompt')
      .mockResolvedValueOnce('granted');
    const requestPermissionMock = vi.fn(() =>
      Promise.resolve({
        action: 'granted' as const,
        permissionState: 'granted' as const
      })
    );
    const writeLocalFileMock = vi.fn(() => Promise.resolve(undefined));
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: vi.fn(() => Promise.resolve('granted')),
        writeFile: writeLocalFileMock
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession(
      {
        baseUrl: 'https://vault.example',
        vault: 'Main',
        apiKey: 'secret',
        localFolderId: 'folder-main',
        localFolderName: 'Main'
      } as never,
      { requestLocalVaultPermission: requestPermissionMock }
    );

    await session.writeMarkdown('Articles/test.md', '# Hello');

    expect(requestPermissionMock).toHaveBeenCalledWith({
      folderId: 'folder-main',
      folderName: 'Main',
      vaultName: 'Main'
    });
    expect(session.target).toEqual({
      storageTarget: 'local-folder',
      localFolderName: 'Main'
    });
    expect(writeLocalFileMock).toHaveBeenCalledWith({
      folderId: 'folder-main',
      filePath: 'Articles/test.md',
      content: '# Hello',
      contentType: 'text/markdown; charset=utf-8'
    });
    expect(writeFileMock).not.toHaveBeenCalled();
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'local_vault_permission_prompted',
      {
        source: 'clip'
      },
      ['source']
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[1],
      'local_vault_permission_resolved',
      {
        outcome: 'completed'
      },
      ['outcome']
    );
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[2],
      'vault_write_completed',
      {
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'storage_target']
    );
  });

  it('reports local reauthorization when permission is prompt and REST fallback fails', async () => {
    const restError = new Error('rest offline');
    const writeFileMock = vi.fn(() => Promise.reject(restError));
    const queryPermissionMock = vi.fn(() => Promise.resolve('prompt'));
    const ensurePermissionMock = vi.fn(() => Promise.resolve('prompt'));
    getServiceMock.mockReturnValue({
      restClient: { writeFile: writeFileMock },
      fileSystemAccess: {
        queryPermission: queryPermissionMock,
        ensurePermission: ensurePermissionMock,
        writeFile: vi.fn()
      }
    });

    const { createVaultWriteSession } =
      await import('../../../src/background/services/obsidianWriter');
    const session = await createVaultWriteSession({
      baseUrl: 'https://vault.example',
      vault: 'Main',
      apiKey: 'secret',
      localFolderId: 'folder-main',
      localFolderName: 'Main'
    } as never);

    expect(session.target).toEqual({
      storageTarget: 'rest-api',
      localFolderName: 'Main',
      fallbackReason: 'write-preflight-failed'
    });
    const writeError = await session.writeMarkdown('Articles/test.md', '# Hello').then(
      () => null,
      (error: TestWriteError) => error
    );
    expect(writeError).toMatchObject({
      code: 'LOCAL_VAULT_REAUTH_REQUIRED',
      userMessageDescriptor: {
        key: 'localVaultWriteReauthorizationRequired',
        values: { folderName: 'Main' }
      }
    });
    expect(writeError?.userMessage).toBeUndefined();
    expect(writeError?.userMessageDescriptor?.fallback).toBeUndefined();
    expect(writeFileMock).toHaveBeenCalled();
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'vault_write_failed',
      {
        failure_category: 'connection',
        storage_target: 'rest_api'
      },
      ['failure_category', 'storage_target']
    );
  });

  it.each([
    ['missing', 'folder-missing'],
    ['unsupported', 'unsupported']
  ] as const)(
    'falls back to REST and emits safe analytics when local preflight is %s',
    async (permission, fallbackReason) => {
      const writeFileMock = vi.fn(() => Promise.resolve(undefined));
      getServiceMock.mockReturnValue({
        restClient: { writeFile: writeFileMock },
        fileSystemAccess: {
          queryPermission: vi.fn(() => Promise.resolve(permission)),
          ensurePermission: vi.fn(() => Promise.resolve(permission)),
          writeFile: vi.fn()
        }
      });

      const { createVaultWriteSession } =
        await import('../../../src/background/services/obsidianWriter');
      const session = await createVaultWriteSession({
        baseUrl: 'https://vault.example',
        vault: 'Main',
        apiKey: 'secret',
        localFolderId: 'folder-main',
        localFolderName: 'Main'
      } as never);

      await session.writeMarkdown('Articles/test.md', '# Hello');

      expect(session.target).toEqual({
        storageTarget: 'rest-api',
        localFolderName: 'Main',
        fallbackReason
      });
      expectAnalyticsEvent(
        trackUsageEventMock.mock.calls[0],
        'vault_write_completed',
        {
          storage_target: 'rest_api'
        },
        ['duration_bucket', 'storage_target']
      );
    }
  );

  it('emits safe failure analytics when REST writes fail', async () => {
    const error = new Error('network failed');
    const writeFileMock = vi.fn(() => Promise.reject(error));
    getServiceMock.mockReturnValue({ restClient: { writeFile: writeFileMock } });

    const { writeMarkdownToVault } =
      await import('../../../src/background/services/obsidianWriter');

    await expect(
      writeMarkdownToVault(
        {
          baseUrl: 'https://vault.example',
          vault: 'Main',
          apiKey: 'secret'
        } as never,
        'Articles/test.md',
        '# Hello'
      )
    ).rejects.toThrow('network failed');

    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'vault_write_failed',
      {
        failure_category: 'connection',
        storage_target: 'rest_api'
      },
      ['failure_category', 'storage_target']
    );
  });
});

function expectAnalyticsEvent(
  call: unknown[],
  expectedEvent: string,
  expectedParams: Record<string, unknown>,
  allowedKeys: string[]
): void {
  expect(call[0]).toBe(expectedEvent);
  expect(call[1]).toEqual(expect.objectContaining(expectedParams));
  const params = call[1] as Record<string, unknown>;
  expect(Object.keys(params).sort()).toEqual([...allowedKeys].sort());
  Object.keys(params).forEach((key) => {
    expect(FORBIDDEN_ANALYTICS_KEYS.has(key)).toBe(false);
  });
}
