/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asOptionsController,
  createController,
  createMessaging,
  createStorage,
  findButton,
  findCardByTitle,
  findInputByValue,
  flushPromises,
  input,
  queryRequired,
  setupProductionStitchShellTest
} from './productionStitchShell.helpers';
import { createProductionStitchStorageController } from '@options/app/productionStitchStorageController';
import { mountProductionStitchShell } from '@options/app/productionStitchShell';
import {
  applyOutputPresetToDraft,
  createInitialDraft
} from '@options/app/productionStitchShellState';
import { createInitialStitchState } from '@options/app/productionStitchStateMapper';
import { previewContent } from '@options/stitch/content';
import { getOutputTemplatePreset } from '@shared/config';
import { mergeOptions } from '@shared/config/optionsMerger';
import { DEFAULT_DOMAIN_MAPPINGS } from '@shared/constants';
import { registerService, TOKENS } from '@shared/di';
import type { StorageService } from '@platform/interfaces/storage';
import type { CompleteOptions } from './productionStitchShell.helpers';
import type { StoredOptions } from '@shared/types';
import { getTestRestUrls } from '../../fixtures/configTestHelpers';

const LOCAL_REST_URLS = getTestRestUrls('localhost');
const LOCAL_HTTPS_URL = LOCAL_REST_URLS.httpsUrl.replace(/\/$/, '');
const LOCAL_HTTP_URL = LOCAL_REST_URLS.httpUrl.replace(/\/$/, '');

function withLegacyRootDir<TRest extends NonNullable<StoredOptions['rest']>>(
  rest: TRest,
  rootDir: string
): TRest & { rootDir: string } {
  return Object.assign(rest, { rootDir });
}

describe('mountProductionStitchShell storage', () => {
  beforeEach(setupProductionStitchShellTest);

  it('renders the default vault switch as enabled and immutable', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: { vault: 'Research Vault' },
        vaultRouter: {
          defaultVaultId: 'research',
          vaults: [
            {
              id: 'research',
              name: 'Research Vault',
              vault: 'Research Vault',
              httpsUrl: LOCAL_HTTPS_URL,
              httpUrl: LOCAL_HTTP_URL,
              apiKey: 'token',
              enabled: false,
              isDefault: true
            }
          ],
          rules: []
        }
      },
      messages: null,
      language: 'en'
    });

    const defaultRow = findInputByValue('Research Vault').closest<HTMLElement>('tr');
    const toggle = defaultRow?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
  });

  it('shows storage and reading mode plugin guidance in the option cards', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    const vaultList = findCardByTitle('Vault List');
    expect(vaultList.textContent).toContain('Local Folder is recommended first.');
    const restLink = vaultList.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/coddingtonbear/obsidian-local-rest-api"]'
    );
    expect(restLink?.textContent).toBe('Local REST API with MCP');

    const readingExport = findCardByTitle('Reading Mode');
    expect(readingExport.textContent).toContain(
      'Saved highlights work best with the Obsidian plugin'
    );
    const highlightsLink = readingExport.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/trevware/obsidian-sidebar-highlights"]'
    );
    expect(highlightsLink?.textContent).toBe('Sidebar Highlights');
  });

  it('renders storage tables with dedicated scroll classes for independent column sizing', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });

    expect(findCardByTitle('Vault List').querySelector('.storage-vault-table-scroll')).toBeTruthy();
    expect(
      findCardByTitle('Routing Rules').querySelector('.routing-rules-table-scroll')
    ).toBeTruthy();
  });

  it('renders Usage Dashboard from real usage stats instead of preview fixtures', async () => {
    const controller = createController();
    const storage = createStorage();
    await storage.local.set('usageStats', {
      aiChatSaves: 7,
      fragmentSaves: 5,
      articleSaves: 3,
      lastUpdatedISO: '2026-04-25T00:00:00.000Z',
      history: [
        { date: '2026-04-24', aiChat: 1, fragment: 2, article: 3 },
        { date: '2026-04-25', aiChat: 7, fragment: 5, article: 3 }
      ]
    });

    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en',
      storage: storage as unknown as StorageService
    } as never);
    await flushPromises();

    expect(storage.local.get).toHaveBeenCalledWith('usageStats');
    const statText = document.querySelector('.stats-grid')?.textContent ?? '';
    expect(statText).toContain('15');
    expect(statText).toContain('7');
    expect(statText).toContain('5');
    expect(statText).toContain('3');
    expect(statText).not.toContain('1284');

    const chartLabels = document.querySelectorAll('#usageXAxis text');
    expect(chartLabels.length).toBeGreaterThanOrEqual(5);
    expect(document.querySelector('#usageWavePath')?.getAttribute('d')).toBeTruthy();
  });

  it('renders default zero Usage Dashboard without invalid SVG chart coordinates', async () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: null,
      messages: null,
      language: 'en'
    });
    await flushPromises();

    expect(document.querySelector('[data-role="usage-chart-shell"]')).toBeTruthy();
    const invalidAttributes = Array.from(document.querySelectorAll<SVGElement>('#usageWave *'))
      .flatMap((element) =>
        ['d', 'x1', 'x2', 'y1', 'y2', 'x', 'y'].map((attribute) => element.getAttribute(attribute))
      )
      .filter((value): value is string => Boolean(value?.includes('NaN')));

    expect(invalidAttributes).toEqual([]);
  });

  it('writes routing table edits back into vaultRouter before autosave collection', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: { vault: 'Research Vault' },
        vaultRouter: {
          defaultVaultId: 'research',
          vaults: [
            {
              id: 'research',
              name: 'Research Vault',
              vault: 'Research Vault',
              httpsUrl: LOCAL_HTTPS_URL,
              httpUrl: LOCAL_HTTP_URL,
              apiKey: 'token',
              enabled: true,
              isDefault: true
            }
          ],
          rules: [
            {
              id: 'rule-1',
              vaultId: 'research',
              type: 'domain',
              pattern: 'old.example',
              enabled: true,
              priority: 10
            }
          ]
        }
      },
      messages: null,
      language: 'en',
      messagingRepository: createMessaging({ success: true, message: 'ok' })
    } as never);

    input('old.example', 'new.example', 'change');

    const collected = mounted.collectDraft();
    expect(collected.vaultRouter?.rules?.[0]).toEqual(
      expect.objectContaining({
        vaultId: 'research',
        type: 'domain',
        pattern: 'new.example',
        enabled: true,
        priority: 10
      })
    );
    expect(vi.mocked(controller.scheduleAutoSave)).toHaveBeenCalled();
  });

  it('keeps storage controller draft sync delegated through the vault router helpers', () => {
    const draft = mergeOptions({
      rest: {
        vault: 'Research Vault',
        baseUrl: LOCAL_HTTPS_URL,
        httpsUrl: LOCAL_HTTPS_URL,
        httpUrl: LOCAL_HTTP_URL,
        apiKey: 'token'
      },
      vaultRouter: {
        defaultVaultId: 'research',
        vaults: [
          {
            id: 'research',
            name: 'Research Vault',
            vault: 'Research Vault',
            httpsUrl: LOCAL_HTTPS_URL,
            httpUrl: LOCAL_HTTP_URL,
            apiKey: 'token',
            enabled: true,
            isDefault: true
          }
        ],
        rules: []
      }
    }) as CompleteOptions;
    const state = {
      activeLocalFolderVaultIndex: null,
      routingRules: [
        {
          target: 'Renamed Vault',
          type: 'Domain',
          pattern: 'docs.example',
          enabled: true,
          priority: 25
        }
      ]
    };
    const scheduleDraftSave = vi.fn();
    const storageController = createProductionStitchStorageController({
      getConnectionNotice: () => undefined,
      getDraft: () => draft,
      getMessagingRepository: () => createMessaging({ success: true }) as never,
      getState: () => state as never,
      setConnectionNotice: vi.fn(),
      refreshAppData: vi.fn(),
      render: vi.fn(),
      scheduleDraftSave
    });

    storageController.updateVaultField(0, 'name', 'Renamed Vault');
    storageController.syncRoutingRulesToDraft();

    expect(draft.rest.vault).toBe('Renamed Vault');
    expect(draft.vaultRouter?.vaults[0]).toEqual(
      expect.objectContaining({
        name: 'Renamed Vault',
        vault: 'Renamed Vault'
      })
    );
    expect(draft.vaultRouter?.rules).toEqual([
      expect.objectContaining({
        vaultId: 'research',
        type: 'domain',
        pattern: 'docs.example',
        enabled: true,
        priority: 25
      })
    ]);
    expect(scheduleDraftSave).toHaveBeenCalledTimes(1);
  });

  it('prunes the hidden storage root while persisting vault table edits through collectDraft', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: withLegacyRootDir(
          {
            baseUrl: LOCAL_HTTPS_URL,
            vault: 'Research Vault',
            httpsUrl: LOCAL_HTTPS_URL,
            httpUrl: LOCAL_HTTP_URL,
            apiKey: 'token'
          },
          'Inbox/'
        )
      },
      messages: null,
      language: 'en'
    });

    input('Research Vault', 'Notes Vault');

    const collected = mounted.collectDraft();
    expect(collected.rest).not.toHaveProperty('rootDir');
    expect(collected.rest.vault).toBe('Notes Vault');
    expect(collected.vaultRouter?.vaults?.[0]).toEqual(
      expect.objectContaining({
        name: 'Notes Vault',
        vault: 'Notes Vault'
      })
    );
  });

  it('renders and persists Chromium local folders in the production Vault List', async () => {
    const controller = createController();
    const messagingRepository = createMessaging(undefined);
    const chooseDirectory = vi.fn(() =>
      Promise.resolve({ id: 'folder-main', name: 'Local Vault' })
    );
    const ensurePermission = vi.fn(() => Promise.resolve('granted'));
    registerService(
      TOKENS.platformServices,
      () =>
        ({
          fileSystemAccess: {
            chooseDirectory,
            ensurePermission,
            removeDirectory: vi.fn()
          }
        }) as never
    );

    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: {
          baseUrl: LOCAL_HTTPS_URL,
          vault: 'Research Vault',
          httpsUrl: LOCAL_HTTPS_URL,
          httpUrl: LOCAL_HTTP_URL,
          apiKey: 'token'
        }
      },
      messages: null,
      language: 'en',
      messagingRepository
    } as never);

    const vaultList = findCardByTitle('Vault List');
    expect(
      Array.from(vaultList.querySelectorAll('th')).map((cell) => cell.textContent?.trim())
    ).toEqual(['Enabled', 'Vault', 'Local Folder', 'HTTPS URL', 'HTTP URL', 'API Key', 'Actions']);

    const chooseButton = Array.from(vaultList.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Choose Local Folder'
    );
    expect(chooseButton).toBeTruthy();
    chooseButton?.click();
    await flushPromises();

    expect(chooseDirectory).toHaveBeenCalledWith({ suggestedName: 'Research Vault' });
    const collected = mounted.collectDraft();
    expect(collected.rest.localFolderId).toBe('folder-main');
    expect(collected.rest.localFolderName).toBe('Local Vault');
    expect(collected.vaultRouter?.vaults?.[0]).toEqual(
      expect.objectContaining({
        localFolderId: 'folder-main',
        localFolderName: 'Local Vault'
      })
    );

    const refreshedVaultList = findCardByTitle('Vault List');
    expect(refreshedVaultList.textContent).not.toContain('Delete Local Folder');
    const selectedFolderButton = Array.from(
      refreshedVaultList.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Local Vault');
    expect(selectedFolderButton).toBeTruthy();
    expect(selectedFolderButton?.getAttribute('title')).toContain('Local Vault');
    expect(selectedFolderButton?.getAttribute('title')).not.toMatch(/(^\/|[A-Za-z]:\\)/);
    selectedFolderButton?.click();
    await flushPromises();

    expect(ensurePermission).toHaveBeenCalledWith('folder-main');
    const confirmingCell =
      findCardByTitle('Vault List').querySelector<HTMLElement>('.local-folder-cell');
    expect(confirmingCell?.querySelector('.local-folder-popover')).toBeNull();
    expect(confirmingCell?.textContent?.trim()).toBe('Delete Local Folder');

    const restoredByOutsideClick = queryRequired<HTMLElement>('.main');
    restoredByOutsideClick.click();
    await flushPromises();
    expect(findCardByTitle('Vault List').textContent).not.toContain('Delete Local Folder');
    expect(
      Array.from(findCardByTitle('Vault List').querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent?.trim() === 'Local Vault'
      )
    ).toBe(true);

    const restoredFolderButton = Array.from(
      findCardByTitle('Vault List').querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Local Vault');
    restoredFolderButton?.click();
    await flushPromises();

    const deleteButton = Array.from(
      findCardByTitle('Vault List').querySelectorAll<HTMLButtonElement>('.local-folder-cell button')
    ).find((button) => button.textContent?.trim() === 'Delete Local Folder');
    expect(deleteButton).toBeTruthy();
    deleteButton?.click();
    await flushPromises();

    const cleared = mounted.collectDraft();
    expect(cleared.rest.localFolderId).toBeUndefined();
    expect(cleared.rest.localFolderName).toBeUndefined();
    expect(cleared.vaultRouter?.vaults?.[0]?.localFolderId).toBeUndefined();
    expect(cleared.vaultRouter?.vaults?.[0]?.localFolderName).toBeUndefined();
    expectAnalyticsMessage(
      vi.mocked(messagingRepository.send).mock.calls,
      'local_vault_permission_prompted',
      {
        source: 'options'
      },
      ['source']
    );
    expectAnalyticsMessage(
      vi.mocked(messagingRepository.send).mock.calls,
      'local_vault_permission_resolved',
      {
        outcome: 'completed'
      },
      ['outcome']
    );
  });

  it('still allows clearing a selected local folder when Chrome returns prompt', async () => {
    const controller = createController();
    const messagingRepository = createMessaging(undefined);
    const ensurePermission = vi.fn(() => Promise.resolve('prompt'));
    const removeDirectory = vi.fn(() => Promise.resolve());
    registerService(
      TOKENS.platformServices,
      () =>
        ({
          fileSystemAccess: {
            chooseDirectory: vi.fn(),
            ensurePermission,
            removeDirectory
          }
        }) as never
    );

    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: {
          baseUrl: LOCAL_HTTPS_URL,
          vault: 'Research Vault',
          httpsUrl: LOCAL_HTTPS_URL,
          httpUrl: LOCAL_HTTP_URL,
          apiKey: 'token',
          localFolderId: 'folder-main',
          localFolderName: 'Local Vault'
        },
        vaultRouter: {
          defaultVaultId: 'vault-default',
          vaults: [
            {
              id: 'vault-default',
              name: 'Research Vault',
              vault: 'Research Vault',
              httpsUrl: LOCAL_HTTPS_URL,
              httpUrl: LOCAL_HTTP_URL,
              apiKey: 'token',
              localFolderId: 'folder-main',
              localFolderName: 'Local Vault',
              enabled: true,
              isDefault: true
            }
          ],
          rules: []
        }
      } as Partial<CompleteOptions>,
      messages: null,
      language: 'en',
      messagingRepository
    } as never);

    const selectedFolderButton = Array.from(
      findCardByTitle('Vault List').querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Local Vault');
    expect(selectedFolderButton).toBeTruthy();
    selectedFolderButton?.click();
    await flushPromises();

    expect(ensurePermission).toHaveBeenCalledWith('folder-main');
    const vaultList = findCardByTitle('Vault List');
    expect(vaultList.querySelector('.local-folder-popover')).toBeNull();
    const deleteButton = Array.from(
      vaultList.querySelectorAll<HTMLButtonElement>('.local-folder-cell button')
    ).find((button) => button.textContent?.trim() === 'Delete Local Folder');
    expect(deleteButton).toBeTruthy();
    expect(document.body.textContent).toMatch(
      /Local Folder needs permission again|本地目录需要重新授权/
    );
    deleteButton?.click();
    await flushPromises();

    const cleared = mounted.collectDraft();
    expect(cleared.rest.localFolderId).toBeUndefined();
    expect(cleared.rest.localFolderName).toBeUndefined();
    expect(cleared.vaultRouter?.vaults?.[0]?.localFolderId).toBeUndefined();
    expect(cleared.vaultRouter?.vaults?.[0]?.localFolderName).toBeUndefined();
    expect(removeDirectory).toHaveBeenCalledWith('folder-main');
    expectAnalyticsMessage(
      vi.mocked(messagingRepository.send).mock.calls,
      'local_vault_permission_prompted',
      {
        source: 'options'
      },
      ['source']
    );
    expectAnalyticsMessage(
      vi.mocked(messagingRepository.send).mock.calls,
      'local_vault_permission_resolved',
      {
        outcome: 'failed'
      },
      ['outcome']
    );
  });

  it('persists domain mapping edits and delete actions', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        domainMappings: {
          'old.example': 'old-folder'
        }
      },
      messages: null,
      language: 'en'
    });

    input('old.example', 'new.example');
    input('old-folder', 'new-folder');

    expect(mounted.collectDraft().domainMappings).toEqual({
      'new.example': 'new-folder'
    });

    findButton('Remove').click();
    expect(mounted.collectDraft().domainMappings).toEqual({});
  });

  it('restores default Domain Mappings rows when mappings are empty', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        domainMappings: {}
      },
      messages: null,
      language: 'en'
    });

    const card = findCardByTitle('Domain Mapping Configuration');
    expect(card.querySelector('table')).toBeTruthy();
    expect(card.querySelector('.domain-mapping-table-scroll')).toBeTruthy();
    expect(card.querySelector('thead')?.textContent).toContain('Domain');
    const values = Array.from(card.querySelectorAll<HTMLInputElement>('input')).map(
      (input) => input.value
    );
    expect(values).toContain('mp.weixin.qq.com');
    expect(values).toContain('YouTube');
    expect(mounted.collectDraft().domainMappings).toEqual(DEFAULT_DOMAIN_MAPPINGS);
  });

  it('keeps an editable Domain Mappings fallback row after deleting all mappings', () => {
    const controller = createController();
    const mounted = mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        domainMappings: {
          'single.example': 'Single'
        }
      },
      messages: null,
      language: 'en'
    });

    findButton('Remove').click();
    const card = findCardByTitle('Domain Mapping Configuration');

    const inputs = Array.from(card.querySelectorAll<HTMLInputElement>('tbody input'));
    expect(inputs).toHaveLength(2);

    inputs[0].value = 'docs.example';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'Docs';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));

    expect(mounted.collectDraft().domainMappings).toEqual({
      'docs.example': 'Docs'
    });
  });

  it('deduplicates routing rules that exist in both legacy and vault-scoped storage', () => {
    const controller = createController();
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: { vault: 'Research Vault' },
        vaultRouter: {
          defaultVaultId: 'research',
          vaults: [
            {
              id: 'research',
              name: 'Research Vault',
              vault: 'Research Vault',
              httpsUrl: LOCAL_HTTPS_URL,
              httpUrl: LOCAL_HTTP_URL,
              apiKey: 'token',
              enabled: true,
              isDefault: true,
              rules: [
                {
                  id: 'vault-rule-1',
                  vaultId: 'research',
                  type: 'domain',
                  pattern: 'duplicate.example',
                  enabled: true,
                  priority: 10
                }
              ]
            }
          ],
          rules: [
            {
              id: 'rule-1',
              vaultId: 'research',
              type: 'domain',
              pattern: 'duplicate.example',
              enabled: true,
              priority: 10
            },
            {
              id: 'rule-2',
              vaultId: 'research',
              type: 'domain',
              pattern: 'duplicate.example',
              enabled: true,
              priority: 10
            }
          ]
        }
      },
      messages: null,
      language: 'en'
    } as never);

    const card = findCardByTitle('Routing Rules');
    const duplicateInputs = Array.from(card.querySelectorAll<HTMLInputElement>('input')).filter(
      (candidate) => candidate.value === 'duplicate.example'
    );
    expect(duplicateInputs).toHaveLength(1);
  });

  it('keeps hidden output presets logic wired to templates, YAML configuration, and domain mappings', () => {
    const researchPreset = getOutputTemplatePreset('Research');
    if (!researchPreset) {
      throw new Error('Missing Research preset');
    }
    const draft = createInitialDraft({
      templates: {
        article: 'Old/{title}.md',
        fragment: 'Old/Fragment.md',
        reading: 'Old/Reading.md',
        ai: 'Old/AI.md'
      },
      domainMappings: {
        'old.example': 'old'
      },
      yamlConfig: null
    });
    const state = createInitialStitchState(previewContent);
    const setDomainMappingRows = vi.fn();
    const scheduleDraftSave = vi.fn();

    applyOutputPresetToDraft({
      draft,
      state,
      setDomainMappingRows,
      refreshAppData: vi.fn(),
      scheduleDraftSave,
      render: vi.fn(),
      name: 'Research'
    });

    expect(draft.templates.article).toBe(researchPreset.templates.article);
    expect(draft.templates.reading).toBe(researchPreset.templates.reading);
    expect(draft.domainMappings).toEqual(expect.objectContaining(researchPreset.domainMappings));
    expect(draft.yamlConfig?.contentTypes?.article?.customFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'status', enabled: true }),
        expect.objectContaining({ name: 'workspace', enabled: true })
      ])
    );
    expect(setDomainMappingRows).toHaveBeenCalledWith(Object.entries(draft.domainMappings));
    expect(scheduleDraftSave).toHaveBeenCalled();
  });

  it('runs background vault tests for every enabled Vault List row and renders the result', async () => {
    const controller = createController();
    const messagingRepository = createMessaging({
      success: false,
      status: 401,
      message: 'Research Vault partial',
      error: 'HTTPS: network error: request failed',
      channels: [
        {
          channel: 'localFolder',
          label: '本地目录',
          configured: true,
          success: true,
          message: '本地目录可用：LocalFolder'
        },
        {
          channel: 'https',
          label: 'HTTPS',
          configured: true,
          success: false,
          message: 'network error: request failed',
          error: 'network error: request failed',
          url: LOCAL_HTTPS_URL,
          certificateUrl: `${LOCAL_HTTPS_URL}/obsidian-local-rest-api.crt`
        },
        {
          channel: 'http',
          label: 'HTTP',
          configured: true,
          success: true,
          message: 'HTTP 连接成功',
          url: LOCAL_HTTP_URL
        }
      ]
    });
    mountProductionStitchShell({
      controller: asOptionsController(controller),
      initialOptions: {
        rest: {
          vault: 'Research Vault',
          httpsUrl: LOCAL_HTTPS_URL,
          apiKey: 'bad-token'
        },
        vaultRouter: {
          defaultVaultId: 'research',
          vaults: [
            {
              id: 'research',
              name: 'Research Vault',
              vault: 'Research Vault',
              httpsUrl: LOCAL_HTTPS_URL,
              httpUrl: LOCAL_HTTP_URL,
              apiKey: 'bad-token',
              localFolderId: 'folder-local',
              localFolderName: 'LocalFolder',
              enabled: true,
              isDefault: true
            },
            {
              id: 'disabled',
              name: 'Disabled Vault',
              vault: 'Disabled Vault',
              httpsUrl: 'https://disabled.example',
              httpUrl: '',
              apiKey: 'disabled-token',
              enabled: false,
              isDefault: false
            }
          ]
        }
      },
      messages: null,
      language: 'en',
      messagingRepository
    } as never);

    findButton('Test Connection').click();
    await flushPromises();
    await flushPromises();

    expect(vi.mocked(messagingRepository.send)).toHaveBeenCalledWith({
      type: 'TEST_VAULT_CONNECTION',
      vaultId: 'research',
      vault: expect.objectContaining({
        id: 'research',
        localFolderId: 'folder-local',
        localFolderName: 'LocalFolder'
      }) as unknown
    });
    expect(vi.mocked(messagingRepository.send)).not.toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: 'disabled' })
    );
    const vaultList = findCardByTitle('Vault List');
    const notice = vaultList.querySelector<HTMLElement>('.notice');
    expect(notice?.className).toContain('warning');
    expect(notice?.textContent).toContain('Research Vault');
    expect(notice?.textContent).toContain('✅ Local Folder');
    expect(notice?.textContent).toContain('❌ REST API (HTTPS)');
    expect(notice?.textContent).toContain('✅ REST API (HTTP)');
    const certificateLink = notice?.querySelector<HTMLAnchorElement>(
      `a[href="${LOCAL_HTTPS_URL}/obsidian-local-rest-api.crt"]`
    );
    expect(certificateLink?.textContent).toBe('Download and trust this certificate');
    expectAnalyticsMessage(
      vi.mocked(messagingRepository.send).mock.calls,
      'connection_test_completed',
      {
        failure_category: 'unknown',
        outcome: 'failed',
        storage_target: 'unknown'
      },
      ['duration_bucket', 'failure_category', 'outcome', 'storage_target']
    );
  });
});

const FORBIDDEN_ANALYTICS_KEYS = new Set([
  'apiKey',
  'baseUrl',
  'duration_ms',
  'endpoint',
  'fallback_reason',
  'failure_count_bucket',
  'filePath',
  'folderId',
  'folderName',
  'localFolderName',
  'noteName',
  'permission_state',
  'response',
  'responseBody',
  'success_count_bucket',
  'test_scope',
  'vault',
  'vaultName',
  'vault_count_bucket'
]);

function expectAnalyticsMessage(
  calls: unknown[][],
  expectedEvent: string,
  expectedParams: Record<string, unknown>,
  allowedKeys: string[]
): void {
  const analyticsCall = calls.find((call) => {
    const message = call[0] as { type?: string; event?: string } | undefined;
    return message?.type === 'ANALYTICS_EVENT' && message.event === expectedEvent;
  });
  expect(analyticsCall).toBeDefined();
  const message = analyticsCall?.[0] as {
    event: string;
    params?: Record<string, unknown>;
    type: 'ANALYTICS_EVENT';
  };
  expect(message.params).toEqual(expect.objectContaining(expectedParams));
  const params = message.params ?? {};
  expect(Object.keys(params).sort()).toEqual([...allowedKeys].sort());
  Object.keys(params).forEach((key) => {
    expect(FORBIDDEN_ANALYTICS_KEYS.has(key)).toBe(false);
  });
}
