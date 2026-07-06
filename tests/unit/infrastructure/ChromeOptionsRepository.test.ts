import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeOptionsRepository } from '../../../src/infrastructure/repositories/ChromeOptionsRepository';
import { DEFAULT_OPTIONS } from '@shared/config/defaultOptions';
import { StorageError } from '@shared/errors';
import type { CompleteOptions } from '@shared/types/options';
import type { StorageAreaService, StorageService } from '../../../src/platform/interfaces/storage';

type MockableFunction = (...args: never[]) => void;

const createMockFn = <T extends MockableFunction>() =>
  vi.fn<(...args: Parameters<T>) => ReturnType<T>>();

const DEFAULT_COMPLETE_OPTIONS = DEFAULT_OPTIONS as CompleteOptions;

type StorageAreaMock = StorageAreaService & {
  get: ReturnType<typeof createMockFn<StorageAreaService['get']>>;
  set: ReturnType<typeof createMockFn<StorageAreaService['set']>>;
  getMany: ReturnType<typeof createMockFn<StorageAreaService['getMany']>>;
  setMany: ReturnType<typeof createMockFn<StorageAreaService['setMany']>>;
  remove: ReturnType<typeof createMockFn<StorageAreaService['remove']>>;
  clear: ReturnType<typeof createMockFn<StorageAreaService['clear']>>;
  watchKey: ReturnType<typeof createMockFn<StorageAreaService['watchKey']>>;
  watchAll: ReturnType<typeof createMockFn<StorageAreaService['watchAll']>>;
};

// ===========================
// Helper Functions
// ===========================
function cloneOptions(options: CompleteOptions): CompleteOptions {
  const cloned = JSON.parse(JSON.stringify(options)) as CompleteOptions;
  cloned.rest.apiKey = 'test-api-key-12345';
  return cloned;
}

function withLegacyRootDir<TRest extends CompleteOptions['rest']>(
  rest: TRest,
  rootDir: string
): TRest & { rootDir: string } {
  return Object.assign(rest, { rootDir });
}

// ===========================
// Mock Platform Services
// ===========================
const createStorageAreaMock = (): StorageAreaMock => {
  const watchKey = createMockFn<StorageAreaService['watchKey']>().mockReturnValue(vi.fn());
  const watchAll = createMockFn<StorageAreaService['watchAll']>().mockReturnValue(vi.fn());
  return {
    get: createMockFn<StorageAreaService['get']>() as StorageAreaMock['get'],
    set: createMockFn<StorageAreaService['set']>(),
    getMany: createMockFn<StorageAreaService['getMany']>() as StorageAreaMock['getMany'],
    setMany: createMockFn<StorageAreaService['setMany']>(),
    remove: createMockFn<StorageAreaService['remove']>(),
    clear: createMockFn<StorageAreaService['clear']>(),
    watchKey,
    watchAll
  } as StorageAreaMock;
};

const mockStorage: StorageService & {
  sync: StorageAreaMock;
  local: StorageAreaMock;
  session: StorageAreaMock;
} = {
  sync: createStorageAreaMock(),
  local: createStorageAreaMock(),
  session: createStorageAreaMock()
};

// ===========================
// Test Suite
// ===========================
describe('ChromeOptionsRepository', () => {
  let repo: ChromeOptionsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.sync.get.mockReset();
    mockStorage.sync.set.mockReset();
    mockStorage.sync.watchKey.mockReset();
    mockStorage.sync.watchAll.mockReset();
    mockStorage.sync.set.mockResolvedValue(undefined);
    repo = new ChromeOptionsRepository(mockStorage);
  });

  // ===========================
  // 核心验证：onChange 单次触发
  // ===========================
  describe('onChange triggering', () => {
    it('should trigger onChange callback exactly ONCE when set() is called', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      initialOptions.rest.baseUrl = 'https://initial.example/';

      const updatedOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      updatedOptions.rest.baseUrl = 'https://updated.example/';

      // Setup: Initial get returns initial state
      mockStorage.sync.get.mockResolvedValueOnce(initialOptions);

      // Setup: Second get (for set() merge) returns initial state
      mockStorage.sync.get.mockResolvedValueOnce(initialOptions);

      // Setup: Third get (for notifyListeners) returns updated state
      mockStorage.sync.get.mockResolvedValueOnce(updatedOptions);

      const callback = vi.fn();

      // Subscribe to onChange
      repo.onChange(callback);

      // Wait for initial trigger
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });

      // Clear initial trigger count
      callback.mockClear();

      // Trigger set()
      await repo.set({
        rest: {
          ...initialOptions.rest,
          baseUrl: 'https://updated.example/'
        }
      });

      // Wait for onChange to process
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalled();
      });

      // ✅ Critical assertion: Should be called EXACTLY ONCE, not twice
      expect(callback).toHaveBeenCalledTimes(1);
      const callbackCalls = callback.mock.calls as Array<[CompleteOptions]>;
      const callbackArg = callbackCalls[0]?.[0];
      expect(callbackArg?.rest.baseUrl).toBe('https://updated.example/');

      expect(mockStorage.sync.watchKey).toHaveBeenCalledWith('options', expect.any(Function));
    });

    it('should notify subscribers when options are changed from another extension context', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const externalOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      externalOptions.interfaceTheme = 'light';
      mockStorage.sync.get.mockResolvedValue(initialOptions);
      let externalChange: ((value: CompleteOptions | undefined) => void) | undefined;
      mockStorage.sync.watchKey.mockImplementation((_key, callback) => {
        externalChange = callback as (value: CompleteOptions | undefined) => void;
        return vi.fn();
      });

      const callback = vi.fn();
      repo.onChange(callback);

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });
      callback.mockClear();

      expect(externalChange).toBeDefined();
      externalChange?.(externalOptions);

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ interfaceTheme: 'light' }));
    });

    it('should emit initial state immediately when onChange is called', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      initialOptions.rest.vault = 'InitialVault';
      mockStorage.sync.get.mockResolvedValue(initialOptions);

      const callback = vi.fn();
      repo.onChange(callback);

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });

      const callbackCalls = callback.mock.calls as Array<[CompleteOptions]>;
      const callbackArg = callbackCalls[0]?.[0];
      expect(callbackArg?.rest.vault).toBe('InitialVault');
    });

    it('should unsubscribe correctly and detach the storage watcher for the last listener', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      initialOptions.rest.vault = 'InitialVault';
      mockStorage.sync.get.mockResolvedValue(initialOptions);
      const stopWatching = vi.fn();
      mockStorage.sync.watchKey.mockReturnValue(stopWatching);

      const callback = vi.fn();
      const unsubscribe = repo.onChange(callback);

      // Wait for initial trigger
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledTimes(1);
      });

      // Unsubscribe
      unsubscribe();

      // Clear and verify no more triggers
      callback.mockClear();
      const newOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      newOptions.rest.baseUrl = 'https://unsubscribed.example/';
      mockStorage.sync.get.mockResolvedValue(newOptions);
      await repo.set({
        rest: {
          ...initialOptions.rest,
          baseUrl: 'https://unsubscribed.example/'
        }
      });

      // Wait a bit to ensure callback is not called
      await new Promise((resolve) => setTimeout(resolve, 100));

      // ✅ Should NOT be called after unsubscribe
      expect(callback).not.toHaveBeenCalled();
      expect(stopWatching).toHaveBeenCalledTimes(1);
    });

    it('should notify multiple subscribers when options change', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      initialOptions.rest.vault = 'MultiVault';
      const updatedOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      updatedOptions.rest.baseUrl = 'https://multi.example/';

      mockStorage.sync.get
        .mockResolvedValueOnce(initialOptions) // subscriber 1 initial
        .mockResolvedValueOnce(initialOptions) // subscriber 2 initial
        .mockResolvedValueOnce(initialOptions) // repo.set merge
        .mockResolvedValueOnce(updatedOptions); // notify listeners payload

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      repo.onChange(callback1);
      repo.onChange(callback2);

      await vi.waitFor(() => {
        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
      });

      callback1.mockClear();
      callback2.mockClear();

      await repo.set({
        rest: {
          ...initialOptions.rest,
          baseUrl: 'https://multi.example/'
        }
      });

      await vi.waitFor(() => {
        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
      });
      const callback1Calls = callback1.mock.calls as Array<[CompleteOptions]>;
      const callback2Calls = callback2.mock.calls as Array<[CompleteOptions]>;
      const callbackArg1 = callback1Calls[0]?.[0];
      const callbackArg2 = callback2Calls[0]?.[0];
      expect(callbackArg1?.rest.baseUrl).toBe('https://multi.example/');
      expect(callbackArg2?.rest.baseUrl).toBe('https://multi.example/');
    });
  });

  // ===========================
  // get() 测试
  // ===========================
  describe('get()', () => {
    it('should return merged options from storage', async () => {
      const storedOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      storedOptions.rest.baseUrl = 'https://stored.example/';
      mockStorage.sync.get.mockResolvedValue(storedOptions);

      const result = await repo.get();

      expect(mockStorage.sync.get).toHaveBeenCalledWith('options');
      expect(result.rest.baseUrl).toBe('https://stored.example/');
      expect(result.templates.fragment).toBe(DEFAULT_COMPLETE_OPTIONS.templates.fragment);
      expect(result.domainMappings).toEqual(DEFAULT_COMPLETE_OPTIONS.domainMappings);
    });

    it('should return default options when storage is empty', async () => {
      mockStorage.sync.get.mockResolvedValue(null);

      const result = await repo.get();

      expect(result).toEqual(DEFAULT_COMPLETE_OPTIONS);
    });
    it('should merge partial options with defaults when storage has sparse data', async () => {
      mockStorage.sync.get.mockResolvedValue({
        rest: {
          baseUrl: 'https://partial.example/'
        }
      } as Partial<CompleteOptions>);

      const result = await repo.get();

      expect(result.rest.baseUrl).toBe('https://partial.example/');
      expect(result.templates.fragment).toBe(DEFAULT_COMPLETE_OPTIONS.templates.fragment);
      expect(result.domainMappings).toEqual(DEFAULT_COMPLETE_OPTIONS.domainMappings);
    });

    it('should strip unknown root fields while preserving named persisted settings', async () => {
      mockStorage.sync.get.mockResolvedValue({
        rest: {
          baseUrl: 'https://stored.example/',
          apiKey: 'REST_SECRET_TOKEN'
        },
        aiChat: {
          userName: 'Stored User'
        },
        customKey: {
          hello: 'world'
        }
      } as unknown as Partial<CompleteOptions> & Record<string, unknown>);

      const result = await repo.get();

      expect(result.rest.apiKey).toBe('REST_SECRET_TOKEN');
      expect(result.aiChat?.userName).toBe('Stored User');
      expect((result as Record<string, unknown>).customKey).toBeUndefined();
    });

    it('should preserve persisted privacy preferences after schema sanitization', async () => {
      mockStorage.sync.get.mockResolvedValue({
        privacyPreferences: {
          analytics: true,
          errorReporting: true,
          debugMode: false
        }
      } as Partial<CompleteOptions>);

      const result = await repo.get();

      expect(result.privacyPreferences).toEqual({
        analytics: true,
        errorReporting: true,
        debugMode: false
      });
    });

    it('should still load old stored options with legacy rootDir while stripping it', async () => {
      mockStorage.sync.get.mockResolvedValue({
        rest: withLegacyRootDir(
          {
            baseUrl: 'https://stored.example/',
            vault: 'LegacyVault',
            apiKey: 'REST_SECRET_TOKEN'
          },
          'LegacyRoot/'
        )
      });

      const result = await repo.get();

      expect(result.rest).not.toHaveProperty('rootDir');
      expect(result.rest.vault).toBe('LegacyVault');
    });

    it('should throw StorageError when storage.get fails', async () => {
      const failure = new Error('storage unavailable');
      mockStorage.sync.get.mockRejectedValue(failure);

      const attempt = repo.get();

      await expect(attempt).rejects.toBeInstanceOf(StorageError);
      await expect(attempt).rejects.toThrow('Failed to get options from chrome.storage');
    });
  });

  // ===========================
  // set() 测试
  // ===========================
  describe('set()', () => {
    it('should merge partial options and save to storage', async () => {
      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      currentOptions.rest.baseUrl = 'https://current.example/';
      const partialUpdate = {
        rest: {
          ...currentOptions.rest,
          baseUrl: 'https://updated.example/'
        }
      };

      mockStorage.sync.get.mockResolvedValue(currentOptions);

      await repo.set(partialUpdate);

      expect(mockStorage.sync.set).toHaveBeenCalledWith('options', {
        ...currentOptions,
        ...partialUpdate
      });
    });

    it('should not write legacy rootDir back when saving over an old snapshot', async () => {
      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      withLegacyRootDir(currentOptions.rest, 'LegacyRoot/');
      currentOptions.rest.localFolderId = 'local-folder';
      currentOptions.rest.localFolderName = 'Local Folder';
      const partialUpdate: Partial<CompleteOptions> = { interfaceTheme: 'dark' };

      mockStorage.sync.get.mockResolvedValue(currentOptions);

      await repo.set(partialUpdate);

      const saved = mockStorage.sync.set.mock.calls.at(-1)?.[1] as CompleteOptions | undefined;
      expect(saved?.rest).not.toHaveProperty('rootDir');
      expect(saved?.rest.localFolderId).toBe('local-folder');
      expect(saved?.rest.localFolderName).toBe('Local Folder');
      expect(saved?.rest.vault).toBe(currentOptions.rest.vault);
      expect(saved?.interfaceTheme).toBe('dark');
    });

    it('should throw StorageError when storage.set fails', async () => {
      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const partialUpdate = {
        rest: {
          ...currentOptions.rest,
          baseUrl: 'https://updated.example/'
        }
      };

      mockStorage.sync.get.mockResolvedValue(currentOptions);
      mockStorage.sync.set.mockRejectedValue(new Error('quota exceeded'));

      const attempt = repo.set(partialUpdate);

      await expect(attempt).rejects.toBeInstanceOf(StorageError);
      await expect(attempt).rejects.toThrow('Failed to set options to chrome.storage');
    });

    it('should wrap errors thrown by get() while preparing the payload', async () => {
      const getSpy = vi.spyOn(repo, 'get').mockRejectedValueOnce(new Error('pull failed'));

      const attempt = repo.set({
        rest: {
          ...DEFAULT_COMPLETE_OPTIONS.rest,
          baseUrl: 'https://should-not-write.example/'
        }
      });

      await expect(attempt).rejects.toBeInstanceOf(StorageError);
      await expect(attempt).rejects.toThrow('Failed to set options to chrome.storage');

      getSpy.mockRestore();
    });
  });

  describe('immutability & listener safety', () => {
    it('should deliver deep-cloned snapshots to listeners', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const updatedOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      updatedOptions.rest.vault = 'ImmutableVault';

      mockStorage.sync.get
        .mockResolvedValueOnce(initialOptions) // initial snapshot for onChange
        .mockResolvedValueOnce(initialOptions) // repo.set -> this.get()
        .mockResolvedValueOnce(updatedOptions) // notifyListeners -> this.get()
        .mockResolvedValueOnce(updatedOptions); // repo.get() after mutation check

      let receivedOptions: CompleteOptions | null = null;
      repo.onChange((options) => {
        receivedOptions = options;
      });

      await vi.waitFor(() => {
        expect(receivedOptions).not.toBeNull();
      });

      receivedOptions = null;

      await repo.set({
        rest: {
          ...initialOptions.rest,
          vault: 'ImmutableVault'
        }
      });

      await vi.waitFor(() => {
        expect(receivedOptions).not.toBeNull();
      });

      const clonedOptions = receivedOptions as unknown as CompleteOptions;
      if (!clonedOptions) {
        throw new Error('Received options missing');
      }
      clonedOptions.rest.vault = 'MUTATED';
      const latest = await repo.get();
      expect(latest.rest.vault).toBe('ImmutableVault');
      expect(latest.rest.vault).not.toBe(clonedOptions.rest.vault);
    });

    it('should continue notifying other listeners when one throws', async () => {
      const initialOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const updatedOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      updatedOptions.rest.baseUrl = 'https://listener.example/';

      mockStorage.sync.get
        .mockResolvedValueOnce(initialOptions) // faulty listener initial
        .mockResolvedValueOnce(initialOptions) // healthy listener initial
        .mockResolvedValueOnce(initialOptions) // repo.set -> this.get()
        .mockResolvedValueOnce(updatedOptions); // notify listeners payload

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const faultyListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const healthyListener = vi.fn();

      repo.onChange(faultyListener);
      repo.onChange(healthyListener);

      await vi.waitFor(() => {
        expect(faultyListener).toHaveBeenCalledTimes(1);
        expect(healthyListener).toHaveBeenCalledTimes(1);
      });

      faultyListener.mockClear();
      healthyListener.mockClear();
      consoleSpy.mockClear();

      await repo.set({
        rest: {
          ...initialOptions.rest,
          baseUrl: 'https://listener.example/'
        }
      });

      await vi.waitFor(() => {
        expect(healthyListener).toHaveBeenCalledTimes(1);
        expect(faultyListener).toHaveBeenCalledTimes(1);
      });
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('environment compatibility', () => {
    it('should leverage global structuredClone when available', async () => {
      const globalRef = globalThis as typeof globalThis & { structuredClone?: <T>(value: T) => T };
      const originalStructuredClone = globalRef.structuredClone;

      const structuredCloneSpy = vi.fn<(value: unknown) => unknown>(
        (value) => JSON.parse(JSON.stringify(value)) as unknown
      );
      globalRef.structuredClone = <T>(value: T) => structuredCloneSpy(value) as T;

      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const updatedUrl = 'https://structured.example/';

      mockStorage.sync.get
        .mockResolvedValueOnce(currentOptions) // initial onChange snapshot
        .mockResolvedValueOnce(currentOptions) // repo.set -> this.get()
        .mockResolvedValueOnce({
          ...currentOptions,
          rest: {
            ...currentOptions.rest,
            baseUrl: updatedUrl
          }
        }); // notify listeners payload

      try {
        const callback = vi.fn();
        repo.onChange(callback);
        await vi.waitFor(() => {
          expect(callback).toHaveBeenCalledTimes(1);
        });
        callback.mockClear();

        await repo.set({
          rest: {
            ...currentOptions.rest,
            baseUrl: updatedUrl
          }
        });

        expect(structuredCloneSpy).toHaveBeenCalled();
      } finally {
        globalRef.structuredClone = originalStructuredClone;
      }
    });

    it('should fall back to JSON cloning when structuredClone is unavailable', async () => {
      const globalRef = globalThis as typeof globalThis & { structuredClone?: <T>(value: T) => T };
      const originalStructuredClone = globalRef.structuredClone;
      Reflect.deleteProperty(globalRef, 'structuredClone');

      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const updatedUrl = 'https://json-clone.example/';

      mockStorage.sync.get
        .mockResolvedValueOnce(currentOptions) // repo.set -> this.get()
        .mockResolvedValueOnce({
          ...currentOptions,
          rest: {
            ...currentOptions.rest,
            baseUrl: updatedUrl
          }
        }); // notify listeners payload

      try {
        await repo.set({
          rest: {
            ...currentOptions.rest,
            baseUrl: updatedUrl
          }
        });

        const lastCall = mockStorage.sync.set.mock.calls.at(-1);
        if (!lastCall) {
          throw new Error('Expected storage.set to be called');
        }
        const [, savedOptions] = lastCall;
        expect((savedOptions as CompleteOptions).rest.baseUrl).toBe(updatedUrl);
      } finally {
        globalRef.structuredClone = originalStructuredClone;
      }
    });
  });

  describe('error handling around notifications', () => {
    it('should log errors when notifyListeners fails to fetch options', async () => {
      const currentOptions = cloneOptions(DEFAULT_COMPLETE_OPTIONS);
      const getSpy = vi
        .spyOn(repo, 'get')
        .mockResolvedValueOnce(currentOptions)
        .mockRejectedValueOnce(new Error('notify failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await repo.set({
        rest: {
          ...currentOptions.rest,
          baseUrl: 'https://notify-error.example/'
        }
      });
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        '[ChromeOptionsRepository] Failed to notify listeners:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
      getSpy.mockRestore();
    });
  });
});
