import type {
  StorageAreaService,
  StorageService,
  StorageChange,
  StorageChangeCallback,
  StorageRecord
} from '../interfaces/storage';
import { ensureChrome, getChromeLastError, normalizePromise } from './utils';

type StorageAreaName = 'sync' | 'local' | 'session';

function createStorageArea(area: StorageAreaName): StorageAreaService {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      const result = await normalizePromise<Record<string, T | undefined>>((resolve, reject) => {
        try {
          areaApi.get(key, (items) => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(items as Record<string, T | undefined>);
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return result[key];
    },

    getAll(): Promise<StorageRecord> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      return normalizePromise<StorageRecord>((resolve, reject) => {
        try {
          areaApi.get(null, (items) => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(items);
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async getMany<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      return normalizePromise<Record<string, T | undefined>>((resolve, reject) => {
        try {
          areaApi.get(keys, (items) => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve(items as Record<string, T | undefined>);
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      await normalizePromise<void>((resolve, reject) => {
        try {
          areaApi.set({ [key]: value }, () => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async setMany<T = unknown>(entries: Record<string, T>): Promise<void> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      await normalizePromise<void>((resolve, reject) => {
        try {
          areaApi.set(entries, () => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async remove(key: string | string[]): Promise<void> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      await normalizePromise<void>((resolve, reject) => {
        try {
          areaApi.remove(key, () => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async clear(): Promise<void> {
      const chromeApi = ensureChrome();
      const areaApi = chromeApi.storage?.[area];
      if (!areaApi) {
        throw new Error(`chrome.storage.${area} is unavailable`);
      }
      await normalizePromise<void>((resolve, reject) => {
        try {
          areaApi.clear(() => {
            const error = getChromeLastError();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    watchKey<T = unknown>(key: string, callback: StorageChangeCallback<T>) {
      const chromeApi = ensureChrome();
      const onChanged = chromeApi.storage?.onChanged;
      if (!onChanged || typeof onChanged.addListener !== 'function') {
        return () => undefined;
      }
      const listener = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
      ) => {
        if (areaName !== area) {
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(changes, key)) {
          return;
        }
        const change = changes[key];
        const typedChange: StorageChange<T> = {
          ...(change?.oldValue !== undefined && { oldValue: change.oldValue as T }),
          ...(change?.newValue !== undefined && { newValue: change.newValue as T })
        };
        callback(typedChange.newValue, typedChange);
      };
      onChanged.addListener(listener);
      return () => {
        onChanged.removeListener(listener);
      };
    },

    watchAll(callback) {
      const chromeApi = ensureChrome();
      const onChanged = chromeApi.storage?.onChanged;
      if (!onChanged || typeof onChanged.addListener !== 'function') {
        return () => undefined;
      }
      const listener = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
      ) => {
        if (areaName !== area) {
          return;
        }
        const normalized: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [key, change] of Object.entries(changes)) {
          normalized[key] = {
            oldValue: change?.oldValue,
            newValue: change?.newValue
          };
        }
        callback(normalized);
      };
      onChanged.addListener(listener);
      return () => {
        onChanged.removeListener(listener);
      };
    }
  };
}

const hasSessionStorage = typeof chrome !== 'undefined' && Boolean(chrome.storage?.session);

export const chromeStorageService: StorageService = hasSessionStorage
  ? {
      sync: createStorageArea('sync'),
      local: createStorageArea('local'),
      session: createStorageArea('session')
    }
  : {
      sync: createStorageArea('sync'),
      local: createStorageArea('local')
    };
