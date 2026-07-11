import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ChangeListener {
  (changes: Record<string, chrome.storage.StorageChange>, area: string): void;
}
let changeListener: ChangeListener | undefined;
const chromeApi = vi.hoisted(() => ({
  storage: {
    local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    onChanged: {
      addListener: vi.fn((listener: ChangeListener) => {
        changeListener = listener;
      }),
      removeListener: vi.fn()
    }
  }
}));
const lastErrorMock = vi.hoisted(() =>
  vi.fn<(...args: []) => chrome.runtime.LastError | null>(() => null)
);

vi.mock('../../../../src/platform/chrome/utils', () => ({
  ensureChrome: (): typeof chromeApi => chromeApi,
  getChromeLastError: (): chrome.runtime.LastError | null => lastErrorMock(),
  normalizePromise: <T>(
    executor: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
  ) => new Promise<T>(executor)
}));

describe('chromeStorageService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    changeListener = undefined;
    chromeApi.storage.local.get.mockImplementation(
      (key: string | string[] | null, cb: (items: Record<string, unknown>) => void) =>
        key === null
          ? cb({ key: 'value', second: 2 })
          : cb({ [Array.isArray(key) ? key[0] : key]: 'value' })
    );
    chromeApi.storage.local.set.mockImplementation(
      (_entries: Record<string, unknown>, cb: () => void) => cb()
    );
    chromeApi.storage.local.remove.mockImplementation((_key: string | string[], cb: () => void) =>
      cb()
    );
    chromeApi.storage.local.clear.mockImplementation((cb: () => void) => cb());
  });

  it('reads writes and watches local storage', async () => {
    const { chromeStorageService } = await import('../../../../src/platform/chrome/storage');
    await expect(chromeStorageService.local.get('key')).resolves.toBe('value');
    await expect(chromeStorageService.local.getAll()).resolves.toEqual({ key: 'value', second: 2 });
    await chromeStorageService.local.set('key', 'next');
    await chromeStorageService.local.remove('key');
    await chromeStorageService.local.clear();

    const watchKey = vi.fn();
    const unwatchKey = chromeStorageService.local.watchKey('key', watchKey);
    changeListener?.({ key: { oldValue: 'old', newValue: 'new' } }, 'local');
    expect(watchKey).toHaveBeenCalledWith('new', { oldValue: 'old', newValue: 'new' });
    unwatchKey();
    expect(chromeApi.storage.onChanged.removeListener).toHaveBeenCalled();
  });
});
