/**
 * 测试辅助函数，用于依赖注入容器的测试场景
 */

import { createServiceRegistry, type ServiceRegistry } from './serviceRegistry';
import { TOKENS } from './tokens';
import type { PlatformServices } from '../../platform/types';

/**
 * 创建用于测试的平台服务mock
 */
export function createMockPlatformServices(): PlatformServices {
  return {
    storage: {
      sync: {
        get: <T = unknown>() => Promise.resolve(undefined as T | undefined),
        getAll: () => Promise.resolve({}),
        getMany: () => Promise.resolve({}),
        set: () => Promise.resolve(undefined),
        setMany: () => Promise.resolve(undefined),
        remove: () => Promise.resolve(undefined),
        clear: () => Promise.resolve(undefined),
        watchKey: () => () => undefined,
        watchAll: () => () => undefined
      },
      local: {
        get: <T = unknown>() => Promise.resolve(undefined as T | undefined),
        getAll: () => Promise.resolve({}),
        getMany: () => Promise.resolve({}),
        set: () => Promise.resolve(undefined),
        setMany: () => Promise.resolve(undefined),
        remove: () => Promise.resolve(undefined),
        clear: () => Promise.resolve(undefined),
        watchKey: () => () => undefined,
        watchAll: () => () => undefined
      },
      session: {
        get: <T = unknown>() => Promise.resolve(undefined as T | undefined),
        getAll: () => Promise.resolve({}),
        getMany: () => Promise.resolve({}),
        set: () => Promise.resolve(undefined),
        setMany: () => Promise.resolve(undefined),
        remove: () => Promise.resolve(undefined),
        clear: () => Promise.resolve(undefined),
        watchKey: () => () => undefined,
        watchAll: () => () => undefined
      }
    },
    messaging: {
      send: <TResult = unknown>() => Promise.resolve(undefined as TResult),
      sendToTab: <TResult = unknown>() => Promise.resolve(undefined as TResult),
      addListener: () => () => undefined
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getBrowserTarget: () => 'chrome',
      openOptionsPage: () => Promise.resolve(undefined),
      onInstalled: () => () => undefined,
      onStartup: () => () => undefined
    },
    contextMenus: {
      create: () => Promise.resolve('test-menu-id'),
      update: () => Promise.resolve(undefined),
      removeAll: () => Promise.resolve(undefined),
      onClicked: () => () => undefined,
      onShown: () => () => undefined,
      refresh: () => undefined
    },
    downloads: {
      download: () => Promise.resolve(undefined)
    },
    fileSystemAccess: {
      isSupported: () => false,
      chooseDirectory: () => Promise.reject(new Error('File System Access unavailable in tests.')),
      queryPermission: () => Promise.resolve('unsupported'),
      ensurePermission: () => Promise.resolve('unsupported'),
      writeFile: () => Promise.reject(new Error('File System Access unavailable in tests.')),
      removeDirectory: () => Promise.resolve(undefined)
    },
    notifications: {
      create: () => Promise.resolve(undefined),
      clear: () => Promise.resolve(undefined)
    },
    tabs: {
      create: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(undefined),
      getCurrent: () => Promise.resolve(undefined),
      get: () => Promise.resolve(undefined),
      query: () => Promise.resolve([]),
      sendMessage: <TResult = unknown>() => Promise.resolve(undefined as TResult),
      onActivated: () => () => undefined,
      onUpdated: () => () => undefined,
      onRemoved: () => () => undefined
    },
    action: {
      onClicked: () => () => undefined
    },
    scripting: {
      executeScript: () => Promise.resolve(undefined)
    },

    restClient: {
      writeFile: () => Promise.resolve(undefined)
    }
  };
}

/**
 * 创建用于测试的错误处理器mock
 */
export function createMockErrorHandler() {
  return {
    addReporter: () => () => undefined,
    removeReporter: () => undefined,
    clearReporters: () => undefined,
    setNotificationBridge: () => undefined,
    handle: () => Promise.resolve(undefined)
  };
}

/**
 * 创建用于测试的全局状态管理器mock
 */
interface MockStateStore {
  get: () => unknown;
  set: (value: unknown) => void;
  subscribe: () => () => void;
  clear: () => void;
}

export function createMockGlobalStateManager() {
  const stores = new Map<string, MockStateStore>();

  const ensureStore = (key: string): MockStateStore => {
    let store = stores.get(key);
    if (!store) {
      store = {
        get: () => undefined,
        set: () => undefined,
        subscribe: () => () => undefined,
        clear: () => undefined
      };
      stores.set(key, store);
    }
    return store;
  };

  return {
    getStore: (key: string): MockStateStore => ensureStore(key),
    hasStore: (key: string) => stores.has(key),
    destroyStore: (key: string) => stores.delete(key),
    resetAll: () => stores.clear(),
    registerCleanup: () => () => undefined,
    syncWithStorage: () => Promise.resolve(true),
    stopSync: () => undefined
  };
}

/**
 * 创建用于测试的使用统计存储mock
 */
export function createMockUsageStatsStore() {
  return {
    getStats: () =>
      Promise.resolve({
        aiChatSaves: 0,
        fragmentSaves: 0,
        articleSaves: 0,
        lastUpdatedISO: new Date().toISOString(),
        history: []
      }),
    recordUsage: () => Promise.resolve(null),
    initialize: () => Promise.resolve(undefined)
  };
}

/**
 * 创建用于测试的对话框注册表mock
 */
export function createMockDialogRegistry() {
  return {
    register: () => () => undefined,
    getActive: () => null,
    closeAll: () => undefined
  };
}

/**
 * 创建预配置测试服务的注册表
 */
export function createTestRegistryWithMocks(): ServiceRegistry {
  const registry = createServiceRegistry();

  registry.register(TOKENS.platformServices, createMockPlatformServices);
  registry.register(TOKENS.errorHandler, createMockErrorHandler);
  registry.register(TOKENS.globalStateManager, createMockGlobalStateManager);
  registry.register(TOKENS.usageStatsStore, createMockUsageStatsStore);
  registry.register(TOKENS.dialogRegistry, createMockDialogRegistry);

  return registry;
}

/**
 * 测试辅助函数：在mock平台环境中执行函数
 */
export async function withMockPlatform<T>(
  services: Partial<PlatformServices>,
  fn: () => T | Promise<T>
): Promise<T> {
  const testRegistry = createServiceRegistry();

  testRegistry.register(TOKENS.platformServices, () => ({
    ...createMockPlatformServices(),
    ...services
  }));

  // 这里需要临时替换全局注册表的逻辑
  // 实际实现中可能需要更复杂的作用域管理
  return await fn();
}

/**
 * 为单元测试创建隔离的注册表作用域
 */
export function bootstrapTestRegistry(): ServiceRegistry {
  return createTestRegistryWithMocks();
}
