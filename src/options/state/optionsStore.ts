import type { CompleteOptions, StoredOptions } from '../../shared/types/options';
import type { OptionsStore, OptionsSubscriber } from './types';
import { omitLegacyRestRootDirFromOptions } from '../../shared/config/optionsMerger';
import {
  sanitizeStoredOptionsSnapshot,
  sanitizeVaultRouterConfig,
  sanitizeYamlConfigValue
} from '../../shared/config/optionsSanitizer';
import { setYamlConfigOverrides } from '../../shared/state/yamlConfigOverridesStore';
import type { YamlConfigOverrides } from '../../shared/types/yamlConfig';
import { resolveRepository } from '../../shared/di/serviceRegistry';
import { DI_TOKENS } from '../../shared/di/tokens';
import type { IOptionsRepository } from '../../shared/repositories';
import { areStateValuesEqual, cloneStateValue } from './stateValue';

type MigrationMessageKey = 'yamlConfigMigrated';

// Options UI 主链固定走 IOptionsRepository，但延迟到实际调用时再解析，
// 避免模块加载阶段通过隐式 fallback 偷偷注册依赖。
let optionsRepository: IOptionsRepository | null = null;

function getOptionsRepository(): IOptionsRepository {
  if (!optionsRepository) {
    optionsRepository = resolveRepository<IOptionsRepository>(DI_TOKENS.IOptionsRepository);
  }
  return optionsRepository;
}

let pendingYamlMigrationNotice: MigrationMessageKey | null = null;
let cachedSnapshot: StoredOptions | null = null;
let unsubscribeRepo: (() => void) | null = null;
const subscribers = new Set<OptionsSubscriber>();

const registerYamlMigration = (reason: string): void => {
  pendingYamlMigrationNotice = 'yamlConfigMigrated';
  console.info(`[optionsStore] YAML config overrides normalized (${reason})`);
};

export const consumeYamlMigrationNotice = (): MigrationMessageKey | null => {
  const notice = pendingYamlMigrationNotice;
  pendingYamlMigrationNotice = null;
  return notice;
};

function sanitizeVaultRouter(value: unknown): {
  value: StoredOptions['vaultRouter'];
  changed: boolean;
} {
  const sanitized = sanitizeVaultRouterConfig(value);
  return {
    value: sanitized,
    changed: !areStateValuesEqual(value, sanitized)
  };
}

function sanitizeYamlConfig(value: unknown): {
  value: YamlConfigOverrides | null;
  changed: boolean;
} {
  const normalized = sanitizeYamlConfigValue(value);
  const changed = !areStateValuesEqual(value, normalized);
  return { value: normalized ?? null, changed };
}

function applySanitizedOptions(options: StoredOptions | CompleteOptions): {
  normalized: StoredOptions;
  sanitizedYaml: YamlConfigOverrides | null;
  changed: boolean;
} {
  const { normalized, sanitizedYaml } = sanitizeStoredOptionsSnapshot(options);
  const withoutLegacyRootDir = omitLegacyRestRootDirFromOptions(normalized);
  const vaultResult = sanitizeVaultRouter((options as StoredOptions).vaultRouter);
  const yamlResult = sanitizeYamlConfig(
    (options as StoredOptions).yamlConfig ??
      ((options as StoredOptions).yamlConfig === null ? null : undefined)
  );

  return {
    normalized: withoutLegacyRootDir,
    sanitizedYaml,
    changed:
      vaultResult.changed || yamlResult.changed || normalized.rest !== withoutLegacyRootDir.rest
  };
}

function emitSnapshot(snapshot: StoredOptions | null): void {
  if (areStateValuesEqual(snapshot, cachedSnapshot)) {
    return;
  }
  cachedSnapshot = snapshot ? cloneStateValue(snapshot) : null;
  const clone = cachedSnapshot ? cloneStateValue(cachedSnapshot) : undefined;
  subscribers.forEach((listener) => {
    try {
      listener(clone);
    } catch (error) {
      console.error('[optionsStore] subscriber error', error);
    }
  });
}

function ensureRepositorySubscription(): void {
  if (unsubscribeRepo) {
    return;
  }
  unsubscribeRepo = getOptionsRepository().onChange((next) => {
    const { normalized, sanitizedYaml, changed } = applySanitizedOptions(next);
    setYamlConfigOverrides(sanitizedYaml);
    emitSnapshot(normalized);
    if (changed) {
      void getOptionsRepository().set({
        ...(normalized.vaultRouter !== undefined && { vaultRouter: normalized.vaultRouter }),
        yamlConfig: sanitizedYaml ?? null
      });
      registerYamlMigration('repository subscription');
    }
  });
}

export async function load(): Promise<StoredOptions> {
  const options = await getOptionsRepository().get();
  const { normalized, sanitizedYaml, changed } = applySanitizedOptions(options);
  setYamlConfigOverrides(sanitizedYaml);
  if (changed) {
    await getOptionsRepository().set({
      ...(normalized.vaultRouter !== undefined && { vaultRouter: normalized.vaultRouter }),
      yamlConfig: sanitizedYaml ?? null
    });
    registerYamlMigration('load');
  }
  ensureRepositorySubscription();
  emitSnapshot(normalized);
  return cloneStateValue(normalized);
}

export async function save(options: StoredOptions | CompleteOptions): Promise<void> {
  const { normalized, sanitizedYaml, changed } = applySanitizedOptions(options);
  await getOptionsRepository().set(normalized as CompleteOptions);
  setYamlConfigOverrides(sanitizedYaml);
  emitSnapshot(normalized);
  if (changed) {
    registerYamlMigration('manual save');
  }
}

export function snapshot(): StoredOptions | null {
  return cachedSnapshot ? cloneStateValue(cachedSnapshot) : null;
}

export function replace(options: StoredOptions | CompleteOptions | null): void {
  if (!options) {
    setYamlConfigOverrides(null);
    emitSnapshot(null);
    return;
  }
  const { normalized, sanitizedYaml, changed } = applySanitizedOptions(options);
  setYamlConfigOverrides(sanitizedYaml);
  emitSnapshot(normalized);
  if (changed) {
    registerYamlMigration('state replace');
  }
}

export function reset(): void {
  cachedSnapshot = null;
  setYamlConfigOverrides(null);
  pendingYamlMigrationNotice = null;
  optionsRepository = null;
  if (unsubscribeRepo) {
    unsubscribeRepo();
    unsubscribeRepo = null;
  }
}

export function subscribe(listener: OptionsSubscriber): () => void {
  subscribers.add(listener);
  listener(cachedSnapshot ? cloneStateValue(cachedSnapshot) : undefined);
  ensureRepositorySubscription();
  return () => {
    subscribers.delete(listener);
  };
}

export const optionsStore: OptionsStore = {
  load,
  save,
  snapshot,
  replace,
  reset,
  subscribe
};

export default optionsStore;

export function getLegacyOptionsStore(): OptionsStore {
  return optionsStore;
}
