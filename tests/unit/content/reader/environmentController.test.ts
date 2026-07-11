/* @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  StorageAreaService,
  StorageChangeCallback,
  StorageService
} from '../../../../src/platform/interfaces/storage';
import { ReaderEnvironmentController } from '@content/reader/environmentController';
import type { ReaderSessionMessages } from '@content/reader/sessionMessages';
import type { IOptionsRepository } from '@shared/repositories/IOptionsRepository';
import type { CompleteOptions, FragmentClipperOptions } from '@shared/types/options';
const subscriberCallbacks: Array<(value: CompleteOptions) => void> = [];

vi.mock('@content/i18n/context', () => ({
  ensureContentI18n: vi.fn(() =>
    Promise.resolve({
      registerDynamic: vi.fn()
    })
  ),
  getContentI18nResource: vi.fn(() => ({
    messages: {
      readerPanelTitle: 'Test Title',
      readerPanelStatus: 'status',
      readerPanelCounter: '{count}',
      readerPanelCounterZero: '0',
      readerPanelFinish: 'finish',
      readerPanelCancel: 'cancel',
      readerPanelHint: 'hint',
      readerHighlightEditLabel: 'edit',
      readerHighlightDeleteLabel: 'delete',
      readerHighlightNoComment: 'none',
      readerHighlightSaveLabel: 'save',
      readerHighlightCancelLabel: 'cancel',
      readerHighlightEditPlaceholder: 'placeholder',
      readerHighlightFocusLabel: 'focus',
      readerHintNoHighlights: 'no highlights',
      readerHintExporting: 'exporting',
      readerHintFailure: 'failure',
      readerHintSelectionFailure: 'selection failure'
    }
  })),
  getContentMessages: vi.fn(() =>
    Promise.resolve({
      readerPanelTitle: 'Test Title',
      readerPanelStatus: 'status',
      readerPanelCounter: '{count}',
      readerPanelCounterZero: '0',
      readerPanelFinish: 'finish',
      readerPanelCancel: 'cancel',
      readerPanelHint: 'hint',
      readerHighlightEditLabel: 'edit',
      readerHighlightDeleteLabel: 'delete',
      readerHighlightNoComment: 'none',
      readerHighlightSaveLabel: 'save',
      readerHighlightCancelLabel: 'cancel',
      readerHighlightEditPlaceholder: 'placeholder',
      readerHighlightFocusLabel: 'focus',
      readerHintNoHighlights: 'no highlights',
      readerHintExporting: 'exporting',
      readerHintFailure: 'failure',
      readerHintSelectionFailure: 'selection failure'
    })
  )
}));

vi.mock('@content/clipper/services/fragmentConfig', async () => {
  const actual = await vi.importActual<typeof import('@content/clipper/services/fragmentConfig')>(
    '@content/clipper/services/fragmentConfig'
  );
  return {
    ...actual,
    loadFragmentConfig: vi.fn(() =>
      Promise.resolve({
        ...actual.DEFAULT_FRAGMENT_CONFIG,
        selectionModifierEnabled: true
      })
    )
  };
});

describe('ReaderEnvironmentController', () => {
  let languageWatcher: StorageChangeCallback<string> | null;
  let optionsRepository: IOptionsRepository;
  let storageService: StorageService;
  let messagesHandler: ReturnType<typeof vi.fn<(...args: [ReaderSessionMessages]) => void>>;
  let fragmentHandler: ReturnType<typeof vi.fn<(...args: [FragmentClipperOptions]) => void>>;

  beforeEach(() => {
    languageWatcher = null;
    subscriberCallbacks.length = 0;

    const syncArea: StorageAreaService = {
      get: vi.fn(() => Promise.resolve(undefined)),
      getAll: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve(undefined)),
      getMany: vi.fn(() => Promise.resolve({})),
      setMany: vi.fn(() => Promise.resolve(undefined)),
      remove: vi.fn(() => Promise.resolve(undefined)),
      clear: vi.fn(() => Promise.resolve(undefined)),
      watchKey: vi.fn(<T>(_key: string, callback: StorageChangeCallback<T>) => {
        languageWatcher = callback as StorageChangeCallback<string>;
        return () => {
          languageWatcher = null;
        };
      }) as StorageAreaService['watchKey'],
      watchAll: vi.fn(() => () => {})
    };

    storageService = {
      sync: syncArea,
      local: syncArea
    };

    optionsRepository = {
      get: vi.fn(() =>
        Promise.resolve({
          readingSession: {
            exportMode: 'highlights',
            highlightTheme: 'purple'
          }
        } as CompleteOptions)
      ),
      set: vi.fn(() => Promise.resolve(undefined)),
      onChange: vi.fn((callback: (options: CompleteOptions) => void) => {
        subscriberCallbacks.push(callback);
        return () => {
          const index = subscriberCallbacks.indexOf(callback);
          if (index !== -1) {
            subscriberCallbacks.splice(index, 1);
          }
        };
      })
    };

    messagesHandler = vi.fn<(...args: [ReaderSessionMessages]) => void>((messages) => {
      expect(messages).toBeDefined();
    });
    fragmentHandler = vi.fn<(...args: [FragmentClipperOptions]) => void>();
  });

  it('emits initial environment state and responds to watchers', async () => {
    const controller = new ReaderEnvironmentController(
      {
        doc: document,
        storage: storageService,
        optionsRepository
      },
      {
        onMessagesUpdate: (messages) => messagesHandler(messages),
        onFragmentConfigUpdate: fragmentHandler
      }
    );

    const state = await controller.start();
    expect(state.messages.panel.title).toBe('Test Title');
    expect(fragmentHandler).toHaveBeenCalled();
    expect(state.fragmentConfig.selectionModifierEnabled).toBe(true);

    languageWatcher?.('zh-CN', { oldValue: undefined, newValue: 'zh-CN' });
    expect(messagesHandler).toHaveBeenCalledTimes(2);

    controller.stop();
    expect(languageWatcher).toBeNull();
  });
});
