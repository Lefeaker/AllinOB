/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  StorageAreaService,
  StorageService,
  StorageChangeCallback
} from '../../src/platform/interfaces/storage';
import type { PlatformServices } from '../../src/platform/types';
import type { MessagingService } from '../../src/platform/interfaces/messaging';
import type { ContextMenusService } from '../../src/platform/interfaces/contextMenus';
import type { DownloadsService } from '../../src/platform/interfaces/downloads';
import type { NotificationsService } from '../../src/platform/interfaces/notifications';
import type { TabsService } from '../../src/platform/interfaces/tabs';
import type { ActionService } from '../../src/platform/interfaces/actions';
import type { RuntimeService } from '../../src/platform/interfaces/runtime';
import type { ScriptingService } from '../../src/platform/interfaces/scripting';
import type { RestClient } from '../../src/shared/interfaces/restClient';
import type { StoredOptions } from '../../src/shared/types/options';
import { registerService, resetGlobalRegistry, TOKENS } from '../../src/shared/di';
import { repositoryContainer } from '../../src/shared/di/serviceRegistry';
import { DI_TOKENS } from '../../src/shared/di/tokens';
import { ChromeOptionsRepository } from '../../src/infrastructure/repositories/ChromeOptionsRepository';
import type { OptionsStore } from '../../src/options/state/types';
import { generateYamlFrontMatter } from '../../src/shared/utils/yamlGenerator';

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryStorageArea() {
  const store = new Map<string, unknown>();
  const keyWatchers = new Map<
    string,
    Set<(value: unknown, change: { oldValue?: unknown; newValue?: unknown }) => void>
  >();
  const allWatchers = new Set<
    (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void
  >();

  const notify = (key: string, oldValue: unknown, newValue: unknown) => {
    const change = { oldValue, newValue };
    keyWatchers.get(key)?.forEach((listener) => listener(cloneValue(newValue), cloneValue(change)));
    if (allWatchers.size) {
      allWatchers.forEach((listener) => listener({ [key]: cloneValue(change) }));
    }
  };

  const area: StorageAreaService = {
    get<T = unknown>(key: string): Promise<T | undefined> {
      return Promise.resolve(cloneValue(store.get(key)) as T | undefined);
    },
    getAll(): Promise<Record<string, unknown>> {
      return Promise.resolve(
        Object.fromEntries(Array.from(store.entries(), ([key, value]) => [key, cloneValue(value)]))
      );
    },
    set<T = unknown>(key: string, value: T): Promise<void> {
      const oldValue = store.get(key);
      store.set(key, cloneValue(value));
      notify(key, oldValue, value);
      return Promise.resolve();
    },
    getMany<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
      const result = keys.reduce<Record<string, T | undefined>>((acc, key) => {
        acc[key] = cloneValue(store.get(key)) as T | undefined;
        return acc;
      }, {});
      return Promise.resolve(result);
    },
    async setMany<T = unknown>(entries: Record<string, T>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) {
        await area.set(key, value);
      }
    },
    remove(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((k) => {
        const oldValue = store.get(k);
        store.delete(k);
        notify(k, oldValue, undefined);
      });
      return Promise.resolve();
    },
    clear(): Promise<void> {
      for (const key of Array.from(store.keys())) {
        const oldValue = store.get(key);
        store.delete(key);
        notify(key, oldValue, undefined);
      }
      return Promise.resolve();
    },
    watchKey<T = unknown>(key: string, callback: StorageChangeCallback<T>) {
      const listeners = keyWatchers.get(key) ?? new Set();
      listeners.add(
        callback as (value: unknown, change: { oldValue?: unknown; newValue?: unknown }) => void
      );
      keyWatchers.set(key, listeners);
      return () => {
        listeners.delete(
          callback as (value: unknown, change: { oldValue?: unknown; newValue?: unknown }) => void
        );
      };
    },
    watchAll(callback) {
      allWatchers.add(callback);
      return () => {
        allWatchers.delete(callback);
      };
    }
  };

  return area;
}

const noop = () => undefined;

const mockMessaging: MessagingService = {
  send<TResult = unknown>() {
    return Promise.resolve(undefined as TResult);
  },
  sendToTab<TResult = unknown>() {
    return Promise.resolve(undefined as TResult);
  },
  addListener() {
    return noop;
  }
};

const mockContextMenus: ContextMenusService = {
  create() {
    return Promise.resolve(0);
  },
  update() {
    return Promise.resolve(undefined);
  },
  removeAll() {
    return Promise.resolve(undefined);
  },
  onClicked() {
    return noop;
  },
  onShown() {
    return noop;
  }
};

const mockNotifications: NotificationsService = {
  create() {
    return Promise.resolve(undefined);
  },
  clear() {
    return Promise.resolve(undefined);
  }
};

const mockTabs: TabsService = {
  create() {
    return Promise.resolve(undefined);
  },
  remove() {
    return Promise.resolve(undefined);
  },
  getCurrent() {
    return Promise.resolve(undefined);
  },
  get() {
    return Promise.resolve(undefined);
  },
  query() {
    return Promise.resolve([]);
  },
  sendMessage<TResult = unknown>() {
    return Promise.resolve(undefined as TResult);
  },
  onActivated() {
    return noop;
  },
  onUpdated() {
    return noop;
  },
  onRemoved() {
    return noop;
  }
};

const mockAction: ActionService = {
  onClicked() {
    return noop;
  },
  setBadgeText() {
    return Promise.resolve(undefined);
  },
  setBadgeBackgroundColor() {
    return Promise.resolve(undefined);
  }
};

const mockRuntime: RuntimeService = {
  getURL(path: string) {
    return path;
  },
  getBrowserTarget() {
    return 'chrome';
  },
  openOptionsPage() {
    return Promise.resolve(undefined);
  },
  onInstalled() {
    return noop;
  },
  onStartup() {
    return noop;
  }
};

const mockScripting: ScriptingService = {
  executeScript() {
    return Promise.resolve(undefined);
  }
};

const mockRestClient: RestClient = {
  writeFile() {
    return Promise.resolve(undefined);
  }
};

const mockDownloads: DownloadsService = {
  download() {
    return Promise.resolve(undefined);
  }
};

describe('YAML overrides integration flow', () => {
  let syncArea: StorageAreaService;
  let optionsStore: OptionsStore;

  beforeEach(async () => {
    syncArea = createMemoryStorageArea();
    const storageService: StorageService = {
      sync: syncArea,
      local: createMemoryStorageArea()
    };

    const platformServices: PlatformServices = {
      storage: storageService,
      messaging: mockMessaging,
      runtime: mockRuntime,
      contextMenus: mockContextMenus,
      downloads: mockDownloads,
      fileSystemAccess: {
        isSupported: () => false,
        chooseDirectory: () =>
          Promise.reject(new Error('File System Access unavailable in tests.')),
        queryPermission: () => Promise.resolve('unsupported'),
        ensurePermission: () => Promise.resolve('unsupported'),
        writeFile: () => Promise.reject(new Error('File System Access unavailable in tests.')),
        removeDirectory: () => Promise.resolve(undefined)
      },
      notifications: mockNotifications,
      tabs: mockTabs,
      action: mockAction,
      scripting: mockScripting,
      restClient: mockRestClient
    };

    resetGlobalRegistry();
    registerService(TOKENS.platformServices, () => platformServices);
    repositoryContainer.reset();
    repositoryContainer.registerSingleton(
      DI_TOKENS.IOptionsRepository,
      () => new ChromeOptionsRepository(storageService)
    );
    optionsStore = (await import('../../src/options/state/optionsStore')).optionsStore;
    optionsStore.reset();
  });

  afterEach(() => {
    optionsStore.reset();
    repositoryContainer.reset();
    resetGlobalRegistry();
  });

  it('persists YAML overrides and applies them during export', async () => {
    const overrides: StoredOptions = {
      yamlConfig: {
        contentTypes: {
          article: {
            customFields: [
              { name: 'review_notes', type: 'text', enabled: true, valuePath: 'meta.reviewNotes' }
            ],
            domainOverrides: {
              '*.example.com': [
                { name: 'tags', type: 'array', enabled: true, defaultValue: ['custom-tag'] }
              ]
            }
          }
        }
      }
    };

    await optionsStore.save(overrides);

    const persisted = await syncArea.get<StoredOptions>('options');
    expect(persisted?.yamlConfig?.contentTypes?.article?.customFields?.[0]?.isCustom).toBe(true);

    const frontMatter = generateYamlFrontMatter(
      'article',
      {
        type: 'article',
        title: 'Deep Dive',
        url: 'https://news.example.com/deep-dive',
        clipped_at: '2024-11-11T10:00:00Z',
        meta: {
          reviewNotes: 'Double-check statistics section'
        }
      },
      { domain: 'news.example.com' }
    );

    expect(frontMatter).toContain('review_notes: "Double-check statistics section"');
    expect(frontMatter).toContain('tags: ["custom-tag"]');
  });
});
