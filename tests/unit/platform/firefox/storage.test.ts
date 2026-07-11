import { beforeEach, describe, expect, it, vi } from 'vitest';

let changeListener:
  | ((
      changes: Record<string, browser.storage.StorageChange>,
      area: 'local' | 'sync' | 'session'
    ) => void)
  | undefined;
const firefoxApi = vi.hoisted(() => ({
  storage: {
    local: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    session: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    onChanged: {
      addListener: vi.fn((listener: typeof changeListener) => {
        changeListener = listener ?? undefined;
      }),
      removeListener: vi.fn()
    }
  }
}));
vi.mock('../../../../src/platform/firefox/utils', () => ({
  ensureFirefox: (): typeof firefoxApi => firefoxApi
}));

describe('firefoxStorageService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    changeListener = undefined;
    firefoxApi.storage.local.get.mockImplementation((key?: string | string[] | null) =>
      Promise.resolve(key == null ? { key: 'value', second: 2 } : { key: 'value' })
    );
    firefoxApi.storage.local.set.mockResolvedValue(undefined);
    firefoxApi.storage.local.remove.mockResolvedValue(undefined);
    firefoxApi.storage.local.clear.mockResolvedValue(undefined);
  });

  it('reads writes and watches firefox storage', async () => {
    const { firefoxStorageService } = await import('../../../../src/platform/firefox/storage');
    await expect(firefoxStorageService.local.get('key')).resolves.toBe('value');
    await expect(firefoxStorageService.local.getAll()).resolves.toEqual({
      key: 'value',
      second: 2
    });
    await firefoxStorageService.local.set('key', 'next');
    await firefoxStorageService.local.remove('key');
    await firefoxStorageService.local.clear();
    const watcher = vi.fn();
    const off = firefoxStorageService.local.watchKey('key', watcher);
    changeListener?.({ key: { oldValue: 'old', newValue: 'new' } }, 'local');
    expect(watcher).toHaveBeenCalledWith('new', { oldValue: 'old', newValue: 'new' });
    off();
  });
});
