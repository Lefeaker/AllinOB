import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageService } from '../../../src/platform/interfaces/storage';

const getMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const mergeOptionsMock = vi.hoisted(() =>
  vi.fn((value: unknown) => ({ merged: true, ...(value as Record<string, unknown>) }))
);
const getServiceMock = vi.hoisted(() => vi.fn());

vi.mock('@shared/di', () => ({
  getService: getServiceMock
}));
vi.mock('@shared/config/optionsMerger', () => ({ mergeOptions: mergeOptionsMock }));
vi.mock('@shared/config/defaultOptions', () => ({ DEFAULT_OPTIONS: { defaults: true } }));

function createStorage(): StorageService {
  return {
    sync: {
      get: vi.fn(async () => undefined),
      getAll: vi.fn(async () => ({})),
      getMany: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      setMany: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      watchKey: vi.fn(() => () => undefined),
      watchAll: vi.fn(() => () => undefined)
    },
    local: {
      get: getMock,
      getAll: vi.fn(async () => ({})),
      set: setMock,
      getMany: vi.fn(async () => ({})),
      setMany: vi.fn(async () => undefined),
      remove: removeMock,
      clear: vi.fn(async () => undefined),
      watchKey: vi.fn(() => () => undefined),
      watchAll: vi.fn(() => () => undefined)
    },
    session: {
      get: vi.fn(async () => undefined),
      getAll: vi.fn(async () => ({})),
      getMany: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      setMany: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      watchKey: vi.fn(() => () => undefined),
      watchAll: vi.fn(() => () => undefined)
    }
  };
}

describe('configService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getServiceMock.mockReturnValue({ storage: createStorage() });
  });

  it('loads defaults when storage is empty and validates direct config', async () => {
    getMock.mockResolvedValue(undefined);
    const mod = await import('../../../src/background/services/configService');
    await expect(mod.getCurrentConfig()).resolves.toEqual({
      success: true,
      data: { defaults: true }
    });
    expect(mod.validateConfiguration({ rest: {} }).success).toBe(true);
  });

  it('updates and resets configuration via storage', async () => {
    getMock
      .mockResolvedValueOnce({ rest: { httpUrl: 'http://localhost:27123' } })
      .mockResolvedValueOnce({ rest: { httpUrl: 'http://localhost:27123' } });
    setMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    const mod = await import('../../../src/background/services/configService');
    const updateResult = await mod.updateConfiguration({
      templates: { article: 'A/{title}.md' }
    } as never);
    expect(updateResult.success).toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      'options',
      expect.objectContaining({ templates: { article: 'A/{title}.md' } })
    );

    const unsubscribe = mod.addConfigChangeListener(vi.fn());
    const notifyResult = await mod.updateConfigurationWithNotification({
      rest: { apiKey: 'key' }
    } as never);
    expect(notifyResult.success).toBe(true);
    unsubscribe();

    await expect(mod.resetConfiguration()).resolves.toEqual({
      success: true,
      data: { defaults: true }
    });
    expect(removeMock).toHaveBeenCalledWith('options');
  });

  it('maps storage and merge failures into service failures', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMock.mockRejectedValueOnce(new Error('storage down'));
    const mod = await import('../../../src/background/services/configService');
    const failure = await mod.getCurrentConfig();
    expect(failure.success).toBe(false);

    getMock.mockResolvedValueOnce({ rest: {} });
    mergeOptionsMock.mockImplementationOnce(() => {
      throw new Error('merge failed');
    });
    const invalid = mod.validateConfiguration({ rest: {} });
    expect(invalid.success).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});
