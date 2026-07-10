/* @vitest-environment jsdom */

import { vi } from 'vitest';
import { getMessagesForLanguage, type Language, type Messages } from '@i18n';
import { mergeOptions } from '@shared/config/optionsMerger';
import type { OptionsController } from '@options/app/optionsController';
import {
  getFooterMeta,
  getFooterView,
  getSettingsView,
  previewContent
} from '@options/app/productionStitchAssets';
import {
  applyOptionsToState,
  createInitialStitchState,
  createProductionContent
} from '@options/app/productionStitchStateMapper';
import { createProductionStitchShellActionRuntime } from '@options/app/productionStitchShellActionRuntime';
import { previewContent as stitchPreviewContent } from '@options/stitch/content';
import type { CompleteOptions, StoredOptions } from '@shared/types/options';
import { ensureWindowLocalStorage } from '../../utils/localStorage';

const analyticsMocks = vi.hoisted(() => ({
  clearAllData: vi.fn(() => Promise.resolve()),
  getConfig: vi.fn(() => ({ debugMode: false })),
  getUserConsent: vi.fn(() => Promise.resolve({ analytics: false, errorReporting: false })),
  refreshFromStorage: vi.fn(() => Promise.resolve()),
  setAnalyticsConsent: vi.fn(() => Promise.resolve()),
  updateConfig: vi.fn(() => Promise.resolve())
}));

vi.mock('@shared/errors/analytics/analyticsConfig', () => ({
  getAnalyticsConfigManager: () => ({
    clearAllData: analyticsMocks.clearAllData,
    getConfig: analyticsMocks.getConfig,
    getUserConsent: analyticsMocks.getUserConsent,
    refreshFromStorage: analyticsMocks.refreshFromStorage,
    updateConfig: analyticsMocks.updateConfig
  }),
  setAnalyticsConsent: analyticsMocks.setAnalyticsConsent
}));

export { analyticsMocks };
export type { CompleteOptions, OptionsController };

export function createController() {
  return {
    scheduleAutoSave: vi.fn(),
    dispose: vi.fn(),
    loadInitialState: vi.fn(),
    loadRaw: vi.fn(),
    applyToForm: vi.fn(),
    saveSnapshot: vi.fn(),
    saveRaw: vi.fn(),
    applyImportedConfig: vi.fn(),
    readForm: vi.fn(),
    cancelAutoSave: vi.fn(),
    getSnapshot: vi.fn(),
    setSnapshot: vi.fn()
  };
}

export async function createEnglishPageMessages(
  overrides: Partial<Messages> = {}
): Promise<Messages> {
  return {
    ...(await getMessagesForLanguage('en')),
    ...overrides
  };
}

export type TestOptionsController = ReturnType<typeof createController>;

export function asOptionsController(controller: TestOptionsController): OptionsController {
  return controller as unknown as OptionsController;
}

function isCompleteOptions(merged: ReturnType<typeof mergeOptions>): merged is CompleteOptions {
  return Boolean(
    merged.aiChat &&
    merged.deepResearch &&
    merged.fragmentClipper &&
    merged.readingSession &&
    merged.video &&
    merged.classifier &&
    merged.experimentalAi &&
    merged.pageSummary &&
    merged.readingOverlaySummary &&
    merged.subtitleTranslation
  );
}

export function createCompleteOptions(stored?: StoredOptions | null): CompleteOptions {
  const merged = mergeOptions(stored);
  if (!isCompleteOptions(merged)) {
    throw new Error('Expected mergeOptions to produce a complete options fixture.');
  }
  return merged;
}

export function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

export function findCardByTitle(title: string): HTMLElement {
  const card = Array.from(document.querySelectorAll<HTMLElement>('.card')).find((candidate) =>
    Array.from(candidate.querySelectorAll('h2, h3')).some(
      (heading) => heading.textContent?.trim() === title
    )
  );
  if (!card) {
    throw new Error(`Missing card: ${title}`);
  }
  return card;
}

export function findInputByValue(value: string): HTMLInputElement {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(
    (candidate) => candidate.value === value
  );
  if (!input) {
    throw new Error(`Missing input with value: ${value}`);
  }
  return input;
}

export function requireElement<T extends Element>(
  element: T | null | undefined,
  description: string
): T {
  if (!element) {
    throw new Error(`Missing element: ${description}`);
  }
  return element;
}

export function queryRequired<T extends Element>(selector: string, root: ParentNode = document): T {
  return requireElement(root.querySelector<T>(selector), selector);
}

export function findYamlRowByField(value: string): HTMLElement | null {
  const fieldInput = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(
    (candidate) => candidate.value === value
  );
  return fieldInput?.closest<HTMLElement>('[data-row-id]') ?? null;
}

export function input(value: string, nextValue: string, eventName = 'input'): HTMLInputElement {
  const target = findInputByValue(value);
  target.value = nextValue;
  target.dispatchEvent(new Event(eventName, { bubbles: true }));
  return target;
}

export function createStorage() {
  const localStore = new Map<string, unknown>();
  const syncStore = new Map<string, unknown>();
  const createArea = (store: Map<string, unknown>) => ({
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    getMany: vi.fn((keys: string[]) =>
      Promise.resolve(
        keys.reduce<Record<string, unknown>>((result, key) => {
          result[key] = store.get(key);
          return result;
        }, {})
      )
    ),
    setMany: vi.fn((entries: Record<string, unknown>) => {
      Object.entries(entries).forEach(([key, value]) => store.set(key, value));
      return Promise.resolve();
    }),
    remove: vi.fn((key: string | string[]) => {
      (Array.isArray(key) ? key : [key]).forEach((entry) => store.delete(entry));
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      store.clear();
      return Promise.resolve();
    }),
    watchKey: vi.fn(() => () => {}),
    watchAll: vi.fn(() => () => {})
  });
  return {
    local: createArea(localStore),
    sync: createArea(syncStore)
  };
}

export function createRepository() {
  return {
    get: vi.fn(() => Promise.resolve(createCompleteOptions(null))),
    set: vi.fn(() => Promise.resolve()),
    onChange: vi.fn(() => () => {})
  };
}

export function createMessaging(result: unknown = undefined) {
  return {
    send: vi.fn(() => Promise.resolve(result)),
    onMessage: vi.fn(() => () => {})
  };
}

export function createActionRuntimeHarness() {
  const mountRoot = document.createElement('div');
  document.body.append(mountRoot);

  let draft = mergeOptions(null) as CompleteOptions;
  let appData = createProductionContent(stitchPreviewContent, draft);
  let state = applyOptionsToState(createInitialStitchState(appData), draft, appData);
  const trackUsageEventMock = vi.fn(() => Promise.resolve(undefined));
  const scrollToPanelMock = vi.fn();
  const openResourceMock = vi.fn();

  const runtime = createProductionStitchShellActionRuntime({
    mountRoot,
    buttonPressScrollGuard: {
      cleanup: vi.fn(),
      getSnapshot: vi.fn(() => null)
    },
    controller: {
      loadRaw: vi.fn(() => Promise.resolve(draft)),
      scheduleAutoSave: vi.fn()
    },
    optionsRepository: createRepository(),
    changeLanguage: vi.fn((language: Language) => Promise.resolve({ messages: null, language })),
    getAppData: () => appData,
    getCurrentLanguage: () => state.previewLanguage as Language,
    getCurrentMessages: () => null,
    getDraft: () => draft,
    getState: () => state,
    setConnectionNotice: vi.fn(),
    setDomainMappingRows: vi.fn(),
    setLanguageResource: ({ language }) => {
      state = { ...state, previewLanguage: language };
    },
    setMaintenanceLog: vi.fn(),
    setState: (nextState) => {
      state = nextState;
    },
    createSchemaContext: () => ({
      appData,
      language: state.previewLanguage,
      state
    }),
    mutate: (mutator) => {
      mutator(state);
    },
    currentDomainEntries: () => [],
    refreshAppData: () => {
      appData = createProductionContent(stitchPreviewContent, draft);
    },
    syncOverlayRuntimeState: vi.fn(),
    refreshOptions: (options) => {
      draft = mergeOptions(options) as CompleteOptions;
      appData = createProductionContent(stitchPreviewContent, draft);
      state = applyOptionsToState(state, draft, appData);
    },
    render: vi.fn(),
    renderActiveResourceModal: vi.fn(),
    scheduleDraftSave: vi.fn(),
    scrollToPanel: scrollToPanelMock,
    syncDomainEntries: vi.fn(),
    syncHighlightThemeControls: vi.fn(),
    syncModifierControls: vi.fn(),
    syncPreviewThemeControls: vi.fn(),
    openResource: openResourceMock,
    persistence: {
      clearAnalyticsPrivacyData: vi.fn(() => Promise.resolve()),
      copyConfigurationToClipboard: vi.fn(() => Promise.resolve()),
      importConfigurationWithStatus: vi.fn(() => Promise.resolve()),
      loadUsageStatsFromStorage: vi.fn(() => Promise.resolve()),
      persistPrivacyPreference: vi.fn(() => Promise.resolve()),
      repairConfiguration: vi.fn(() => Promise.resolve()),
      resetUsageData: vi.fn(() => Promise.resolve()),
      trackUsageEvent: trackUsageEventMock
    } as never,
    storageController: {
      activateVaultLocalFolder: vi.fn(() => Promise.resolve()),
      applyConnectionNotice: vi.fn(),
      chooseVaultLocalFolder: vi.fn(() => Promise.resolve()),
      clearVaultLocalFolder: vi.fn(),
      ensureVaultRouter: vi.fn(() => ({ vaults: [], rules: [], defaultVaultId: '' })),
      runVaultListConnectionTest: vi.fn(() => Promise.resolve({ success: true, message: 'ok' })),
      syncRoutingRulesToDraft: vi.fn(),
      updateVaultField: vi.fn()
    } as never,
    widgetHost: {
      collectDraftWithWidgets: vi.fn(() => draft),
      flushDirtyWidgets: vi.fn(),
      markDirty: vi.fn()
    } as never
  });

  return {
    runtime,
    scrollToPanelMock,
    openResourceMock,
    trackUsageEventMock
  };
}

export function findCheckboxInText(text: string): HTMLInputElement {
  const container = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.row, .consent-inline-item, .summary-toggle-item, .subtitle-inline-item'
    )
  ).find((candidate) => candidate.textContent?.includes(text));
  const checkbox = container?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) {
    throw new Error(`Missing checkbox for: ${text}`);
  }
  return checkbox;
}

export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function installSmoothMainScrollSimulation(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const values = new WeakMap<HTMLElement, number>();

  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return values.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const nextValue = Number(value) || 0;
      if (this.classList.contains('main') && this.style.scrollBehavior !== 'auto') {
        values.set(this, 0);
        return;
      }
      values.set(this, nextValue);
    }
  });

  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', original);
      return;
    }
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  };
}

export function setupProductionStitchShellTest(): void {
  document.documentElement.removeAttribute('data-theme');
  ensureWindowLocalStorage().clear();
  document.body.innerHTML = '<div id="optionsShellRoot"></div>';
  Object.assign(globalThis, {
    __AIIINOB_TEST_STITCH_ASSETS__: {
      previewContent,
      getFooterMeta,
      getFooterView,
      getSettingsView
    }
  });
  Object.values(analyticsMocks).forEach((mock) => mock.mockClear());
  analyticsMocks.getConfig.mockReturnValue({ debugMode: false });
  analyticsMocks.getUserConsent.mockResolvedValue({ analytics: false, errorReporting: false });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
}
