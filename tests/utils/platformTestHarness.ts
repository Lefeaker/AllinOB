import { configurePlatformServices, resetPlatformServices } from '../../src/platform';
import type {
  ContextMenusService,
  MenuCreateProperties,
  MenuID,
  MenuUpdateProperties
} from '../../src/platform/interfaces/contextMenus';
import type {
  MessageListener,
  MessageSenderInfo,
  MessagingService
} from '../../src/platform/interfaces/messaging';
import type {
  NotificationOptions,
  NotificationsService
} from '../../src/platform/interfaces/notifications';
import type { RuntimeService } from '../../src/platform/interfaces/runtime';
import type {
  ScriptExecutionOptions,
  ScriptingService
} from '../../src/platform/interfaces/scripting';
import type {
  StorageAreaService,
  StorageChange,
  StorageChangeMap,
  StorageService
} from '../../src/platform/interfaces/storage';
import type { ActionService } from '../../src/platform/interfaces/actions';
import type { TabsSendOptions, TabsService } from '../../src/platform/interfaces/tabs';
import type { RestClient } from '../../src/shared/interfaces/restClient';
import { resetGlobalRegistry } from '../../src/shared/di';

type StorageRecord = Record<string, unknown>;
type StorageWatcher = (changes: StorageChangeMap) => void;
type KeyWatcher = (value: unknown, change: StorageChange) => void;

class InMemoryStorageArea implements StorageAreaService {
  private data = new Map<string, unknown>();
  private keyWatchers = new Map<string, Set<KeyWatcher>>();
  private allWatchers = new Set<StorageWatcher>();

  constructor(initial?: StorageRecord) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.data.set(key, value);
      }
    }
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
    return Promise.resolve(value);
  }

  getAll(): Promise<StorageRecord> {
    return Promise.resolve(
      Object.fromEntries(
        Array.from(this.data.entries(), ([key, value]) => [key, structuredClone(value)])
      )
    );
  }

  getMany<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
    const result: Record<string, T | undefined> = {};
    for (const key of keys) {
      result[key] = this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
    }
    return Promise.resolve(result);
  }

  set<T = unknown>(key: string, value: T): Promise<void> {
    this.applyChanges({ [key]: value });
    return Promise.resolve();
  }

  setMany<T = unknown>(entries: Record<string, T>): Promise<void> {
    this.applyChanges(entries);
    return Promise.resolve();
  }

  remove(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    const raw: StorageRecord = {};
    const changes: StorageChangeMap = {};
    for (const entry of keys) {
      if (this.data.has(entry)) {
        const previous = this.data.get(entry);
        this.data.delete(entry);
        raw[entry] = undefined;
        changes[entry] = { oldValue: structuredClone(previous), newValue: undefined };
      }
    }
    if (Object.keys(raw).length) {
      this.emitChangesInternal(raw, changes);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    const raw: StorageRecord = {};
    const changes: StorageChangeMap = {};
    for (const [key, value] of this.data.entries()) {
      raw[key] = undefined;
      changes[key] = { oldValue: structuredClone(value), newValue: undefined };
    }
    this.data.clear();
    if (Object.keys(raw).length) {
      this.emitChangesInternal(raw, changes);
    }
    return Promise.resolve();
  }

  watchKey<T = unknown>(
    key: string,
    callback: (value: T | undefined, change: StorageChange<T>) => void
  ): () => void {
    const watcher: KeyWatcher = (value, change) => {
      callback(value as T | undefined, change as StorageChange<T>);
    };
    const existing = this.keyWatchers.get(key) ?? new Set<KeyWatcher>();
    existing.add(watcher);
    this.keyWatchers.set(key, existing);
    return () => existing.delete(watcher);
  }

  watchAll(callback: (changes: StorageChangeMap) => void): () => void {
    this.allWatchers.add(callback);
    return () => this.allWatchers.delete(callback);
  }

  snapshot(): StorageRecord {
    return Object.fromEntries(
      Array.from(this.data.entries()).map(([key, value]) => [key, structuredClone(value)])
    );
  }

  resetAll(): void {
    this.data.clear();
    this.keyWatchers.clear();
    this.allWatchers.clear();
  }

  private applyChanges(entries: StorageRecord): void {
    const changeMap: StorageChangeMap = {};
    for (const [key, value] of Object.entries(entries)) {
      const previous = this.data.get(key);
      this.data.set(key, structuredClone(value));
      changeMap[key] = {
        oldValue: structuredClone(previous),
        newValue: structuredClone(value)
      };
    }
    this.emitChangesInternal(entries, changeMap);
  }

  private emitChangesInternal(raw: StorageRecord, changes: StorageChangeMap): void {
    for (const [key, watcherSet] of this.keyWatchers.entries()) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) {
        continue;
      }
      const change = changes[key];
      const value = this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
      for (const watcher of watcherSet) {
        watcher(
          value,
          change ?? {
            oldValue: undefined,
            newValue: value
          }
        );
      }
    }

    for (const watcher of this.allWatchers) {
      watcher(changes);
    }
  }

  private emitChanges(entries: StorageRecord): void {
    const normalized: StorageChangeMap = {};
    for (const [key, value] of Object.entries(entries)) {
      normalized[key] = {
        oldValue: undefined,
        newValue: structuredClone(value)
      } as StorageChange;
    }
    this.emitChangesInternal(entries, normalized);
  }
}

type MessagingHandler = (message: unknown) => Promise<unknown>;
const defaultMessagingHandler: MessagingHandler = () => Promise.resolve(undefined);

class MessagingStub implements MessagingService {
  private listeners = new Set<MessageListener>();
  private handler: MessagingHandler = defaultMessagingHandler;

  setHandler(handler: MessagingHandler): void {
    this.handler = handler;
  }

  clear(): void {
    this.listeners.clear();
    this.handler = defaultMessagingHandler;
  }

  send<TResult = unknown>(message: unknown): Promise<TResult> {
    return this.handler(message) as Promise<TResult>;
  }

  sendToTab<TResult = unknown>(
    _tabId: number,
    message: unknown,
    _options?: { frameId?: number }
  ): Promise<TResult> {
    return this.handler(message) as Promise<TResult>;
  }

  addListener(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(message: unknown, sender: MessageSenderInfo = {}): void {
    for (const listener of this.listeners) {
      void listener(message, sender);
    }
  }
}

function createNoopTabsService(): TabsService {
  return {
    create(): Promise<chrome.tabs.Tab | undefined> {
      return Promise.resolve<chrome.tabs.Tab | undefined>(undefined);
    },
    remove(): Promise<void> {
      return Promise.resolve();
    },
    getCurrent(): Promise<chrome.tabs.Tab | undefined> {
      return Promise.resolve<chrome.tabs.Tab | undefined>(undefined);
    },
    get(): Promise<chrome.tabs.Tab | undefined> {
      return Promise.resolve<chrome.tabs.Tab | undefined>(undefined);
    },
    query(): Promise<chrome.tabs.Tab[]> {
      return Promise.resolve<chrome.tabs.Tab[]>([]);
    },
    sendMessage<TResult = unknown>(
      _tabId: number,
      _message: unknown,
      _options?: TabsSendOptions
    ): Promise<TResult> {
      return Promise.resolve<TResult>(undefined as TResult);
    },
    onActivated() {
      return () => undefined;
    },
    onUpdated() {
      return () => undefined;
    },
    onRemoved() {
      return () => undefined;
    }
  };
}

function createNoopContextMenusService(): ContextMenusService {
  let nextId = 0;
  return {
    create(_properties: MenuCreateProperties): Promise<MenuID> {
      nextId += 1;
      return Promise.resolve<MenuID>(nextId);
    },
    update(_id: MenuID, _properties: MenuUpdateProperties): Promise<void> {
      // no-op
      return Promise.resolve();
    },
    removeAll(): Promise<void> {
      // no-op
      return Promise.resolve();
    },
    onClicked() {
      return () => undefined;
    },
    onShown() {
      return () => undefined;
    },
    refresh() {
      // no-op
    }
  };
}

function createNoopRuntimeService(): RuntimeService {
  return {
    getURL(path: string): string {
      return path;
    },
    getBrowserTarget() {
      return 'chrome';
    },
    openOptionsPage(): Promise<void> {
      return Promise.resolve();
    },
    onInstalled() {
      return () => undefined;
    },
    onStartup() {
      return () => undefined;
    }
  };
}

function createNoopNotificationsService(): NotificationsService {
  return {
    create(_id: string, _options: NotificationOptions): Promise<string | void> {
      return Promise.resolve<string | void>(undefined);
    },
    clear(): Promise<void> {
      // no-op
      return Promise.resolve();
    }
  };
}

function createNoopActionService(): ActionService {
  return {
    onClicked() {
      return () => undefined;
    }
  };
}

function createNoopScriptingService(): ScriptingService {
  return {
    executeScript(_options: ScriptExecutionOptions): Promise<void> {
      // no-op
      return Promise.resolve();
    }
  };
}

export interface TestPlatformHarness {
  readonly storage: StorageService;
  readonly messaging: MessagingStub;
  readonly runtime: RuntimeService;
  readonly contextMenus: ContextMenusService;
  readonly notifications: NotificationsService;
  readonly tabs: TabsService;
  readonly action: ActionService;
  readonly scripting: ScriptingService;
  readonly restClient: RestClient;
  configure(): void;
  reset(): void;
  resetDI(): void;
}

export function createTestPlatformHarness(
  initialSync?: StorageRecord,
  initialLocal?: StorageRecord
): TestPlatformHarness {
  const syncArea = new InMemoryStorageArea(initialSync);
  const localArea = new InMemoryStorageArea(initialLocal);
  const sessionArea = new InMemoryStorageArea();
  const messaging = new MessagingStub();

  const storageService: StorageService = {
    sync: syncArea,
    local: localArea,
    session: sessionArea
  };

  const runtime = createNoopRuntimeService();
  const contextMenus = createNoopContextMenusService();
  const notifications = createNoopNotificationsService();
  const tabs = createNoopTabsService();
  const action = createNoopActionService();
  const scripting = createNoopScriptingService();
  const restClient: RestClient = {
    async writeFile() {
      // no-op stub for tests
    }
  };

  const services = {
    storage: storageService,
    messaging,
    runtime,
    contextMenus,
    notifications,
    tabs,
    action,
    scripting,
    restClient
  };

  return {
    storage: storageService,
    messaging,
    runtime,
    contextMenus,
    notifications,
    tabs,
    action,
    scripting,
    restClient,
    configure() {
      configurePlatformServices(services);
    },
    reset() {
      resetPlatformServices();
      syncArea.resetAll();
      localArea.resetAll();
      sessionArea.resetAll();
      messaging.clear();
    },
    resetDI() {
      // 重置依赖注入容器
      resetGlobalRegistry();
      // 重新配置平台服务
      configurePlatformServices(services);
    }
  };
}
