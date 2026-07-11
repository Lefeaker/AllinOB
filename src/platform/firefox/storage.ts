import type {
  StorageAreaChangeCallback,
  StorageAreaService,
  StorageChange,
  StorageService,
  StorageChangeCallback,
  StorageRecord
} from '../interfaces/storage';
import { ensureFirefox } from './utils';

type FirefoxStorageAreaName = 'local' | 'sync' | 'session';

function ensureStorageArea(areaName: FirefoxStorageAreaName) {
  const firefoxApi = ensureFirefox();
  const area = firefoxApi.storage?.[areaName];
  if (!area) {
    throw new Error(`Firefox storage.${areaName} is unavailable`);
  }
  return area;
}

function mapChange(change: browser.storage.StorageChange | undefined): StorageChange {
  if (!change) {
    return {};
  }
  return {
    ...(change.oldValue !== undefined && { oldValue: change.oldValue }),
    ...(change.newValue !== undefined && { newValue: change.newValue })
  };
}

function createWatcher(
  areaName: FirefoxStorageAreaName,
  handler: (changes: Record<string, StorageChange>) => void
): () => void {
  const firefoxApi = ensureFirefox();
  if (!firefoxApi.storage.onChanged) {
    return () => {};
  }
  const wrapped = (changes: Record<string, browser.storage.StorageChange>, changedArea: string) => {
    if (changedArea !== areaName) {
      return;
    }
    const mapped: Record<string, StorageChange> = {};
    for (const [key, change] of Object.entries(changes)) {
      mapped[key] = mapChange(change);
    }
    handler(mapped);
  };
  firefoxApi.storage.onChanged.addListener(wrapped);
  return () => firefoxApi.storage.onChanged?.removeListener(wrapped);
}

function createFirefoxStorageArea(areaName: FirefoxStorageAreaName): StorageAreaService {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const area = ensureStorageArea(areaName);
      const result = await area.get(key);
      return (result as Record<string, T | undefined>)[key];
    },

    getAll(): Promise<StorageRecord> {
      const area = ensureStorageArea(areaName);
      return area.get(null);
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const area = ensureStorageArea(areaName);
      await area.set({ [key]: value });
    },

    async getMany<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
      const area = ensureStorageArea(areaName);
      const result = await area.get(keys);
      const output: Record<string, T | undefined> = {};
      for (const key of keys) {
        output[key] = (result as Record<string, T | undefined>)[key];
      }
      return output;
    },

    async setMany<T = unknown>(entries: Record<string, T>): Promise<void> {
      const area = ensureStorageArea(areaName);
      await area.set(entries);
    },

    async remove(keys: string | string[]): Promise<void> {
      const area = ensureStorageArea(areaName);
      await area.remove(keys);
    },

    async clear(): Promise<void> {
      const area = ensureStorageArea(areaName);
      await area.clear();
    },

    watchKey<T = unknown>(key: string, callback: StorageChangeCallback<T>): () => void {
      return createWatcher(areaName, (changes) => {
        if (!(key in changes)) {
          return;
        }
        const change = changes[key];
        callback(change.newValue as T | undefined, {
          ...(change.oldValue !== undefined && { oldValue: change.oldValue as T }),
          ...(change.newValue !== undefined && { newValue: change.newValue as T })
        });
      });
    },

    watchAll(callback: StorageAreaChangeCallback): () => void {
      return createWatcher(areaName, callback);
    }
  };
}

function hasStorageArea(areaName: FirefoxStorageAreaName): boolean {
  try {
    const firefoxApi = ensureFirefox();
    return Boolean(firefoxApi.storage?.[areaName]);
  } catch {
    return false;
  }
}

export const firefoxStorageService: StorageService = {
  local: createFirefoxStorageArea('local'),
  sync: createFirefoxStorageArea('sync'),
  ...(hasStorageArea('session') ? { session: createFirefoxStorageArea('session') } : {})
};
