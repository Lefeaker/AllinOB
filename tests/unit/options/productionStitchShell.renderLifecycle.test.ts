/* @vitest-environment jsdom */

import { DEFAULT_RUNTIME_MESSAGES } from '@i18n';
import * as productionStitchShellContextModule from '@options/app/productionStitchShellContext';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asOptionsController,
  createController,
  createMessaging,
  findButton,
  findCardByTitle,
  findInputByValue,
  findYamlRowByField,
  flushPromises,
  installSmoothMainScrollSimulation,
  queryRequired,
  requireElement,
  setupProductionStitchShellTest
} from './productionStitchShell.helpers';
import { createProductionStitchRenderLifecycle } from '@options/app/productionStitchRenderLifecycle';
import { mountProductionStitchShell } from '@options/app/productionStitchShell';
import { previewContent } from '@options/stitch/content';
import { getFooterMeta, getFooterView, getSettingsView } from '@options/stitch/schema/registry';
import { mergeOptions } from '@shared/config/optionsMerger';
import type { StoredOptions } from '@shared/types';

function withLegacyRootDir<TRest extends NonNullable<StoredOptions['rest']>>(
  rest: TRest,
  rootDir: string
): TRest & { rootDir: string } {
  return Object.assign(rest, { rootDir });
}

describe('mountProductionStitchShell renderLifecycle', () => {
  beforeEach(setupProductionStitchShellTest);

  it('mounts the shared Stitch shell and exposes the required lifecycle API', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: { rest: { vault: 'Research Vault' } },
      messages: null,
      language: 'en',
      messagingRepository: createMessaging({ success: true, message: 'ok' })
    } as never);

    expect(document.querySelector('.sidebar')).toBeTruthy();
    expect(document.querySelector('.brand-copy strong')?.textContent).toBe('Zendio');
    const brandLink = document.querySelector<HTMLAnchorElement>('.brand-title-link');
    expect(brandLink?.textContent).toBe('Zendio');
    expect(brandLink?.getAttribute('href')).toBe('https://zendio.sxnian.com/en/');
    expect(brandLink?.getAttribute('target')).toBe('_blank');
    expect(brandLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('.brand-copy span')?.textContent).toMatch(/^v\d+\.\d+\.\d+/);
    const brandLogo = document.querySelector<HTMLImageElement>('.brand-mark img');
    expect(brandLogo?.getAttribute('src')).toBe('../icons/bannerlogo-128.png');
    expect(document.querySelector('[data-nav-panel="overview"]')).toBeTruthy();
    expect(document.querySelector('[data-panel-id="storage"]')).toBeTruthy();
    expect(document.querySelector('.nav-group > .nav-title')).toBeNull();
    expect(document.querySelector('.sidebar')?.textContent).not.toContain('Resources');
    expect(document.querySelector('.sidebar')?.textContent).not.toContain('Settings');
    expect(document.querySelector('.sidebar')?.textContent).not.toContain('Runtime UI');
    expect(document.querySelector('[data-footer-panel="clipper"]')).toBeNull();
    expect(typeof mounted.cleanup).toBe('function');
    expect(typeof mounted.collectDraft).toBe('function');
    expect(typeof mounted.refreshOptions).toBe('function');
    expect(typeof mounted.setMessages).toBe('function');
  });

  it('resolves production shell image assets through the injected resolver', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en',
      runtime: {
        getURL: (path: string) => `extension-root://${path}`,
        getBrowserTarget: () => 'chrome'
      }
    } as never);

    const brandLogo = document.querySelector<HTMLImageElement>('.brand-mark img');
    expect(brandLogo?.getAttribute('src')).toBe('extension-root://icons/bannerlogo-128.png');
  });

  it('collectDraft returns complete options and preserves refreshed fields', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: { rest: { vault: 'Research Vault' } },
      messages: null,
      language: 'en'
    });

    expect(mounted.collectDraft()).toEqual(
      expect.objectContaining({
        ...mergeOptions({ rest: { vault: 'Research Vault' } }),
        rest: expect.objectContaining({ vault: 'Research Vault' }) as unknown
      })
    );

    mounted.refreshOptions({ aiChat: { userName: 'Alice' } });
    expect(mounted.collectDraft().aiChat.userName).toBe('Alice');
  });

  it('setMessages recreates schema context with the new language while keeping the version subtitle', () => {
    const controller = createController();
    const schemaContextSpy = vi.spyOn(
      productionStitchShellContextModule,
      'createProductionStitchSchemaContext'
    );
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'zh-CN'
    });

    expect(
      document.querySelector<HTMLAnchorElement>('.brand-title-link')?.getAttribute('href')
    ).toBe('https://zendio.sxnian.com/');

    mounted.setMessages(
      {
        ...DEFAULT_RUNTIME_MESSAGES,
        schemaOverviewTitle: 'Overview From Messages',
        extensionSubtitle: 'Production Shell'
      },
      'en'
    );

    const recreatedContextInput = schemaContextSpy.mock.calls.at(-1)?.[0];
    if (!recreatedContextInput) {
      throw new Error('Expected schema context recreation call.');
    }
    const recreatedContext =
      productionStitchShellContextModule.createProductionStitchSchemaContext(recreatedContextInput);
    expect(recreatedContext.language).toBe('en');
    expect(recreatedContext.messages?.schemaOverviewTitle).toBe('Overview From Messages');
    expect(recreatedContext.t?.('schemaOverviewTitle', 'Fallback')).toBe('Overview From Messages');
    expect(document.querySelector('.brand-copy span')?.textContent).toMatch(/^v\d+\.\d+\.\d+/);
    expect(
      document.querySelector<HTMLAnchorElement>('.brand-title-link')?.getAttribute('href')
    ).toBe('https://zendio.sxnian.com/en/');

    mounted.cleanup();
    expect(document.getElementById('optionsShellRoot')?.innerHTML).toBe('');
  });

  it('cleanup detaches shell theme listeners and clears the mount root', () => {
    const controller = createController();
    const media = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as never);

    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: { interfaceTheme: 'system' },
      messages: null,
      language: 'en'
    });

    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(document.getElementById('optionsShellRoot')?.innerHTML).not.toBe('');

    mounted.cleanup();

    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(document.getElementById('optionsShellRoot')?.innerHTML).toBe('');
  });

  it('tests modal render lifecycle without widget-host mutation', () => {
    const mountRoot = document.createElement('div');
    mountRoot.innerHTML =
      '<div class="resource-modal-overlay"></div><div data-modal-host="true"></div>';
    const flushDirtyWidgets = vi.fn();
    const destroyWidgets = vi.fn();
    const lifecycle = createProductionStitchRenderLifecycle({
      mountRoot,
      getAppData: () => ({ overview: { history: [] }, nav: [] }) as never,
      getCurrentLanguage: () => 'en',
      getState: () => ({ activeResource: null }) as never,
      setState: vi.fn(),
      createSchemaContext: () =>
        ({ appData: { nav: [], sidebarLinks: [], surfaceLinks: [] }, state: {} }) as never,
      dispatch: vi.fn(),
      resolveAssetUrl: (path) => path,
      schemaRenderer: { renderView: vi.fn() },
      widgetHost: {
        createWidgetFactory: vi.fn(),
        destroyWidgets,
        flushDirtyWidgets,
        mountWidget: vi.fn()
      }
    });

    lifecycle.renderActiveResourceModal();

    expect(mountRoot.querySelector('.resource-modal-overlay')).toBeNull();
    expect(flushDirtyWidgets).not.toHaveBeenCalled();
    expect(destroyWidgets).not.toHaveBeenCalled();
  });

  it('binds production option values and schedules autosave after edits', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: { vault: 'Bob Vault' },
        video: { promptButtonLabel: 'Clip this video', promptShortcut: 'Alt+Shift+V' }
      },
      messages: null,
      language: 'en',
      messagingRepository: createMessaging({ success: true, message: 'ok' })
    } as never);

    const vaultNameInput = findInputByValue('Bob Vault');

    vaultNameInput.value = 'Alice Vault';
    vaultNameInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(vi.mocked(controller.scheduleAutoSave)).toHaveBeenCalledTimes(1);
    expect(mounted.collectDraft().rest.vault).toBe('Alice Vault');
  });

  it('dispatches additional owner-provided Stitch action handlers', () => {
    const controller = createController();
    const actionHandler = vi.fn();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en',
      additionalActionHandlers: {
        'owner-extension:run': actionHandler
      },
      getSettingsView: (id, ctx) => {
        const view = getSettingsView(id, ctx);
        if (id !== 'overview' || !view) {
          return view;
        }
        return {
          ...view,
          children: [
            ...(view.children ?? []),
            {
              kind: 'button',
              label: 'Run owner extension action',
              action: { id: 'owner-extension:run' }
            }
          ]
        };
      },
      getFooterMeta,
      getFooterView,
      previewContent
    });

    findButton('Run owner extension action').click();

    expect(actionHandler).toHaveBeenCalledTimes(1);
    expect(actionHandler.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        descriptor: { id: 'owner-extension:run', args: [] }
      })
    );
  });

  it('keeps built-in Stitch actions authoritative over additional owner handlers', () => {
    const controller = createController();
    const ownerOverride = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en',
      additionalActionHandlers: {
        'routing:add': ownerOverride
      }
    });

    findButton('Add Rule').click();

    expect(ownerOverride).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Options] Ignoring additional Stitch action handler for "routing:add".'
    );
    warn.mockRestore();
  });

  it('prevents mouse button presses from moving the production Options scroller', async () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });
    await flushPromises();

    const main = queryRequired<HTMLElement>('.main');
    main.scrollTop = 420;

    const yamlAddButton = findButton('+ Add field');
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    yamlAddButton.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector<HTMLElement>('.main')?.scrollTop).toBe(420);
  });

  it('renders Video Prompt & Entry switches in one horizontal body row instead of the card header', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        video: { floatingPromptEnabled: true, commentEditorAutoPause: true }
      },
      messages: null,
      language: 'en'
    });

    const card = findCardByTitle('Video Prompt & Entry');
    const header = card.querySelector<HTMLElement>('.card-header');
    expect(header?.textContent).not.toContain('Show note button on video sites');
    expect(header?.textContent).not.toContain('Pause video while editing notes');

    const videoEntryRow = requireElement(
      card.querySelector<HTMLElement>('.video-entry-toggle-row'),
      'video entry toggle row'
    );
    expect(videoEntryRow.textContent).toContain('Show note button on video sites');
    expect(videoEntryRow.textContent).toContain('Pause video while editing notes');
    const [promptSwitch, autoPauseSwitch] = Array.from(
      videoEntryRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    expect([promptSwitch, autoPauseSwitch]).toHaveLength(2);
    expect(promptSwitch?.checked).toBe(true);
    expect(autoPauseSwitch?.checked).toBe(true);
    expect(card.textContent).toContain(
      'Grey dots mean no screenshot has been saved for that timestamp yet.'
    );
    expect(card.textContent).toContain('Green dots mean a screenshot is already attached.');
  });

  it('renders video screenshot attachment inputs, hydrates merged values, and preserves string writes', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        video: {
          floatingPromptEnabled: false,
          commentEditorAutoPause: false,
          screenshotAttachment: {
            locationTemplate: 'VideoShots/${noteFileName}',
            markdownUrlFormat: '![[${fileName}]]'
          }
        }
      },
      messages: null,
      language: 'en'
    });

    const card = findCardByTitle('Video Prompt & Entry');
    expect(card.textContent).toContain('Attachment path configuration');
    expect(card.textContent).toContain('Custom Attachment Location');
    expect(
      card.querySelector<HTMLAnchorElement>(
        'a[href="https://github.com/mnaoumov/obsidian-custom-attachment-location"]'
      )
    ).toBeTruthy();

    const rows = Array.from(card.querySelectorAll<HTMLElement>('.row'));
    const locationRow = rows.find((row) =>
      row.textContent?.includes('Attachment location template')
    );
    const fileNameRow = rows.find((row) =>
      row.textContent?.includes('Attachment filename template')
    );
    const markdownRow = rows.find((row) => row.textContent?.includes('Markdown URL format'));

    const locationInput = queryRequired<HTMLInputElement>(
      'input',
      requireElement(locationRow, 'Attachment location template row')
    );
    const fileNameInput = queryRequired<HTMLInputElement>(
      'input',
      requireElement(fileNameRow, 'Attachment filename template row')
    );
    const markdownInput = queryRequired<HTMLInputElement>(
      'input',
      requireElement(markdownRow, 'Markdown URL format row')
    );

    expect(locationInput.value).toBe('VideoShots/${noteFileName}');
    expect(fileNameInput.value).toBe("file-${date:{momentJsFormat:'YYYYMMDDHHmmssSSS'}}.jpg");
    expect(markdownInput.value).toBe('![[${fileName}]]');

    locationInput.value = 'Assets/${noteFileName}';
    locationInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileNameInput.value = 'capture-${title}.jpg';
    fileNameInput.dispatchEvent(new Event('input', { bubbles: true }));
    markdownInput.value = '![](${attachmentUrl})';
    markdownInput.dispatchEvent(new Event('input', { bubbles: true }));

    const videoEntryRow = requireElement(
      card.querySelector<HTMLElement>('.video-entry-toggle-row'),
      'video entry toggle row'
    );
    const videoEntrySwitches = Array.from(
      videoEntryRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    expect(videoEntrySwitches).toHaveLength(2);
    const promptCheckbox = requireElement(videoEntrySwitches[0], 'video prompt switch');
    const autoPauseCheckbox = requireElement(videoEntrySwitches[1], 'video auto-pause switch');
    promptCheckbox.checked = true;
    promptCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    autoPauseCheckbox.checked = true;
    autoPauseCheckbox.dispatchEvent(new Event('change', { bubbles: true }));

    expect(mounted.collectDraft().video).toEqual(
      expect.objectContaining({
        floatingPromptEnabled: true,
        commentEditorAutoPause: true,
        screenshotAttachment: {
          locationTemplate: 'Assets/${noteFileName}',
          fileNameTemplate: 'capture-${title}.jpg',
          markdownUrlFormat: '![](${attachmentUrl})'
        }
      })
    );
  });

  it('opens onboarding through the production onboarding page path', () => {
    const controller = createController();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    findButton('Setup Guide').click();

    expect(openSpy).toHaveBeenCalledWith(
      '../onboarding/index.html',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('keeps the Options scroller stable when Vault List actions re-render', async () => {
    const restoreScrollDescriptor = installSmoothMainScrollSimulation();
    const controller = createController();
    const messagingRepository = createMessaging({ success: true, message: 'ok' });
    try {
      mountProductionStitchShell({
        controller: asOptionsController(controller),
        initialOptions: {
          rest: { vault: 'Research Vault' }
        },
        messages: null,
        language: 'en',
        messagingRepository
      } as never);
      const main = queryRequired<HTMLElement>('.main');
      main.style.scrollBehavior = 'auto';
      main.scrollTop = 520;
      main.style.removeProperty('scroll-behavior');

      const addVaultButton = findButton('Add Vault');
      const pointerEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      addVaultButton.dispatchEvent(pointerEvent);
      document.getElementById('optionsShellRoot')?.addEventListener(
        'click',
        () => {
          const currentMain = document.querySelector<HTMLElement>('.main');
          if (currentMain) {
            currentMain.scrollTop = 0;
          }
        },
        { capture: true, once: true }
      );

      addVaultButton.click();
      await flushPromises();
      expect(document.querySelector<HTMLElement>('.main')?.scrollTop).toBe(520);

      const currentMain = queryRequired<HTMLElement>('.main');
      currentMain.style.scrollBehavior = 'auto';
      currentMain.scrollTop = 520;
      currentMain.style.removeProperty('scroll-behavior');
      findButton('Delete').click();
      await flushPromises();
      expect(document.querySelector<HTMLElement>('.main')?.scrollTop).toBe(520);

      const finalMain = queryRequired<HTMLElement>('.main');
      finalMain.style.scrollBehavior = 'auto';
      finalMain.scrollTop = 520;
      finalMain.style.removeProperty('scroll-behavior');
      findButton('Test Connection').click();
      await flushPromises();
      expect(document.querySelector<HTMLElement>('.main')?.scrollTop).toBe(520);
    } finally {
      restoreScrollDescriptor();
    }
  });

  it('uses an immediate scroll fallback when sidebar navigation targets a panel', () => {
    const restoreScrollDescriptor = installSmoothMainScrollSimulation();
    const controller = createController();
    try {
      mountProductionStitchShell({
        controller: asOptionsController(controller),
        initialOptions: null,
        messages: null,
        language: 'en'
      });

      const main = queryRequired<HTMLElement>('.main');
      const storageSection = queryRequired<HTMLElement>('[data-panel-id="storage"]');
      Object.defineProperty(storageSection, 'offsetTop', {
        configurable: true,
        value: 640
      });

      queryRequired<HTMLButtonElement>('[data-nav-panel="storage"]').click();

      expect(main.scrollTop).toBe(628);
      expect(
        queryRequired<HTMLElement>('[data-nav-panel="storage"]').classList.contains('is-active')
      ).toBe(true);
    } finally {
      restoreScrollDescriptor();
    }
  });

  it('does not render the future experimental panel in the release options shell', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        pageSummary: { enabled: true },
        readingOverlaySummary: { enabled: true },
        subtitleTranslation: { enabled: true, targetLanguage: 'en' }
      },
      messages: null,
      language: 'en'
    });

    expect(document.querySelector('[data-nav-panel="experimental"]')).toBeFalsy();
    expect(document.body.textContent).not.toContain('敬请期待');
    expect(document.body.textContent).not.toContain('Coming soon');
    expect(document.body.textContent).not.toContain('启用视频字幕翻译');
    expect(document.body.textContent).not.toContain('实验功能预留项');

    const collected = mounted.collectDraft();
    expect(collected.pageSummary.enabled).toBe(false);
    expect(collected.readingOverlaySummary.enabled).toBe(false);
    expect(collected.subtitleTranslation).toEqual({ enabled: false, targetLanguage: 'en' });
    expect(vi.mocked(controller.scheduleAutoSave)).not.toHaveBeenCalled();
  });

  it('uses schema controls as the single source for storage/domain and keeps only the structured YAML widget mounted', async () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: withLegacyRootDir({ vault: 'Widget Vault' }, 'WidgetRoot/'),
        domainMappings: { 'widget.example': 'widget-folder' }
      },
      messages: null,
      language: 'en'
    });

    expect(document.querySelector('.rest-storage-widget')).toBeFalsy();
    expect(document.querySelector('.domain-mappings-widget')).toBeFalsy();
    await flushPromises();
    expect(document.querySelector('.stitch-yaml-config-table')).toBeTruthy();
    expect(document.querySelector('[data-role="yaml-config-view"]')).toBeFalsy();
  });

  it('flushes dirty widget edits before actions that rerender the shell', async () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        yamlConfig: {
          contentTypes: {
            article: {
              fields: [{ name: 'author', type: 'text', enabled: false }]
            }
          }
        }
      },
      messages: null,
      language: 'en',
      messagingRepository: createMessaging({ success: true, message: 'ok' })
    } as never);

    await flushPromises();

    const authorRow = requireElement(findYamlRowByField('author'), 'author YAML row');
    const authorArticleToggle = queryRequired<HTMLInputElement>(
      'input[type="checkbox"]',
      authorRow
    );
    authorArticleToggle.checked = true;
    authorArticleToggle.dispatchEvent(new Event('change', { bubbles: true }));

    findButton('Test Connection').click();
    await flushPromises();

    expect(mounted.collectDraft().yamlConfig?.contentTypes?.article?.fields?.[0]).toEqual(
      expect.objectContaining({ name: 'author', enabled: true })
    );
  });

  it('does not render fake interactive YAML summary buttons outside the structured YAML widget', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        yamlConfig: {
          globalFields: [{ name: 'kept', type: 'text', enabled: true }]
        }
      },
      messages: null,
      language: 'en'
    });

    const summaryButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button')
    ).filter((button) => ['On', 'Off'].includes(button.textContent?.trim() ?? ''));
    expect(summaryButtons).toEqual([]);

    const widgetActions = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.stitch-yaml-config-widget button')
    ).map((button) => button.textContent?.trim());
    expect(widgetActions).toContain('+ Add field');
    expect(widgetActions).toContain('+ Add domain rule');
  });

  it('hides unreleased AI timestamp, Deep Research, and advanced video controls', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        aiChat: { includeTimestamps: true },
        deepResearch: { pureMode: true },
        video: {
          floatingPromptEnabled: true,
          promptButtonLabel: 'Legacy prompt',
          promptShortcut: 'Alt+V',
          promptPosition: { x: 99, y: 77 }
        }
      },
      messages: null,
      language: 'en'
    });

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('包含时间戳');
    expect(text).not.toContain('Gemini Deep Research');
    expect(text).not.toContain('Deep Research');
    expect(text).not.toContain('Advanced Video Schema');
    expect(text).not.toContain('提示文案与快捷键');
    expect(text).not.toContain('promptPosition');
    expect(text).toContain('Show note button on video sites');
    expect(text).toContain('Pause video while editing notes');

    const videoCard = findCardByTitle('Video Prompt & Entry');
    const videoEntryRow = requireElement(
      videoCard.querySelector<HTMLElement>('.video-entry-toggle-row'),
      'video entry toggle row'
    );
    expect(videoEntryRow.textContent).toContain('Show note button on video sites');
    expect(videoEntryRow.textContent).toContain('Pause video while editing notes');
    const videoEntrySwitches = Array.from(
      videoEntryRow.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    );
    expect(
      videoCard.querySelectorAll<HTMLInputElement>('.card-header input[type="checkbox"]')
    ).toHaveLength(0);
    expect(videoEntrySwitches).toHaveLength(2);
    const videoSwitch = requireElement(videoEntrySwitches[0], 'video prompt switch');
    const commentEditorAutoPauseSwitch = requireElement(
      videoEntrySwitches[1],
      'video auto-pause switch'
    );
    videoSwitch.checked = false;
    videoSwitch.dispatchEvent(new Event('change', { bubbles: true }));
    commentEditorAutoPauseSwitch.checked = true;
    commentEditorAutoPauseSwitch.dispatchEvent(new Event('change', { bubbles: true }));

    const draft = mounted.collectDraft();
    expect(draft.video.floatingPromptEnabled).toBe(false);
    expect(draft.video.commentEditorAutoPause).toBe(true);
    expect(draft.aiChat.includeTimestamps).toBe(true);
    expect(draft.deepResearch.pureMode).toBe(true);
    expect(draft.video.promptPosition).toEqual({ x: 99, y: 77 });
  });

  it('updates fragment modifier selection without remounting the options shell', () => {
    const controller = createController();
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32'
    });
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        fragmentClipper: {
          selectionModifierEnabled: true,
          selectionModifierKeys: ['alt']
        }
      },
      messages: null,
      language: 'en'
    });

    const main = queryRequired<HTMLElement>('.main');
    const altChip = queryRequired<HTMLButtonElement>(
      '.modifier-key-inline .chip[data-value="alt"]'
    );
    const shiftChip = queryRequired<HTMLButtonElement>(
      '.modifier-key-inline .chip[data-value="shift"]'
    );
    expect(document.body.textContent).toContain(
      'Alt may conflict with system, browser, or page shortcuts. If it is unstable, use Shift.'
    );

    shiftChip.click();

    expect(document.querySelector('.main')).toBe(main);
    expect(altChip.getAttribute('aria-pressed')).toBe('false');
    expect(shiftChip.getAttribute('aria-pressed')).toBe('true');
    expect(mounted.collectDraft().fragmentClipper.selectionModifierEnabled).toBe(true);
    expect(mounted.collectDraft().fragmentClipper.selectionModifierKeys).toEqual(['shift']);
    expect(document.body.textContent).not.toContain('快捷键冲突');
  });

  it('renders the fragment keyboard shortcut hint for the current desktop platform only', () => {
    const controller = createController();
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32'
    });

    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    expect(document.body.textContent).toContain(
      'In clipper dialog: Double-Enter to enter reader mode, Alt+Enter to clip directly'
    );
    expect(document.body.textContent).not.toContain('Cmd+Enter (Mac) or Alt+Enter (Windows)');
    expect(document.body.textContent).not.toContain('Cmd+Enter to clip directly');
  });

  it('keeps YAML widget interactions scoped away from the options shell render tree', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        yamlConfig: {
          contentTypes: {
            article: {
              customFields: [{ name: 'score', type: 'number', enabled: true, defaultValue: 42 }]
            }
          }
        }
      },
      messages: null,
      language: 'en'
    });

    const main = document.querySelector<HTMLElement>('.main');
    const widgetHost = document.querySelector<HTMLElement>('[data-stitch-widget="yaml-config"]');
    const articleFilter = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.stitch-yaml-filter-row button')
    ).find((button) => button.textContent?.trim() === 'Article');
    const addField = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.stitch-yaml-actions button')
    ).find((button) => button.textContent?.trim() === '+ Add field');
    expect(main).toBeTruthy();
    requireElement(widgetHost, 'YAML widget host');
    const articleFilterButton = requireElement(articleFilter, 'article YAML filter');
    const addFieldButton = requireElement(addField, 'add YAML field button');

    articleFilterButton.click();
    addFieldButton.click();

    expect(document.querySelector('.main')).toBe(main);
    expect(document.querySelector('[data-stitch-widget="yaml-config"]')).toBe(widgetHost);
  });

  it('keeps disabled default YAML custom fields in production collectDraft', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    const statusRow = requireElement(findYamlRowByField('status'), 'status YAML row');
    const statusToggle = queryRequired<HTMLInputElement>('input[type="checkbox"]', statusRow);

    expect(statusToggle.checked).toBe(true);
    statusToggle.checked = false;
    statusToggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(mounted.collectDraft().yamlConfig?.contentTypes?.article?.customFields).toEqual([
      expect.objectContaining({
        name: 'status',
        enabled: false,
        defaultValue: ['unread']
      })
    ]);
  });

  it('locks default YAML custom field delete and rename controls in production', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    const statusRow = requireElement(findYamlRowByField('status'), 'status YAML row');
    const nameInput = queryRequired<HTMLInputElement>('input[data-yaml-field="name"]', statusRow);
    const deleteButton = queryRequired<HTMLButtonElement>('button.yaml-delete-button', statusRow);

    expect(nameInput.disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);

    nameInput.value = 'state';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    deleteButton.click();

    const draft = mounted.collectDraft();
    expect(draft.yamlConfig ?? null).toBeNull();

    mounted.refreshOptions(draft);
    expect(findYamlRowByField('status')).toBeTruthy();
    expect(findYamlRowByField('state')).toBeNull();
  });

  it('does not clone default YAML custom fields from non-owner content toggles', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    const statusRow = requireElement(findYamlRowByField('status'), 'status YAML row');
    const articleToggle = queryRequired<HTMLInputElement>(
      'input.stitch-yaml-toggle[data-mode="article"]',
      statusRow
    );
    const nonOwnerToggles = ['clipper', 'video', 'ai_chat'].map((contentType) =>
      queryRequired<HTMLInputElement>(
        `input.stitch-yaml-toggle[data-mode="${contentType}"]`,
        statusRow
      )
    );

    expect(articleToggle.disabled).toBe(false);
    expect(articleToggle.checked).toBe(true);
    for (const toggle of nonOwnerToggles) {
      expect(toggle.disabled).toBe(true);
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const draft = mounted.collectDraft();
    expect(draft.yamlConfig ?? null).toBeNull();
  });

  it('does not let invalid YAML widget edits pollute production collectDraft', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        yamlConfig: {
          contentTypes: {
            article: {
              customFields: [{ name: 'score', type: 'number', enabled: true, defaultValue: 42 }]
            }
          }
        }
      },
      messages: null,
      language: 'en'
    });

    const row = requireElement(findYamlRowByField('score'), 'score YAML row');
    const defaultValue = queryRequired<HTMLInputElement>(
      'input[data-yaml-field="defaultValue"]',
      row
    );
    defaultValue.value = 'not-a-number';
    defaultValue.dispatchEvent(new Event('input', { bubbles: true }));

    expect(vi.mocked(controller.scheduleAutoSave)).not.toHaveBeenCalled();
    expect(mounted.collectDraft().yamlConfig?.contentTypes?.article?.customFields).toEqual([
      expect.objectContaining({ name: 'score', defaultValue: 42 })
    ]);
    expect(document.body.textContent).toContain(
      'Please fix YAML configuration errors before saving.'
    );
  });

  it('opens privacy policy and data usage resources from the privacy card', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    const privacyPolicy = findButton('Privacy Policy');
    expect(privacyPolicy.disabled).toBe(false);
    privacyPolicy.click();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Privacy Policy');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Page body, clipped text, article text, AI chat content, reading highlight text'
    );

    document.querySelector<HTMLElement>('.resource-modal-overlay')?.click();

    const dataUsage = findButton('Data usage details');
    expect(dataUsage.disabled).toBe(false);
    dataUsage.click();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Data Usage');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Anonymous Usage Counts'
    );
  });

  it('handles resource navigation actions by closing the modal and activating the target panel', () => {
    const controller = createController();
    const messagingRepository = createMessaging();
    const legacyAliasPreviewContent = structuredClone(previewContent);
    legacyAliasPreviewContent.sidebarLinks = [
      ...previewContent.sidebarLinks,
      {
        id: 'plugin-setup',
        label: 'Plugin Setup',
        hint: 'Local REST API setup guide',
        icon: 'extension'
      }
    ];
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en',
      previewContent: legacyAliasPreviewContent,
      getFooterMeta,
      getFooterView,
      getSettingsView,
      messagingRepository: messagingRepository as never
    });

    findButton('Privacy Policy').click();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Privacy Policy');
    document.querySelector<HTMLElement>('.resource-modal-overlay')?.click();

    findButton('Plugin Setup').click();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Setup Guide');

    findButton('Go To Storage').click();

    expect(document.querySelector('[role="dialog"]')).toBeFalsy();
    expect(
      document.querySelector('[data-nav-panel="storage"]')?.classList.contains('is-active')
    ).toBe(true);
    expect(messagingRepository.send).toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'options_action_completed',
      params: {
        action: 'resource_open',
        outcome: 'completed',
        section: 'privacy'
      }
    });
    expect(messagingRepository.send).toHaveBeenCalledWith({
      type: 'ANALYTICS_EVENT',
      event: 'options_section_viewed',
      params: {
        section: 'storage'
      }
    });

    const emittedEvents = (messagingRepository.send.mock.calls as unknown as Array<[unknown]>).map(
      ([message]) => (message as { event?: string } | undefined)?.event
    );
    expect(emittedEvents).not.toContain('options_resource_viewed');
  });

  it('does not expose future classifier controls in the release options shell', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        classifier: {
          enabled: false,
          provider: 'ollama',
          endpoint: 'http://localhost:11434/api/chat',
          model: 'llama3.1',
          apiKey: '',
          taxonomy: {
            version: '1',
            categories: [{ id: 'research', name: 'Research' }],
            tags: [],
            rules: [],
            defaultCategory: 'research'
          }
        }
      },
      messages: null,
      language: 'en'
    });

    expect(document.body.textContent).not.toContain('启用智能分类');
    expect(document.querySelector('textarea.classifier-taxonomy')).toBeFalsy();
    expect(mounted.collectDraft().classifier).toEqual(
      expect.objectContaining({
        enabled: false,
        provider: 'ollama',
        model: 'llama3.1'
      })
    );
    expect(vi.mocked(controller.scheduleAutoSave)).not.toHaveBeenCalled();
  });

  it('keeps stored classifier taxonomy while the release options shell hides its editor', () => {
    const controller = createController();
    const existingTaxonomy = {
      version: '1',
      categories: [{ id: 'research', name: 'Research' }],
      tags: [],
      rules: [],
      defaultCategory: 'research'
    };
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        classifier: {
          enabled: true,
          provider: 'ollama',
          endpoint: 'http://localhost:11434/api/chat',
          model: 'llama3.1',
          apiKey: '',
          taxonomy: existingTaxonomy
        }
      },
      messages: null,
      language: 'en'
    });

    expect(document.querySelector('textarea.classifier-taxonomy')).toBeFalsy();
    expect(mounted.collectDraft().classifier.taxonomy).toEqual(existingTaxonomy);
  });

  it('uses the structured YAML editor instead of the JSON textarea fallback', async () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        yamlConfig: {
          contentTypes: {
            article: {
              fields: [{ name: 'author', type: 'text', enabled: false }]
            }
          }
        }
      },
      messages: null,
      language: 'en'
    });

    await flushPromises();

    expect(document.querySelector('.yaml-config-json')).toBeFalsy();
    expect(document.querySelector('.stitch-yaml-config-widget')).toBeTruthy();
    expect(document.querySelector('.stitch-yaml-config-table')).toBeTruthy();
    expect(document.querySelector('[data-role="yaml-config-view"]')).toBeFalsy();

    const authorRow = requireElement(findYamlRowByField('author'), 'author YAML row');
    const authorArticleToggle = queryRequired<HTMLInputElement>(
      'input[type="checkbox"]',
      authorRow
    );
    authorArticleToggle.checked = true;
    authorArticleToggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(mounted.collectDraft().yamlConfig?.contentTypes?.article?.fields?.[0]).toEqual(
      expect.objectContaining({
        name: 'author',
        enabled: true
      })
    );
  });
});
