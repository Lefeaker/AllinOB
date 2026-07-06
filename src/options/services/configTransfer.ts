import type { CompleteOptions, StoredOptions } from '../../shared/types/options';
import { omitLegacyRestRootDirFromOptions } from '../../shared/config/optionsMerger';
import { sanitizeYamlConfigValue } from '../../shared/config/optionsSanitizer';
import { StoredOptionsSchema } from '../../shared/schemas';
import type { AnalyticsTransferPayload } from './analyticsTransfer';

export interface ConfigTransferPayload {
  version: number;
  options: StoredOptions;
  analytics?: AnalyticsTransferPayload;
}

export type ConfigTransferErrorCode =
  | 'EMPTY_IMPORT'
  | 'PARSE_FAILED'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'CLIPBOARD_READ_UNAVAILABLE';

export class ConfigTransferError extends Error {
  readonly code: ConfigTransferErrorCode;
  readonly detail?: string;

  constructor(code: ConfigTransferErrorCode, detail?: string) {
    super(code);
    this.name = 'ConfigTransferError';
    this.code = code;
    // Fix exactOptionalPropertyTypes error by conditionally assigning detail
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export async function copyOptionsToClipboard(
  options: StoredOptions | CompleteOptions | ConfigTransferPayload
): Promise<void> {
  const jsonText = JSON.stringify(options, null, 2);
  await writeToClipboard(jsonText);
}

export async function writeToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const success = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!success) {
    throw new ConfigTransferError('CLIPBOARD_UNAVAILABLE');
  }
}

export async function readConfigTextFromClipboard(): Promise<string> {
  if (navigator.clipboard && navigator.clipboard.readText) {
    return navigator.clipboard.readText();
  }
  throw new ConfigTransferError('CLIPBOARD_READ_UNAVAILABLE');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeImportedOptions(candidate: unknown): StoredOptions {
  if (!isPlainObject(candidate)) {
    throw new ConfigTransferError('PARSE_FAILED');
  }

  const hasYamlConfig = Object.prototype.hasOwnProperty.call(candidate, 'yamlConfig');
  const yamlConfigCandidate = candidate.yamlConfig;
  const schemaCandidate = { ...candidate };
  delete schemaCandidate.yamlConfig;

  const parsed = StoredOptionsSchema.safeParse(schemaCandidate);
  if (!parsed.success) {
    throw new ConfigTransferError('PARSE_FAILED');
  }

  const options = omitLegacyRestRootDirFromOptions(parsed.data as StoredOptions);
  if (hasYamlConfig) {
    options.yamlConfig = sanitizeYamlConfigValue(yamlConfigCandidate) ?? null;
  }
  return options;
}

function parseAnalyticsPayload(candidate: unknown): AnalyticsTransferPayload | undefined {
  if (!isPlainObject(candidate)) {
    return undefined;
  }

  const payload: AnalyticsTransferPayload = {};

  const consentCandidate = candidate['consent'];
  if (isPlainObject(consentCandidate)) {
    const consent = consentCandidate;
    if ('analytics' in consent || 'errorReporting' in consent) {
      payload.consent = {
        analytics: Boolean(consent.analytics),
        errorReporting: Boolean(consent.errorReporting)
      };
    }
  }

  const debugCandidate = candidate['debugMode'];
  if (typeof debugCandidate === 'boolean') {
    payload.debugMode = debugCandidate;
  }

  return payload.consent || typeof payload.debugMode === 'boolean' ? payload : undefined;
}

export function parseConfigInput(raw: string): ConfigTransferPayload {
  const textValue = (raw || '').trim();
  if (!textValue) {
    throw new ConfigTransferError('EMPTY_IMPORT');
  }

  try {
    const parsedValue: unknown = JSON.parse(textValue);
    if (!isPlainObject(parsedValue)) {
      throw new ConfigTransferError('PARSE_FAILED');
    }
    const parsed: Record<string, unknown> = parsedValue;

    if ('options' in parsed && isPlainObject(parsed.options)) {
      const version = typeof parsed.version === 'number' ? parsed.version : 1;
      const options = sanitizeImportedOptions(parsed.options);
      const analytics = parseAnalyticsPayload(parsed.analytics);
      return {
        version,
        options,
        ...(analytics !== undefined && { analytics })
      };
    }

    return {
      version: 0,
      options: sanitizeImportedOptions(parsed)
    };
  } catch (error) {
    if (error instanceof ConfigTransferError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : undefined;
    throw new ConfigTransferError('PARSE_FAILED', detail);
  }
}
