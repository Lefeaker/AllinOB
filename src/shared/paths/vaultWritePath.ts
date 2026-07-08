export type VaultWritePathTarget = 'rest-api' | 'local-folder';

export interface NormalizeVaultWritePathOptions {
  vaultName?: string;
  allowEmpty?: boolean;
  stripMatchingVaultPrefix?: boolean;
}

export interface NormalizedVaultWritePath {
  path: string;
  strippedVaultPrefix: boolean;
}

export interface NormalizeLocalFolderWritePathOptions {
  selectedVaultName?: string;
}

export function normalizeVaultWritePath(
  input: string,
  options: NormalizeVaultWritePathOptions = {}
): NormalizedVaultWritePath {
  const normalizedInput = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const vaultName = options.vaultName?.trim();
  const segments = normalizedInput
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  let strippedVaultPrefix = false;

  // REST compatibility: accept paths already prefixed with the selected vault to avoid double-vault writes.
  if (options.stripMatchingVaultPrefix === true && vaultName && segments[0] === vaultName) {
    segments.shift();
    strippedVaultPrefix = true;
  }

  if (segments.length === 0) {
    if (options.allowEmpty === true) {
      return { path: '', strippedVaultPrefix };
    }
    throw new Error('Vault-relative path must not be empty.');
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Vault-relative path must not contain traversal segments.');
  }

  return { path: segments.join('/'), strippedVaultPrefix };
}

export function normalizeRestWritePath(input: string, vaultName: string): NormalizedVaultWritePath {
  return normalizeVaultWritePath(input, {
    vaultName,
    stripMatchingVaultPrefix: true
  });
}

export function normalizeLocalFolderWritePath(
  input: string,
  options: NormalizeLocalFolderWritePathOptions = {}
): NormalizedVaultWritePath {
  const selectedVaultName = options.selectedVaultName?.trim();
  if (!selectedVaultName) {
    return normalizeVaultWritePath(input);
  }
  return normalizeVaultWritePath(input, {
    vaultName: selectedVaultName,
    stripMatchingVaultPrefix: true
  });
}

export function encodeVaultWritePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
