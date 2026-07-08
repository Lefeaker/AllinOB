import type { CompleteOptions, StoredOptions } from '../types';

export function omitLegacyRestRootDir<TRest extends object | undefined>(rest: TRest): TRest {
  if (!rest || !('rootDir' in rest)) {
    return rest;
  }

  const restWithoutRootDir = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key !== 'rootDir')
  );
  return restWithoutRootDir as TRest;
}

export function omitLegacyRestRootDirFromOptions(options: CompleteOptions): CompleteOptions;
export function omitLegacyRestRootDirFromOptions(options: StoredOptions): StoredOptions;
export function omitLegacyRestRootDirFromOptions<TOptions extends StoredOptions | CompleteOptions>(
  options: TOptions
): TOptions;
export function omitLegacyRestRootDirFromOptions<TOptions extends StoredOptions | CompleteOptions>(
  options: TOptions
): TOptions {
  if (!options.rest || !('rootDir' in options.rest)) {
    return options;
  }

  return {
    ...options,
    rest: omitLegacyRestRootDir(options.rest)
  } as TOptions;
}
