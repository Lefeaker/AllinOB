import type { VaultRouterConfig } from '@shared/types';
import type { CompleteOptions, RestOptions, StoredOptions } from '@shared/types/options';
import type { VaultConfig } from '@shared/types/vault';

export interface RestSectionBaseInputs {
  nameInput: HTMLInputElement | null;
  httpsInput: HTMLInputElement | null;
  httpInput: HTMLInputElement | null;
  apiKeyInput: HTMLInputElement | null;
}

export interface RestSectionLocalFolderInput {
  localFolderButton?: HTMLButtonElement | null;
}

export function resolveDefaultVault(
  snapshot: VaultRouterConfig | null,
  defaultVaultId: string | null
): VaultConfig | undefined {
  return (
    snapshot?.vaults.find(
      (vault) => vault.id === (snapshot.defaultVaultId ?? defaultVaultId ?? '')
    ) ?? snapshot?.vaults[0]
  );
}

export function applyRestBaseSectionSnapshot(params: {
  options: StoredOptions | CompleteOptions;
  defaultInputs: RestSectionBaseInputs;
  defaultVaultId: string | null;
  vaultRouterSnapshot: VaultRouterConfig | null;
  defaults: RestOptions;
}): {
  name: string;
  httpsUrl: string;
  httpUrl: string;
  apiKey: string;
} {
  const { options, defaultInputs, defaultVaultId, vaultRouterSnapshot, defaults } = params;
  const rest = (options.rest ?? {}) as Partial<RestOptions>;
  const defaultVault = resolveDefaultVault(vaultRouterSnapshot, defaultVaultId);

  const resolved = {
    name: rest.vault ?? defaultVault?.vault ?? defaults.vault,
    httpsUrl: rest.httpsUrl ?? defaultVault?.httpsUrl ?? '',
    httpUrl: rest.httpUrl ?? defaultVault?.httpUrl ?? '',
    apiKey: rest.apiKey ?? defaultVault?.apiKey ?? ''
  };

  if (defaultInputs.nameInput) {
    defaultInputs.nameInput.value = resolved.name;
  }
  if (defaultInputs.httpsInput) {
    defaultInputs.httpsInput.value = resolved.httpsUrl;
  }
  if (defaultInputs.httpInput) {
    defaultInputs.httpInput.value = resolved.httpUrl;
  }
  if (defaultInputs.apiKeyInput) {
    defaultInputs.apiKeyInput.value = resolved.apiKey;
  }

  return resolved;
}

export function collectRestBaseChanges(params: {
  previous: StoredOptions | null;
  defaultInputs: RestSectionBaseInputs;
  defaults: RestOptions;
}): { rest: RestOptions } {
  const { defaultInputs, defaults } = params;

  const https = defaultInputs.httpsInput?.value.trim() ?? '';
  const http = defaultInputs.httpInput?.value.trim() ?? '';
  const vault = defaultInputs.nameInput?.value.trim() ?? '';
  const apiKey = defaultInputs.apiKeyInput?.value ?? '';

  const httpsUrl = https.length > 0 ? https : undefined;
  const httpUrl = http.length > 0 ? http : undefined;
  const resolvedVault = vault.length > 0 ? vault : defaults.vault;
  const baseUrl = httpsUrl || httpUrl || defaults.baseUrl;

  return {
    rest: {
      baseUrl,
      vault: resolvedVault,
      apiKey,
      ...(httpsUrl !== undefined && { httpsUrl }),
      ...(httpUrl !== undefined && { httpUrl })
    }
  };
}

export function collectRestBaseDraft(defaultInputs: RestSectionBaseInputs): Partial<RestOptions> {
  const httpsInput = defaultInputs.httpsInput?.value.trim() ?? '';
  const httpInput = defaultInputs.httpInput?.value.trim() ?? '';
  const vaultInput = defaultInputs.nameInput?.value.trim() ?? '';
  const apiKeyInput = defaultInputs.apiKeyInput?.value ?? '';

  const draft: Partial<RestOptions> = {};
  if (httpsInput) {
    draft.httpsUrl = httpsInput;
  }
  if (httpInput) {
    draft.httpUrl = httpInput;
  }
  if (vaultInput) {
    draft.vault = vaultInput;
  }
  if (apiKeyInput) {
    draft.apiKey = apiKeyInput;
  }
  const baseCandidate = httpsInput || httpInput;
  if (baseCandidate) {
    draft.baseUrl = baseCandidate;
  }
  return draft;
}

export function readRestRowValue(row: HTMLElement, selector: string, trim = true): string | null {
  const input = row.querySelector<HTMLInputElement>(selector);
  if (!input) {
    return null;
  }
  const value = input.value ?? '';
  return trim ? value.trim() : value;
}

export function collectAdditionalVaultConfigsCore(params: {
  additionalRowsHost: HTMLElement | null;
  vaultRouterSnapshot: VaultRouterConfig | null;
  defaultVaultId: string | null;
  includeLocalFolder: boolean;
}): VaultConfig[] {
  const { additionalRowsHost, vaultRouterSnapshot, defaultVaultId, includeLocalFolder } = params;
  const vaults = vaultRouterSnapshot?.vaults ?? [];
  const resolvedDefaultId =
    vaultRouterSnapshot?.defaultVaultId ?? defaultVaultId ?? vaults[0]?.id ?? null;

  return vaults
    .filter((vault) => vault.id !== resolvedDefaultId)
    .map((vault) => {
      const row = additionalRowsHost?.querySelector<HTMLElement>(`[data-vault-id="${vault.id}"]`);
      const baseVault = includeLocalFolder ? vault : omitLocalFolderFields(vault);
      if (!row) {
        return baseVault;
      }

      const enabledToggle = row.querySelector<HTMLInputElement>('.rest-vault-enabled');
      const https = readRestRowValue(row, '.rest-vault-https');
      const http = readRestRowValue(row, '.rest-vault-http');
      const name = readRestRowValue(row, '.rest-vault-name');
      const apiKey = readRestRowValue(row, '.rest-vault-api', false);
      const localFolderButton = includeLocalFolder
        ? row.querySelector<HTMLButtonElement>('.rest-vault-local-folder')
        : null;
      const localFolderId = localFolderButton?.dataset.localFolderId?.trim();
      const localFolderName = localFolderButton?.dataset.localFolderName?.trim();

      return {
        ...baseVault,
        ...(enabledToggle
          ? { enabled: enabledToggle.checked }
          : baseVault.enabled !== undefined
            ? { enabled: baseVault.enabled }
            : {}),
        ...(https !== null
          ? { httpsUrl: https }
          : baseVault.httpsUrl !== undefined
            ? { httpsUrl: baseVault.httpsUrl }
            : {}),
        ...(http !== null
          ? { httpUrl: http }
          : baseVault.httpUrl !== undefined
            ? { httpUrl: baseVault.httpUrl }
            : {}),
        vault: name ?? baseVault.vault,
        name: name ?? baseVault.name,
        apiKey: apiKey ?? baseVault.apiKey,
        ...(includeLocalFolder && localFolderId !== undefined
          ? localFolderId
            ? { localFolderId }
            : {}
          : includeLocalFolder && baseVault.localFolderId
            ? { localFolderId: baseVault.localFolderId }
            : {}),
        ...(includeLocalFolder && localFolderName !== undefined
          ? localFolderName
            ? { localFolderName }
            : {}
          : includeLocalFolder && baseVault.localFolderName
            ? { localFolderName: baseVault.localFolderName }
            : {})
      };
    })
    .filter((vault) => vault.enabled !== false);
}

function omitLocalFolderFields(vault: VaultConfig): VaultConfig {
  return {
    id: vault.id,
    name: vault.name,
    httpsUrl: vault.httpsUrl,
    httpUrl: vault.httpUrl,
    vault: vault.vault,
    apiKey: vault.apiKey,
    ...(vault.isDefault !== undefined && { isDefault: vault.isDefault }),
    ...(vault.enabled !== undefined && { enabled: vault.enabled }),
    ...(vault.rules !== undefined && { rules: vault.rules })
  };
}
