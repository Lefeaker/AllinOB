import type { StorageAreaService, StorageRecord, StorageService } from '../interfaces/storage';

export function createMemoryStorageArea(): StorageAreaService {
  const values = new Map<string, StorageRecord[string]>();

  return {
    get<T = unknown>(key: string): Promise<T | undefined> {
      return Promise.resolve(values.get(key) as T | undefined);
    },
    getAll(): Promise<StorageRecord> {
      return Promise.resolve(Object.fromEntries(values));
    },
    set<T = unknown>(key: string, value: T): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    getMany<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
      return Promise.resolve(
        Object.fromEntries(keys.map((key) => [key, values.get(key) as T | undefined]))
      );
    },
    setMany<T = unknown>(entries: Record<string, T>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) {
        values.set(key, value);
      }
      return Promise.resolve();
    },
    remove(key: string | string[]): Promise<void> {
      for (const currentKey of Array.isArray(key) ? key : [key]) {
        values.delete(currentKey);
      }
      return Promise.resolve();
    },
    clear(): Promise<void> {
      values.clear();
      return Promise.resolve();
    },
    watchKey(): () => void {
      return () => {};
    },
    watchAll(): () => void {
      return () => {};
    }
  };
}

export function createMemoryStorageService(): StorageService {
  const sync = createMemoryStorageArea();
  const local = createMemoryStorageArea();
  const session = createMemoryStorageArea();

  return { sync, local, session };
}
