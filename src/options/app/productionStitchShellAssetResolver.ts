import type { ProductionStitchShellDependencies } from './productionStitchShellTypes';

export type ResolvedProductionStitchAssets = Required<
  Pick<
    ProductionStitchShellDependencies,
    'previewContent' | 'getFooterMeta' | 'getFooterView' | 'getSettingsView'
  >
>;

export type ProductionStitchAssetsProvider = () =>
  | Promise<ResolvedProductionStitchAssets>
  | ResolvedProductionStitchAssets;

interface ProductionStitchAssetCandidates {
  previewContent: ProductionStitchShellDependencies['previewContent'] | undefined;
  getFooterMeta: ProductionStitchShellDependencies['getFooterMeta'] | undefined;
  getFooterView: ProductionStitchShellDependencies['getFooterView'] | undefined;
  getSettingsView: ProductionStitchShellDependencies['getSettingsView'] | undefined;
}

export function resolveProductionStitchAssets(
  assets: ProductionStitchAssetCandidates
): ResolvedProductionStitchAssets {
  if (
    assets.previewContent &&
    assets.getFooterMeta &&
    assets.getFooterView &&
    assets.getSettingsView
  ) {
    return assets as ResolvedProductionStitchAssets;
  }

  const globalAssets = (
    globalThis as typeof globalThis & {
      __AIIINOB_TEST_STITCH_ASSETS__?: ResolvedProductionStitchAssets;
    }
  ).__AIIINOB_TEST_STITCH_ASSETS__;

  if (globalAssets) {
    return globalAssets;
  }

  throw new Error('[Options] Production Stitch assets are required before mounting the shell.');
}

export async function loadProductionStitchAssets(): Promise<ResolvedProductionStitchAssets> {
  return import('./productionStitchAssets');
}
