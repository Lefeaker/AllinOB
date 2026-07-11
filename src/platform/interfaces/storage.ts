export interface StorageChange<T = unknown> {
  oldValue?: T;
  newValue?: T;
}

export type StorageChangeMap = Record<string, StorageChange>;

export type StorageChangeCallback<T = unknown> = (
  value: T | undefined,
  change: StorageChange<T>
) => void;
export type StorageAreaChangeCallback = (changes: StorageChangeMap) => void;
export type StorageRecord = Record<string, unknown>;

export interface StorageAreaService {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  getAll: () => Promise<StorageRecord>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  getMany: <T = unknown>(keys: string[]) => Promise<Record<string, T | undefined>>;
  setMany: <T = unknown>(entries: Record<string, T>) => Promise<void>;
  remove: (key: string | string[]) => Promise<void>;
  clear: () => Promise<void>;
  watchKey: <T = unknown>(key: string, callback: StorageChangeCallback<T>) => () => void;
  watchAll: (callback: StorageAreaChangeCallback) => () => void;
}

export interface StorageService {
  readonly sync: StorageAreaService;
  readonly local: StorageAreaService;
  readonly session?: StorageAreaService;
}
