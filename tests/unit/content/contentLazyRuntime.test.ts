import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionDraftStoragePolicy } from '@content/sessionDrafts';
import {
  createLazyReaderSessionFactory,
  createLazyVideoSessionFactory,
  createLazyLocalVaultPermissionPrompt,
  createVideoPromptOnDemandInitializer,
  isVideoPromptCandidateUrl
} from '../../../src/content/runtime/contentLazyRuntime';
import type { SessionDraftStoragePolicy } from '../../../src/content/sessionDrafts';

const createReaderSessionAdapterMock = vi.hoisted(() => vi.fn());
const createVideoSessionAdapterMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/content/reader/readerLazyRuntime', () => ({
  createReaderSessionAdapter: createReaderSessionAdapterMock
}));

vi.mock('../../../src/content/video/videoLazyRuntime', () => ({
  createVideoSessionAdapter: createVideoSessionAdapterMock
}));

function createDeps() {
  return {
    optionsRepository: {} as never,
    storage: {} as never,
    runtime: {} as never
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
    'https://mp.weixin.qq.com/s/U-5PG2mF3Y5oJGea1HsD-Q'
  ])('does not treat %s as a video prompt candidate', (url) => {
    expect(isVideoPromptCandidateUrl(url)).toBe(false);
  });

  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
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
      document: {} as Document,
      window: {} as Window,
      runtime: { getURL: vi.fn((path: string) => `chrome-extension://test/${path}`) }
    };
    const prompt = createLazyLocalVaultPermissionPrompt(dependencies as never, loadPrompt);

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
    const sharedDependencies = {
      document: {} as Document,
      optionsRepository: {} as never,
      storage: {} as never,
      messaging: {} as never,
      runtime: {} as never,
      getSessionDraftStoragePolicy: () => currentPolicy
    };
    const createReaderSession = createLazyReaderSessionFactory({
      ...sharedDependencies,
      promptGateway: {} as never
    });
    const createVideoSession = createLazyVideoSessionFactory(sharedDependencies);

    const firstReader = createReaderSession({} as Document, 'https://example.com/one');
    const firstVideo = createVideoSession({} as Document);
    await firstReader.start();
    await firstVideo.start();

    currentPolicy = secondPolicy;
    await firstReader.start();
    await firstVideo.start();
    expect(observedReaderPolicies).toEqual([firstPolicy]);
    expect(observedVideoPolicies).toEqual([firstPolicy]);

    await createReaderSession({} as Document, 'https://example.com/two').start();
    await createVideoSession({} as Document).start();

    expect(observedReaderPolicies).toEqual([firstPolicy, secondPolicy]);
    expect(observedVideoPolicies).toEqual([firstPolicy, secondPolicy]);
  });
});
