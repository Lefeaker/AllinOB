/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Messages } from '../../../src/i18n/messages';

type OnboardingRuntimeMessagesMock = Partial<Messages>;
type OnboardingControllerCtor =
  typeof import('../../../src/onboarding/bootstrap').OnboardingController;
type OnboardingNavigationRepo = ConstructorParameters<OnboardingControllerCtor>[0];
type OnboardingDependencies = NonNullable<ConstructorParameters<OnboardingControllerCtor>[1]>;

const defaultRuntimeMessagesMock = vi.hoisted<OnboardingRuntimeMessagesMock>(() => ({
  onboardingDocumentTitle: 'Zendio',
  step1Title: 'Configure Obsidian Local REST API',
  step1Description: 'Configure Obsidian Local REST API in Firefox.',
  step1Detail1: 'Install and enable the Local REST API plugin in Obsidian.',
  step1Detail2: 'Enable the HTTP server in the plugin settings.',
  step1Detail3: 'Note the HTTPS URL.',
  step1Detail4: 'Note the HTTP URL.',
  step1Detail5: 'Copy the API key.',
  step1Detail6: 'Run the connection test.',
  step1ChromeTitle: 'Connect Obsidian with Local Folder (Recommended)',
  step1ChromeDescription:
    'Use Local Folder first in Chrome and keep Obsidian Local REST API as the fallback.',
  step1ChromeDetail1: 'Open Storage and choose the vault row.',
  step1ChromeDetail2: 'Choose Local Folder.',
  step1ChromeDetail3: 'Keep folder permission active.',
  step1ChromeDetail4: 'Use Obsidian Local REST API if Local Folder is unavailable.',
  step1ChromeDetail5: 'Run the connection test.',
  step1ChromeDetail6: 'Configure routing after the default vault works.'
}));

const currentResourceMock = vi.hoisted<{
  value: { language: string; messages: OnboardingRuntimeMessagesMock };
}>(() => ({
  value: {
    language: 'en',
    messages: {
      onboardingDocumentTitle: 'Zendio',
      step1ChromeTitle: 'Connect Obsidian with Local Folder (Recommended)'
    }
  }
}));
const pageI18nControllerMock = vi.hoisted(() => ({
  load: vi.fn(() => Promise.resolve(undefined)),
  mount: vi.fn(),
  getCurrentResource: vi.fn(() => currentResourceMock.value)
}));
const createDefaultPageI18nControllerMock = vi.hoisted(() => vi.fn(() => pageI18nControllerMock));
const configureI18nStorageMock = vi.hoisted(() => vi.fn());
const resolveRepositoryMock = vi.hoisted(() => vi.fn());
const getServiceMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/i18n/locales', () => ({
  DEFAULT_RUNTIME_MESSAGES: defaultRuntimeMessagesMock
}));
vi.mock('../../../src/i18n/catalog/runtimeFallbackMessages', () => ({
  RUNTIME_FALLBACK_MESSAGES: defaultRuntimeMessagesMock
}));

vi.mock('../../../src/i18n', () => ({
  createDefaultPageI18nController: createDefaultPageI18nControllerMock,
  configureI18nStorage: configureI18nStorageMock,
  DEFAULT_RUNTIME_MESSAGES: defaultRuntimeMessagesMock
}));
vi.mock('../../../src/shared/di/serviceRegistry', () => ({
  resolveRepository: resolveRepositoryMock
}));
vi.mock('../../../src/shared/di', () => ({
  getService: getServiceMock
}));

function installLocalStorageMock(): void {
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      }
    }
  });
}

function buildOnboardingDom(): void {
  document.documentElement.lang = 'en';
  document.title = 'Zendio';
  document.body.innerHTML = `
    <button id="openVault"></button>
    <button id="configureApiBtn"></button>
    <button id="skipStep1Btn"></button>
    <button id="configureVaultsBtn"></button>
    <button id="skipStep2Btn"></button>
    <button id="exploreSettingsBtn"></button>
    <button id="skipStep3Btn"></button>
    <button id="exploreAuxiliaryBtn"></button>
    <button id="skipStep4Btn"></button>
    <a id="termsOfUseLink" href="#"></a>
    <a id="privacyPolicyLink" href="#"></a>
    <input id="onboardingAnalyticsConsent" type="checkbox" />
    <input id="onboardingErrorReportingConsent" type="checkbox" />
    <a id="officialWebsiteLink" href="#"></a>
    <a id="suggestionsLink" href="#"></a>
    <a id="supportLink" href="#"></a>
    <a id="contactLink" href="#"></a>
    <a id="changelogLink" href="#"></a>
    <button id="skipOnboardingBtn"></button>
    <button id="completeOnboardingBtn" class="hidden"></button>
    <div id="progressBar"></div>
    <div id="step1">
      <h2 data-i18n="step1Title" data-onboarding-step1-title>Initial REST Required Copy</h2>
      <p data-i18n="step1Description" data-onboarding-step1-description>
        Initial description.
      </p>
      <ul>
        <li data-i18n="step1Detail1" data-onboarding-step1-detail="1">Initial detail 1</li>
        <li data-i18n="step1Detail2" data-onboarding-step1-detail="2">Initial detail 2</li>
        <li data-i18n="step1Detail3" data-onboarding-step1-detail="3">Initial detail 3</li>
        <li data-i18n="step1Detail4" data-onboarding-step1-detail="4">Initial detail 4</li>
        <li data-i18n="step1Detail5" data-onboarding-step1-detail="5">Initial detail 5</li>
        <li data-i18n="step1Detail6" data-onboarding-step1-detail="6">Initial detail 6</li>
      </ul>
    </div>
    <div id="step2"></div>
    <div id="step3"></div>
    <div id="step4"></div>
    <div id="step5"></div>
  `;
}

async function waitForSentMessage(
  send: (message: unknown) => unknown,
  message: unknown
): Promise<void> {
  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith(message);
  });
}

function createStorageAreaMock() {
  return {
    get: vi.fn(() => Promise.resolve(undefined)),
    getAll: vi.fn(() => Promise.resolve({})),
    set: vi.fn(() => Promise.resolve(undefined)),
    getMany: vi.fn(() => Promise.resolve({})),
    setMany: vi.fn(() => Promise.resolve(undefined)),
    remove: vi.fn(() => Promise.resolve(undefined)),
    clear: vi.fn(() => Promise.resolve(undefined)),
    watchKey: vi.fn(() => () => {}),
    watchAll: vi.fn(() => () => {})
  };
}

function createNavigationRepoMock(): OnboardingNavigationRepo {
  return {
    openVault: vi.fn(() => Promise.resolve(undefined)),
    openOptions: vi.fn(() => Promise.resolve(undefined)),
    openExternalLink: vi.fn(() => Promise.resolve(undefined))
  };
}

function createOnboardingDependencies(
  overrides: Partial<OnboardingDependencies> = {}
): OnboardingDependencies {
  const syncArea = createStorageAreaMock();
  const localArea = createStorageAreaMock();
  const sessionArea = createStorageAreaMock();
  const sendMessage: OnboardingDependencies['tabs']['sendMessage'] = (_tabId, _message, _options) =>
    new Promise<never>(() => {});
  return {
    storage: {
      sync: syncArea,
      local: localArea,
      session: sessionArea
    },
    tabs: {
      create: vi.fn(() => Promise.resolve(undefined)),
      getCurrent: vi.fn(() => Promise.resolve(undefined)),
      remove: vi.fn(() => Promise.resolve(undefined)),
      get: vi.fn(() => Promise.resolve(undefined)),
      query: vi.fn(() => Promise.resolve([])),
      sendMessage,
      onActivated: vi.fn(() => () => {}),
      onUpdated: vi.fn(() => () => {}),
      onRemoved: vi.fn(() => () => {})
    },
    ...overrides
  };
}

function getInputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected #${id} to be an input`);
  }
  return input;
}

async function createSupportModalTestController() {
  const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
  type ModalTestDependencies = NonNullable<ConstructorParameters<typeof OnboardingController>[1]>;
  type ModalTestTabs = ModalTestDependencies['tabs'];
  const syncArea = createStorageAreaMock();
  const localArea = createStorageAreaMock();
  const sendMessage: ModalTestTabs['sendMessage'] = (
    _tabId: Parameters<ModalTestTabs['sendMessage']>[0],
    _message: Parameters<ModalTestTabs['sendMessage']>[1],
    _options?: Parameters<ModalTestTabs['sendMessage']>[2]
  ) => new Promise<never>(() => {});
  const navigationRepo = {
    openVault: vi.fn(() => Promise.resolve(undefined)),
    openOptions: vi.fn(() => Promise.resolve(undefined)),
    openExternalLink: vi.fn(() => Promise.resolve(undefined))
  } satisfies ConstructorParameters<typeof OnboardingController>[0];
  const dependencies = {
    storage: {
      sync: syncArea,
      local: localArea
    },
    tabs: {
      create: vi.fn(() => Promise.resolve(undefined)),
      getCurrent: vi.fn(() => Promise.resolve(undefined)),
      remove: vi.fn(() => Promise.resolve(undefined)),
      get: vi.fn(() => Promise.resolve(undefined)),
      query: vi.fn(() => Promise.resolve([])),
      sendMessage,
      onActivated: vi.fn(() => () => {}),
      onUpdated: vi.fn(() => () => {}),
      onRemoved: vi.fn(() => () => {})
    }
  } satisfies ConstructorParameters<typeof OnboardingController>[1];

  return new OnboardingController(navigationRepo, dependencies);
}

describe('onboarding bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.assign(defaultRuntimeMessagesMock, {
      onboardingDocumentTitle: 'Zendio',
      step1Title: 'Configure Obsidian Local REST API',
      step1Description: 'Configure Obsidian Local REST API in Firefox.',
      step1Detail1: 'Install and enable the Local REST API plugin in Obsidian.',
      step1Detail2: 'Enable the HTTP server in the plugin settings.',
      step1Detail3: 'Note the HTTPS URL.',
      step1Detail4: 'Note the HTTP URL.',
      step1Detail5: 'Copy the API key.',
      step1Detail6: 'Run the connection test.',
      step1ChromeTitle: 'Connect Obsidian with Local Folder (Recommended)',
      step1ChromeDescription:
        'Use Local Folder first in Chrome and keep Obsidian Local REST API as the fallback.',
      step1ChromeDetail1: 'Open Storage and choose the vault row.',
      step1ChromeDetail2: 'Choose Local Folder.',
      step1ChromeDetail3: 'Keep folder permission active.',
      step1ChromeDetail4: 'Use Obsidian Local REST API if Local Folder is unavailable.',
      step1ChromeDetail5: 'Run the connection test.',
      step1ChromeDetail6: 'Configure routing after the default vault works.'
    });
    currentResourceMock.value = {
      language: 'en',
      messages: {
        onboardingDocumentTitle: 'Zendio',
        step1ChromeTitle: 'Connect Obsidian with Local Folder (Recommended)'
      }
    };
    installLocalStorageMock();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn()
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as never);
    Reflect.deleteProperty(globalThis, 'browser');
    localStorage.clear();
    buildOnboardingDom();
  });

  it('sets document lang and title from the active onboarding runtime resource', async () => {
    currentResourceMock.value = {
      language: 'zh-CN',
      messages: {
        onboardingDocumentTitle: '欢迎使用 Zendio',
        step1ChromeTitle: '使用本地目录连接 Obsidian（推荐）'
      }
    };
    resolveRepositoryMock.mockReturnValue({
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    });

    const { bootstrapOnboardingApp } = await import('../../../src/onboarding/bootstrap');
    await bootstrapOnboardingApp();

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.title).toBe('欢迎使用 Zendio');
  });

  it('renders Chrome onboarding connection copy as local-folder-first recommendation', async () => {
    currentResourceMock.value = {
      language: 'zh-CN',
      messages: {
        onboardingDocumentTitle: '欢迎使用 Zendio',
        step1ChromeTitle: 'Chrome Local Folder Recommended Sentinel',
        step1ChromeDescription: 'Chrome should use Local Folder Sentinel.',
        step1ChromeDetail1: 'Local Folder Detail 1 Sentinel',
        step1ChromeDetail2: 'Local Folder Detail 2 Sentinel',
        step1ChromeDetail3: 'Local Folder Detail 3 Sentinel',
        step1ChromeDetail4: 'REST API Fallback Detail Sentinel',
        step1ChromeDetail5: 'Connection Test Detail Sentinel',
        step1ChromeDetail6: 'Routing Later Detail Sentinel',
        step1Title: 'Firefox REST Required Sentinel'
      }
    };
    resolveRepositoryMock.mockReturnValue({
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    });

    const { bootstrapOnboardingApp } = await import('../../../src/onboarding/bootstrap');
    await bootstrapOnboardingApp();

    const step1Text = document.getElementById('step1')?.textContent ?? '';
    expect(step1Text).toContain('Chrome Local Folder Recommended Sentinel');
    expect(step1Text).toContain('Local Folder Detail 1 Sentinel');
    expect(step1Text).toContain('REST API Fallback Detail Sentinel');
    expect(step1Text).not.toContain('Firefox REST Required Sentinel');
    expect(step1Text).not.toMatch(/Required|必须配置/u);
  });

  it('renders Firefox onboarding connection copy as REST API setup', async () => {
    currentResourceMock.value = {
      language: 'zh-CN',
      messages: {
        onboardingDocumentTitle: '欢迎使用 Zendio',
        step1Title: 'Firefox REST API Title Sentinel',
        step1Description: 'Firefox REST API Description Sentinel',
        step1Detail1: 'Firefox REST Detail 1 Sentinel',
        step1Detail2: 'Firefox REST Detail 2 Sentinel',
        step1Detail3: 'Firefox REST Detail 3 Sentinel',
        step1Detail4: 'Firefox REST Detail 4 Sentinel',
        step1Detail5: 'Firefox REST Detail 5 Sentinel',
        step1Detail6: 'Firefox REST Detail 6 Sentinel',
        step1ChromeTitle: 'Chrome Local Folder Hidden Sentinel'
      }
    };
    resolveRepositoryMock.mockReturnValue({
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    });
    getServiceMock.mockReturnValue({
      storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
      runtime: {
        getURL: vi.fn((path: string) => `moz-extension://test/${path}`),
        getBrowserTarget: vi.fn<() => 'firefox'>(() => 'firefox')
      },
      tabs: {
        getCurrent: vi.fn(() => Promise.resolve(undefined)),
        remove: vi.fn(() => Promise.resolve(undefined))
      }
    });

    const { bootstrapOnboardingApp } = await import('../../../src/onboarding/bootstrap');
    await bootstrapOnboardingApp();

    const step1Text = document.getElementById('step1')?.textContent ?? '';
    expect(step1Text).toContain('Firefox REST API Title Sentinel');
    expect(step1Text).toContain('Firefox REST Detail 6 Sentinel');
    expect(step1Text).not.toContain('Chrome Local Folder Hidden Sentinel');
  });

  it('restores completed steps and updates progress on initialize', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    localStorage.setItem('onboardingCompletedSteps', JSON.stringify([1, 3]));
    const controller = new OnboardingController(
      {
        openVault: vi.fn(() => Promise.resolve(undefined)),
        openOptions: vi.fn(() => Promise.resolve(undefined)),
        openExternalLink: vi.fn(() => Promise.resolve(undefined))
      } as never,
      {
        storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
        tabs: {
          getCurrent: vi.fn(() => Promise.resolve(undefined)),
          remove: vi.fn(() => Promise.resolve(undefined))
        }
      } as never
    );

    controller.initialize();

    expect(localStorage.getItem('onboardingCompletedSteps')).toContain('1');
    expect(document.getElementById('step3')?.classList.contains('step-completed')).toBe(true);
    expect(document.getElementById('progressBar')?.getAttribute('style')).toContain('width: 40%');
  });

  it('marks steps, opens support flow, and completes onboarding lifecycle', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const navigationRepo = {
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    };
    const storageSet = vi.fn(() => Promise.resolve(undefined));
    const tabsRemove = vi.fn(() => Promise.resolve(undefined));
    const controller = new OnboardingController(
      navigationRepo as never,
      {
        storage: { local: { set: storageSet } },
        tabs: { getCurrent: vi.fn(() => Promise.resolve({ id: 77 })), remove: tabsRemove }
      } as never
    );

    controller.initialize();
    document
      .getElementById('configureApiBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigationRepo.openOptions).toHaveBeenCalledTimes(1);

    document
      .getElementById('skipStep1Btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(localStorage.getItem('onboardingCompletedSteps') ?? '').toContain('1');

    document
      .getElementById('suggestionsLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });
    expect(document.querySelector('.resource-modal')?.textContent).toContain('Suggestions');
    expect(navigationRepo.openExternalLink).not.toHaveBeenCalled();

    document
      .getElementById('skipOnboardingBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(storageSet).toHaveBeenCalledWith('onboardingCompleted', true);
  });

  it('renders the support modal from onboarding catalog messages', async () => {
    currentResourceMock.value = {
      language: 'en',
      messages: {
        onboardingDocumentTitle: 'Zendio',
        schemaResourceSupportTitle: 'Support Title Sentinel',
        schemaResourceSupportDescription: 'Support Description Sentinel',
        schemaResourceSupportKoFiTitle: 'Ko-fi Title Sentinel',
        schemaResourceSupportAfdianTitle: 'WeChat Reward Title Sentinel',
        schemaResourceSupportAfdianDescription: 'WeChat Reward Description Sentinel'
      }
    };

    const controller = await createSupportModalTestController();

    controller.initialize();
    document
      .getElementById('supportLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });

    const modal = document.querySelector('.resource-modal');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('Support Title Sentinel');
    expect(modal?.textContent).toContain('Support Description Sentinel');
    expect(modal?.textContent).toContain('Ko-fi Title Sentinel');
    expect(modal?.textContent).toContain('WeChat Reward Title Sentinel');
    expect(modal?.querySelector('[data-role="resource-image-modal-trigger"]')).not.toBeNull();
    expect(document.querySelector('.support-modal')).toBeNull();
    expect(modal?.textContent).not.toContain('感谢支持');
    expect(modal?.textContent).not.toContain('爱发电');
  });

  it('uses default onboarding runtime messages when page resources are unavailable', async () => {
    currentResourceMock.value = {
      language: 'en',
      messages: {}
    };

    const controller = await createSupportModalTestController();

    controller.initialize();
    document
      .getElementById('supportLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });

    const modal = document.querySelector('.resource-modal');
    const modalText = modal?.textContent ?? '';
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Zendio');
    expect(modalText).toContain('Support');
    expect(modal?.querySelector('[data-role="resource-image-modal-trigger"]')).not.toBeNull();
    expect(document.querySelector('.support-modal')).toBeNull();
    expect(modalText).not.toMatch(/\p{Script=Han}/u);
  });

  it('opens the official website externally for non-Chinese interface languages and renders changelog from the shared resource modal', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const openExternalLink = vi.fn(() => Promise.resolve(undefined));
    const navigationRepo: OnboardingNavigationRepo = {
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink
    };
    const controller = new OnboardingController(navigationRepo, createOnboardingDependencies());

    controller.initialize();
    document
      .getElementById('officialWebsiteLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(openExternalLink).toHaveBeenCalledWith('https://zendio.sxnian.com/en/');

    document
      .getElementById('changelogLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });

    expect(document.querySelector('.resource-modal')?.textContent).toContain('Changelog');
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'zh-TW'] as const)(
    'opens the Chinese official website for %s interface language',
    async (language) => {
      const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
      const openExternalLink = vi.fn(() => Promise.resolve(undefined));
      const navigationRepo: OnboardingNavigationRepo = {
        openVault: vi.fn(() => Promise.resolve(undefined)),
        openOptions: vi.fn(() => Promise.resolve(undefined)),
        openExternalLink
      };
      document.documentElement.lang = language;
      const controller = new OnboardingController(navigationRepo, createOnboardingDependencies());

      controller.initialize();
      document
        .getElementById('officialWebsiteLink')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();

      expect(openExternalLink).toHaveBeenCalledWith('https://zendio.sxnian.com/');
    }
  );

  it('opens terms of use and privacy policy inline from the first-run agreement card', async () => {
    currentResourceMock.value = {
      language: 'en',
      messages: {
        onboardingDocumentTitle: 'Zendio',
        schemaResourceTermsTitle: 'Terms of Use Sentinel',
        schemaResourceTermsDescription: 'Terms description sentinel',
        schemaResourcePrivacyPolicyTitle: 'Privacy Policy Sentinel',
        schemaResourcePrivacyPolicyDescription: 'Privacy description sentinel'
      }
    };
    const controller = await createSupportModalTestController();

    controller.initialize();
    document
      .getElementById('termsOfUseLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });
    expect(document.querySelector('.resource-modal')?.textContent).toContain(
      'Terms of Use Sentinel'
    );

    document.querySelectorAll('.resource-modal-overlay').forEach((modal) => modal.remove());
    document
      .getElementById('privacyPolicyLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });
    expect(document.querySelector('.resource-modal')?.textContent).toContain(
      'Privacy Policy Sentinel'
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it('syncs first-run analytics and error diagnostic toggles with Options privacy preferences', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const optionsRepository = {
      get: vi.fn(() =>
        Promise.resolve({
          privacyPreferences: {
            analytics: false,
            errorReporting: true,
            debugMode: true
          }
        })
      ),
      set: vi.fn(() => Promise.resolve(undefined))
    };
    const controller = new OnboardingController(
      createNavigationRepoMock(),
      createOnboardingDependencies({
        optionsRepository
      })
    );

    controller.initialize();
    const analytics = getInputById('onboardingAnalyticsConsent');
    const errorReporting = getInputById('onboardingErrorReportingConsent');
    await vi.waitFor(() => {
      expect(analytics?.checked).toBe(false);
      expect(errorReporting?.checked).toBe(true);
    });

    analytics?.click();
    await vi.waitFor(() => {
      expect(optionsRepository.set).toHaveBeenCalledWith({
        privacyPreferences: {
          analytics: true,
          errorReporting: true,
          debugMode: true
        }
      });
    });

    errorReporting?.click();
    await vi.waitFor(() => {
      expect(optionsRepository.set).toHaveBeenLastCalledWith({
        privacyPreferences: {
          analytics: true,
          errorReporting: false,
          debugMode: false
        }
      });
    });
  });

  it('emits catalog-safe onboarding lifecycle telemetry for consented users', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const navigationRepo = {
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    };
    let now = 0;
    const messagingRepository = {
      send: vi.fn(() => Promise.resolve(undefined))
    };
    const optionsRepository = {
      get: vi.fn(() =>
        Promise.resolve({
          privacyPreferences: {
            analytics: true
          }
        })
      )
    };
    const controller = new OnboardingController(
      navigationRepo as never,
      {
        storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
        tabs: {
          getCurrent: vi.fn(() => Promise.resolve({ id: 42 })),
          remove: vi.fn(() => Promise.resolve(undefined))
        },
        messagingRepository,
        now: () => now,
        optionsRepository
      } as never
    );

    controller.initialize();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_started',
      params: { source: 'install' }
    });

    now = 150;
    document
      .getElementById('configureApiBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_step_completed',
      params: {
        step: 'welcome',
        duration_bucket: '100ms_to_499ms'
      }
    });
    expect(messagingRepository.send).not.toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_step_completed',
      params: {
        step: 'welcome',
        duration_ms: 150,
        step_index: 1
      }
    });

    now = 400;
    document
      .getElementById('skipStep2Btn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_skipped',
      params: {
        step: 'vault'
      }
    });
    expect(messagingRepository.send).not.toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_step_completed',
      params: {
        step: 'vault',
        duration_bucket: '100ms_to_499ms'
      }
    });

    now = 3_500;
    document
      .getElementById('supportLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localStorage.getItem('onboardingCompletedSteps') ?? '').toContain('5');
    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_support_action',
      params: {
        action: 'docs'
      }
    });
    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_step_completed',
      params: {
        step: 'finish',
        duration_bucket: '3s_to_9s'
      }
    });
    expect(messagingRepository.send).not.toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_support_action',
      params: {
        action: 'docs',
        url: 'https://ko-fi.com/xiannian'
      }
    });

    now = 4_500;
    document
      .getElementById('skipOnboardingBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_completed',
      params: {
        duration_bucket: '3s_to_9s'
      }
    });
  });

  it('emits feedback/contact support actions without changing base contact completion semantics', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const messagingRepository = {
      send: vi.fn(() => Promise.resolve(undefined))
    };
    const optionsRepository = {
      get: vi.fn(() =>
        Promise.resolve({
          privacyPreferences: {
            analytics: true
          }
        })
      )
    };
    const controller = new OnboardingController(
      {
        openVault: vi.fn(() => Promise.resolve(undefined)),
        openOptions: vi.fn(() => Promise.resolve(undefined)),
        openExternalLink: vi.fn(() => Promise.resolve(undefined))
      } as never,
      {
        storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
        tabs: {
          getCurrent: vi.fn(() => Promise.resolve(undefined)),
          remove: vi.fn(() => Promise.resolve(undefined))
        },
        messagingRepository,
        now: () => 3_200,
        optionsRepository
      } as never
    );

    controller.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    localStorage.removeItem('onboardingCompletedSteps');

    document
      .getElementById('contactLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });

    expect(document.querySelector('.resource-modal')?.textContent).toContain('Contact');
    expect(window.open).not.toHaveBeenCalled();
    expect(localStorage.getItem('onboardingCompletedSteps')).toBeNull();
    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_support_action',
      params: {
        action: 'contact'
      }
    });
    expect(messagingRepository.send).not.toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_step_completed',
      params: {
        step: 'finish',
        duration_bucket: '3s_to_9s'
      }
    });

    document.querySelectorAll('.resource-modal-overlay').forEach((modal) => modal.remove());
    document
      .getElementById('suggestionsLink')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('.resource-modal')).not.toBeNull();
    });

    expect(document.querySelector('.resource-modal')?.textContent).toContain('Suggestions');
    expect(window.open).not.toHaveBeenCalled();
    await waitForSentMessage(messagingRepository.send, {
      type: 'ANALYTICS_EVENT',
      event: 'onboarding_support_action',
      params: {
        action: 'feedback'
      }
    });
    expect(localStorage.getItem('onboardingCompletedSteps') ?? '').toContain('5');
  });

  it('does not emit onboarding telemetry before analytics consent exists', async () => {
    const { OnboardingController } = await import('../../../src/onboarding/bootstrap');
    const messagingRepository = {
      send: vi.fn(() => Promise.resolve(undefined))
    };
    const optionsRepository = {
      get: vi.fn(() =>
        Promise.resolve({
          privacyPreferences: {
            analytics: false
          }
        })
      )
    };
    const controller = new OnboardingController(
      {
        openVault: vi.fn(() => Promise.resolve(undefined)),
        openOptions: vi.fn(() => Promise.resolve(undefined)),
        openExternalLink: vi.fn(() => Promise.resolve(undefined))
      } as never,
      {
        storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
        tabs: {
          getCurrent: vi.fn(() => Promise.resolve(undefined)),
          remove: vi.fn(() => Promise.resolve(undefined))
        },
        messagingRepository,
        now: () => 0,
        optionsRepository
      } as never
    );

    controller.initialize();
    await Promise.resolve();
    document
      .getElementById('configureApiBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(messagingRepository.send).not.toHaveBeenCalled();
  });

  it('bootstraps controller from resolved dependencies', async () => {
    const navigationRepo = {
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    };
    resolveRepositoryMock.mockReturnValue(navigationRepo);
    getServiceMock.mockReturnValue({
      storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
      tabs: {
        getCurrent: vi.fn(() => Promise.resolve(undefined)),
        remove: vi.fn(() => Promise.resolve(undefined))
      }
    });

    const mod = await import('../../../src/onboarding/bootstrap');
    await mod.bootstrapOnboardingApp();

    document
      .getElementById('configureVaultsBtn')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(navigationRepo.openOptions).toHaveBeenCalledTimes(1);
    expect(createDefaultPageI18nControllerMock).toHaveBeenCalledTimes(1);
  });

  it('applies the stored options theme during bootstrap', async () => {
    const navigationRepo = {
      openVault: vi.fn(() => Promise.resolve(undefined)),
      openOptions: vi.fn(() => Promise.resolve(undefined)),
      openExternalLink: vi.fn(() => Promise.resolve(undefined))
    };
    const optionsRepo = {
      get: vi.fn(() => Promise.resolve({ interfaceTheme: 'light' }))
    };
    resolveRepositoryMock.mockReturnValueOnce(optionsRepo).mockReturnValue(navigationRepo);
    getServiceMock.mockReturnValue({
      storage: { local: { set: vi.fn(() => Promise.resolve(undefined)) } },
      tabs: {
        getCurrent: vi.fn(() => Promise.resolve(undefined)),
        remove: vi.fn(() => Promise.resolve(undefined))
      }
    });

    const mod = await import('../../../src/onboarding/bootstrap');
    await mod.bootstrapOnboardingApp();

    expect(document.documentElement.dataset.previewTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.body.dataset.previewTheme).toBe('light');
  });
});
