import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionTestResult } from '../../../src/shared/types/connection';
import type { CaptureVisibleTabScreenshotResponse } from '../../../src/shared/types/videoScreenshotMessages';
import type { VideoScreenshotCacheResponse } from '../../../src/content/video/videoScreenshotCacheMessages';
import type { StorageService } from '../../../src/platform/interfaces/storage';
import type { TabsService } from '../../../src/platform/interfaces/tabs';
import { createSessionDraftStoragePolicy } from '../../../src/content/sessionDrafts';
import { asType } from '../../utils/typeHelpers';

const addListenerMock = vi.hoisted(() => vi.fn());
const handleClipResultMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const createClipPipelineDependenciesMock = vi.hoisted(() =>
  vi.fn(() => ({ sendSupportPrompt: vi.fn(() => Promise.resolve(undefined)) }))
);
const handleConnectionTestMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConnectionTestResult>>(() =>
    Promise.resolve({ success: true, message: 'ok' })
  )
);
const handleVaultConnectionTestMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConnectionTestResult>>(() =>
    Promise.resolve({ success: true, message: 'ok' })
  )
);
const notifyClipFailureMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const notifyExtractionErrorMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const trackUsageEventMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const trackActivationMilestoneIfNeededMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(undefined))
);
const handleErrorMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
const processClipPayloadMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ filePath: 'Video/example.md' }))
);
type UntrustedValue = Parameters<typeof asType>[0];
type FailureCarrier = { failureCategory?: UntrustedValue };
type TabContextSuccess = {
  success: true;
  tabId?: number;
  frameId?: number;
  windowId?: number;
};

function hasFailureCategory(error: object): error is FailureCarrier {
  return 'failureCategory' in error;
}

function readMockFailureCategory(error: UntrustedValue): UntrustedValue {
  return typeof error === 'object' && error !== null && hasFailureCategory(error)
    ? error.failureCategory
    : undefined;
}

const readClipProcessingFailureCategoryMock = vi.hoisted(() =>
  vi.fn((error: UntrustedValue) => readMockFailureCategory(error))
);
const isAppErrorMock = vi.hoisted(() => vi.fn(() => false));
const normalizeToAppErrorMock = vi.hoisted(() =>
  vi.fn((error: UntrustedValue) => ({
    message: String(error),
    userMessage: 'normalized user',
    code: 'CONTENT_CLIP_FAILURE'
  }))
);
const dispatchFailedMock = vi.hoisted(() =>
  vi.fn((_message: string, _meta: UntrustedValue, options: { cause?: UntrustedValue }) => ({
    message: 'dispatch failed',
    cause: options.cause
  }))
);

vi.mock('../../../src/background/pipelines/clipPipeline', () => ({
  createClipPipelineDependencies: createClipPipelineDependenciesMock,
  handleClipResult: handleClipResultMock
}));
vi.mock('../../../src/background/pipelines/connectionTest', () => ({
  handleConnectionTest: handleConnectionTestMock,
  handleVaultConnectionTest: handleVaultConnectionTestMock
}));
vi.mock('../../../src/background/services/notifications', () => ({
  notifyClipFailure: notifyClipFailureMock,
  notifyExtractionError: notifyExtractionErrorMock
}));
vi.mock('../../../src/background/services/analyticsEvents', () => ({
  trackUsageEvent: trackUsageEventMock,
  trackActivationMilestoneIfNeeded: trackActivationMilestoneIfNeededMock
}));
vi.mock('../../../src/background/application/clipProcessor', () => ({
  processClipPayload: processClipPayloadMock,
  readClipProcessingFailureCategory: readClipProcessingFailureCategoryMock
}));
vi.mock('../../../src/shared/errors', () => ({
  errorHandler: { handle: handleErrorMock },
  isAppError: isAppErrorMock,
  normalizeToAppError: normalizeToAppErrorMock,
  notificationErrors: { dispatchFailed: dispatchFailedMock }
}));

describe('runtime message listener', () => {
  let listener:
    | ((
        message: unknown,
        sender: { tabId?: number; frameId?: number; windowId?: number }
      ) => Promise<unknown>)
    | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    processClipPayloadMock.mockResolvedValue({ filePath: 'Video/example.md' });
    readClipProcessingFailureCategoryMock.mockImplementation((error: UntrustedValue) =>
      readMockFailureCategory(error)
    );
    listener = undefined;
    addListenerMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => undefined;
    });
  });

  function createDependencies() {
    return {
      messaging: { addListener: addListenerMock },
      clipPipeline: { sendSupportPrompt: vi.fn(() => Promise.resolve(undefined)) },
      openOptionsPage: vi.fn(() => Promise.resolve(undefined)),
      getTabContext: vi.fn(
        (sender: {
          tabId?: number;
          frameId?: number;
          windowId?: number;
        }): Promise<TabContextSuccess> =>
          Promise.resolve({
            success: true,
            ...(sender.tabId !== undefined ? { tabId: sender.tabId } : {}),
            ...(sender.windowId !== undefined ? { windowId: sender.windowId } : {}),
            ...(sender.frameId !== undefined ? { frameId: sender.frameId } : {})
          })
      ),
      isTabContextActive: vi.fn(
        (ownerContext: { tabId?: number }): Promise<{ success: true; active: boolean }> =>
          Promise.resolve({
            success: true,
            active: ownerContext.tabId === 12
          })
      ),
      captureVisibleTabScreenshot: vi.fn<() => Promise<CaptureVisibleTabScreenshotResponse>>(() =>
        Promise.resolve({
          success: true,
          dataUrl: 'data:image/jpeg;base64,dmlkZW8='
        })
      ),
      handleVideoScreenshotCacheMessage: vi.fn(
        (message: unknown): Promise<VideoScreenshotCacheResponse | undefined> =>
          Promise.resolve(
            typeof message === 'object' &&
              message !== null &&
              'type' in message &&
              message.type === 'AIIOB_VIDEO_SCREENSHOT_CACHE'
              ? { success: true, operation: 'pruneExpired' }
              : undefined
          )
      )
    };
  }

  it('registers listener and returns fallback responses for connection test failures', async () => {
    handleConnectionTestMock.mockRejectedValueOnce(new Error('offline'));
    handleVaultConnectionTestMock.mockRejectedValueOnce('vault down');

    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    expect(addListenerMock).toHaveBeenCalledTimes(1);
    const connection = await listener?.(
      { type: 'TEST_CONNECTION', rest: { baseUrl: 'https://example.com' } },
      {}
    );
    const vault = await listener?.(
      { type: 'TEST_VAULT_CONNECTION', vaultId: 'vault-1', vault: { id: 'vault-1' } },
      {}
    );

    expect(connection).toEqual({
      success: false,
      error: 'offline',
      errorDescriptor: {
        key: 'connectionRestFailure',
        values: { reason: 'offline' }
      },
      message: '',
      messageDescriptor: {
        key: 'connectionFailureWithReason',
        values: { reason: 'offline' }
      }
    });
    expect(vault).toEqual({
      success: false,
      error: 'vault down',
      errorDescriptor: {
        key: 'connectionRestFailure',
        values: { reason: 'vault down' }
      },
      message: '',
      messageDescriptor: {
        key: 'connectionFailureWithReason',
        values: { reason: 'vault down' }
      }
    });
  });

  it('preserves vault connection channel results across the runtime listener boundary', async () => {
    handleVaultConnectionTestMock.mockResolvedValueOnce({
      success: false,
      message: '[Research] 连接失败',
      messageDescriptor: {
        key: 'connection.vault.failed',
        values: { vaultName: 'Research' },
        fallback: '[Research] Connection failed'
      },
      error: 'network error: request failed',
      errorDescriptor: {
        key: 'connection.vault.failedReason',
        values: { reason: 'network error: request failed' },
        fallback: 'network error: request failed'
      },
      channels: [
        {
          channel: 'localFolder',
          label: '本地目录',
          labelDescriptor: {
            key: 'connection.channel.localFolder',
            fallback: 'Local folder'
          },
          configured: true,
          success: true,
          message: '本地目录可用：Research',
          messageDescriptor: {
            key: 'connection.channel.localFolder.success',
            values: { vaultName: 'Research' },
            fallback: 'Local folder ready: Research'
          }
        },
        {
          channel: 'https',
          label: 'HTTPS',
          labelDescriptor: {
            key: 'connection.channel.https',
            fallback: 'HTTPS'
          },
          configured: true,
          success: false,
          message: 'network error: request failed',
          messageDescriptor: {
            key: 'connection.channel.https.failed',
            values: { reason: 'network error: request failed' },
            fallback: 'network error: request failed'
          },
          error: 'network error: request failed',
          errorDescriptor: {
            key: 'connection.channel.https.failed',
            values: { reason: 'network error: request failed' },
            fallback: 'network error: request failed'
          },
          url: 'https://vault.example',
          certificateUrl: 'https://vault.example/obsidian-local-rest-api.crt'
        },
        {
          channel: 'http',
          label: 'HTTP',
          labelDescriptor: {
            key: 'connection.channel.http',
            fallback: 'HTTP'
          },
          configured: true,
          success: true,
          message: 'REST API HTTP 连接成功，状态码: 200',
          messageDescriptor: {
            key: 'connection.channel.http.success',
            values: { status: 200 },
            fallback: 'REST API HTTP connected, status: 200'
          },
          status: 200,
          url: 'http://vault.example'
        }
      ]
    } as ConnectionTestResult);

    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    const response = await listener?.(
      {
        type: 'TEST_VAULT_CONNECTION',
        vaultId: 'research',
        vault: { id: 'research', name: 'Research' }
      },
      {}
    );

    expect(response).toEqual({
      success: false,
      message: '[Research] 连接失败',
      messageDescriptor: {
        key: 'connection.vault.failed',
        values: { vaultName: 'Research' },
        fallback: '[Research] Connection failed'
      },
      error: 'network error: request failed',
      errorDescriptor: {
        key: 'connection.vault.failedReason',
        values: { reason: 'network error: request failed' },
        fallback: 'network error: request failed'
      },
      channels: [
        expect.objectContaining({
          channel: 'localFolder',
          success: true,
          labelDescriptor: {
            key: 'connection.channel.localFolder',
            fallback: 'Local folder'
          },
          messageDescriptor: {
            key: 'connection.channel.localFolder.success',
            values: { vaultName: 'Research' },
            fallback: 'Local folder ready: Research'
          }
        }),
        expect.objectContaining({
          channel: 'https',
          success: false,
          certificateUrl: 'https://vault.example/obsidian-local-rest-api.crt',
          labelDescriptor: {
            key: 'connection.channel.https',
            fallback: 'HTTPS'
          },
          messageDescriptor: {
            key: 'connection.channel.https.failed',
            values: { reason: 'network error: request failed' },
            fallback: 'network error: request failed'
          },
          errorDescriptor: {
            key: 'connection.channel.https.failed',
            values: { reason: 'network error: request failed' },
            fallback: 'network error: request failed'
          }
        }),
        expect.objectContaining({
          channel: 'http',
          success: true,
          status: 200,
          labelDescriptor: {
            key: 'connection.channel.http',
            fallback: 'HTTP'
          },
          messageDescriptor: {
            key: 'connection.channel.http.success',
            values: { status: 200 },
            fallback: 'REST API HTTP connected, status: 200'
          }
        })
      ]
    });
  });

  it('normalizes clip errors and swallows clip failure notification dispatch failures', async () => {
    notifyClipFailureMock.mockRejectedValueOnce(new Error('notify failed'));
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.({ type: 'CLIP_ERROR', error: 'boom' }, { tabId: 7 });

    expect(normalizeToAppErrorMock).toHaveBeenCalledWith(
      'boom',
      expect.objectContaining({ code: 'CONTENT_CLIP_FAILURE' })
    );
    expect(handleErrorMock).toHaveBeenCalledTimes(2);
    expect(dispatchFailedMock).toHaveBeenCalledWith(
      'normalized user',
      expect.objectContaining({ channel: 'clipper.error', title: 'notifyClipFailure' }),
      expect.any(Object)
    );
    const dispatchOptions = dispatchFailedMock.mock.calls[0]?.[2] as
      | { cause?: unknown }
      | undefined;
    expect(dispatchOptions?.cause).toBeInstanceOf(Error);
  });

  it('forwards clip results and allowlisted analytics usage events', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.({ type: 'CLIP_RESULT', payload: { markdown: '# hello' } }, { tabId: 12 });
    await listener?.(
      { type: 'ANALYTICS_EVENT', event: 'support_like_clicked', params: { variant: 'first' } },
      { tabId: 12 }
    );

    expect(handleClipResultMock).toHaveBeenCalledWith(
      { type: 'CLIP_RESULT', payload: { markdown: '# hello' } },
      12,
      expect.any(Object)
    );
    expect(trackUsageEventMock).toHaveBeenCalledWith('support_like_clicked', { variant: 'first' });
  });

  it('returns an explicit ack for analytics runtime messages', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await expect(
      listener?.(
        {
          type: 'ANALYTICS_EVENT',
          event: 'video_exported',
          params: {
            platform: 'youtube',
            destination: 'downloads',
            duration_bucket: '3s_to_9s'
          }
        },
        { tabId: 12 }
      )
    ).resolves.toEqual({ success: true });
    expect(trackUsageEventMock).toHaveBeenCalledWith('video_exported', {
      platform: 'youtube',
      destination: 'downloads',
      duration_bucket: '3s_to_9s'
    });
  });

  it('maps onboarding and export success runtime events to activation milestones', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      {
        type: 'ANALYTICS_EVENT',
        event: 'onboarding_completed',
        params: { duration_bucket: '3s_to_9s' }
      },
      { tabId: 12 }
    );
    await listener?.(
      {
        type: 'ANALYTICS_EVENT',
        event: 'reader_exported',
        params: { destination: 'downloads', duration_bucket: '3s_to_9s' }
      },
      { tabId: 12 }
    );
    await listener?.(
      {
        type: 'ANALYTICS_EVENT',
        event: 'video_exported',
        params: {
          platform: 'bilibili',
          destination: 'downloads',
          duration_bucket: '3s_to_9s'
        }
      },
      { tabId: 12 }
    );

    expect(trackActivationMilestoneIfNeededMock).toHaveBeenNthCalledWith(1, 'onboarding_completed');
    expect(trackActivationMilestoneIfNeededMock).toHaveBeenNthCalledWith(
      2,
      'first_reader_exported'
    );
    expect(trackActivationMilestoneIfNeededMock).toHaveBeenNthCalledWith(3, 'first_video_exported');
  });

  it('keeps legacy analytics runtime message types accepted for one release boundary', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      { type: 'TRACK_USAGE_EVENT', event: 'support_dislike_clicked' },
      { tabId: 12 }
    );
    await listener?.(
      {
        type: 'track',
        event: 'usage_dashboard_increment',
        params: { category: 'ai_chat', increment: 1, total_after: 5 }
      },
      { tabId: 12 }
    );

    expect(trackUsageEventMock).toHaveBeenNthCalledWith(1, 'support_dislike_clicked', undefined);
    expect(trackUsageEventMock).toHaveBeenNthCalledWith(2, 'usage_dashboard_increment', {
      category: 'ai_chat',
      increment: 1,
      total_after: 5
    });
  });

  it('returns sender tab context metadata for content-side owner resolution', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    await expect(
      listener?.({ type: 'AIIOB_GET_TAB_CONTEXT' }, { tabId: 12, windowId: 4, frameId: 0 })
    ).resolves.toEqual({
      success: true,
      tabId: 12,
      windowId: 4,
      frameId: 0
    });
    expect(dependencies.getTabContext).toHaveBeenCalledWith({
      tabId: 12,
      windowId: 4,
      frameId: 0
    });
  });

  it('returns success with omitted tab fields when sender metadata is unavailable', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    await expect(listener?.({ type: 'AIIOB_GET_TAB_CONTEXT' }, {})).resolves.toEqual({
      success: true
    });
  });

  it('reports whether a stored session draft owner tab is still active', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    await expect(
      listener?.(
        {
          type: 'AIIOB_IS_TAB_CONTEXT_ACTIVE',
          ownerContext: { tabId: 12, windowId: 4, frameId: 0 }
        },
        {}
      )
    ).resolves.toEqual({
      success: true,
      active: true
    });
    await expect(
      listener?.(
        {
          type: 'AIIOB_IS_TAB_CONTEXT_ACTIVE',
          ownerContext: { tabId: 99, windowId: 4, frameId: 0 }
        },
        {}
      )
    ).resolves.toEqual({
      success: true,
      active: false
    });
    expect(dependencies.isTabContextActive).toHaveBeenCalledWith({
      tabId: 12,
      windowId: 4,
      frameId: 0
    });
  });

  it('returns a visible-tab screenshot for video frame fallback requests', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    await expect(
      listener?.({ type: 'AIIOB_CAPTURE_VISIBLE_TAB_SCREENSHOT' }, { tabId: 12, windowId: 4 })
    ).resolves.toEqual({
      success: true,
      dataUrl: 'data:image/jpeg;base64,dmlkZW8='
    });
    expect(dependencies.captureVisibleTabScreenshot).toHaveBeenCalledWith({
      tabId: 12,
      windowId: 4
    });
  });

  it('routes video screenshot cache messages through the background cache owner', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    await expect(
      listener?.({ type: 'AIIOB_VIDEO_SCREENSHOT_CACHE', operation: 'pruneExpired' }, {})
    ).resolves.toEqual({
      success: true,
      operation: 'pruneExpired'
    });
    expect(dependencies.handleVideoScreenshotCacheMessage).toHaveBeenCalledWith({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'pruneExpired'
    });
  });

  it('threads the full injected generic screenshot cache policy into the concrete cache owner', async () => {
    const handleVideoScreenshotCacheMessage = vi.fn(
      (message: unknown): Promise<VideoScreenshotCacheResponse | undefined> =>
        Promise.resolve(
          typeof message === 'object' &&
            message !== null &&
            'type' in message &&
            message.type === 'AIIOB_VIDEO_SCREENSHOT_CACHE'
            ? { success: true, operation: 'pruneExpired' }
            : undefined
        )
    );
    const createBackgroundVideoScreenshotCacheHandler = vi.fn(
      () => handleVideoScreenshotCacheMessage
    );
    vi.doMock('../../../src/background/services/videoScreenshotCacheService', () => ({
      createBackgroundVideoScreenshotCacheHandler
    }));
    const storagePolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 123_456,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      videoScreenshotCache: {
        ttlMs: 123_456,
        maxGlobalEntries: 11,
        maxPageEntries: 7,
        maxContentBytes: 256 * 1024
      }
    });
    const storage = asType<Pick<StorageService, 'local'>>({ local: {} });

    try {
      const { createRuntimeMessageListenerDependencies, registerRuntimeMessageListener } =
        await import('../../../src/background/listeners/runtimeMessages');
      const dependencies = createRuntimeMessageListenerDependencies(
        { addListener: addListenerMock },
        asType<Pick<TabsService, 'create' | 'get' | 'sendMessage' | 'captureVisibleTab'>>({
          create: vi.fn(),
          get: vi.fn(),
          sendMessage: vi.fn(),
          captureVisibleTab: vi.fn()
        }),
        { getURL: vi.fn((path: string) => `chrome-extension://${path}`) },
        storage,
        storagePolicy.videoScreenshotCache
      );

      expect(createBackgroundVideoScreenshotCacheHandler).toHaveBeenCalledWith(
        storage,
        storagePolicy.videoScreenshotCache
      );
      registerRuntimeMessageListener(dependencies);
      await expect(
        listener?.({ type: 'AIIOB_VIDEO_SCREENSHOT_CACHE', operation: 'pruneExpired' }, {})
      ).resolves.toEqual({
        success: true,
        operation: 'pruneExpired'
      });
      expect(handleVideoScreenshotCacheMessage).toHaveBeenCalledWith({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'pruneExpired'
      });
    } finally {
      vi.doUnmock('../../../src/background/services/videoScreenshotCacheService');
    }
  });

  it('routes visible-tab screenshot runtime messages through the concrete sender-window capture dependency', async () => {
    const tabs = {
      create: vi.fn(),
      get: vi.fn(() => Promise.resolve({ id: 12, windowId: 6 })),
      sendMessage: vi.fn(),
      captureVisibleTab: vi.fn(() => Promise.resolve('data:image/jpeg;base64,dmlkZW8='))
    };
    const runtime = {
      getURL: vi.fn((path: string) => `chrome-extension://${path}`)
    };
    const { createRuntimeMessageListenerDependencies, registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    const dependencies = createRuntimeMessageListenerDependencies(
      { addListener: addListenerMock },
      asType<Pick<TabsService, 'create' | 'get' | 'sendMessage' | 'captureVisibleTab'>>(tabs),
      runtime,
      asType({ local: {} })
    );
    registerRuntimeMessageListener(dependencies);

    await expect(
      listener?.({ type: 'AIIOB_CAPTURE_VISIBLE_TAB_SCREENSHOT' }, { tabId: 12 })
    ).resolves.toEqual({
      success: true,
      dataUrl: 'data:image/jpeg;base64,dmlkZW8='
    });
    expect(tabs.get).toHaveBeenCalledWith(12);
    expect(tabs.captureVisibleTab).toHaveBeenCalledWith(6, { format: 'jpeg', quality: 88 });
  });

  it('strips unknown clip result payload fields before forwarding to the clip pipeline', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      {
        type: 'CLIP_RESULT',
        payload: {
          markdown: '# hello',
          meta: {
            url: 'https://example.com',
            attachments: [
              {
                id: 'shot-1',
                fileName: 'frame.jpg',
                mimeType: 'image/jpeg',
                dataUrl: 'data:image/jpeg;base64,aaa',
                unsafe: true
              }
            ],
            exportDestination: { kind: 'downloads', unsafe: true },
            unsafeMeta: true
          },
          unsafeRoot: true
        }
      },
      { tabId: 12 }
    );

    expect(handleClipResultMock).toHaveBeenCalledWith(
      {
        type: 'CLIP_RESULT',
        payload: {
          markdown: '# hello',
          meta: {
            url: 'https://example.com',
            attachments: [
              {
                id: 'shot-1',
                fileName: 'frame.jpg',
                mimeType: 'image/jpeg',
                dataUrl: 'data:image/jpeg;base64,aaa'
              }
            ],
            exportDestination: { kind: 'downloads' }
          }
        }
      },
      12,
      expect.any(Object)
    );
  });

  it('accepts structured binary clip result attachments and strips unknown nested fields', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      {
        type: 'CLIP_RESULT',
        payload: {
          markdown: '# hello',
          meta: {
            attachments: [
              {
                id: 'shot-2',
                fileName: 'frame.jpg',
                mimeType: 'image/jpeg',
                content: {
                  encoding: 'base64',
                  data: 'Zm9v',
                  byteLength: 3,
                  unsafe: true
                },
                unsafe: true
              }
            ]
          }
        }
      },
      { tabId: 12 }
    );

    expect(handleClipResultMock).toHaveBeenCalledWith(
      {
        type: 'CLIP_RESULT',
        payload: {
          markdown: '# hello',
          meta: {
            attachments: [
              {
                id: 'shot-2',
                fileName: 'frame.jpg',
                mimeType: 'image/jpeg',
                content: {
                  encoding: 'base64',
                  data: 'Zm9v',
                  byteLength: 3
                }
              }
            ]
          }
        }
      },
      12,
      expect.any(Object)
    );
  });

  it('rejects unknown and unsafe analytics usage events', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      { type: 'TRACK_USAGE_EVENT', event: 'arbitrary_event', params: { source: 'toolbar' } },
      { tabId: 12 }
    );
    await listener?.(
      {
        type: 'track',
        event: 'support_link_clicked',
        params: { url: 'https://ko-fi.com/xiannian?user=reader' }
      },
      { tabId: 12 }
    );
    await listener?.(
      { type: 'TRACK_USAGE_EVENT', event: 'support_like_clicked', params: { variant: ['first'] } },
      { tabId: 12 }
    );

    expect(trackUsageEventMock).not.toHaveBeenCalled();
  });

  it('returns clip results for repository video export messages', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    const result = await listener?.(
      {
        type: 'videoClip',
        data: {
          content: '# video',
          title: 'Video title',
          url: 'https://youtube.com/watch?v=1',
          videoUrl: 'https://youtube.com/watch?v=1',
          timestamp: 1,
          platform: 'youtube',
          attachments: [
            {
              id: 'shot-1',
              fileName: 'file-20260509194226985.jpg',
              mimeType: 'image/jpeg',
              dataUrl: 'data:image/jpeg;base64,aaa'
            }
          ],
          exportDestination: { kind: 'downloads' }
        }
      },
      { tabId: 12 }
    );

    expect(result).toEqual({ success: true, filePath: 'Video/example.md' });
    expect(processClipPayloadMock).toHaveBeenCalledWith({
      markdown: '# video',
      title: 'Video title',
      type: 'video',
      meta: {
        url: 'https://youtube.com/watch?v=1',
        sourceUrl: 'https://youtube.com/watch?v=1',
        platform: 'youtube',
        attachments: [
          {
            id: 'shot-1',
            fileName: 'file-20260509194226985.jpg',
            mimeType: 'image/jpeg',
            dataUrl: 'data:image/jpeg;base64,aaa'
          }
        ],
        exportDestination: { kind: 'downloads' }
      }
    });
  });

  it('returns clip results for repository video export messages with structured binary attachments', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    const result = await listener?.(
      {
        type: 'videoClip',
        data: {
          content: '# video',
          title: 'Video title',
          url: 'https://youtube.com/watch?v=1',
          videoUrl: 'https://youtube.com/watch?v=1',
          timestamp: 1,
          platform: 'youtube',
          attachments: [
            {
              id: 'shot-2',
              fileName: 'file-20260509194226985.jpg',
              mimeType: 'image/jpeg',
              content: {
                encoding: 'base64',
                data: 'Zm9v',
                byteLength: 3
              }
            }
          ]
        }
      },
      { tabId: 12 }
    );

    expect(result).toEqual({ success: true, filePath: 'Video/example.md' });
    expect(processClipPayloadMock).toHaveBeenCalledWith({
      markdown: '# video',
      title: 'Video title',
      type: 'video',
      meta: {
        url: 'https://youtube.com/watch?v=1',
        sourceUrl: 'https://youtube.com/watch?v=1',
        platform: 'youtube',
        attachments: [
          {
            id: 'shot-2',
            fileName: 'file-20260509194226985.jpg',
            mimeType: 'image/jpeg',
            content: {
              encoding: 'base64',
              data: 'Zm9v',
              byteLength: 3
            }
          }
        ]
      }
    });
  });

  it('preserves structured failure categories for repository video export failures', async () => {
    const failure = new Error('vault write failed');
    Object.defineProperty(failure, 'failureCategory', {
      configurable: true,
      enumerable: false,
      value: 'write'
    });
    processClipPayloadMock.mockRejectedValueOnce(failure);
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    const result = await listener?.(
      {
        type: 'videoClip',
        data: {
          content: '# video',
          title: 'Video title',
          url: 'https://youtube.com/watch?v=1',
          videoUrl: 'https://youtube.com/watch?v=1',
          timestamp: 1,
          platform: 'youtube'
        }
      },
      { tabId: 12 }
    );

    expect(result).toEqual({
      success: false,
      error: 'vault write failed',
      failureCategory: 'write'
    });
  });

  it('validates legacy repository clip and reading clip payloads before processing', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    const clipResult = await listener?.(
      {
        type: 'clip',
        data: {
          markdown: '# clip',
          title: 'Clip title',
          meta: { url: 'https://example.com', unsafeMeta: true },
          unsafeRoot: true
        }
      },
      { tabId: 12 }
    );
    const readingResult = await listener?.(
      {
        type: 'readingClip',
        data: {
          content: '# reading',
          title: 'Reading title',
          url: 'https://reader.example.com',
          highlights: [],
          exportMode: 'highlights'
        }
      },
      { tabId: 12 }
    );

    expect(clipResult).toEqual({ success: true, filePath: 'Video/example.md' });
    expect(readingResult).toEqual({ success: true, filePath: 'Video/example.md' });
    expect(processClipPayloadMock).toHaveBeenNthCalledWith(1, {
      markdown: '# clip',
      title: 'Clip title',
      meta: { url: 'https://example.com' }
    });
    expect(processClipPayloadMock).toHaveBeenNthCalledWith(2, {
      markdown: '# reading',
      title: 'Reading title',
      type: 'clipper',
      meta: {
        url: 'https://reader.example.com',
        readerMode: true,
        exportMode: 'highlights'
      }
    });
  });

  it('rejects malformed clip payloads through existing error responses', async () => {
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(createDependencies());

    await listener?.(
      {
        type: 'CLIP_RESULT',
        payload: {
          markdown: '# hello',
          meta: { attachments: [{ id: 'missing-required-fields' }] }
        }
      },
      { tabId: 12 }
    );
    const repositoryResult = await listener?.(
      {
        type: 'clip',
        data: {
          markdown: '# clip',
          meta: { exportDestination: { kind: 'external' } }
        }
      },
      { tabId: 12 }
    );

    expect(handleClipResultMock).not.toHaveBeenCalled();
    expect(processClipPayloadMock).not.toHaveBeenCalled();
    expect(notifyExtractionErrorMock).toHaveBeenCalledWith('Invalid clip payload received.');
    expect(repositoryResult).toEqual({
      success: false,
      error: 'Invalid clip payload received.'
    });
  });

  it('opens the options page and reports failures or unknown messages safely', async () => {
    const dependencies = createDependencies();
    const { registerRuntimeMessageListener } =
      await import('../../../src/background/listeners/runtimeMessages');
    registerRuntimeMessageListener(dependencies);

    const success = await listener?.({ type: 'openOptionsPage', section: 'reader' }, {});
    expect(dependencies.openOptionsPage).toHaveBeenCalledWith('reader');
    expect(success).toEqual({ success: true });

    dependencies.openOptionsPage.mockRejectedValueOnce(new Error('tab failed'));
    const failure = await listener?.({ type: 'openOptionsPage' }, {});
    expect(failure).toEqual({ success: false, error: 'tab failed' });

    await expect(listener?.({ type: 'openOptionsPage', section: 42 }, {})).resolves.toBeUndefined();
    await expect(listener?.({ type: 'unknown' }, {})).resolves.toBeUndefined();
  });
});
