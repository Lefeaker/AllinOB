import { normalizeVaultWritePath } from './vaultWritePath';

export interface NormalizeVaultRelativePathOptions {
  vaultName?: string;
  allowEmpty?: boolean;
}

export function normalizeVaultRelativePath(
  input: string,
  options: NormalizeVaultRelativePathOptions = {}
): string {
  return normalizeVaultWritePath(input, {
    ...options,
    stripMatchingVaultPrefix: Boolean(options.vaultName)
  }).path;
}
