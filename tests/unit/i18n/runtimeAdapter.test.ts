/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LANGUAGE } from '../../../src/i18n/config';
import { DEFAULT_RUNTIME_MESSAGES } from '../../../src/i18n/locales';
import type { LocaleDefinition } from '../../../src/i18n/localeDefinition';
import type {
  PageI18nController,
  PageI18nControllerDependencies
} from '../../../src/i18n/pageController';
import type { StorageAreaService } from '../../../src/platform/interfaces/storage';

function createStorageArea(initial: Record<string, unknown> = {}): StorageAreaService {
  const store = new Map<string, unknown>(Object.entries(initial));

  return {
    get: vi.fn(<T>(key: string) =>
      Promise.resolve(store.get(key) as T | undefined)
    ) as StorageAreaService['get'],
    getAll: vi.fn(() => Promise.resolve(Object.fromEntries(store))) as StorageAreaService['getAll'],
    set: vi.fn(<T>(key: string, value: T) => {
      store.set(key, value);
      return Promise.resolve();
    }) as StorageAreaService['set'],
    getMany: vi.fn(<T>(keys: string[]) =>
      Promise.resolve(Object.fromEntries(keys.map((key) => [key, store.get(key) as T | undefined])))
    ) as StorageAreaService['getMany'],
    setMany: vi.fn(<T>(entries: Record<string, T>) => {
      for (const [key, value] of Object.entries(entries)) {
        store.set(key, value);
      }
      return Promise.resolve();
    }) as StorageAreaService['setMany'],
    remove: vi.fn((key: string | string[]) => {
      for (const entry of Array.isArray(key) ? key : [key]) {
        store.delete(entry);
      }
      return Promise.resolve();
    }) as StorageAreaService['remove'],
    clear: vi.fn(() => {
      store.clear();
      return Promise.resolve();
    }) as StorageAreaService['clear'],
    watchKey: vi.fn(() => () => undefined) as StorageAreaService['watchKey'],
    watchAll: vi.fn(() => () => undefined) as StorageAreaService['watchAll']
  };
}

function createLocaleDefinition(label: string): LocaleDefinition {
  return {
    runtime: {
      ...DEFAULT_RUNTIME_MESSAGES,
      extensionSubtitle: label
    },
    static: {
      extName: `${label} name`,
      extDescription: `${label} description`
    }
  };
}

describe('runtime storage and language services', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reads and writes through the storage adapter without browser globals', async () => {
    const { createStorageAdapter } = await import('../../../src/i18n/runtime/storageAdapter');
    const storage = createStorageArea({ language: 'fr' });
    const adapter = createStorageAdapter(storage);

    await expect(adapter.get('language')).resolves.toBe('fr');
    await adapter.set('language', 'ja');

    expect(storage.set).toHaveBeenCalledWith('language', 'ja');
  });

  it('uses navigator fallback, reports read errors, and persists resolved languages', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const { createStorageAdapter } = await import('../../../src/i18n/runtime/storageAdapter');
    const storage = createStorageArea();
    const readError = new Error('read failed');
    const onReadError = vi.fn(() => Promise.resolve());
    const onWriteError = vi.fn(() => Promise.resolve());

    vi.mocked(storage.get).mockRejectedValueOnce(readError);

    const service = createLanguageService({
      storage: createStorageAdapter(storage),
      getNavigator: () => ({ language: 'ja-JP' }),
      onReadError,
      onWriteError
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('ja');
    await service.setCurrentLanguage('es' as never);

    expect(onReadError).toHaveBeenCalledWith(readError);
    expect(onWriteError).not.toHaveBeenCalled();
    expect(storage.set).toHaveBeenCalledWith('language', 'es-ES');
  });

  it('uses the first supported navigator.languages entry when storage has no language', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const { createStorageAdapter } = await import('../../../src/i18n/runtime/storageAdapter');
    const storage = createStorageArea();

    const service = createLanguageService({
      storage: createStorageAdapter(storage),
      getNavigator: () => ({ languages: ['fr-FR', 'ja-JP'], language: 'en-US' })
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('fr');
  });

  it('continues through navigator.languages when the first entry is unsupported', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const service = createLanguageService({
      storage: null,
      getNavigator: () => ({ languages: ['nl-NL', 'fr-FR', 'en-US'], language: 'en-US' })
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('fr');
  });

  it('uses navigator.language when navigator.languages has no supported entries', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const service = createLanguageService({
      storage: null,
      getNavigator: () => ({ languages: ['nl-NL'], language: 'ko-KR' })
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('ko');
  });

  it('uses Chrome UI language when navigator candidates are unsupported', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const service = createLanguageService({
      storage: null,
      getNavigator: () => ({ languages: ['nl-NL'], language: 'sv-SE' }),
      getChromeI18nLanguage: () => 'ja-JP'
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('ja');
  });

  it('keeps storage language above automatic language candidates', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const { createStorageAdapter } = await import('../../../src/i18n/runtime/storageAdapter');
    const storage = createStorageArea({ language: 'de-DE' });

    const service = createLanguageService({
      storage: createStorageAdapter(storage),
      getNavigator: () => ({ languages: ['fr-FR'], language: 'ja-JP' }),
      getChromeI18nLanguage: () => 'ko-KR'
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('de');
  });

  it('uses automatic language candidates when storage read fails', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const { createStorageAdapter } = await import('../../../src/i18n/runtime/storageAdapter');
    const storage = createStorageArea();
    const onReadError = vi.fn(() => Promise.resolve());
    vi.mocked(storage.get).mockRejectedValueOnce(new Error('sync failed'));

    const service = createLanguageService({
      storage: createStorageAdapter(storage),
      getNavigator: () => ({ languages: ['nl-NL', 'fr-FR'], language: 'en-US' }),
      getChromeI18nLanguage: () => 'ja-JP',
      onReadError
    });

    await expect(service.getCurrentLanguage()).resolves.toBe('fr');
    expect(onReadError).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default language when all automatic candidates are unsupported', async () => {
    const { createLanguageService } = await import('../../../src/i18n/runtime/languageService');
    const service = createLanguageService({
      storage: null,
      getNavigator: () => ({ languages: ['nl-NL'], language: 'sv-SE' }),
      getChromeI18nLanguage: () => 'th-TH'
    });

    await expect(service.getCurrentLanguage()).resolves.toBe(DEFAULT_LANGUAGE);
  });
});

describe('runtime locale and page services', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loads locale definitions once and preserves fallback behavior', async () => {
    const { createLocaleService } = await import('../../../src/i18n/runtime/localeService');
    const zhLoader = vi.fn(() => Promise.resolve(createLocaleDefinition('zh-CN')));

    const service = createLocaleService({
      defaultLanguage: DEFAULT_LANGUAGE,
      defaultDefinition: createLocaleDefinition('en'),
      loaders: {
        en: () => Promise.resolve(createLocaleDefinition('en')),
        'zh-CN': zhLoader
      }
    });

    const aliasMessages = await service.loadMessagesWithFallback('zh');
    const unknownMessages = await service.loadMessagesWithFallback('unknown-locale');
    await service.loadLocaleDefinition('zh-CN');
    await service.loadLocaleDefinition('zh-CN');

    expect(aliasMessages.extensionSubtitle).toBe('zh-CN');
    expect(unknownMessages).toBe(service.defaultRuntimeMessages);
    expect(zhLoader).toHaveBeenCalledTimes(1);
  });

  it('updates document metadata and wires the default page controller through injected dependencies', async () => {
    const { createPageRuntime } = await import('../../../src/i18n/runtime/pageRuntime');
    const bindingAdapter = {
      bindText: vi.fn(),
      bindAttribute: vi.fn(),
      bindHtml: vi.fn(),
      refresh: vi.fn(),
      clear: vi.fn()
    };
    const controller: PageI18nController = {
      load: vi.fn(() => Promise.resolve()),
      mount: vi.fn(),
      registerDynamic: vi.fn(),
      changeLanguage: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(),
      getCurrentResource: vi.fn(() => null),
      getBinder: vi.fn(
        () =>
          ({
            bindText: vi.fn(),
            bindAttr: vi.fn(),
            bindHtml: vi.fn()
          }) as never
      )
    };
    const createPageController = vi.fn((_: PageI18nControllerDependencies) => controller);

    const runtime = createPageRuntime({
      loadLocaleDefinition: () => Promise.resolve(createLocaleDefinition('zh-CN')),
      defaultRuntimeMessages: DEFAULT_RUNTIME_MESSAGES,
      getMessagesForLanguage: () => Promise.resolve(DEFAULT_RUNTIME_MESSAGES),
      getCurrentLanguage: () => Promise.resolve('en'),
      setCurrentLanguage: () => Promise.resolve(),
      createBindingAdapter: () => bindingAdapter,
      createPageController
    });

    const messages = await runtime.loadLocale('zh');
    const createdController = runtime.createDefaultPageI18nController();

    expect(messages.extensionSubtitle).toBe('zh-CN');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(createPageController).toHaveBeenCalledTimes(1);
    const controllerOptions = createPageController.mock.calls[0]?.[0];
    expect(controllerOptions?.bindingAdapter).toBe(bindingAdapter);
    expect(controllerOptions?.defaultLanguage).toBe(DEFAULT_LANGUAGE);
    expect(typeof controllerOptions?.getCurrentLanguage).toBe('function');
    expect(typeof controllerOptions?.setCurrentLanguage).toBe('function');
    expect(createdController).toBe(controller);
  });
});
