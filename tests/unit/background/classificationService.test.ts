import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OptionsState } from '@shared/types/options';
import type { ClipPayload } from '@shared/types';
import { ErrorSeverity } from '@shared/errors/types';
import { getRestDefaults } from '../../utils/restDefaults';
import { DEFAULT_TAXONOMY_CONFIG } from '@shared/types/taxonomy';
import { ClassificationResultSchema } from '@shared/schemas';

type ClassifyFn = typeof import('../../../src/background/llm/classifier').classify;

const classifyMock = vi.fn<(...args: Parameters<ClassifyFn>) => ReturnType<ClassifyFn>>();

vi.mock('../../../src/background/llm/classifier', () => ({
  classify: classifyMock
}));

describe('classificationService', () => {
  beforeEach(() => {
    vi.resetModules();
    classifyMock.mockReset();
  });

  it('returns fallback when classifier disabled', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: false });
    const payload = createPayload();

    const result = await classifyClip(options, payload);
    expect(result.type).toBe(payload.type);
    expect(result.fallbackReason).toBe('disabled');
    expect(result.status).toBe('fallback');
    expect(result.errorDetail).toBeUndefined();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('returns classifier result when invocation succeeds', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: true });
    const payload = createPayload();
    const classifierResult = {
      ok: true as const,
      payload: { type: 'custom', topics: ['tech'], tags: ['foo'] }
    };

    classifyMock.mockResolvedValueOnce(classifierResult);

    const result = await classifyClip(options, payload);
    expect(result.status).toBe('success');
    expect(result.type).toBe('custom');
    expect(result.topics).toEqual(['tech']);
    expect(result.tags).toEqual(['foo']);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.errorDetail).toBeUndefined();
  });

  it('does not copy unknown classifier provider fields to the result root', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: true });
    const payload = createPayload();
    classifyMock.mockResolvedValueOnce({
      ok: true as const,
      payload: {
        type: 'custom',
        topics: ['tech'],
        tags: ['foo'],
        ai_platform: 'provider',
        confidence: 0.92,
        raw_provider_payload: { tokenCount: 12 }
      }
    });

    const result = await classifyClip(options, payload);

    expect(result).toMatchObject({
      status: 'success',
      type: 'custom',
      topics: ['tech'],
      tags: ['foo'],
      ai_platform: 'provider'
    });
    expect('confidence' in result).toBe(false);
    expect('raw_provider_payload' in result).toBe(false);
  });

  it('falls back when classifier throws', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: true });
    const payload = createPayload();

    classifyMock.mockRejectedValueOnce(new Error('network'));

    const result = await classifyClip(options, payload);
    expect(result.type).toBe(payload.type);
    expect(result.fallbackReason).toBe('error');
    expect(result.status).toBe('fallback');
    expect(result.errorDetail).toMatchObject({
      code: 'CLASSIFIER_TRANSPORT_FAILURE',
      domain: 'classifier',
      message: 'network',
      severity: ErrorSeverity.ERROR
    });
    expect(result.errorDetail?.context).toMatchObject({
      provider: options.classifier?.provider
    });
  });

  it('falls back when classifier returns error payload', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: true });
    const payload = createPayload();

    classifyMock.mockResolvedValueOnce({
      ok: false as const,
      error: {
        code: 'CLASSIFIER_TRANSPORT_FAILURE',
        domain: 'classifier',
        message: '401 Unauthorized',
        severity: ErrorSeverity.ERROR,
        recoverable: true,
        userMessage: '分类服务暂时不可用，我们会继续使用默认分类。',
        context: {
          provider: options.classifier?.provider,
          status: 401
        }
      }
    });

    const result = await classifyClip(options, payload);
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('error');
    expect(result.errorDetail).toMatchObject({
      code: 'CLASSIFIER_TRANSPORT_FAILURE',
      message: '401 Unauthorized'
    });
    expect(result.errorDetail?.context).toMatchObject({ status: 401 });
  });

  it('returns fallback timeout classification when classifier transport exceeds the budget', async () => {
    vi.useFakeTimers();
    classifyMock.mockReturnValue(new Promise(() => undefined) as never);
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const classifyPromise = classifyClip(
      createOptions({
        enabled: true,
        timeoutMs: 50
      }),
      {
        type: 'article',
        title: 'Slow Clip',
        markdown: 'Long article markdown',
        meta: { url: 'https://example.com/slow' }
      }
    );

    await vi.advanceTimersByTimeAsync(60);
    const result = await Promise.race([
      classifyPromise,
      Promise.resolve({ status: 'pending', fallbackReason: undefined })
    ]);

    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('timeout');
    vi.useRealTimers();
  });

  it('limits preview length to 4000 characters', async () => {
    const { createClassificationPreview } =
      await import('../../../src/background/services/classificationService');
    const longMarkdown = '#'.repeat(6000);
    const payload = createPayload({ markdown: longMarkdown });

    const preview = createClassificationPreview(payload);
    expect(preview.length).toBeLessThanOrEqual(4000);
  });

  it('fallback result conforms to ClassificationResultSchema', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: false });
    const payload = createPayload({ type: 'article', meta: { platform: 'test' } });

    const result = await classifyClip(options, payload);

    // Verify result conforms to Schema
    const parseResult = ClassificationResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.status).toBe('fallback');
      expect(parseResult.data.type).toBe('article');
      expect(parseResult.data.ai_platform).toBe('test');
      expect(parseResult.data.topics).toEqual([]);
      expect(parseResult.data.tags).toEqual([]);
    }
  });

  it('success result conforms to ClassificationResultSchema', async () => {
    const { classifyClip } = await import('../../../src/background/services/classificationService');
    const options = createOptions({ enabled: true });
    const payload = createPayload();
    const classifierResult = {
      ok: true as const,
      payload: {
        type: 'research',
        topics: ['ai', 'ml'],
        tags: ['important', 'review'],
        ai_platform: 'custom'
      }
    };

    classifyMock.mockResolvedValueOnce(classifierResult);

    const result = await classifyClip(options, payload);

    // Verify result conforms to Schema
    const parseResult = ClassificationResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.status).toBe('success');
      expect(parseResult.data.type).toBe('research');
      expect(parseResult.data.topics).toEqual(['ai', 'ml']);
      expect(parseResult.data.tags).toEqual(['important', 'review']);
      expect(parseResult.data.ai_platform).toBe('custom');
    }
  });
});

function createOptions(
  classifierOverrides: Partial<{ enabled: boolean; timeoutMs: number }> = {}
): OptionsState {
  const classifier = {
    enabled: classifierOverrides.enabled ?? true,
    provider: 'ollama' as const,
    endpoint: 'http://localhost:11434/api/chat',
    apiKey: '',
    model: 'llama3.1',
    timeoutMs: classifierOverrides.timeoutMs,
    taxonomy: DEFAULT_TAXONOMY_CONFIG
  };

  const restDefaults = getRestDefaults();

  return {
    rest: {
      baseUrl: restDefaults.baseUrl,
      httpsUrl: restDefaults.httpsUrl,
      httpUrl: restDefaults.httpUrl,
      vault: restDefaults.vault,
      apiKey: 'key'
    },
    templates: {
      article: '',
      video: '',
      ai: '',
      fragment: '',
      reading: ''
    },
    domainMappings: {},
    classifier,
    deepResearch: undefined,
    vaultRouter: undefined,
    fragmentClipper: undefined
  };
}

function createPayload(overrides: Partial<ClipPayload> = {}): ClipPayload {
  const { meta, ...restOverrides } = overrides;
  return {
    markdown: '# Title',
    title: 'Title',
    type: 'article',
    ...restOverrides,
    meta: {
      url: 'https://example.com/post',
      platform: 'test',
      ...meta
    }
  };
}
