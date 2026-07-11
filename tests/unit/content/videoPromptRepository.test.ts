/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { VideoPromptDependencies } from '@content/video/videoPromptDependencies';
import type { IVideoRepository } from '@shared/repositories/IVideoRepository';
import type { StorageService, StorageAreaService } from '../../../src/platform/interfaces/storage';
import type { RuntimeService } from '../../../src/platform/interfaces/runtime';
import type { VideoOptions } from '@shared/types/options';

import { __videoPromptTestUtils } from '@content/video/videoPromptTestHarness';

type VideoRepoMock<K extends keyof IVideoRepository> = Mock<
  (...args: Parameters<IVideoRepository[K]>) => ReturnType<IVideoRepository[K]>
>;

const createVideoRepoMock = <K extends keyof IVideoRepository>() =>
  vi.fn<(...args: Parameters<IVideoRepository[K]>) => ReturnType<IVideoRepository[K]>>();

const screenshotAttachmentDefaults = {
  locationTemplate: './assets/${noteFileName}',
  fileNameTemplate: "file-${date:{momentJsFormat:'YYYYMMDDHHmmssSSS'}}.jpg",
  markdownUrlFormat: ''
};

const {
  setDependenciesForTests,
  resetDependenciesForTests,
  setPromptStateForTests,
  getPromptStateForTests,
  savePromptPositionForTests,
  loadPromptPositionForTests,
  setupVideoConfigListenerForTests
} = __videoPromptTestUtils;

function createStorageArea(): StorageAreaService {
  return {
    get: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    getMany: vi.fn().mockResolvedValue({}),
    setMany: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    watchKey: vi.fn().mockReturnValue(() => {}),
    watchAll: vi.fn().mockReturnValue(() => {})
  };
}

function createRuntime(): RuntimeService {
  return {
    getURL: vi.fn(() => 'mock-url'),
    getBrowserTarget: vi.fn<() => 'chrome'>(() => 'chrome'),
    openOptionsPage: vi.fn(() => Promise.resolve(undefined)),
    onInstalled: vi.fn().mockReturnValue(() => {}),
    onStartup: vi.fn().mockReturnValue(() => {})
  };
}

describe('VideoPrompt repository integration helpers', () => {
  let mockRepo: IVideoRepository;
  let storage: StorageService;
  let runtime: RuntimeService;
  let savePromptPositionMock: VideoRepoMock<'savePromptPosition'>;
  let saveControlBarPreferencesMock: VideoRepoMock<'saveControlBarPreferences'>;
  let getPromptPositionMock: VideoRepoMock<'getPromptPosition'>;
  let getVideoConfigMock: VideoRepoMock<'getVideoConfig'>;
  let onConfigChangeMock: VideoRepoMock<'onConfigChange'>;
  let sendVideoClipMock: VideoRepoMock<'sendVideoClip'>;

  beforeEach(() => {
    getVideoConfigMock = createVideoRepoMock<'getVideoConfig'>();
    getVideoConfigMock.mockResolvedValue({
      floatingPromptEnabled: true,
      promptButtonLabel: 'Start capture',
      promptShortcut: 'Alt+V',
      controlBarAutoPause: true,
      controlBarScreenshot: true,
      commentEditorAutoPause: false,
      screenshotAttachment: screenshotAttachmentDefaults
    });
    savePromptPositionMock = createVideoRepoMock<'savePromptPosition'>();
    savePromptPositionMock.mockResolvedValue(undefined);
    saveControlBarPreferencesMock = createVideoRepoMock<'saveControlBarPreferences'>();
    saveControlBarPreferencesMock.mockResolvedValue(undefined);
    getPromptPositionMock = createVideoRepoMock<'getPromptPosition'>();
    getPromptPositionMock.mockResolvedValue(null);
    sendVideoClipMock = createVideoRepoMock<'sendVideoClip'>();
    sendVideoClipMock.mockResolvedValue({ success: true });
    onConfigChangeMock = createVideoRepoMock<'onConfigChange'>();
    onConfigChangeMock.mockReturnValue(() => {});

    mockRepo = {
      getVideoConfig: getVideoConfigMock,
      savePromptPosition: savePromptPositionMock,
      saveControlBarPreferences: saveControlBarPreferencesMock,
      getPromptPosition: getPromptPositionMock,
      sendVideoClip: sendVideoClipMock,
      onConfigChange: onConfigChangeMock
    };

    storage = {
      local: createStorageArea(),
      sync: createStorageArea()
    };
    runtime = createRuntime();

    const deps: VideoPromptDependencies = {
      storage,
      runtime,
      videoRepo: mockRepo,
      createVideoSession: vi.fn(() => ({ start: vi.fn(() => Promise.resolve()) })),
      getRuntimeTheme: vi.fn(() => null)
    };
    setDependenciesForTests(deps);
    setPromptStateForTests({ left: 40, top: 60, side: 'right', hasCustomPosition: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDependenciesForTests();
  });

  it('saves prompt position through the video repository', async () => {
    setPromptStateForTests({ left: 150, top: 220 });

    await savePromptPositionForTests();

    expect(savePromptPositionMock).toHaveBeenCalledWith({ x: 150, y: 220 });
  });

  it('loads prompt position from the video repository', async () => {
    getPromptPositionMock.mockResolvedValue({ x: 320, y: 180 });

    await loadPromptPositionForTests();

    expect(getPromptPositionMock).toHaveBeenCalled();
    const state = getPromptStateForTests();
    expect(state.left).toBe(320);
    expect(state.top).toBe(180);
    expect(state.hasCustomPosition).toBe(true);
  });

  it('subscribes to video config changes and applies positions', async () => {
    const unsubscribe = vi.fn();
    const configCallbacks: Array<(config: VideoOptions) => void> = [];
    onConfigChangeMock.mockImplementation((callback) => {
      configCallbacks.push(callback);
      return unsubscribe;
    });

    const cleanup = setupVideoConfigListenerForTests();
    await Promise.resolve();

    expect(onConfigChangeMock).toHaveBeenCalledTimes(1);

    const newConfig = {
      floatingPromptEnabled: true,
      promptButtonLabel: 'Record highlight',
      promptShortcut: 'Shift+V',
      controlBarAutoPause: true,
      controlBarScreenshot: true,
      commentEditorAutoPause: false,
      screenshotAttachment: screenshotAttachmentDefaults,
      promptPosition: { x: 90, y: 140 }
    };
    configCallbacks.forEach((callback) => callback(newConfig));

    const state = getPromptStateForTests();
    expect(state.left).toBe(90);
    expect(state.top).toBe(140);
    expect(state.hasCustomPosition).toBe(true);

    cleanup();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
