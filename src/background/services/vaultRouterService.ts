import type { Options } from '../store';
import { VaultRouter } from '../vault-router';
import type { ClipPayload, ClipContext, VaultConfig } from '../../shared/types';
import type { RestOptions } from '../../shared/types/options';
import { tryParseUrl } from '../../shared/url';
import { parseExportDestinationMetadata } from '../../shared/exportDestination';

export interface VaultSelectionResult {
  vault: VaultConfig | null;
  restConfig: Options['rest'];
  context: ClipContext;
}

export function buildClipContext(payload: ClipPayload): ClipContext {
  return {
    url: payload.meta?.url ?? '',
    domain: payload.meta?.domain ?? deriveDomain(payload.meta?.url),
    title: payload.title ?? 'Untitled',
    content: payload.markdown.slice(0, 2000),
    type: (payload.type as ClipContext['type']) ?? 'article'
  };
}

export function selectVaultForClip(options: Options, payload: ClipPayload): VaultSelectionResult {
  const context = buildClipContext(payload);
  const defaultRest = options.rest;

  if (!options.vaultRouter || options.vaultRouter.vaults.length === 0) {
    return { vault: null, restConfig: defaultRest, context };
  }

  const requestedDestination = parseExportDestinationMetadata(payload.meta?.exportDestination);
  const requestedVault =
    requestedDestination?.kind === 'vault' && requestedDestination.vaultId
      ? options.vaultRouter.vaults.find(
          (vault) => vault.enabled !== false && vault.id === requestedDestination.vaultId
        )
      : undefined;

  const router = new VaultRouter(options.vaultRouter);
  const selectedVault = requestedVault ?? router.selectVault(context) ?? router.getDefaultVault();

  if (!selectedVault) {
    return { vault: null, restConfig: defaultRest, context };
  }

  const httpsUrl = selectedVault.httpsUrl || defaultRest.httpsUrl;
  const httpUrl = selectedVault.httpUrl || defaultRest.httpUrl;
  const baseUrl = selectedVault.httpsUrl || selectedVault.httpUrl || defaultRest.baseUrl;
  const apiKey = selectedVault.apiKey?.trim() || defaultRest.apiKey;

  const restConfig: RestOptions = {
    baseUrl,
    vault: selectedVault.vault,
    apiKey,
    ...(httpsUrl ? { httpsUrl } : {}),
    ...(httpUrl ? { httpUrl } : {}),
    ...(selectedVault.localFolderId ? { localFolderId: selectedVault.localFolderId } : {}),
    ...(selectedVault.localFolderName ? { localFolderName: selectedVault.localFolderName } : {})
  };

  return { vault: selectedVault, restConfig, context };
}

function deriveDomain(url?: string): string {
  const parsed = tryParseUrl(url);
  return parsed?.hostname ?? '';
}
