import { describe, it, expect } from 'vitest';
import { DEFAULT_OPTIONS } from '@shared/config';
import { mergeOptions, optionsMerger } from '@shared/config/optionsMerger';
import type { StoredOptions } from '@shared/types';

function requireDefaultOption<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing default option: ${label}`);
  }
  return value;
}

function parseStoredOptions(text: string): StoredOptions {
  return JSON.parse(text) as StoredOptions;
}

const defaultReadingSession = requireDefaultOption(
  DEFAULT_OPTIONS.readingSession,
  'readingSession'
);
const defaultFragmentClipper = requireDefaultOption(
  DEFAULT_OPTIONS.fragmentClipper,
  'fragmentClipper'
);
const screenshotAttachmentDefaults = {
  locationTemplate: './assets/${noteFileName}',
  fileNameTemplate: "file-${date:{momentJsFormat:'YYYYMMDDHHmmssSSS'}}.jpg",
  markdownUrlFormat: ''
};

describe('shared optionsMerger', () => {
  function getScreenshotAttachment(result: ReturnType<typeof mergeOptions>) {
    if (!result.video) {
      throw new Error('Expected merged video options to be present');
    }

    return result.video.screenshotAttachment;
  }

  it('returns defaults when no stored options provided', () => {
    const result = mergeOptions(undefined);
    expect(result.rest.baseUrl).toBe(DEFAULT_OPTIONS.rest.baseUrl);
    expect(result.templates.article).toBe(DEFAULT_OPTIONS.templates.article);
    expect(result.templates.video).toBe(DEFAULT_OPTIONS.templates.video);
    expect(result.interfaceTheme).toBe('system');
    expect(result.templates.reading).toBe(DEFAULT_OPTIONS.templates.reading);
    expect(result.domainMappings).toEqual(DEFAULT_OPTIONS.domainMappings);
    expect(result.readingSession?.exportMode).toBe(defaultReadingSession.exportMode);
    expect(result.readingSession?.highlightTheme).toBe(defaultReadingSession.highlightTheme);
    expect(result.experimentalAi).toEqual(DEFAULT_OPTIONS.experimentalAi);
    expect(result.pageSummary).toEqual(DEFAULT_OPTIONS.pageSummary);
    expect(result.readingOverlaySummary).toEqual(DEFAULT_OPTIONS.readingOverlaySummary);
    expect(result.subtitleTranslation).toEqual(DEFAULT_OPTIONS.subtitleTranslation);
    expect(result.privacyPreferences).toEqual(DEFAULT_OPTIONS.privacyPreferences);
  });

  it('merges partial rest and classifier values', () => {
    const stored: StoredOptions = {
      rest: {
        baseUrl: 'https://example.com',
        apiKey: 'token'
      },
      classifier: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o'
      },
      fragmentClipper: {
        captureContext: true
      }
    };

    const result = mergeOptions(stored);
    expect(result.rest.baseUrl).toBe('https://example.com');
    expect(result.rest.apiKey).toBe('token');
    expect(result.rest.httpsUrl).toBe(DEFAULT_OPTIONS.rest.httpsUrl);
    expect(result.classifier?.enabled).toBe(true);
    expect(result.classifier?.provider).toBe('openai');
    expect(result.classifier?.model).toBe('gpt-4o');
    expect(result.classifier?.taxonomy).toEqual(DEFAULT_OPTIONS.classifier?.taxonomy);
    expect(result.fragmentClipper?.captureContext).toBe(true);
    expect(result.fragmentClipper?.contextLength).toBe(defaultFragmentClipper.contextLength);
    expect(result.fragmentClipper?.selectionModifierEnabled).toBe(
      defaultFragmentClipper.selectionModifierEnabled
    );
    expect(result.fragmentClipper?.selectionModifierKeys).toEqual(
      defaultFragmentClipper.selectionModifierKeys
    );
    expect(result.fragmentClipper?.keyboardShortcutsEnabled).toBe(
      defaultFragmentClipper.keyboardShortcutsEnabled
    );
    expect(result.templates.reading).toBe(DEFAULT_OPTIONS.templates.reading);
    expect(result.templates.video).toBe(DEFAULT_OPTIONS.templates.video);
  });

  it('preserves explicit video template values without legacy default migration', () => {
    expect(
      mergeOptions({
        templates: {
          video: 'video/{domain}/{yyyy}/{yyyy}-{mm}-{dd}/{slug}.md'
        }
      }).templates.video
    ).toBe('video/{domain}/{yyyy}/{yyyy}-{mm}-{dd}/{slug}.md');
  });

  it('merges persisted privacy preferences with explicit false defaults', () => {
    const result = mergeOptions({
      privacyPreferences: {
        analytics: true
      }
    });

    expect(result.privacyPreferences).toEqual({
      analytics: true,
      errorReporting: false,
      debugMode: false
    });
  });

  it('requires analytics and error reporting before preserving privacy debug mode', () => {
    const result = mergeOptions({
      privacyPreferences: {
        analytics: true,
        errorReporting: false,
        debugMode: true
      }
    });

    expect(result.privacyPreferences).toEqual({
      analytics: true,
      errorReporting: false,
      debugMode: false
    });
  });

  it('normalizes fragment modifier keys to a single selection', () => {
    const stored = parseStoredOptions(
      '{"fragmentClipper":{"selectionModifierEnabled":true,"selectionModifierKeys":["meta","ctrl","cmd","Alt"]}}'
    );

    const result = mergeOptions(stored);
    expect(result.fragmentClipper?.selectionModifierEnabled).toBe(true);
    expect(result.fragmentClipper?.selectionModifierKeys).toEqual(['meta']);
  });

  it('merges reading session highlight theme when valid', () => {
    const stored: StoredOptions = {
      readingSession: {
        exportMode: 'full',
        highlightTheme: 'neonOrange'
      }
    };

    const result = mergeOptions(stored);
    expect(result.readingSession?.exportMode).toBe('full');
    expect(result.readingSession?.highlightTheme).toBe('neonOrange');
  });

  it('falls back to default highlight theme when invalid', () => {
    const stored = parseStoredOptions('{"readingSession":{"highlightTheme":"invalid-color"}}');

    const result = mergeOptions(stored);
    expect(result.readingSession?.highlightTheme).toBe(defaultReadingSession.highlightTheme);
  });

  it('merges keyboard shortcuts configuration', () => {
    const stored: StoredOptions = {
      fragmentClipper: {
        keyboardShortcutsEnabled: false,
        selectionModifierEnabled: true,
        selectionModifierKeys: ['alt']
      }
    };

    const result = mergeOptions(stored);
    expect(result.fragmentClipper?.keyboardShortcutsEnabled).toBe(false);
    expect(result.fragmentClipper?.selectionModifierEnabled).toBe(true);
    expect(result.fragmentClipper?.selectionModifierKeys).toEqual(['alt']);
  });

  it('uses default keyboard shortcuts when not specified', () => {
    const stored: StoredOptions = {
      fragmentClipper: {
        selectionModifierEnabled: true
      }
    };

    const result = mergeOptions(stored);
    expect(result.fragmentClipper?.keyboardShortcutsEnabled).toBe(
      defaultFragmentClipper.keyboardShortcutsEnabled
    );
  });

  it('fills video screenshot attachment defaults when stored options are missing', () => {
    const result = mergeOptions(undefined);

    expect(getScreenshotAttachment(result)).toEqual(screenshotAttachmentDefaults);
  });

  it('merges partial video screenshot attachment fields with defaults', () => {
    const result = mergeOptions({
      video: {
        screenshotAttachment: {
          locationTemplate: ' video/${noteFileName} '
        }
      }
    });

    expect(getScreenshotAttachment(result)).toEqual({
      locationTemplate: 'video/${noteFileName}',
      fileNameTemplate: screenshotAttachmentDefaults.fileNameTemplate,
      markdownUrlFormat: screenshotAttachmentDefaults.markdownUrlFormat
    });
  });

  it('falls back for blank location and filename while keeping blank markdown format', () => {
    const result = mergeOptions({
      video: {
        screenshotAttachment: {
          locationTemplate: '   ',
          fileNameTemplate: '   ',
          markdownUrlFormat: '   '
        }
      }
    });

    expect(getScreenshotAttachment(result)).toEqual(screenshotAttachmentDefaults);
  });

  it('merges experimental options with defaults', () => {
    const stored: StoredOptions = {
      experimentalAi: {
        provider: 'openai',
        model: 'gpt-4o-mini'
      },
      pageSummary: {
        enabled: true
      },
      subtitleTranslation: {
        enabled: true
      }
    };

    const result = mergeOptions(stored);

    expect(result.experimentalAi).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiUrl: DEFAULT_OPTIONS.experimentalAi?.apiUrl ?? '',
      apiKey: DEFAULT_OPTIONS.experimentalAi?.apiKey ?? ''
    });
    expect(result.pageSummary).toEqual({ enabled: true });
    expect(result.readingOverlaySummary).toEqual(DEFAULT_OPTIONS.readingOverlaySummary);
    expect(result.subtitleTranslation).toEqual({
      enabled: true,
      targetLanguage: DEFAULT_OPTIONS.subtitleTranslation?.targetLanguage ?? 'zh-CN'
    });
  });

  it('prunes legacy rest rootDir while preserving current rest fields and unknown extensions', () => {
    const result = mergeOptions(
      parseStoredOptions(
        JSON.stringify({
          interfaceTheme: 'unexpected',
          rest: {
            baseUrl: '',
            vault: '',
            apiKey: '',
            httpsUrl: '',
            httpUrl: 'http://stored.example/',
            rootDir: 'Root',
            localFolderId: '',
            localFolderName: 'Local Folder'
          },
          templates: {
            clipper: 'Legacy/{title}.md'
          },
          domainMappings: { 'example.com': 'Examples' },
          yamlConfig: { fields: [] },
          customExtension: { enabled: true }
        })
      )
    );

    expect(result.interfaceTheme).toBe(DEFAULT_OPTIONS.interfaceTheme ?? 'system');
    expect(result.rest.baseUrl).toBe(DEFAULT_OPTIONS.rest.baseUrl);
    expect(result.rest.vault).toBe(DEFAULT_OPTIONS.rest.vault);
    expect(result.rest.apiKey).toBe(DEFAULT_OPTIONS.rest.apiKey);
    expect(result.rest.httpsUrl).toBe(DEFAULT_OPTIONS.rest.httpsUrl);
    expect(result.rest.httpUrl).toBe('http://stored.example/');
    expect(result.rest).not.toHaveProperty('rootDir');
    expect(result.rest.localFolderId).toBe('');
    expect(result.rest.localFolderName).toBe('Local Folder');
    expect(result.templates.fragment).toBe('Legacy/{title}.md');
    expect(result.templates.reading).toBe('Legacy/{title}.md');
    expect(result.domainMappings).toEqual({ 'example.com': 'Examples' });
    expect(result.yamlConfig).toEqual({ fields: [] });
    expect(Reflect.get(result, 'customExtension')).toEqual({
      enabled: true
    });
  });

  it('normalizes blank optional feature values through documented fallbacks', () => {
    const result = mergeOptions(
      parseStoredOptions(
        JSON.stringify({
          aiChat: { includeTimestamps: true, userName: '' },
          video: {
            floatingPromptEnabled: false,
            promptButtonLabel: '   ',
            promptShortcut: '',
            controlBarAutoPauseEnabled: false,
            controlBarCaptureScreenshotEnabled: false,
            commentEditorAutoPause: true,
            promptPosition: { x: 'NaN', y: 12 }
          },
          experimentalAi: {
            provider: '',
            model: '   ',
            apiUrl: '',
            apiKey: '  custom-key  '
          },
          subtitleTranslation: {
            enabled: true,
            targetLanguage: ''
          }
        })
      )
    );

    expect(result.aiChat?.userName).toBe(DEFAULT_OPTIONS.aiChat?.userName ?? 'USER');
    expect(result.aiChat?.includeTimestamps).toBe(true);
    expect(result.video?.floatingPromptEnabled).toBe(false);
    expect(result.video?.promptButtonLabel).toBe(
      DEFAULT_OPTIONS.video?.promptButtonLabel ?? 'Clip video'
    );
    expect(result.video?.promptShortcut).toBe(DEFAULT_OPTIONS.video?.promptShortcut ?? 'Alt+V');
    expect(result.video?.controlBarAutoPause).toBe(false);
    expect(result.video?.controlBarScreenshot).toBe(false);
    expect(result.video?.commentEditorAutoPause).toBe(true);
    expect(result.video?.promptPosition).toEqual({ x: 0, y: 12 });
    expect(getScreenshotAttachment(result)).toEqual(screenshotAttachmentDefaults);
    expect(result.experimentalAi?.provider).toBe(
      DEFAULT_OPTIONS.experimentalAi?.provider ?? 'compatible'
    );
    expect(result.experimentalAi?.model).toBe(
      DEFAULT_OPTIONS.experimentalAi?.model ?? 'gpt-4.1-mini'
    );
    expect(result.experimentalAi?.apiUrl).toBe(
      DEFAULT_OPTIONS.experimentalAi?.apiUrl ?? 'https://api.openai.com/v1/chat/completions'
    );
    expect(result.experimentalAi?.apiKey).toBe('custom-key');
    expect(result.subtitleTranslation?.targetLanguage).toBe(
      DEFAULT_OPTIONS.subtitleTranslation?.targetLanguage ?? 'zh-CN'
    );
  });

  it('preserves stored domain mappings instead of replacing them with new default aliases', () => {
    const result = mergeOptions({
      domainMappings: {
        'mp.weixin.qq.com': '公众号',
        'example.com': '示例'
      }
    });

    expect(result.domainMappings).toEqual({
      'mp.weixin.qq.com': '公众号',
      'example.com': '示例'
    });
  });

  it('keeps explicit summary and vault-router settings while exposing the merger facade', () => {
    const result = optionsMerger.merge({
      deepResearch: { pureMode: true },
      pageSummary: { enabled: true },
      readingOverlaySummary: { enabled: true },
      vaultRouter: {
        defaultVaultId: 'vault-1',
        vaults: [
          {
            id: 'vault-1',
            name: 'Vault One',
            vault: 'Vault One',
            httpsUrl: 'https://vault.example/',
            httpUrl: 'http://vault.example/',
            apiKey: 'vault-key',
            enabled: true,
            rules: [
              {
                id: 'rule-1',
                vaultId: 'vault-1',
                type: 'domain',
                pattern: '*.example.com',
                enabled: true,
                priority: 1
              }
            ]
          }
        ]
      }
    });

    expect(result.deepResearch).toEqual({ pureMode: true });
    expect(result.pageSummary).toEqual({ enabled: true });
    expect(result.readingOverlaySummary).toEqual({ enabled: true });
    expect(result.vaultRouter?.defaultVaultId).toBe('vault-1');
    expect(result.vaultRouter?.vaults).toHaveLength(1);
  });
});
