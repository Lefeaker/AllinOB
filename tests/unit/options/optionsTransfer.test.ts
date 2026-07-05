import { describe, it, expect } from 'vitest';
import { normalizeOptionsForTransfer } from '@options/utils/optionsTransfer';
import type { StoredOptions } from '@shared/types';
import { getRestDefaults } from '../../utils/restDefaults';

const REST_DEFAULTS = getRestDefaults();
const defaultScreenshotAttachmentSettings = {
  locationTemplate: './assets/${noteFileName}',
  fileNameTemplate: "file-${date:{momentJsFormat:'YYYYMMDDHHmmssSSS'}}.jpg",
  markdownUrlFormat: ''
};
const screenshotAttachmentSettings = {
  locationTemplate: 'Assets/${noteFileName}',
  fileNameTemplate: "shot-${date:{momentJsFormat:'YYYYMMDD'}}.jpg",
  markdownUrlFormat: '../${generatedAttachmentFilePath}'
};

function legacyStoredOptions(options: Record<string, unknown>): StoredOptions {
  return options as unknown as StoredOptions;
}

describe('options transfer normalizer', () => {
  function getScreenshotAttachment(normalized: StoredOptions) {
    if (!normalized.video?.screenshotAttachment) {
      throw new Error('Expected screenshot attachment settings to be present');
    }

    return normalized.video.screenshotAttachment;
  }

  it('fills newly added fields with defaults when missing', () => {
    const normalized = normalizeOptionsForTransfer({});
    expect(normalized.readingSession?.highlightTheme).toBe('gradient');
    expect(normalized.video?.floatingPromptEnabled).toBe(true);
    expect(normalized.video?.promptButtonLabel).toBe('Clip video');
    expect(normalized.video?.promptShortcut).toBe('Alt+V');
  });

  it('preserves existing user selections for new fields', () => {
    const stored: StoredOptions = {
      readingSession: {
        exportMode: 'full',
        highlightTheme: 'neonOrange'
      },
      vaultRouter: {
        vaults: [
          {
            id: 'extra',
            name: 'ExtraVault',
            httpsUrl: 'https://127.0.0.1:3000/',
            httpUrl: 'http://127.0.0.1:3001/',
            vault: 'ExtraVault',
            apiKey: 'token',
            isDefault: false,
            rules: [
              {
                id: 'rule-1',
                type: 'domain',
                pattern: 'example.com',
                enabled: true,
                priority: 10,
                vaultId: 'extra'
              }
            ]
          }
        ],
        defaultVaultId: 'extra'
      },
      video: {
        floatingPromptEnabled: false,
        promptButtonLabel: 'Start Video Notes',
        promptShortcut: 'cmd+shift+v',
        screenshotAttachment: screenshotAttachmentSettings
      }
    };
    const normalized = normalizeOptionsForTransfer(stored);
    expect(normalized.readingSession?.highlightTheme).toBe('neonOrange');
    expect(normalized.readingSession?.exportMode).toBe('full');
    expect(normalized.video?.promptButtonLabel).toBe('Start Video Notes');
    expect(normalized.video?.promptShortcut).toBe('CMD+SHIFT+V');
    expect(getScreenshotAttachment(normalized)).toEqual(screenshotAttachmentSettings);
    expect(normalized.vaultRouter?.vaults[0].rules?.[0].pattern).toBe('example.com');
  });

  it('exports every known option key while dropping arbitrary top-level keys', () => {
    const normalized = normalizeOptionsForTransfer(
      {
        interfaceTheme: 'dark',
        aiChat: { userName: 'Researcher' },
        deepResearch: { pureMode: true },
        classifier: {
          enabled: true,
          provider: 'compatible',
          endpoint: 'https://classifier.example/v1/chat',
          apiKey: 'CLASSIFIER_SECRET',
          model: 'classify-1'
        },
        experimentalAi: {
          provider: 'compatible',
          model: 'summary-1',
          apiUrl: 'https://ai.example/v1/chat/completions',
          apiKey: 'EXPERIMENTAL_SECRET'
        },
        pageSummary: { enabled: true },
        readingOverlaySummary: { enabled: true },
        subtitleTranslation: { enabled: true, targetLanguage: 'ja' },
        customKey: { hello: 'world' },
        cloudSyncToken: 'future-secret'
      },
      { mode: 'fullBackup' }
    );

    expect(normalized.interfaceTheme).toBe('dark');
    expect(normalized.aiChat?.userName).toBe('Researcher');
    expect(normalized.deepResearch?.pureMode).toBe(true);
    expect(normalized.classifier?.model).toBe('classify-1');
    expect(normalized.experimentalAi?.model).toBe('summary-1');
    expect(normalized.pageSummary?.enabled).toBe(true);
    expect(normalized.readingOverlaySummary?.enabled).toBe(true);
    expect(normalized.subtitleTranslation?.targetLanguage).toBe('ja');
    expect(normalized.customKey).toBeUndefined();
    expect(normalized.cloudSyncToken).toBeUndefined();
  });

  it('redacts sensitive fields in portable mode', () => {
    const normalized = normalizeOptionsForTransfer(
      legacyStoredOptions({
        rest: {
          baseUrl: REST_DEFAULTS.baseUrl,
          httpsUrl: REST_DEFAULTS.httpsUrl,
          httpUrl: REST_DEFAULTS.httpUrl,
          vault: 'MainVault',
          apiKey: 'REST_SECRET_TOKEN',
          rootDir: 'LegacyRoot/'
        },
        classifier: {
          enabled: true,
          provider: 'compatible',
          endpoint: 'https://classifier.example/v1/chat',
          apiKey: 'CLASSIFIER_SECRET_TOKEN',
          model: 'classify-1'
        },
        experimentalAi: {
          provider: 'compatible',
          model: 'summary-1',
          apiUrl: 'https://ai.example/v1/chat/completions',
          apiKey: 'EXPERIMENTAL_SECRET_TOKEN'
        },
        vaultRouter: {
          vaults: [
            {
              id: 'main',
              name: 'MainVault',
              httpsUrl: REST_DEFAULTS.httpsUrl,
              httpUrl: REST_DEFAULTS.httpUrl,
              vault: 'MainVault',
              apiKey: 'VAULT_SECRET_TOKEN'
            }
          ],
          defaultVaultId: 'main'
        },
        video: {
          floatingPromptEnabled: true,
          promptButtonLabel: 'Video notes',
          promptShortcut: 'alt+v',
          screenshotAttachment: screenshotAttachmentSettings
        }
      }),
      { mode: 'portable' }
    );

    expect(normalized.rest?.apiKey).toBe('');
    expect(normalized.rest).not.toHaveProperty('rootDir');
    expect(normalized.classifier?.apiKey).toBe('');
    expect(normalized.experimentalAi?.apiKey).toBe('');
    expect(normalized.vaultRouter?.vaults[0]?.apiKey).toBe('');
    expect(getScreenshotAttachment(normalized)).toEqual(screenshotAttachmentSettings);
  });

  it('preserves sensitive fields in explicit fullBackup mode without preserving unknown keys', () => {
    const normalized = normalizeOptionsForTransfer(
      legacyStoredOptions({
        rest: {
          baseUrl: REST_DEFAULTS.baseUrl,
          vault: 'MainVault',
          apiKey: 'REST_SECRET_TOKEN',
          rootDir: 'LegacyRoot/'
        },
        classifier: {
          enabled: true,
          provider: 'compatible',
          endpoint: 'https://classifier.example/v1/chat',
          apiKey: 'CLASSIFIER_SECRET_TOKEN',
          model: 'classify-1'
        },
        experimentalAi: {
          provider: 'compatible',
          model: 'summary-1',
          apiUrl: 'https://ai.example/v1/chat/completions',
          apiKey: 'EXPERIMENTAL_SECRET_TOKEN'
        },
        vaultRouter: {
          vaults: [
            {
              id: 'main',
              name: 'MainVault',
              httpsUrl: REST_DEFAULTS.httpsUrl,
              httpUrl: REST_DEFAULTS.httpUrl,
              vault: 'MainVault',
              apiKey: 'VAULT_SECRET_TOKEN'
            }
          ],
          defaultVaultId: 'main'
        },
        video: {
          screenshotAttachment: screenshotAttachmentSettings
        },
        customKey: { hello: 'world' }
      }),
      { mode: 'fullBackup' }
    );

    expect(normalized.rest?.apiKey).toBe('REST_SECRET_TOKEN');
    expect(normalized.rest).not.toHaveProperty('rootDir');
    expect(normalized.rest?.vault).toBe('MainVault');
    expect(normalized.classifier?.apiKey).toBe('CLASSIFIER_SECRET_TOKEN');
    expect(normalized.experimentalAi?.apiKey).toBe('EXPERIMENTAL_SECRET_TOKEN');
    expect(normalized.vaultRouter?.vaults[0]?.apiKey).toBe('VAULT_SECRET_TOKEN');
    expect(getScreenshotAttachment(normalized)).toEqual(screenshotAttachmentSettings);
    expect(normalized.customKey).toBeUndefined();
  });

  it('merges video screenshot attachment defaults for partial stored config exports', () => {
    const normalized = normalizeOptionsForTransfer({
      video: {
        screenshotAttachment: {
          locationTemplate: './attachments/${noteFileName}'
        }
      }
    });

    expect(normalized.video?.floatingPromptEnabled).toBe(true);
    expect(normalized.video?.promptButtonLabel).toBe('Clip video');
    expect(normalized.video?.promptShortcut).toBe('Alt+V');
    expect(getScreenshotAttachment(normalized)).toEqual({
      ...defaultScreenshotAttachmentSettings,
      locationTemplate: './attachments/${noteFileName}'
    });
  });

  it('includes sanitized yaml config overrides in transfer payload', () => {
    const stored: StoredOptions = {
      yamlConfig: {
        contentTypes: {
          article: {
            customFields: [{ name: 'alias', type: 'text', enabled: true, valuePath: 'title' }]
          },
          clipper: {
            domainOverrides: {
              '*.example.com': [
                { name: 'tags', type: 'array', enabled: true, defaultValue: ['clip'] }
              ]
            }
          }
        }
      }
    };

    const normalized = normalizeOptionsForTransfer(stored);
    expect(normalized.yamlConfig).toEqual({
      contentTypes: {
        article: {
          customFields: [
            { name: 'alias', type: 'text', enabled: true, valuePath: 'title', isCustom: true }
          ]
        },
        clipper: {
          domainOverrides: {
            '*.example.com': [
              { name: 'tags', type: 'array', enabled: true, defaultValue: ['clip'] }
            ]
          }
        }
      }
    });
  });

  it('explicitly sets yamlConfig to null when overrides sanitize away', () => {
    const stored: StoredOptions = {
      yamlConfig: {
        contentTypes: {
          article: {
            fields: []
          }
        }
      }
    };

    const normalized = normalizeOptionsForTransfer(stored);
    expect(normalized.yamlConfig).toBeNull();
  });
});
