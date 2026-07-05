import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getRestDefaults } from '../../utils/restDefaults';
import { getTestRestUrls } from '../../fixtures/configTestHelpers';

const REST_DEFAULTS = getRestDefaults();
const DEFAULT_ROOT_URL = withTrailingSlash(
  REST_DEFAULTS.httpsUrl ?? REST_DEFAULTS.baseUrl ?? REST_DEFAULTS.httpUrl
);
const DRAFT_HTTPS_URL = `https://draft.example:${REST_DEFAULTS.httpsPort}/`;
const BODY_STREAM_REUSE_ERROR = ['Body', 'is', 'unusable'].join(' ');
const LOCAL_REST_URLS = getTestRestUrls('localhost');
const LOCAL_HTTPS_URL = LOCAL_REST_URLS.httpsUrl.replace(/\/+$/, '');
const LOCAL_HTTP_URL = LOCAL_REST_URLS.httpUrl.replace(/\/+$/, '');
const LOCAL_CERTIFICATE_URL = new URL(
  '/obsidian-local-rest-api.crt',
  LOCAL_REST_URLS.httpsUrl
).toString();

const getOptionsMock = vi.fn();
const queryPermissionMock = vi.fn();
const trackUsageEventMock = vi.fn();

vi.mock('../../../src/background/store', () => ({
  getOptions: getOptionsMock
}));
vi.mock('../../../src/background/services/analyticsEvents', () => ({
  trackUsageEvent: trackUsageEventMock
}));

vi.mock('../../../src/shared/di', () => ({
  getService: () => ({
    fileSystemAccess: {
      queryPermission: queryPermissionMock
    }
  }),
  TOKENS: {
    platformServices: Symbol('platformServices')
  }
}));

describe('connectionTest pipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    getOptionsMock.mockReset();
    queryPermissionMock.mockReset();
    trackUsageEventMock.mockReset();
    queryPermissionMock.mockResolvedValue('missing');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it('returns success when first candidate passes', async () => {
    const { handleConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(
      createOptions({
        baseUrl: REST_DEFAULTS.baseUrl,
        httpsUrl: REST_DEFAULTS.httpsUrl
      })
    );

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));

    const result = await handleConnectionTest();
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(getDefaultRootUrl());
    expect(getAuthorizationHeader(init)).toBe('Bearer token');
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'connection_test_completed',
      {
        outcome: 'completed',
        storage_target: 'rest_api'
      },
      ['duration_bucket', 'outcome', 'storage_target']
    );
  });

  it('tries multiple candidates until success', async () => {
    const { handleConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(
      createOptions({
        baseUrl: REST_DEFAULTS.baseUrl,
        httpsUrl: REST_DEFAULTS.httpsUrl,
        httpUrl: REST_DEFAULTS.httpUrl
      })
    );

    const fetchMock = setFetchMock();
    const error = Object.assign(new Error('Failed to fetch'), { message: 'Failed to fetch' });
    fetchMock.mockRejectedValueOnce(error);
    fetchMock.mockResolvedValueOnce(createResponse('OK', { status: 200 }));

    const result = await handleConnectionTest();
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = expectFetchCall(fetchMock, 0);
    expect(firstUrl).toBe(getDefaultRootUrl());
  });

  it('applies draft overrides when testing default REST configuration', async () => {
    const { handleConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(
      createOptions({
        baseUrl: 'https://stored.example/',
        httpsUrl: 'https://stored.example/'
      })
    );

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));

    const result = await handleConnectionTest({
      httpsUrl: DRAFT_HTTPS_URL,
      vault: 'DraftVault',
      apiKey: 'draft-token'
    });

    expect(result.success).toBe(true);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash(DRAFT_HTTPS_URL));
    expect(getAuthorizationHeader(init)).toBe('Bearer draft-token');
  });

  it('does not read legacy rootDir when testing default REST configuration', async () => {
    const { handleConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    const options = createOptions({
      baseUrl: 'https://stored.example/',
      httpsUrl: 'https://stored.example/'
    });
    Object.defineProperty(options.rest, 'rootDir', {
      get() {
        throw new Error('rootDir should not be read by connection tests');
      }
    });
    getOptionsMock.mockResolvedValue(options);

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));

    const result = await handleConnectionTest({
      httpsUrl: DRAFT_HTTPS_URL,
      rootDir: 'DraftRoot/',
      vault: 'DraftVault',
      apiKey: 'draft-token'
    } as Parameters<typeof handleConnectionTest>[0] & { rootDir: string });

    expect(result.success).toBe(true);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash(DRAFT_HTTPS_URL));
    expect(getAuthorizationHeader(init)).toBe('Bearer draft-token');
    expect(result.channels).toEqual([
      expect.objectContaining({ channel: 'localFolder' }),
      expect.objectContaining({
        channel: 'https',
        url: withTrailingSlash(DRAFT_HTTPS_URL)
      })
    ]);
    expect(JSON.stringify(result)).not.toContain('rootDir');
    expect(JSON.stringify(result)).not.toContain('DraftRoot');
  });

  it('returns failure summary when all candidates fail', async () => {
    const { handleConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(
      createOptions({
        baseUrl: 'https://service.example.com/',
        httpsUrl: undefined,
        httpUrl: undefined
      })
    );

    const fetchMock = setFetchMock();
    const failure = Object.assign(new Error('Failed to fetch'), { message: 'Failed to fetch' });
    fetchMock.mockRejectedValue(failure);

    const result = await handleConnectionTest();
    expect(result.success).toBe(false);
    expect(result.message).toBe('');
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderFailure' });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionRestFailure',
      values: {
        reason:
          'HTTPS: network error: request failed; HTTP: network error: request failed; HTTP: network error: request failed'
      }
    });
    expect(result.error).toContain('network error');
    expect(result.error).not.toContain(BODY_STREAM_REUSE_ERROR);
  });

  it('returns failure when server responds with non-2xx status', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(
      createResponse('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-auth',
      vault: {
        id: 'vault-auth',
        name: 'Auth Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'Auth',
        apiKey: 'bad-token',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('');
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderFailure' });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionRestFailure',
      values: { reason: 'HTTP error: HTTP 401 - Unauthorized' }
    });
    expect(result.error).toContain('HTTP 401 - Unauthorized');
    expect(result.error).not.toContain(BODY_STREAM_REUSE_ERROR);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash('https://api.example.com'));
    expect(getAuthorizationHeader(init)).toBe('Bearer bad-token');
  });

  it('fails when vault name does not exist on server', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(
      createResponse('Vault not found', { status: 404, statusText: 'Not Found' })
    );

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-missing',
      vault: {
        id: 'vault-missing',
        name: 'Missing Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'Missing',
        apiKey: 'token',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('');
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderFailure' });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionRestFailure',
      values: { reason: 'HTTP error: HTTP 404 - Vault not found' }
    });
    expect(result.error).toContain('HTTP 404 - Vault not found');
    expect(result.error).not.toContain(BODY_STREAM_REUSE_ERROR);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash('https://api.example.com'));
    expect(getAuthorizationHeader(init)).toBe('Bearer token');
  });

  it('fails fast when API key is missing', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-unsaved',
      vault: {
        id: 'vault-unsaved',
        name: 'Unsaved Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'Unsaved',
        apiKey: '',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.messageDescriptor).toEqual({
      key: 'connectionResultHeaderFailure'
    });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionRestApiKeyMissing'
    });
    expect(result.channels).toEqual([
      expect.objectContaining({
        channel: 'localFolder',
        label: 'localFolder',
        configured: false,
        success: false,
        labelDescriptor: {
          key: 'connectionChannelLocalFolderLabel'
        },
        message: '',
        messageDescriptor: {
          key: 'connectionLocalFolderNotConfigured'
        }
      }),
      expect.objectContaining({
        channel: 'https',
        label: 'rest',
        configured: true,
        success: false,
        labelDescriptor: {
          key: 'connectionChannelRestLabel'
        },
        message: '',
        messageDescriptor: {
          key: 'connectionRestApiKeyMissing'
        },
        error: 'config error: API Key is missing',
        errorDescriptor: {
          key: 'connectionRestApiKeyMissing'
        }
      }),
      expect.objectContaining({
        channel: 'http',
        label: 'rest',
        configured: false,
        success: false,
        labelDescriptor: {
          key: 'connectionChannelRestLabel'
        },
        message: '',
        messageDescriptor: {
          key: 'connectionRestUrlMissing',
          values: { label: 'HTTP' }
        }
      })
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'connection_test_completed',
      {
        failure_category: 'validation',
        outcome: 'failed',
        storage_target: 'rest_api'
      },
      ['duration_bucket', 'failure_category', 'outcome', 'storage_target']
    );
  });

  it('tests vault connection using provided config without saving first', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-unsaved',
      vault: {
        id: 'vault-unsaved',
        name: 'Unsaved Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: 'http://api.example.com',
        vault: 'Unsaved',
        apiKey: 'secret',
        isDefault: false
      }
    });

    expect(result.success).toBe(true);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash('https://api.example.com'));
    expect(getAuthorizationHeader(init)).toBe('Bearer secret');
  });

  it('reports unsupported local-folder failures without relying on localized text heuristics', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));
    queryPermissionMock.mockResolvedValue('unsupported');

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-local',
      vault: {
        id: 'vault-local',
        name: 'Local Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'LocalVault',
        apiKey: 'secret',
        localFolderId: 'folder-local',
        localFolderName: 'LocalFolder',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderFailure' });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionLocalFolderUnsupported'
    });
    expect(result.error).toContain('local_folder_unsupported');
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'connection_test_completed',
      {
        failure_category: 'unsupported',
        outcome: 'failed',
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'failure_category', 'outcome', 'storage_target']
    );
  });

  it('returns separate local folder, HTTPS, and HTTP channel results for vault tests', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Failed to fetch'), { message: 'Failed to fetch' })
      )
      .mockResolvedValueOnce(createResponse('OK', { status: 200 }));
    queryPermissionMock.mockResolvedValue('granted');

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-split',
      vault: {
        id: 'vault-split',
        name: 'Split Vault',
        httpsUrl: LOCAL_HTTPS_URL,
        httpUrl: LOCAL_HTTP_URL,
        vault: 'Split',
        apiKey: 'secret',
        localFolderId: 'folder-split',
        localFolderName: 'SplitFolder',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.channels).toEqual([
      expect.objectContaining({
        channel: 'localFolder',
        label: 'localFolder',
        configured: true,
        success: true,
        message: '',
        messageDescriptor: {
          key: 'connectionLocalFolderAvailable',
          values: { folderName: 'SplitFolder' }
        }
      }),
      expect.objectContaining({
        channel: 'https',
        configured: true,
        success: false,
        url: LOCAL_HTTPS_URL,
        certificateUrl: LOCAL_CERTIFICATE_URL
      }),
      expect.objectContaining({
        channel: 'http',
        configured: true,
        success: true,
        url: LOCAL_HTTP_URL
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows vault tests to pass through the local folder channel without REST URLs', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    queryPermissionMock.mockResolvedValue('granted');

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-local-only',
      vault: {
        id: 'vault-local-only',
        name: 'Local Only',
        httpsUrl: '',
        httpUrl: '',
        vault: 'LocalOnly',
        apiKey: '',
        localFolderId: 'folder-local-only',
        localFolderName: 'LocalOnlyFolder',
        isDefault: false
      }
    });

    expect(result.success).toBe(true);
    expect(result.channels).toEqual([
      expect.objectContaining({ channel: 'localFolder', success: true }),
      expect.objectContaining({ channel: 'https', configured: false, success: false }),
      expect.objectContaining({ channel: 'http', configured: false, success: false })
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes local folder permission in a vault connection test when configured', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));
    queryPermissionMock.mockResolvedValue('granted');

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-local',
      vault: {
        id: 'vault-local',
        name: 'Local Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'LocalVault',
        apiKey: 'secret',
        localFolderId: 'folder-local',
        localFolderName: 'LocalFolder',
        isDefault: false
      }
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('');
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderSuccess' });
    expect(result.channels).toEqual([
      expect.objectContaining({
        channel: 'localFolder',
        success: true,
        messageDescriptor: {
          key: 'connectionLocalFolderAvailable',
          values: { folderName: 'LocalFolder' }
        }
      }),
      expect.objectContaining({
        channel: 'https',
        success: true,
        messageDescriptor: {
          key: 'connectionRestSuccess',
          values: { status: 200 }
        }
      }),
      expect.objectContaining({
        channel: 'http',
        configured: false,
        messageDescriptor: {
          key: 'connectionRestUrlMissing',
          values: { label: 'HTTP' }
        }
      })
    ]);
    expect(queryPermissionMock).toHaveBeenCalledWith('folder-local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'connection_test_completed',
      {
        outcome: 'completed',
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'outcome', 'storage_target']
    );
  });

  it('fails a vault connection test when the configured local folder needs reauthorization', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));
    queryPermissionMock.mockResolvedValue('prompt');

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-local',
      vault: {
        id: 'vault-local',
        name: 'Local Vault',
        httpsUrl: 'https://api.example.com',
        httpUrl: '',
        vault: 'LocalVault',
        apiKey: 'secret',
        localFolderId: 'folder-local',
        localFolderName: 'LocalFolder',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('');
    expect(result.messageDescriptor).toEqual({ key: 'connectionResultHeaderFailure' });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionLocalFolderNeedsReauthorization',
      values: { folderName: 'LocalFolder' }
    });
    expect(result.error).toContain('local_folder_reauthorization_required:LocalFolder');
    expectAnalyticsEvent(
      trackUsageEventMock.mock.calls[0],
      'connection_test_completed',
      {
        failure_category: 'permission',
        outcome: 'failed',
        storage_target: 'local_folder'
      },
      ['duration_bucket', 'failure_category', 'outcome', 'storage_target']
    );
  });

  it('tests vault connection using stored configuration when payload has no vault', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(
      createOptions(
        { baseUrl: 'https://default.example/' },
        {
          vaults: [
            {
              id: 'vault-1',
              name: 'Stored Vault',
              httpsUrl: 'https://stored.example.com',
              httpUrl: 'http://stored.example.com',
              vault: 'Stored',
              apiKey: 'stored-token',
              isDefault: false
            }
          ]
        }
      )
    );

    const fetchMock = setFetchMock();
    fetchMock.mockResolvedValue(createResponse('OK', { status: 200 }));

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-1'
    });

    expect(result.success).toBe(true);
    const [url, init] = expectFetchCall(fetchMock, 0);
    expect(url).toBe(withTrailingSlash('https://stored.example.com'));
    expect(getAuthorizationHeader(init)).toBe('Bearer stored-token');
  });

  it('fails when additional vault is missing URLs', async () => {
    const { handleVaultConnectionTest } =
      await import('../../../src/background/pipelines/connectionTest');

    getOptionsMock.mockResolvedValue(createOptions({ baseUrl: 'https://default.example/' }));

    const fetchMock = setFetchMock();

    const result = await handleVaultConnectionTest({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'vault-no-url',
      vault: {
        id: 'vault-no-url',
        name: 'No URL',
        httpsUrl: '',
        httpUrl: '',
        vault: 'NoUrl',
        apiKey: 'token',
        isDefault: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.messageDescriptor).toEqual({
      key: 'connectionResultHeaderFailure'
    });
    expect(result.errorDescriptor).toEqual({
      key: 'connectionNoUsableAddress'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function getDefaultRootUrl(): string {
  return DEFAULT_ROOT_URL;
}

function withTrailingSlash(url: string): string {
  if (!url) {
    return '/';
  }
  return url.replace(/\/+$/, '') + '/';
}

function createOptions(
  restOverrides: Partial<{ baseUrl: string; httpsUrl?: string; httpUrl?: string }>,
  vaultOverrides?: {
    vaults: Array<{
      id: string;
      name: string;
      httpsUrl: string;
      httpUrl: string;
      vault: string;
      apiKey: string;
      isDefault?: boolean;
    }>;
  }
) {
  return {
    rest: {
      baseUrl: restOverrides.baseUrl ?? REST_DEFAULTS.baseUrl,
      httpsUrl: restOverrides.httpsUrl ?? REST_DEFAULTS.httpsUrl,
      httpUrl: restOverrides.httpUrl ?? REST_DEFAULTS.httpUrl,
      apiKey: 'token',
      vault: REST_DEFAULTS.vault
    },
    vaultRouter: vaultOverrides ?? { vaults: [] }
  } as const;
}

type FetchParams = [input: RequestInfo | URL, init?: RequestInit];

function setFetchMock() {
  const fetchMock = vi.fn<(...args: FetchParams) => Promise<Response>>();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function createResponse(body: string, init: ResponseInit & { status: number }): Response {
  return new Response(body, init);
}

type FetchMock = ReturnType<typeof setFetchMock>;

function expectFetchCall(mock: FetchMock, index: number): FetchParams {
  const call = mock.mock.calls[index];
  expect(call).toBeDefined();
  return call as FetchParams;
}

function getAuthorizationHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get('Authorization') ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === 'authorization');
    return match?.[1];
  }
  if (isHeaderRecord(headers)) {
    return headers.Authorization ?? headers.authorization;
  }
  return undefined;
}

function isHeaderRecord(headers: HeadersInit): headers is Record<string, string> {
  return (
    typeof headers === 'object' &&
    headers !== null &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
  );
}

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
