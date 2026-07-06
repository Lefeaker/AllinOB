/* @vitest-environment jsdom */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  copyOptionsToClipboard,
  parseConfigInput,
  readConfigTextFromClipboard,
  writeToClipboard,
  ConfigTransferError
} from '@options/services/configTransfer';
import { getRestDefaults } from '../../utils/restDefaults';

const REST_DEFAULTS = getRestDefaults();

declare global {
  // eslint-disable-next-line no-var
  var navigator: Navigator;
}

declare global {
  // eslint-disable-next-line no-var
  var navigator: Navigator;
}

type ClipboardMocks = {
  writeText: Mock<(text: string) => Promise<void>>;
  readText: Mock<() => Promise<string>>;
};

let clipboardMocks: ClipboardMocks | null = null;

describe('configTransfer service', () => {
  beforeEach(() => {
    const clipboard: ClipboardMocks = {
      writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      readText: vi.fn<() => Promise<string>>().mockResolvedValue('{"value":42}')
    };

    clipboardMocks = clipboard;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard
      }
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'navigator');
    clipboardMocks = null;
  });

  it('copies transfer payload到剪贴板', async () => {
    const payload = {
      version: 1,
      options: { foo: 'bar' },
      analytics: {
        consent: {
          analytics: true,
          errorReporting: false
        },
        debugMode: true
      }
    };

    await copyOptionsToClipboard(payload);

    if (!clipboardMocks) {
      throw new Error('Clipboard writeText mock missing');
    }
    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
    const maybeWritten = clipboardMocks.writeText.mock.calls.at(-1)?.[0];
    if (typeof maybeWritten !== 'string') {
      throw new Error('Clipboard contents must be stringified JSON');
    }
    expect(JSON.parse(maybeWritten)).toEqual(payload);
  });

  it('reads configuration text from clipboard', async () => {
    const result = await readConfigTextFromClipboard();
    expect(result).toBe('{"value":42}');
    if (!clipboardMocks) {
      throw new Error('Clipboard readText mock missing');
    }
    expect(clipboardMocks.readText).toHaveBeenCalledTimes(1);
  });

  it('解析新版传输格式', () => {
    const text =
      '{"version":2,"options":{"rest":{"baseUrl":"https://example.com"},"customKey":{"hello":"world"},"analytics":{"debugMode":true}},"analytics":{"consent":{"analytics":true,"errorReporting":false},"debugMode":false}}';
    const parsed = parseConfigInput(text);
    expect(parsed.version).toBe(2);
    expect(parsed.options).toEqual({ rest: { baseUrl: 'https://example.com' } });
    expect(parsed.options).not.toHaveProperty('customKey');
    expect(parsed.options).not.toHaveProperty('analytics');
    expect(parsed.analytics).toEqual({
      consent: { analytics: true, errorReporting: false },
      debugMode: false
    });
  });

  it('normalizes legacy YAML array shape before schema validation for versioned imports', () => {
    const parsed = parseConfigInput(
      JSON.stringify({
        version: 2,
        options: {
          yamlConfig: {
            contentTypes: [
              {
                contentType: 'article',
                fields: [{ name: 'title', type: 'text', enabled: false }]
              }
            ]
          }
        }
      })
    );

    expect(parsed.version).toBe(2);
    expect(parsed.options.yamlConfig?.contentTypes?.article?.fields?.[0]).toEqual({
      name: 'title',
      type: 'text',
      enabled: false
    });
    expect(Array.isArray(parsed.options.yamlConfig?.contentTypes)).toBe(false);
  });

  it('兼容旧版仅包含选项的格式', () => {
    const text =
      '{"rest":{"baseUrl":"https://example.com"},"customKey":{"hello":"world"},"analytics":{"debugMode":true}}';
    const parsed = parseConfigInput(text);
    expect(parsed.version).toBe(0);
    expect(parsed.options).toEqual({ rest: { baseUrl: 'https://example.com' } });
    expect(parsed.analytics).toBeUndefined();
  });

  it('normalizes legacy YAML array shape before schema validation for bare options imports', () => {
    const parsed = parseConfigInput(
      JSON.stringify({
        yamlConfig: {
          contentTypes: [
            {
              contentType: 'article',
              fields: [{ name: 'title', type: 'text', enabled: false }]
            }
          ]
        },
        customKey: { hello: 'world' }
      })
    );

    expect(parsed.version).toBe(0);
    expect(parsed.options.yamlConfig?.contentTypes?.article?.fields?.[0]?.enabled).toBe(false);
    expect(parsed.options).not.toHaveProperty('customKey');
  });

  it('imports known current settings and sensitive fields through the transfer sanitizer', () => {
    const text = JSON.stringify({
      version: 2,
      options: {
        interfaceTheme: 'light',
        rest: {
          baseUrl: REST_DEFAULTS.baseUrl,
          vault: 'MainVault',
          apiKey: 'REST_SECRET_TOKEN',
          rootDir: 'LegacyRoot/'
        },
        templates: { article: 'Articles/{{title}}.md' },
        domainMappings: { 'example.com': 'Research' },
        aiChat: { userName: 'Researcher' },
        deepResearch: { pureMode: true },
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
        pageSummary: { enabled: true },
        readingOverlaySummary: { enabled: true },
        subtitleTranslation: { enabled: true, targetLanguage: 'ja' },
        video: { promptShortcut: 'cmd+shift+v' },
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
        }
      }
    });

    const parsed = parseConfigInput(text);

    expect(parsed.options.interfaceTheme).toBe('light');
    expect(parsed.options.rest?.apiKey).toBe('REST_SECRET_TOKEN');
    expect(parsed.options.rest?.vault).toBe('MainVault');
    expect(parsed.options.rest).not.toHaveProperty('rootDir');
    expect(parsed.options.templates?.article).toBe('Articles/{{title}}.md');
    expect(parsed.options.domainMappings?.['example.com']).toBe('Research');
    expect(parsed.options.aiChat?.userName).toBe('Researcher');
    expect(parsed.options.deepResearch?.pureMode).toBe(true);
    expect(parsed.options.classifier?.apiKey).toBe('CLASSIFIER_SECRET_TOKEN');
    expect(parsed.options.experimentalAi?.apiKey).toBe('EXPERIMENTAL_SECRET_TOKEN');
    expect(parsed.options.pageSummary?.enabled).toBe(true);
    expect(parsed.options.readingOverlaySummary?.enabled).toBe(true);
    expect(parsed.options.subtitleTranslation?.targetLanguage).toBe('ja');
    expect(parsed.options.video?.promptShortcut).toBe('cmd+shift+v');
    expect(parsed.options.vaultRouter?.vaults[0]?.apiKey).toBe('VAULT_SECRET_TOKEN');
  });

  it('throws EMPTY_IMPORT for empty input', () => {
    expect(() => parseConfigInput('   ')).toThrowError(ConfigTransferError);
    try {
      parseConfigInput('   ');
    } catch (error) {
      if (!(error instanceof ConfigTransferError)) {
        throw error;
      }
      expect(error).toBeInstanceOf(ConfigTransferError);
      expect(error.code).toBe('EMPTY_IMPORT');
    }
  });

  it('throws PARSE_FAILED for invalid json', () => {
    expect(() => parseConfigInput('not json')).toThrowError(ConfigTransferError);
    try {
      parseConfigInput('not json');
    } catch (error) {
      if (!(error instanceof ConfigTransferError)) {
        throw error;
      }
      expect(error).toBeInstanceOf(ConfigTransferError);
      expect(error.code).toBe('PARSE_FAILED');
    }
  });

  it('falls back to document.execCommand when clipboard api is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {}
    });
    document.body.innerHTML = '';
    const execCommandMock = vi.fn(() => true);
    document.execCommand = execCommandMock;

    await writeToClipboard('hello');

    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('throws clipboard-specific errors for unavailable read and failed copy fallback', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {}
    });
    document.execCommand = vi.fn(() => false);

    await expect(writeToClipboard('hello')).rejects.toMatchObject({
      code: 'CLIPBOARD_UNAVAILABLE'
    });
    await expect(readConfigTextFromClipboard()).rejects.toMatchObject({
      code: 'CLIPBOARD_READ_UNAVAILABLE'
    });
  });

  it('defaults version to 1 and drops invalid analytics payloads', () => {
    const parsed = parseConfigInput(
      '{"options":{"rest":{"baseUrl":"https://example.com"}},"analytics":{"debugMode":"nope","consent":"invalid"}}'
    );
    expect(parsed.version).toBe(1);
    expect(parsed.analytics).toBeUndefined();
  });

  it('keeps analytics transfer payload limited to consent and debug mode', () => {
    const parsed = parseConfigInput(
      JSON.stringify({
        version: 2,
        options: {
          rest: { baseUrl: 'https://example.com' }
        },
        analytics: {
          consent: {
            analytics: true,
            errorReporting: false
          },
          debugMode: true,
          measurementId: 'G-1111111111',
          transportMode: 'proxy',
          proxyEndpoint: 'https://proxy.example/collect'
        }
      })
    );

    expect(parsed.analytics).toEqual({
      consent: {
        analytics: true,
        errorReporting: false
      },
      debugMode: true
    });
    expect(parsed.analytics).not.toHaveProperty('measurementId');
    expect(parsed.analytics).not.toHaveProperty('transportMode');
    expect(parsed.analytics).not.toHaveProperty('proxyEndpoint');
  });
});
