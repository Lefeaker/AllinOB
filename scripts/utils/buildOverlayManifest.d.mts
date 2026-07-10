export interface BuildOverlayManifest {
  allowedRoots: string[];
  entryPoints: Record<string, string>;
  manifestPath: string;
  manifestPatch: Record<string, { path: string; patch: Record<string, unknown> }>;
  overlayRoots: string[];
  schemaVersion: 1;
  staticCopies: Array<{
    allowOverwrite: string[];
    from: string;
    targetPaths: string[];
    to: string;
  }>;
}

export const FORBIDDEN_OVERLAY_PERMISSIONS: string[];

export function loadBuildOverlayManifest(
  manifestPath?: string | null,
  options?: { cwd?: string; repoRoot?: string }
): BuildOverlayManifest | null;

export function createBuildEntrypointPlan(options?: {
  includeHarnesses?: boolean;
  overlay?: BuildOverlayManifest | null;
}): {
  appEntryPoints: Record<string, string>;
  backgroundEntryPoints: Record<string, string>;
};

export function applyBuildOverlayManifestPatch<T>(
  manifest: T,
  browser: 'chrome' | 'firefox',
  overlay?: BuildOverlayManifest | null
): T;
