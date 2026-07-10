/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts';
import { DEFAULT_OPTIONS } from '@shared/config/defaultOptions';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { createPreviewPlatformServices } from '@platform/preview/services';
import {
  createLazyReaderSessionFactory,
  createLazyVideoSessionFactory,
  createLazyLocalVaultPermissionPrompt,
  createVideoPromptOnDemandInitializer,
  isVideoPromptCandidateUrl
} from '../../../src/content/runtime/contentLazyRuntime';
import type { SessionDraftStoragePolicy } from '../../../src/content/sessionDrafts';
import type { ClipPromptGateway } from '../../../src/content/clipper/application/clipPromptGateway';
import type { RuntimeService } from '../../../src/platform/interfaces/runtime';
import type { StorageService } from '../../../src/platform/interfaces/storage';
import type { IOptionsRepository } from '../../../src/shared/repositories/IOptionsRepository';

type CreateReaderSessionAdapter =
  typeof import('../../../src/content/reader/readerLazyRuntime').createReaderSessionAdapter;
type CreateVideoSessionAdapter =
  typeof import('../../../src/content/video/videoLazyRuntime').createVideoSessionAdapter;
const createReaderSessionAdapterMock = vi.hoisted(() => vi.fn<CreateReaderSessionAdapter>());
const createVideoSessionAdapterMock = vi.hoisted(() => vi.fn<CreateVideoSessionAdapter>());

vi.mock('../../../src/content/reader/readerLazyRuntime', () => ({
  createReaderSessionAdapter: createReaderSessionAdapterMock
}));

vi.mock('../../../src/content/video/videoLazyRuntime', () => ({
  createVideoSessionAdapter: createVideoSessionAdapterMock
}));

function createOptionsRepository(): IOptionsRepository {
  return {
    get: () => Promise.resolve(DEFAULT_OPTIONS),
    set: () => Promise.resolve(),
    onChange: () => () => undefined
  };
}

function createStorage(): StorageService {
  return {
    local: createMemoryStorageArea(),
    sync: createMemoryStorageArea()
  };
}

function createRuntime(): RuntimeService {
  return {
    getURL: (path) => `chrome-extension://test/${path}`,
    getBrowserTarget: () => 'chrome',
    openOptionsPage: () => Promise.resolve(),
    onInstalled: () => () => undefined,
    onStartup: () => () => undefined
  };
}

function createDeps(): Parameters<ReturnType<typeof createVideoPromptOnDemandInitializer>>[0] {
  return {
    optionsRepository: createOptionsRepository(),
    storage: createStorage(),
    runtime: createRuntime()
  };
}

describe('contentLazyRuntime video prompt gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'https://en.wikipedia.org/wiki/Artificial_intelligence',
    'https://medium.com/tag/artificial-intelligence',
    'https://x.com/OpenAI',
    'https://www.reddit.com/r/programming/',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    'https://mp.weixin.qq.com/s/U-5PG2mF3Y5oJGea1HsD-Q',
    'https://notyoutube.com/watch?v=lookalike',
    'https://notbilibili.com/video/BV1lookalike'
  ])('does not treat %s as a video prompt candidate', (url) => {
    expect(isVideoPromptCandidateUrl(url)).toBe(false);
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.bilibili.com/video/BV1abc123456/'
  ])('treats %s as a video prompt candidate', (url) => {
    expect(isVideoPromptCandidateUrl(url)).toBe(true);
  });

  it('does not import the video runtime for non-video pages', async () => {
    const loadRuntime = vi.fn();
    const initialize = createVideoPromptOnDemandInitializer(loadRuntime);

    await initialize(createDeps(), 'https://developer.mozilla.org/en-US/docs/Web/JavaScript');

    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it('imports and initializes the video runtime for video pages', async () => {
    const initializeVideoPromptRuntime = vi.fn().mockResolvedValue(undefined);
    const loadRuntime = vi.fn().mockResolvedValue({ initializeVideoPromptRuntime });
    const deps = createDeps();
    const initialize = createVideoPromptOnDemandInitializer(loadRuntime);

    await initialize(deps, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(initializeVideoPromptRuntime).toHaveBeenCalledWith(
      deps,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });

  it('defers local vault permission prompt import until a permission request arrives', async () => {
    const request = vi.fn().mockResolvedValue({ action: 'granted', permissionState: 'granted' });
    const createLocalVaultPermissionPrompt = vi.fn(() => ({ request }));
    const loadPrompt = vi.fn().mockResolvedValue({ createLocalVaultPermissionPrompt });
    const dependencies = {
      document,
      window,
      runtime: createRuntime()
    };
    const prompt = createLazyLocalVaultPermissionPrompt(dependencies, loadPrompt);

    expect(loadPrompt).not.toHaveBeenCalled();

    await expect(
      prompt.request({
        type: 'SHOW_LOCAL_VAULT_PERMISSION_PROMPT',
        folderId: 'folder-main',
        folderName: 'Blog',
        vaultName: 'blog'
      })
    ).resolves.toEqual({ action: 'granted', permissionState: 'granted' });

    expect(loadPrompt).toHaveBeenCalledTimes(1);
    expect(createLocalVaultPermissionPrompt).toHaveBeenCalledWith(dependencies);
    expect(request).toHaveBeenCalledWith({
      type: 'SHOW_LOCAL_VAULT_PERMISSION_PROMPT',
      folderId: 'folder-main',
      folderName: 'Blog',
      vaultName: 'blog'
    });
  });

  it('resolves current policy for newly created lazy reader and video sessions', async () => {
    const firstPolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 96 * 60 * 60 * 1000
      }
    });
    const secondPolicy = createSessionDraftStoragePolicy({
      retentionPolicy: {
        retentionMs: 120 * 60 * 60 * 1000
      }
    });
    let currentPolicy = firstPolicy;
    const observedReaderPolicies: Array<SessionDraftStoragePolicy | undefined> = [];
    const observedVideoPolicies: Array<SessionDraftStoragePolicy | undefined> = [];
    createReaderSessionAdapterMock.mockImplementation((_doc, _url, deps) => {
      observedReaderPolicies.push(
        deps.getSessionDraftStoragePolicy?.() ?? deps.sessionDraftStoragePolicy
      );
      return {
        start: vi.fn().mockResolvedValue(undefined),
        ingestExternalHighlight: vi.fn()
      };
    });
    createVideoSessionAdapterMock.mockImplementation((_doc, deps) => {
      observedVideoPolicies.push(
        deps.getSessionDraftStoragePolicy?.() ?? deps.sessionDraftStoragePolicy
      );
      return {
        start: vi.fn().mockResolvedValue(undefined),
        ingestTextCapture: vi.fn()
      };
    });
    const messaging = createPreviewPlatformServices().messaging;
    const sharedDependencies: Parameters<typeof createLazyVideoSessionFactory>[0] = {
      document,
      optionsRepository: createOptionsRepository(),
      storage: createStorage(),
      messaging,
      runtime: createRuntime(),
      getSessionDraftStoragePolicy: () => currentPolicy
    };
    const promptGateway: ClipPromptGateway = {
      requestSelectionAction: () => Promise.resolve({ action: 'cancel', comment: '' })
    };
    const createReaderSession = createLazyReaderSessionFactory({
      ...sharedDependencies,
      promptGateway
    });
    const createVideoSession = createLazyVideoSessionFactory(sharedDependencies);

    const firstReader = createReaderSession(document, 'https://example.com/one');
    const firstVideo = createVideoSession(document);
    await firstReader.start();
    await firstVideo.start();

    currentPolicy = secondPolicy;
    await firstReader.start();
    await firstVideo.start();
    expect(observedReaderPolicies).toEqual([firstPolicy]);
    expect(observedVideoPolicies).toEqual([firstPolicy]);

    await createReaderSession(document, 'https://example.com/two').start();
    await createVideoSession(document).start();

    expect(observedReaderPolicies).toEqual([firstPolicy, secondPolicy]);
    expect(observedVideoPolicies).toEqual([firstPolicy, secondPolicy]);
  });
});
