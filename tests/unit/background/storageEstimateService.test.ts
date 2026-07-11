import { describe, expect, it, vi } from 'vitest';
import { createStorageEstimateService } from '../../../src/background/services/storageEstimateService';

describe('storageEstimateService', () => {
  it('returns a sanitized supported snapshot', async () => {
    const estimate = vi.fn().mockResolvedValue({ usage: 750, quota: 1_000 });
    const service = createStorageEstimateService({ estimate });

    await expect(service.getSnapshot()).resolves.toEqual({
      usage: 750,
      quota: 1_000,
      available: 250,
      supported: true
    });
  });

  it('returns a fixed unsupported snapshot when the API is absent', async () => {
    const service = createStorageEstimateService({ estimate: null });
    await expect(service.getSnapshot()).resolves.toEqual({
      usage: null,
      quota: null,
      available: null,
      supported: false
    });
  });

  it.each([
    ['rejection', () => Promise.reject(new Error('/private/profile/path'))],
    ['non-finite usage', () => Promise.resolve({ usage: Number.POSITIVE_INFINITY, quota: 1_000 })],
    ['negative usage', () => Promise.resolve({ usage: -1, quota: 1_000 })],
    ['zero quota', () => Promise.resolve({ usage: 0, quota: 0 })],
    ['missing quota', () => Promise.resolve({ usage: 10 })]
  ])('sanitizes %s without exposing raw diagnostics', async (_label, estimate) => {
    const service = createStorageEstimateService({ estimate });
    await expect(service.getSnapshot()).resolves.toEqual({
      usage: null,
      quota: null,
      available: null,
      supported: true
    });
  });
});
