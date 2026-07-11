import type {
  StorageAreaService,
  StorageChange,
  StorageAreaChangeCallback,
  StorageChangeCallback,
  StorageService
} from '../../platform/interfaces/storage';
import { ReactiveStore, type StateStore } from './ReactiveStore';

type StorageAreaName = 'sync' | 'local' | 'session';
type StoredValue = unknown;
// 模块级别的单例实例
let globalStateManagerInstance: GlobalStateManager | null = null;
let globalStateManagerStorage: StorageService | null = null;
let fallbackGlobalStateManagerStorage: StorageService | null = null;
export interface SyncOptions<TStored, TMapped = TStored> {
  area?: StorageAreaName;
  deserialize?: (value: TStored | undefined) => TMapped | undefined;
  onError?: (error: unknown) => void;
}
type CleanupFn = () => void;

interface GlobalStateEntry {
  store: ReactiveStore<StoredValue>;
  cleanups: Set<CleanupFn>;
}

interface SyncDescriptor {
  storageKey: string;
  cleanup: CleanupFn;
}

function toStateStore<T>(store: ReactiveStore<StoredValue>): StateStore<T> {
  return store as StateStore<T>;
}

function toReactiveStore<T>(store: ReactiveStore<StoredValue>): ReactiveStore<T> {
  return store as ReactiveStore<T>;
}

function toMappedValue<T>(value: StoredValue): T | undefined {
  return value as T | undefined;
}

function toStorageChangeCallback<T>(
  callback: StorageChangeCallback<T>
): (value: StoredValue, change: StorageChange) => void {
  return callback as (value: StoredValue, change: StorageChange) => void;
}

export class GlobalStateManager {
  constructor(private readonly storage: StorageService) {}

  private entries = new Map<string, GlobalStateEntry>();
  private syncDescriptors = new Map<string, SyncDescriptor>();

  getStore<T>(key: string): StateStore<T> {
    const entry = this.entries.get(key);
    if (entry) {
      return toStateStore<T>(entry.store);
    }

    const store = new ReactiveStore<StoredValue>(key);
    this.entries.set(key, {
      store,
      cleanups: new Set()
    });
    return toStateStore<T>(store);
  }

  hasStore(key: string): boolean {
    return this.entries.has(key);
  }

  destroyStore(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.stopSync(key);
    entry.cleanups.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.warn('[GlobalState] cleanup failed', error);
      }
    });
    entry.cleanups.clear();
    entry.store.clear();
    this.entries.delete(key);
  }

  resetAll(): void {
    Array.from(this.entries.keys()).forEach((key) => {
      this.destroyStore(key);
    });
  }

  registerCleanup(key: string, cleanup: CleanupFn): CleanupFn {
    const entry = this.ensureEntry(key);
    entry.cleanups.add(cleanup);
    return () => {
      entry.cleanups.delete(cleanup);
    };
  }

  async syncWithStorage<TStored, TMapped = TStored>(
    key: string,
    storageKey: string,
    options?: SyncOptions<TStored, TMapped>
  ): Promise<boolean> {
    const entry = this.ensureEntry(key);
    const store = toReactiveStore<TMapped>(entry.store);
    const areaName: StorageAreaName = options?.area ?? 'sync';
    const area = this.resolveStorageArea(this.storage, areaName);
    if (!area) {
      options?.onError?.(new Error(`Storage area ${areaName} is unavailable`));
      return false;
    }

    this.stopSync(key);

    try {
      const storedValue = await area.get<TStored>(storageKey);
      const mapped = options?.deserialize
        ? options.deserialize(storedValue)
        : toMappedValue<TMapped>(storedValue);
      store.set(mapped);
    } catch (error) {
      options?.onError?.(error);
    }

    const watcher = area.watchKey<TStored>(storageKey, (value) => {
      const mapped = options?.deserialize
        ? options.deserialize(value)
        : toMappedValue<TMapped>(value);
      store.set(mapped);
    });

    this.syncDescriptors.set(key, {
      storageKey,
      cleanup: watcher
    });
    entry.cleanups.add(watcher);
    return true;
  }

  stopSync(key: string): void {
    const descriptor = this.syncDescriptors.get(key);
    if (!descriptor) {
      return;
    }
    try {
      descriptor.cleanup();
    } catch (error) {
      console.warn('[GlobalState] failed to stop sync watcher', error);
    }
    this.syncDescriptors.delete(key);
    const entry = this.entries.get(key);
    if (entry) {
      entry.cleanups.delete(descriptor.cleanup);
    }
  }

  private ensureEntry(key: string): GlobalStateEntry {
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }
    const store = new ReactiveStore<StoredValue>(key);
    const entry: GlobalStateEntry = {
      store,
      cleanups: new Set()
    };
    this.entries.set(key, entry);
    return entry;
  }

  private resolveStorageArea(
    storage: StorageService,
    area: StorageAreaName
  ): StorageAreaService | null {
    if (area === 'session') {
      return storage.session ?? null;
    }
    const storageAreas: Pick<StorageService, 'sync' | 'local'> = storage;
    return storageAreas[area] ?? null;
  }
}

/**
 * 创建GlobalStateManager实例的工厂函数
 */
export function configureGlobalStateManagerStorage(storage: StorageService): void {
  if (globalStateManagerStorage !== storage) {
    globalStateManagerInstance = null;
  }
  globalStateManagerStorage = storage;
}

function createMemoryStorageArea(): StorageAreaService {
  const values = new Map<string, StoredValue>();
  const keyWatchers = new Map<string, Set<(value: StoredValue, change: StorageChange) => void>>();
  const allWatchers = new Set<StorageAreaChangeCallback>();

  const notify = (key: string, change: StorageChange): void => {
    keyWatchers.get(key)?.forEach((callback) => callback(change.newValue, change));
    allWatchers.forEach((callback) => callback({ [key]: change }));
  };

  const area: StorageAreaService = {
    async get<T = StoredValue>(key: string): Promise<T | undefined> {
      return toMappedValue<T>(values.get(key));
    },
    getAll(): Promise<Record<string, StoredValue>> {
      return Promise.resolve(Object.fromEntries(values));
    },
    async set<T = StoredValue>(key: string, value: T): Promise<void> {
      const oldValue = values.get(key);
      values.set(key, value);
      notify(key, { oldValue, newValue: value });
    },
    async getMany<T = StoredValue>(keys: string[]): Promise<Record<string, T | undefined>> {
      return Object.fromEntries(keys.map((key) => [key, toMappedValue<T>(values.get(key))]));
    },
    async setMany<T = StoredValue>(entries: Record<string, T>): Promise<void> {
      for (const [key, value] of Object.entries(entries)) {
        const oldValue = values.get(key);
        values.set(key, value);
        notify(key, { oldValue, newValue: value });
      }
    },
    async remove(key: string | string[]): Promise<void> {
      for (const currentKey of Array.isArray(key) ? key : [key]) {
        const oldValue = values.get(currentKey);
        values.delete(currentKey);
        notify(currentKey, { oldValue, newValue: undefined });
      }
    },
    async clear(): Promise<void> {
      for (const key of Array.from(values.keys())) {
        const oldValue = values.get(key);
        values.delete(key);
        notify(key, { oldValue, newValue: undefined });
      }
    },
    watchKey<T = StoredValue>(key: string, callback: StorageChangeCallback<T>): () => void {
      const watchers = keyWatchers.get(key) ?? new Set();
      keyWatchers.set(key, watchers);
      const wrapped = toStorageChangeCallback(callback);
      watchers.add(wrapped);
      return () => {
        watchers.delete(wrapped);
      };
    },
    watchAll(callback: StorageAreaChangeCallback): () => void {
      allWatchers.add(callback);
      return () => {
        allWatchers.delete(callback);
      };
    }
  };

  return area;
}

function requireGlobalStateManagerStorage(): StorageService {
  if (!globalStateManagerStorage) {
    if (!fallbackGlobalStateManagerStorage) {
      const sync = createMemoryStorageArea();
      const local = createMemoryStorageArea();
      const session = createMemoryStorageArea();
      fallbackGlobalStateManagerStorage = { sync, local, session };
    }
    return fallbackGlobalStateManagerStorage;
  }
  return globalStateManagerStorage;
}

export function createGlobalStateManager(
  storage: StorageService = requireGlobalStateManagerStorage()
): GlobalStateManager {
  return new GlobalStateManager(storage);
}

/**
 * 获取GlobalStateManager实例
 * 使用依赖注入容器获取实例
 */
export function getGlobalStateManager(): GlobalStateManager {
  if (!globalStateManagerInstance) {
    globalStateManagerInstance = createGlobalStateManager();
  }
  return globalStateManagerInstance;
}

/**
 * 获取状态存储的便捷函数
 * 使用依赖注入获取GlobalStateManager实例
 */
export function getStateStore<T>(key: string): StateStore<T> {
  const manager = getGlobalStateManager();
  return manager.getStore<T>(key);
}

/**
 * 重置全局状态的便捷函数
 */
export function resetGlobalState(): void {
  const manager = getGlobalStateManager();
  manager.resetAll();
}

/**
 * @deprecated 使用getGlobalStateManager()替代
 * 为了向后兼容保留的导出，将在后续版本中移除
 */
export const globalStateManager = {
  getStore<T>(key: string): StateStore<T> {
    return getGlobalStateManager().getStore<T>(key);
  },
  hasStore(key: string): boolean {
    return getGlobalStateManager().hasStore(key);
  },
  destroyStore(key: string): void {
    getGlobalStateManager().destroyStore(key);
  },
  resetAll(): void {
    getGlobalStateManager().resetAll();
  },
  registerCleanup(key: string, cleanup: CleanupFn): CleanupFn {
    return getGlobalStateManager().registerCleanup(key, cleanup);
  },
  syncWithStorage<TStored, TMapped = TStored>(
    key: string,
    storageKey: string,
    options?: SyncOptions<TStored, TMapped>
  ): Promise<boolean> {
    return getGlobalStateManager().syncWithStorage<TStored, TMapped>(key, storageKey, options);
  },
  stopSync(key: string): void {
    getGlobalStateManager().stopSync(key);
  }
};
