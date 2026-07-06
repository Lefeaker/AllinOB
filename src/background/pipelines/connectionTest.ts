import { getOptions } from '../store';
import type { ConnectionChannelResult, ConnectionTestResult } from '../../shared/types/connection';
import type { UserVisibleMessageDescriptor } from '../../shared/i18n/userVisibleMessageDescriptor';
import type { TestVaultConnectionMessage, VaultConfig } from '../../shared/types';
import type { RestOptions } from '../../shared/types/options';
import { createRestCandidates, type RestConfig } from '../utils/restCandidates';
import { trackUsageEvent } from '../services/analyticsEvents';
import type {
  FailureCategory as AnalyticsFailureCategory,
  StorageTarget
} from '../../shared/types/analytics';
import { bucketDurationMs } from '../../shared/analytics/featureTimer';
import { executeVaultStorageTargetTest } from './vaultConnectionChannels';
import { executeLocalFolderChannelTest } from './vaultLocalFolderChannel';
import type { ConnectionTestConfig } from './vaultConnectionTypes';
import { summarizeVaultStorageTargetTest } from './connectionTestAnalytics';

type FailureCategory = 'HTTP error' | 'network error' | 'config error';
type ConnectionTestSummary = {
  result: ConnectionTestResult;
  storageTarget: StorageTarget;
  failureCategory?: AnalyticsFailureCategory;
};
type ConnectionResultSummary = {
  result: ConnectionTestResult;
  failureCategory?: AnalyticsFailureCategory;
};
type ConnectionErrorInput = Error | object | string | number | boolean | null | undefined;

interface UrlCandidate {
  url: string;
  protocol: string;
}

const RESPONSE_SNIPPET_LIMIT = 120;
const NETWORK_FAILURE_DETAIL = 'request failed';
const HTTP_FAILURE_DETAIL = 'response unavailable';
const CONFIG_FAILURE_DETAIL = 'configuration invalid';
const NO_USABLE_ADDRESS_DETAIL = 'No usable address is configured.';
const REST_API_KEY_MISSING_DETAIL = 'API Key is missing';
const REST_VAULT_NAME_MISSING_DETAIL = 'Vault Name is missing';
const EXTRA_VAULT_MISSING_DETAIL = 'Additional vault configuration not found.';

function sanitizeSnippet(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= RESPONSE_SNIPPET_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, RESPONSE_SNIPPET_LIMIT)}...`;
}

function normalizeFailureDetail(category: FailureCategory, detail?: string): string | undefined {
  const normalized = detail?.toLowerCase().trim();
  if (!normalized) {
    return defaultFailureDetail(category);
  }

  if (normalized.includes('body is unusable')) {
    return HTTP_FAILURE_DETAIL;
  }

  if (
    normalized.includes('cannot read properties of undefined') ||
    normalized.includes('illegal invocation') ||
    normalized.includes('missing response from rest endpoint')
  ) {
    return CONFIG_FAILURE_DETAIL;
  }

  if (category === 'network error' && isKnownNetworkFailure(normalized)) {
    return NETWORK_FAILURE_DETAIL;
  }

  return detail;
}

function defaultFailureDetail(category: FailureCategory): string {
  if (category === 'HTTP error') {
    return HTTP_FAILURE_DETAIL;
  }
  if (category === 'network error') {
    return NETWORK_FAILURE_DETAIL;
  }
  return CONFIG_FAILURE_DETAIL;
}

function isKnownNetworkFailure(message: string): boolean {
  return message.includes('failed to fetch') || message.includes('networkerror');
}

function createDescriptor<Key extends string>(
  key: Key,
  values?: Record<string, string | number | boolean>
): UserVisibleMessageDescriptor<Key> {
  return {
    key,
    ...(values ? { values } : {})
  };
}

function createHeaderDescriptor(success: boolean): UserVisibleMessageDescriptor {
  return createDescriptor(
    success ? 'connectionResultHeaderSuccess' : 'connectionResultHeaderFailure'
  );
}

function createFailureReasonDescriptor(detail: string): UserVisibleMessageDescriptor {
  if (detail === NO_USABLE_ADDRESS_DETAIL) {
    return createDescriptor('connectionNoUsableAddress');
  }
  if (detail === REST_API_KEY_MISSING_DETAIL) {
    return createDescriptor('connectionRestApiKeyMissing');
  }
  if (detail === REST_VAULT_NAME_MISSING_DETAIL) {
    return createDescriptor('connectionRestVaultNameMissing');
  }
  if (detail === EXTRA_VAULT_MISSING_DETAIL) {
    return createDescriptor('connectionExtraVaultMissing');
  }

  return createDescriptor('connectionRestFailure', { reason: detail });
}

export async function handleConnectionTest(
  restDraft?: Partial<RestOptions>
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  try {
    const options = await getOptions();
    const rest = mergeRestOptions(options.rest, restDraft);
    try {
      const config: ConnectionTestConfig = {
        baseUrl: rest.baseUrl,
        apiKey: rest.apiKey,
        vault: rest.vault,
        label: rest.vault,
        ...(rest.httpsUrl ? { httpsUrl: rest.httpsUrl } : {}),
        ...(rest.httpUrl ? { httpUrl: rest.httpUrl } : {}),
        ...(rest.localFolderId ? { localFolderId: rest.localFolderId } : {}),
        ...(rest.localFolderName ? { localFolderName: rest.localFolderName } : {})
      };

      const summary = await executeStorageTargetTest(config);
      trackConnectionTestCompleted(summary, startedAt);
      return summary.result;
    } catch (error) {
      const errorInput: ConnectionErrorInput =
        error instanceof Error ||
        typeof error === 'string' ||
        typeof error === 'number' ||
        typeof error === 'boolean' ||
        error === null ||
        error === undefined ||
        typeof error === 'object'
          ? error
          : undefined;
      const summary = buildFailureSummary(errorInput, 'rest_api');
      trackConnectionTestCompleted(summary, startedAt);
      return summary.result;
    }
  } catch (error) {
    const errorInput: ConnectionErrorInput =
      error instanceof Error ||
      typeof error === 'string' ||
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      error === null ||
      error === undefined ||
      typeof error === 'object'
        ? error
        : undefined;
    const summary = buildFailureSummary(errorInput, 'unknown');
    trackConnectionTestCompleted(summary, startedAt);
    return summary.result;
  }
}

export async function handleVaultConnectionTest(
  message: TestVaultConnectionMessage
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  try {
    const options = await getOptions();
    const activeVaults = (options.vaultRouter?.vaults ?? []).filter((v) => v.enabled !== false);
    const vault = resolveVaultConfig(message, activeVaults);
    const httpsUrl = sanitizeUrl(vault.httpsUrl);
    const httpUrl = sanitizeUrl(vault.httpUrl);
    const baseUrl = httpsUrl ?? httpUrl ?? options.rest.baseUrl;
    const label = vault.name || vault.vault;
    const apiKey = (vault.apiKey ?? '').trim();

    try {
      const config: ConnectionTestConfig = {
        baseUrl,
        apiKey,
        vault: vault.vault,
        label,
        ...(httpsUrl ? { httpsUrl } : {}),
        ...(httpUrl ? { httpUrl } : {}),
        ...(vault.localFolderId ? { localFolderId: vault.localFolderId } : {}),
        ...(vault.localFolderName ? { localFolderName: vault.localFolderName } : {})
      };

      const result = await executeVaultStorageTargetTest(config);
      trackConnectionTestCompleted(
        summarizeVaultStorageTargetTest(result, vault.localFolderId ? 'local_folder' : 'rest_api'),
        startedAt
      );
      return result;
    } catch (error) {
      const errorInput: ConnectionErrorInput =
        error instanceof Error ||
        typeof error === 'string' ||
        typeof error === 'number' ||
        typeof error === 'boolean' ||
        error === null ||
        error === undefined ||
        typeof error === 'object'
          ? error
          : undefined;
      const summary = buildFailureSummary(
        errorInput,
        vault.localFolderId ? 'local_folder' : 'rest_api'
      );
      trackConnectionTestCompleted(summary, startedAt);
      return summary.result;
    }
  } catch (error) {
    const errorInput: ConnectionErrorInput =
      error instanceof Error ||
      typeof error === 'string' ||
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      error === null ||
      error === undefined ||
      typeof error === 'object'
        ? error
        : undefined;
    const summary = buildFailureSummary(
      errorInput,
      message.vault?.localFolderId ? 'local_folder' : 'unknown'
    );
    trackConnectionTestCompleted(summary, startedAt);
    return summary.result;
  }
}

async function executeStorageTargetTest(
  config: ConnectionTestConfig
): Promise<ConnectionTestSummary> {
  const restResult = await executeConnectionTest(config);
  const localChannel = config.localFolderId
    ? await executeLocalFolderChannelTest(config)
    : buildSkippedLocalFolderChannel();
  const channels = [localChannel, ...(restResult.result.channels ?? [])];
  const success = restResult.result.success && (!config.localFolderId || localChannel.success);
  const errors = channels
    .filter((channel) => channel.configured && !channel.success)
    .map((channel) => channel.error || channel.message)
    .filter((message): message is string => typeof message === 'string' && message.length > 0);
  const errorDescriptor = !success ? selectPrimaryErrorDescriptor(channels) : undefined;
  const storageTarget: StorageTarget = config.localFolderId ? 'local_folder' : 'rest_api';

  return {
    result: {
      success,
      message: '',
      messageDescriptor: createHeaderDescriptor(success),
      ...(restResult.result.status !== undefined ? { status: restResult.result.status } : {}),
      ...(restResult.result.response !== undefined ? { response: restResult.result.response } : {}),
      ...(errors.length ? { error: errors.join('\n') } : {}),
      ...(errorDescriptor ? { errorDescriptor } : {}),
      channels
    },
    storageTarget,
    ...(!success
      ? {
          failureCategory:
            config.localFolderId && !localChannel.success
              ? inferLocalFailureCategory(localChannel)
              : restResult.failureCategory
        }
      : {})
  };
}

function buildSkippedLocalFolderChannel(): ConnectionChannelResult {
  return {
    channel: 'localFolder',
    label: 'localFolder',
    labelDescriptor: createDescriptor('connectionChannelLocalFolderLabel'),
    configured: false,
    success: false,
    message: '',
    messageDescriptor: createDescriptor('connectionLocalFolderSkipped')
  };
}

async function executeConnectionTest(
  config: ConnectionTestConfig
): Promise<ConnectionResultSummary> {
  const trimmedBase = config.baseUrl.trim();
  const httpsUrl = sanitizeUrl(config.httpsUrl);
  const httpUrl = sanitizeUrl(config.httpUrl);
  const baseForConfig = trimmedBase || httpsUrl || httpUrl;

  if (!baseForConfig) {
    return {
      result: {
        success: false,
        message: '',
        messageDescriptor: createHeaderDescriptor(false),
        error: 'config error: no_usable_address',
        errorDescriptor: createFailureReasonDescriptor(NO_USABLE_ADDRESS_DETAIL)
      },
      failureCategory: 'validation'
    };
  }

  const vaultName = (config.vault ?? '').trim();
  const restChannel = primaryRestChannel(baseForConfig);
  if (!vaultName) {
    return {
      result: {
        success: false,
        message: '',
        messageDescriptor: createHeaderDescriptor(false),
        error: `config error: ${REST_VAULT_NAME_MISSING_DETAIL}`,
        errorDescriptor: createFailureReasonDescriptor(REST_VAULT_NAME_MISSING_DETAIL),
        channels: [
          buildRestChannelFailure(
            restChannel,
            baseForConfig,
            'config error',
            REST_VAULT_NAME_MISSING_DETAIL
          )
        ]
      },
      failureCategory: 'validation'
    };
  }

  if (!config.apiKey || config.apiKey.trim() === '') {
    return {
      result: {
        success: false,
        message: '',
        messageDescriptor: createHeaderDescriptor(false),
        error: `config error: ${REST_API_KEY_MISSING_DETAIL}`,
        errorDescriptor: createFailureReasonDescriptor(REST_API_KEY_MISSING_DETAIL),
        channels: [
          buildRestChannelFailure(
            restChannel,
            baseForConfig,
            'config error',
            REST_API_KEY_MISSING_DETAIL
          )
        ]
      },
      failureCategory: 'validation'
    };
  }

  const restConfig: RestConfig = {
    baseUrl: baseForConfig,
    vault: vaultName,
    apiKey: config.apiKey
  };

  if (httpsUrl !== undefined) {
    restConfig.httpsUrl = httpsUrl;
  }

  if (httpUrl !== undefined) {
    restConfig.httpUrl = httpUrl;
  }

  const urlsToTry = createConnectionCandidates(restConfig);
  const errors: string[] = [];

  for (const candidate of urlsToTry) {
    try {
      console.log(`[connectionTest] Testing URL (${candidate.protocol}):`, candidate.url);
      const { response, text } = await testConnection(candidate.url, config.apiKey);
      if (!response.ok) {
        const detail = sanitizeSnippet(text);
        const statusLine = `HTTP ${response.status}`;
        const message = detail ? `${statusLine} - ${detail}` : statusLine;
        const formatted = `${candidate.protocol}: ${formatCategoryMessage(
          'HTTP error',
          normalizeFailureDetail('HTTP error', message)
        )}`;
        console.warn(
          `[connectionTest] candidate responded with error${config.label ? ` (${config.label})` : ''}:`,
          formatted
        );
        errors.push(formatted);
        continue;
      }
      return {
        result: {
          success: true,
          status: response.status,
          message: '',
          messageDescriptor: createHeaderDescriptor(true),
          response: text.slice(0, 200),
          channels: [
            buildRestChannelSuccess(candidate.protocol, candidate.url, response.status, text)
          ]
        }
      };
    } catch (error) {
      const errorInput: ConnectionErrorInput =
        error instanceof Error ||
        typeof error === 'string' ||
        typeof error === 'number' ||
        typeof error === 'boolean' ||
        error === null ||
        error === undefined ||
        typeof error === 'object'
          ? error
          : undefined;
      const detail = sanitizeSnippet(error instanceof Error ? error.message : String(error));
      const category = deriveExternalCategory(errorInput);
      const formatted = `${candidate.protocol}: ${formatCategoryMessage(
        category,
        normalizeFailureDetail(category, detail)
      )}`;
      console.warn(
        `[connectionTest] candidate failed${config.label ? ` (${config.label})` : ''}:`,
        formatted
      );
      errors.push(formatted);

      if (!isRecoverableNetworkError(errorInput)) {
        break;
      }
    }
  }

  const joined =
    errors.join('; ') || formatCategoryMessage('network error', NETWORK_FAILURE_DETAIL);
  return {
    result: {
      success: false,
      message: '',
      messageDescriptor: createHeaderDescriptor(false),
      error: joined,
      errorDescriptor: createDescriptor('connectionRestFailure', { reason: joined }),
      channels: [buildRestChannelFailure(restChannel, baseForConfig, 'network error', joined)]
    },
    failureCategory: 'connection'
  };
}

function buildRestChannelSuccess(
  protocol: string,
  url: string,
  status: number,
  text: string
): ConnectionChannelResult {
  const channel = protocol === 'HTTP' ? 'http' : 'https';
  return {
    channel,
    label: 'rest',
    labelDescriptor: createDescriptor('connectionChannelRestLabel'),
    configured: true,
    success: true,
    url,
    status,
    message: '',
    messageDescriptor: createDescriptor('connectionRestSuccess', { status }),
    response: text.slice(0, 200)
  };
}

function buildRestChannelFailure(
  channel: 'https' | 'http',
  url: string,
  category: FailureCategory,
  detail?: string
): ConnectionChannelResult {
  const normalizedReason = detail ?? defaultFailureDetail(category);
  const descriptor = createFailureReasonDescriptor(normalizedReason);
  const certificateUrl = buildCertificateUrlForFailure(channel, url, category, normalizedReason);
  return {
    channel,
    label: 'rest',
    labelDescriptor: createDescriptor('connectionChannelRestLabel'),
    configured: true,
    success: false,
    url,
    message: '',
    messageDescriptor: descriptor,
    error: normalizedReason,
    errorDescriptor: descriptor,
    ...(certificateUrl ? { certificateUrl } : {})
  };
}

async function testConnection(url: string, apiKey: string) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  const text = await readResponseTextSafely(response);
  return { response, text };
}

async function readResponseTextSafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText || '';
  }
}

function mergeRestOptions(rest: RestOptions, draft?: Partial<RestOptions>): RestOptions {
  if (!draft) {
    return { ...rest };
  }

  const httpsUrl = sanitizeUrl(draft.httpsUrl) ?? rest.httpsUrl;
  const httpUrl = sanitizeUrl(draft.httpUrl) ?? rest.httpUrl;
  const vault = draft.vault !== undefined ? draft.vault.trim() : rest.vault;
  const apiKey = draft.apiKey !== undefined ? draft.apiKey.trim() : rest.apiKey;
  const baseUrl =
    sanitizeUrl(draft.baseUrl) ?? httpsUrl ?? httpUrl ?? sanitizeUrl(rest.baseUrl) ?? rest.baseUrl;

  return {
    baseUrl,
    vault,
    apiKey,
    ...(httpsUrl !== undefined && { httpsUrl }),
    ...(httpUrl !== undefined && { httpUrl }),
    ...(rest.localFolderId !== undefined && { localFolderId: rest.localFolderId }),
    ...(rest.localFolderName !== undefined && { localFolderName: rest.localFolderName })
  };
}

function createConnectionCandidates(config: RestConfig): UrlCandidate[] {
  const candidates = createRestCandidates(config, '', null);
  if (candidates.length > 0) {
    return candidates.map((candidate) => ({
      url: candidate.url,
      protocol: normalizeProtocolLabel(candidate.protocol)
    }));
  }

  const trimmed = config.baseUrl.trim();
  const fallbackUrl = trimmed.replace(/\/+$/, '') + '/';
  return [
    {
      url: fallbackUrl,
      protocol: fallbackUrl.startsWith('https://') ? 'HTTPS' : 'HTTP'
    }
  ];
}

function normalizeProtocolLabel(protocol: string): string {
  return protocol.toUpperCase().startsWith('HTTPS') ? 'HTTPS' : 'HTTP';
}

function isRecoverableNetworkError(error: ConnectionErrorInput): boolean {
  return error instanceof Error && isKnownNetworkFailure(error.message.toLowerCase());
}

function deriveExternalCategory(error: ConnectionErrorInput): FailureCategory {
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('failed to fetch') || normalized.includes('networkerror')) {
      return 'network error';
    }
    if (normalized.includes('http') || normalized.includes('status')) {
      return 'HTTP error';
    }
  }
  return 'config error';
}

function formatCategoryMessage(category: FailureCategory, detail?: string): string {
  if (detail) {
    return `${category}: ${detail}`;
  }
  return category;
}

function buildFailureSummary(
  error: ConnectionErrorInput,
  storageTarget: StorageTarget
): ConnectionTestSummary {
  const category = deriveExternalCategory(error);
  const detail = sanitizeSnippet(error instanceof Error ? error.message : String(error));
  const normalized = normalizeFailureDetail(category, detail) ?? defaultFailureDetail(category);
  const formatted = formatCategoryMessage(category, normalized);
  console.error('[connectionTest] unexpected error:', error);
  return {
    result: {
      success: false,
      message: '',
      messageDescriptor: createHeaderDescriptor(false),
      error: formatted,
      errorDescriptor: createFailureReasonDescriptor(normalized)
    },
    storageTarget,
    failureCategory: toAnalyticsFailureCategory(category)
  };
}

function primaryRestChannel(baseUrl: string): 'https' | 'http' {
  return baseUrl.startsWith('http://') ? 'http' : 'https';
}

function buildCertificateUrlForFailure(
  channel: 'https' | 'http',
  url: string,
  category: FailureCategory,
  detail?: string
): string | undefined {
  if (channel !== 'https') {
    return undefined;
  }

  const normalizedDetail = detail?.toLowerCase() ?? '';
  const looksLikeCertificateFailure =
    category === 'network error' ||
    normalizedDetail.includes('cert') ||
    normalizedDetail.includes('certificate') ||
    normalizedDetail.includes('err_cert');
  if (!looksLikeCertificateFailure || (!url.includes('localhost') && !url.includes('127.0.0.1'))) {
    return undefined;
  }

  try {
    return new URL('/obsidian-local-rest-api.crt', url.replace(/\/+$/, '') + '/').toString();
  } catch {
    return undefined;
  }
}

function findVaultConfig(vaults: VaultConfig[], vaultId: string): VaultConfig {
  const vault = vaults.find((item) => item.id === vaultId);
  if (!vault) {
    throw new Error(EXTRA_VAULT_MISSING_DETAIL);
  }
  return vault;
}

function resolveVaultConfig(
  message: TestVaultConnectionMessage,
  storedVaults: VaultConfig[]
): VaultConfig {
  if (message.vault) {
    return { ...message.vault };
  }

  return findVaultConfig(storedVaults, message.vaultId);
}

function sanitizeUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function trackConnectionTestCompleted(summary: ConnectionTestSummary, startedAt: number): void {
  void trackUsageEvent('connection_test_completed', {
    storage_target: summary.storageTarget,
    outcome: summary.result.success ? 'completed' : 'failed',
    duration_bucket: bucketDurationMs(Date.now() - startedAt),
    ...(summary.failureCategory ? { failure_category: summary.failureCategory } : {})
  });
}

function toAnalyticsFailureCategory(category: FailureCategory): AnalyticsFailureCategory {
  if (category === 'config error') {
    return 'validation';
  }
  return 'connection';
}

function selectPrimaryErrorDescriptor(
  channels: ConnectionChannelResult[]
): UserVisibleMessageDescriptor | undefined {
  return channels.find((channel) => channel.configured && !channel.success)?.errorDescriptor;
}

function inferLocalFailureCategory(channel: ConnectionChannelResult): AnalyticsFailureCategory {
  const detail = `${channel.error ?? channel.message}`.toLowerCase();
  return detail.includes('not supported') ? 'unsupported' : 'permission';
}
