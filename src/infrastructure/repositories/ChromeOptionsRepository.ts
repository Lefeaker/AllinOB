import type { StorageService } from '../../platform/interfaces/storage';
import { optionsMerger } from '../../shared/config';
import { omitLegacyRestRootDirFromOptions } from '../../shared/config/optionsMerger';
import type { IOptionsRepository } from '../../shared/repositories';
import type { CompleteOptions, StoredOptions } from '../../shared/types/options';
import { StorageError } from '../../shared/errors/repositoryErrors';
import { StoredOptionsSchema } from '../../shared/schemas';

const OPTIONS_STORAGE_KEY = 'options';

function cloneOptions<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeStoredOptions(stored: unknown): StoredOptions | null {
  const parsed = StoredOptionsSchema.safeParse(stored ?? {});
  if (parsed.success) {
    return parsed.data as StoredOptions;
  }

  const fallback =
    typeof stored === 'object' && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
  delete fallback.vaultRouter;

  const reparsed = StoredOptionsSchema.safeParse(fallback);
  if (reparsed.success) {
    return reparsed.data as StoredOptions;
  }

  return {};
}

/**
 * Chrome Storage 实现的 Options Repository
 *
 * 职责:
 * - 通过 chrome.storage.sync 读写用户配置
 * - 管理配置变更订阅,实现单一真相源
 * - 集中错误处理,抛出语义化异常
 */
export class ChromeOptionsRepository implements IOptionsRepository {
  private readonly changeListeners = new Set<(options: CompleteOptions) => void>();
  private stopWatchingOptions: (() => void) | null = null;
  private lastEmittedSignature: string | null = null;
  constructor(private readonly storage: StorageService) {}

  async get(): Promise<CompleteOptions> {
    try {
      const stored = await this.storage.sync.get<StoredOptions>(OPTIONS_STORAGE_KEY);
      const sanitized = sanitizeStoredOptions(stored);
      return optionsMerger.merge(sanitized) as CompleteOptions;
    } catch (error) {
      throw new StorageError('Failed to get options from chrome.storage', {
        cause: error,
        context: { storageKey: OPTIONS_STORAGE_KEY }
      });
    }
  }

  async set(options: Partial<CompleteOptions>): Promise<void> {
    try {
      const current = await this.get();
      const updated = {
        ...cloneOptions(current),
        ...options
      } as CompleteOptions;

      await this.storage.sync.set(OPTIONS_STORAGE_KEY, omitLegacyRestRootDirFromOptions(updated));

      this.notifyListeners();
    } catch (error) {
      throw new StorageError('Failed to set options to chrome.storage', {
        cause: error,
        context: { storageKey: OPTIONS_STORAGE_KEY, options }
      });
    }
  }

  onChange(callback: (options: CompleteOptions) => void): () => void {
    this.changeListeners.add(callback);
    this.ensureStorageWatcher();

    void this.get()
      .then((options) => {
        this.lastEmittedSignature = JSON.stringify(options);
        callback(options);
      })
      .catch((error) => {
        console.error('[ChromeOptionsRepository] Failed to emit initial state:', error);
      });

    return () => {
      this.changeListeners.delete(callback);
      if (this.changeListeners.size === 0) {
        this.stopWatchingOptions?.();
        this.stopWatchingOptions = null;
      }
    };
  }

  private ensureStorageWatcher(): void {
    if (this.stopWatchingOptions) {
      return;
    }
    this.stopWatchingOptions = this.storage.sync.watchKey<StoredOptions>(
      OPTIONS_STORAGE_KEY,
      (stored) => {
        const sanitized = sanitizeStoredOptions(stored);
        const options = optionsMerger.merge(sanitized) as CompleteOptions;
        this.emitToListeners(options);
      }
    );
  }

  private notifyListeners(): void {
    void this.get()
      .then((options) => {
        this.emitToListeners(options);
      })
      .catch((error) => {
        console.error('[ChromeOptionsRepository] Failed to notify listeners:', error);
      });
  }

  private emitToListeners(options: CompleteOptions): void {
    const signature = JSON.stringify(options);
    if (signature === this.lastEmittedSignature) {
      return;
    }
    this.lastEmittedSignature = signature;
    this.changeListeners.forEach((listener) => {
      try {
        listener(options);
      } catch (error) {
        console.error('[ChromeOptionsRepository] onChange callback error:', error);
      }
    });
  }
}
