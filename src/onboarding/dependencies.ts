import type { RuntimeService } from '../platform/interfaces/runtime';
import type {
  StorageAreaService,
  StorageRecord,
  StorageService
} from '../platform/interfaces/storage';
import type { TabsService } from '../platform/interfaces/tabs';
import type { PlatformServices } from '../platform/types';
import { getService } from '../shared/di';
import { resolveRepository } from '../shared/di/serviceRegistry';
import { DI_TOKENS, TOKENS } from '../shared/di/tokens';
import type { IMessagingRepository } from '../shared/repositories/IMessagingRepository';
import type { PrivacyPreferencesOptions } from '../shared/types/options';

export type OnboardingPrivacyField = 'analytics' | 'errorReporting';

export interface OnboardingPrivacySnapshot {
  analytics: boolean;
  debugMode: boolean;
  errorReporting: boolean;
}

export interface OnboardingPrivacyOptions {
  privacyPreferences?: Partial<PrivacyPreferencesOptions>;
}

export interface OnboardingOptionsRepository {
  get: () => Promise<OnboardingPrivacyOptions>;
  set: (options: { privacyPreferences: OnboardingPrivacySnapshot }) => Promise<void>;
  onChange?: (callback: (options: OnboardingPrivacyOptions) => void) => () => void;
}

export interface OnboardingControllerDependencies {
  messagingRepository?: Pick<IMessagingRepository, 'send'>;
  now?: () => number;
  optionsRepository?: OnboardingOptionsRepository;
  runtime?: Pick<RuntimeService, 'getURL' | 'getBrowserTarget'>;
  storage: StorageService;
  tabs: TabsService;
}

function createMemoryStorageArea(): StorageAreaService {
  const values = new Map<string, unknown>();
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

function createPreviewDependencies(): OnboardingControllerDependencies {
  const sync = createMemoryStorageArea();
  const local = createMemoryStorageArea();
  const session = createMemoryStorageArea();

  return {
    storage: { sync, local, session },
    runtime: {
      getURL(path: string) {
        return path;
      },
      getBrowserTarget() {
        return 'chrome';
      }
    },
    tabs: {
      async create() {
        return undefined;
      },
      async remove() {},
      async getCurrent() {
        return undefined;
      },
      async get() {
        return undefined;
      },
      async query() {
        return [];
      },
      async sendMessage<TResult = unknown>() {
        return undefined as TResult;
      },
      onActivated() {
        return () => {};
      },
      onUpdated() {
        return () => {};
      },
      onRemoved() {
        return () => {};
      }
    }
  };
}

function hasOptionsRepository(value: unknown): value is OnboardingOptionsRepository {
  const candidate = value as Partial<OnboardingOptionsRepository> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.get === 'function' &&
    typeof candidate.set === 'function'
  );
}

function hasMessagingRepository(value: unknown): value is Pick<IMessagingRepository, 'send'> {
  const candidate = value as { send?: unknown } | null;
  return (
    typeof candidate === 'object' && candidate !== null && typeof candidate.send === 'function'
  );
}

export function resolveOptionalOptionsRepository(): OnboardingOptionsRepository | undefined {
  try {
    const repository = resolveRepository<unknown>(DI_TOKENS.IOptionsRepository);
    return hasOptionsRepository(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOptionalMessagingRepository():
  | Pick<IMessagingRepository, 'send'>
  | undefined {
  try {
    const repository = resolveRepository<unknown>(DI_TOKENS.IMessagingRepository);
    return hasMessagingRepository(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOnboardingDependencies(): OnboardingControllerDependencies {
  try {
    const platform = getService<PlatformServices>(TOKENS.platformServices);
    const messagingRepository = resolveOptionalMessagingRepository();
    const optionsRepository = resolveOptionalOptionsRepository();
    return {
      ...(messagingRepository ? { messagingRepository } : {}),
      ...(optionsRepository ? { optionsRepository } : {}),
      runtime: platform.runtime,
      storage: platform.storage,
      tabs: platform.tabs
    };
  } catch {
    return createPreviewDependencies();
  }
}
