import type {
  RestClient,
  RestConnection,
  RestWriteFileOptions
} from '../shared/interfaces/restClient';
import type { AppError } from '../shared/errors/types';
import {
  createRestCandidates,
  maskApiKey,
  buildVaultUrl
} from '../background/utils/restCandidates';
import { errorHandler, restErrors } from '../shared/errors';
import { encodeVaultWritePath, normalizeRestWritePath } from '../shared/paths/vaultWritePath';

type FailureCategory = 'HTTP error' | 'network error' | 'config error';

const RESPONSE_SNIPPET_LIMIT = 120;
const NETWORK_FAILURE_DETAIL = 'request failed';
const HTTP_FAILURE_DETAIL = 'response unavailable';
const CONFIG_FAILURE_DETAIL = 'configuration invalid';

function sanitizeSnippet(raw?: string): string | undefined {
  const normalized = raw?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= RESPONSE_SNIPPET_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, RESPONSE_SNIPPET_LIMIT)}...`;
}

function formatCategoryMessage(category: FailureCategory, detail?: string): string {
  if (detail) {
    return `${category}: ${detail}`;
  }
  return category;
}

function createSanitizedRestCause(message: string): Error {
  return new Error(message);
}

function describeRestResponse(error: RestResponseError): string | undefined {
  const match = error.message.match(/\):\s*(.+)$/);
  const rawDetail = match?.[1] ?? error.message;
  return sanitizeSnippet(rawDetail);
}

function deriveRestFailure(error: unknown): {
  category: FailureCategory;
  detail: string | undefined;
} {
  if (error instanceof RestResponseError) {
    const detail = describeRestResponse(error);
    const normalizedDetail = detail?.replace(new RegExp(`^${error.status}\\s*`), '').trim();
    const statusLine = `HTTP ${error.status}`;
    return {
      category: 'HTTP error',
      detail: normalizedDetail ? `${statusLine} - ${normalizedDetail}` : statusLine
    };
  }

  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('failed to fetch') || normalized.includes('networkerror')) {
      return { category: 'network error', detail: NETWORK_FAILURE_DETAIL };
    }
    if (normalized.includes('http') || normalized.includes('status')) {
      const snippet = sanitizeSnippet(error.message);
      return { category: 'HTTP error', detail: snippet ?? HTTP_FAILURE_DETAIL };
    }

    const detail = sanitizeSnippet(error.message);
    if (
      detail?.toLowerCase().includes('cannot read properties') ||
      normalized.includes('missing response from rest endpoint') ||
      normalized.includes('illegal invocation')
    ) {
      return { category: 'config error', detail: CONFIG_FAILURE_DETAIL };
    }

    return { category: 'config error', detail: detail ?? CONFIG_FAILURE_DETAIL };
  }

  const detail = sanitizeSnippet(String(error));
  return { category: 'config error', detail: detail ?? CONFIG_FAILURE_DETAIL };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function bindFetch(fetchImpl?: typeof fetch | FetchLike): FetchLike {
  const impl = fetchImpl ?? globalThis.fetch;
  if (!impl) {
    throw new Error('Fetch API is not available in the current environment.');
  }

  // 绑定到 globalThis，避免在 Service Worker 环境中出现 Illegal invocation
  const fetchFunction = impl as FetchLike;
  const boundFetch: FetchLike = (input, init) => {
    const result = fetchFunction.call(globalThis, input, init);
    return result;
  };
  return boundFetch;
}

/**
 * REST 响应错误类
 */
class RestResponseError extends Error {
  status: number;
  protocol: string;

  constructor(status: number, protocol: string, message: string) {
    super(`REST write failed (${protocol}): ${status} ${message}`);
    this.status = status;
    this.protocol = protocol;
    this.name = 'RestResponseError';
  }
}

/**
 * 基于 fetch 的 REST 客户端实现
 *
 * 这是 RestClient 接口的默认实现，使用全局 fetch API
 * 支持 HTTPS/HTTP 协议遍历和错误聚合
 */
export class FetchRestClient implements RestClient {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: typeof fetch | FetchLike = fetch) {
    this.fetchImpl = bindFetch(fetchImpl);
  }

  async writeFile(
    config: RestConnection,
    filePath: string,
    content: BodyInit,
    options: RestWriteFileOptions = {}
  ): Promise<void> {
    const encodedPath = this.buildRestWritePath(filePath, config.vault);

    console.log('Writing to Obsidian:', {
      filePath,
      baseUrl: config.baseUrl,
      httpsUrl: config.httpsUrl,
      httpUrl: config.httpUrl,
      vault: config.vault,
      hasApiKey: Boolean(config.apiKey)
    });

    const candidates = createRestCandidates(config, encodedPath);
    if (candidates.length === 0) {
      candidates.push({
        url: buildVaultUrl(config.baseUrl, config.vault, encodedPath),
        protocol: config.baseUrl.startsWith('https://') ? 'HTTPS' : 'HTTP'
      });
    }

    const errors: AppError[] = [];

    for (const candidate of candidates) {
      try {
        await this.doPut(candidate.url, candidate.protocol, config.apiKey, content, options);
        console.log(
          `✅ Write successful (${candidate.protocol}):`,
          maskApiKey(candidate.url, config.apiKey)
        );
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const { category, detail } = deriveRestFailure(err);
        const sanitizedMessage = formatCategoryMessage(category, detail);
        console.warn(`❌ ${candidate.protocol} failed:`, sanitizedMessage);

        const context: Record<string, unknown> = {
          endpoint: candidate.url,
          method: 'PUT',
          vault: config.vault,
          protocol: candidate.protocol,
          failureCategory: category
        };

        if (err instanceof RestResponseError && err.status !== undefined) {
          context.statusCode = err.status;
        }

        const appError = restErrors.requestFailed(sanitizedMessage, context, {
          cause: createSanitizedRestCause(sanitizedMessage)
        });
        errors.push(appError);
        await errorHandler.handle(appError, { suppressNotifications: true });

        if (err instanceof RestResponseError) {
          continue;
        }

        if (category !== 'network error') {
          throw appError;
        }
      }
    }

    const aggregatedError = restErrors.vaultUnavailable({
      endpoint: config.baseUrl,
      vault: config.vault,
      retryCount: errors.length,
      attempts: errors.map((attempt) => ({
        protocol: attempt.context?.protocol,
        endpoint: attempt.context?.endpoint,
        message: attempt.message,
        statusCode: attempt.context?.statusCode
      }))
    });

    throw aggregatedError;
  }

  private async doPut(
    url: string,
    protocol: string,
    apiKey: string,
    content: BodyInit,
    options: RestWriteFileOptions
  ): Promise<Response> {
    const maskedUrl = maskApiKey(url, apiKey);
    console.log(`Trying ${protocol}:`, maskedUrl);

    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': options.contentType ?? 'text/markdown; charset=utf-8'
      },
      body: content
    });

    if (!res) {
      throw new Error('Missing response from REST endpoint');
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText || HTTP_FAILURE_DETAIL);
      throw new RestResponseError(res.status, protocol, errorText);
    }

    return res;
  }

  private buildRestWritePath(filePath: string, vaultName: string): string {
    const normalized = normalizeRestWritePath(filePath, vaultName);
    return encodeVaultWritePath(normalized.path);
  }
}

/**
 * 创建基于 fetch 的 REST 客户端实例
 *
 * @param fetchImpl fetch 实现，默认使用全局 fetch，测试时可传入 mock
 * @returns RestClient 实例
 */
export function createFetchRestClient(fetchImpl: typeof fetch | FetchLike = fetch): RestClient {
  return new FetchRestClient(fetchImpl);
}
