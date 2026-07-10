import { constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { access, cp, mkdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export const PUBLIC_BACKGROUND_ENTRYPOINTS = {
  'background/index': 'src/background/index.ts'
};

export const PUBLIC_APP_ENTRYPOINTS = {
  'content/runtime': 'src/content/index.ts',
  'local-vault-permission': 'src/content/runtime/localVaultPermissionFrame.ts',
  'offscreen/local-vault': 'src/offscreen/localVault.ts',
  'options/index': 'src/options/index.ts',
  'onboarding/index': 'src/onboarding/index.ts'
};

export const HARNESS_ENTRYPOINTS = {
  'interaction-contract-harness': 'src/dev/interactionContractHarness.ts',
  'content-orchestrator-harness': 'src/dev/contentOrchestratorHarness.ts',
  'runtime-observability-harness': 'src/dev/runtimeObservabilityHarness.ts',
  'local-vault-write-harness': 'src/dev/localVaultWriteHarness.ts'
};

export const REQUIRED_ENTRYPOINT_NAMES = [
  'background/index',
  'content/runtime',
  'options/index',
  'onboarding/index'
];

export const FORBIDDEN_OVERLAY_PERMISSIONS = [
  'unlimitedStorage',
  'message_serialization',
  'tabCapture'
];

const ALL_PUBLIC_ENTRYPOINTS = {
  ...PUBLIC_BACKGROUND_ENTRYPOINTS,
  ...PUBLIC_APP_ENTRYPOINTS
};
const SUPPORTED_ENTRYPOINT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SUPPORTED_STATIC_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.md',
  '.png',
  '.svg',
  '.txt',
  '.webp',
  '.woff',
  '.woff2'
]);
const FORBIDDEN_PATH_SEGMENTS = new Set(['.git', '.worktrees', 'build', 'node_modules']);
const FORBIDDEN_PATH_EXTENSIONS = new Set([
  '.cer',
  '.crt',
  '.crx',
  '.der',
  '.key',
  '.pem',
  '.pfx',
  '.p12',
  '.xpi',
  '.zip'
]);
const SECRET_LIKE_FILE_EXTENSIONS = new Set(['.json', '.key', '.pem', '.txt']);
const SECRET_LIKE_PATH_RE =
  /(^|\/).*(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|secret|token|credential|signing-key).*$/i;
const CRITICAL_DIST_PATHS = new Set([
  'manifest.json',
  'background/index.js',
  'content/index.js',
  'content/runtime.js',
  'options/index.html',
  'options/index.js',
  'onboarding/index.html',
  'onboarding/index.js'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDistPath(path) {
  const normalized = posix.normalize(path.replaceAll('\\', '/')).replace(/^\/+/, '');
  return normalized === '.' ? '' : normalized;
}

function validateDistPathInput(path, label) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`${label} must be a non-empty dist path`);
  }
  if (isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} must stay inside the dist directory`);
  }
  const slashNormalized = path.replaceAll('\\', '/');
  const normalized = normalizeDistPath(path);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must stay inside the dist directory`);
  }
  if (normalized !== slashNormalized.replace(/^\/+/, '')) {
    throw new Error(`${label} must be a normalized dist path: ${path}`);
  }
  return normalized;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInsideRoot(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function resolveExistingPath(value, { cwd, label }) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const resolved = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

function assertAllowedPath(path, { allowedRoots, label }) {
  if (!allowedRoots.some((root) => isInsideRoot(path, root))) {
    throw new Error(`${label} is outside allowed roots: ${path}`);
  }
}

function getPolicyPath(path, allowedRoots = []) {
  for (const root of allowedRoots) {
    if (isInsideRoot(path, root)) {
      const rel = relative(root, path);
      return rel === '' ? basename(path) : rel;
    }
  }
  return path;
}

function assertNotForbiddenPath(path, label, allowedRoots = []) {
  const normalized = getPolicyPath(path, allowedRoots).replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  const base = basename(path);
  const lowerBase = base.toLowerCase();
  const lowerPath = normalized.toLowerCase();
  const extension = extname(path).toLowerCase();

  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error(`${label} contains forbidden path segment: ${path}`);
  }
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) {
    throw new Error(`${label} contains forbidden env path: ${path}`);
  }
  if (
    lowerPath.includes('/.env.') ||
    lowerPath.includes('/id_rsa') ||
    lowerPath.includes('/id_dsa') ||
    lowerPath.includes('/id_ecdsa') ||
    lowerPath.includes('/id_ed25519') ||
    FORBIDDEN_PATH_EXTENSIONS.has(extension)
  ) {
    throw new Error(`${label} contains forbidden secret/archive path: ${path}`);
  }
  if (SECRET_LIKE_FILE_EXTENSIONS.has(extension) && SECRET_LIKE_PATH_RE.test(lowerPath)) {
    throw new Error(`${label} contains forbidden secret-like path: ${path}`);
  }
}

function assertSupportedExtension(path, allowedExtensions, label) {
  const extension = extname(path).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`${label} uses unsupported file type: ${path}`);
  }
}

function listStaticFiles(path, { allowedRoots, label }) {
  const stats = statSync(path);
  if (stats.isFile()) {
    return [{ path, realPath: realpathSync(path) }];
  }
  if (!stats.isDirectory()) {
    throw new Error(`static copy source must be a file or directory: ${path}`);
  }

  const files = [];
  const visitedDirectories = new Set();
  const visit = (directory) => {
    const realDirectory = realpathSync(directory);
    if (visitedDirectories.has(realDirectory)) {
      return;
    }
    assertAllowedPath(realDirectory, { allowedRoots, label });
    visitedDirectories.add(realDirectory);
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const realPath = realpathSync(absolute);
      assertAllowedPath(realPath, { allowedRoots, label });
      const entryStats = statSync(realPath);
      if (entryStats.isDirectory()) {
        visit(absolute);
      } else if (entryStats.isFile()) {
        files.push({ path: absolute, realPath });
      }
    }
  };
  visit(path);
  return files;
}

function createStaticCopyTargetPaths({ files, from, fromIsDirectory, to }) {
  if (!fromIsDirectory) {
    return [to];
  }

  return files.map((file) => {
    const rel = normalizeDistPath(relative(from, file.path));
    if (rel === '..' || rel.startsWith('../') || rel.includes('\0')) {
      throw new Error(`static copy source cannot map outside target directory: ${file.path}`);
    }
    return normalizeDistPath(posix.join(to, rel));
  });
}

function validateEntrypoints(entryPoints, context) {
  if (entryPoints === undefined) {
    return {};
  }
  assertObject(entryPoints, 'entryPoints');

  const normalized = {};
  for (const [name, value] of Object.entries(entryPoints)) {
    if (!Object.hasOwn(ALL_PUBLIC_ENTRYPOINTS, name)) {
      throw new Error(`Unsupported overlay entrypoint: ${name}`);
    }
    const path = resolveExistingPath(value, { cwd: context.cwd, label: `entryPoints.${name}` });
    assertAllowedPath(path, { allowedRoots: context.allowedRoots, label: `entryPoints.${name}` });
    assertNotForbiddenPath(path, `entryPoints.${name}`, context.allowedRoots);
    assertSupportedExtension(path, SUPPORTED_ENTRYPOINT_EXTENSIONS, `entryPoints.${name}`);
    normalized[name] = path;
  }
  return normalized;
}

function validateStaticCopies(staticCopies, context) {
  if (staticCopies === undefined) {
    return [];
  }
  assertArray(staticCopies, 'staticCopies');

  return staticCopies.map((copyRule, index) => {
    assertObject(copyRule, `staticCopies[${index}]`);
    const from = resolveExistingPath(copyRule.from, {
      cwd: context.cwd,
      label: `staticCopies[${index}].from`
    });
    assertAllowedPath(from, {
      allowedRoots: context.allowedRoots,
      label: `staticCopies[${index}].from`
    });
    assertNotForbiddenPath(from, `staticCopies[${index}].from`, context.allowedRoots);

    const to = validateDistPathInput(copyRule.to, `staticCopies[${index}].to`);

    const allowOverwrite = Array.isArray(copyRule.allowOverwrite)
      ? copyRule.allowOverwrite.map((path, allowIndex) =>
          validateDistPathInput(path, `staticCopies[${index}].allowOverwrite[${allowIndex}]`)
        )
      : [];
    const fromIsDirectory = statSync(from).isDirectory();
    const files = listStaticFiles(from, {
      allowedRoots: context.allowedRoots,
      label: `staticCopies[${index}].from`
    });
    const targetPaths = createStaticCopyTargetPaths({ files, from, fromIsDirectory, to });
    const blockedCriticalTargets = targetPaths.filter(
      (targetPath) => CRITICAL_DIST_PATHS.has(targetPath) && !allowOverwrite.includes(targetPath)
    );
    if (blockedCriticalTargets.length > 0) {
      throw new Error(
        `staticCopies[${index}] would overwrite critical public files without allowOverwrite: ${blockedCriticalTargets.join(', ')}`
      );
    }

    for (const file of files) {
      assertAllowedPath(file.realPath, {
        allowedRoots: context.allowedRoots,
        label: `staticCopies[${index}].from`
      });
      assertNotForbiddenPath(file.path, `staticCopies[${index}].from`, context.allowedRoots);
      assertNotForbiddenPath(file.realPath, `staticCopies[${index}].from`, context.allowedRoots);
      assertSupportedExtension(
        file.realPath,
        SUPPORTED_STATIC_EXTENSIONS,
        `staticCopies[${index}].from`
      );
    }

    return { allowOverwrite, from, targetPaths, to };
  });
}

function collectForbiddenPermissions(value, path = 'manifestPatch') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectForbiddenPermissions(entry, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    return [];
  }

  const findings = [];
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if ((key === 'permissions' || key === 'optional_permissions') && Array.isArray(entry)) {
      for (const permission of entry) {
        if (FORBIDDEN_OVERLAY_PERMISSIONS.includes(permission)) {
          findings.push(`${nextPath}: ${permission}`);
        }
      }
    }
    findings.push(...collectForbiddenPermissions(entry, nextPath));
  }
  return findings;
}

function validateManifestPatchMap(manifestPatch, context) {
  if (manifestPatch === undefined) {
    return {};
  }
  assertObject(manifestPatch, 'manifestPatch');

  const normalized = {};
  for (const [browser, value] of Object.entries(manifestPatch)) {
    if (browser !== 'chrome' && browser !== 'firefox') {
      throw new Error(`Unsupported manifestPatch browser: ${browser}`);
    }
    const path = resolveExistingPath(value, {
      cwd: context.cwd,
      label: `manifestPatch.${browser}`
    });
    assertAllowedPath(path, {
      allowedRoots: context.allowedRoots,
      label: `manifestPatch.${browser}`
    });
    assertNotForbiddenPath(path, `manifestPatch.${browser}`, context.allowedRoots);
    assertSupportedExtension(path, new Set(['.json']), `manifestPatch.${browser}`);
    const patch = JSON.parse(readFileSync(path, 'utf8'));
    assertObject(patch, `manifestPatch.${browser} content`);
    const forbidden = collectForbiddenPermissions(patch);
    if (forbidden.length > 0) {
      throw new Error(
        `Overlay manifest patch contains forbidden permissions: ${forbidden.join(', ')}`
      );
    }
    normalized[browser] = { path, patch };
  }
  return normalized;
}

function mergeManifestPatch(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const values = [...base];
    const seen = new Set(values.map((value) => JSON.stringify(value)));
    for (const entry of patch) {
      const key = JSON.stringify(entry);
      if (!seen.has(key)) {
        values.push(clone(entry));
        seen.add(key);
      }
    }
    return values;
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const next = { ...clone(base) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = key in next ? mergeManifestPatch(next[key], value) : clone(value);
    }
    return next;
  }
  return clone(patch);
}

function normalizeAllowedRoots(value, { cwd, repoRoot }) {
  assertArray(value, 'allowedRoots');
  if (value.length === 0) {
    throw new Error('allowedRoots must contain at least one root');
  }

  const roots = value.map((entry, index) => {
    if (typeof entry !== 'string' || !isAbsolute(entry)) {
      throw new Error(`allowedRoots[${index}] must be an absolute path`);
    }
    const resolved = resolve(entry);
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    if (!existsSync(canonical) || !statSync(canonical).isDirectory()) {
      throw new Error(`allowedRoots[${index}] must be an existing directory: ${resolved}`);
    }
    return canonical;
  });

  const publicRoots = [repoRoot, cwd]
    .map((path) => resolve(path))
    .filter((path) => existsSync(path))
    .map((path) => realpathSync(path));

  return {
    allowedRoots: Array.from(new Set([...roots, ...publicRoots])),
    overlayRoots: roots
  };
}

export function resolveBuildOverlayManifestPath(value, options = {}) {
  if (!value) {
    return null;
  }
  const cwd = options.cwd ?? process.cwd();
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function loadBuildOverlayManifest(manifestPath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = resolve(options.repoRoot ?? cwd);
  const resolvedManifestPath = resolveBuildOverlayManifestPath(manifestPath, { cwd });
  if (!resolvedManifestPath) {
    return null;
  }
  if (!existsSync(resolvedManifestPath)) {
    throw new Error(`Overlay manifest does not exist: ${resolvedManifestPath}`);
  }

  const raw = JSON.parse(readFileSync(resolvedManifestPath, 'utf8'));
  assertObject(raw, 'overlay manifest');
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported overlay manifest schemaVersion: ${raw.schemaVersion}`);
  }

  const { allowedRoots, overlayRoots } = normalizeAllowedRoots(raw.allowedRoots, { cwd, repoRoot });
  const context = { allowedRoots, cwd, repoRoot };
  const entryPoints = validateEntrypoints(raw.entryPoints, context);
  const staticCopies = validateStaticCopies(raw.staticCopies, context);
  const manifestPatch = validateManifestPatchMap(raw.manifestPatch, context);

  return {
    allowedRoots,
    entryPoints,
    manifestPath: resolvedManifestPath,
    manifestPatch,
    overlayRoots,
    schemaVersion: 1,
    staticCopies
  };
}

export function createBuildEntrypointPlan(options = {}) {
  const overlay = options.overlay ?? null;
  const includeHarnesses = options.includeHarnesses ?? false;
  const backgroundEntryPoints = { ...PUBLIC_BACKGROUND_ENTRYPOINTS };
  const appEntryPoints = includeHarnesses
    ? { ...PUBLIC_APP_ENTRYPOINTS, ...HARNESS_ENTRYPOINTS }
    : { ...PUBLIC_APP_ENTRYPOINTS };

  for (const [name, path] of Object.entries(overlay?.entryPoints ?? {})) {
    if (Object.hasOwn(backgroundEntryPoints, name)) {
      backgroundEntryPoints[name] = path;
    } else if (Object.hasOwn(appEntryPoints, name)) {
      appEntryPoints[name] = path;
    }
  }

  return { appEntryPoints, backgroundEntryPoints };
}

export function createRequiredEntrypoints(entrypointPlan) {
  const all = {
    ...entrypointPlan.backgroundEntryPoints,
    ...entrypointPlan.appEntryPoints
  };
  return REQUIRED_ENTRYPOINT_NAMES.map((name) => all[name]).filter(Boolean);
}

export function createConfiguredEntrypoints(entrypointPlan) {
  return {
    ...entrypointPlan.backgroundEntryPoints,
    ...entrypointPlan.appEntryPoints
  };
}

export function isOverlaySourcePath(path, overlay, options = {}) {
  if (!overlay) {
    return false;
  }
  const cwd = options.cwd ?? process.cwd();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return (overlay.overlayRoots ?? overlay.allowedRoots).some((root) =>
    isInsideRoot(resolved, root)
  );
}

export function applyBuildOverlayManifestPatch(manifest, browser, overlay) {
  const patch = overlay?.manifestPatch?.[browser]?.patch;
  const base = clone(manifest);
  if (!patch) {
    return base;
  }
  const merged = mergeManifestPatch(base, patch);
  const forbidden = collectForbiddenPermissions(merged);
  if (forbidden.length > 0) {
    throw new Error(
      `Build overlay cannot add forbidden manifest permissions: ${forbidden.join(', ')}`
    );
  }
  return merged;
}

async function assertCopyTargetAllowed({ allowOverwrite, distDir, from, targetPaths, to }) {
  const target = resolve(distDir, to);
  const resolvedDist = resolve(distDir);
  const rel = relative(resolvedDist, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Overlay static copy target escapes dist directory: ${to}`);
  }

  for (const targetPath of targetPaths) {
    const resolvedTargetPath = resolve(distDir, targetPath);
    const targetRel = relative(resolvedDist, resolvedTargetPath);
    if (targetRel === '..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
      throw new Error(`Overlay static copy target escapes dist directory: ${targetPath}`);
    }
    const targetExists = await access(resolvedTargetPath, constants.F_OK)
      .then(() => true)
      .catch(() => false);
    const normalizedTargetPath = normalizeDistPath(targetRel);
    if (targetExists && !allowOverwrite.includes(normalizedTargetPath)) {
      throw new Error(`Overlay static copy would overwrite existing dist path: ${targetPath}`);
    }
    if (
      CRITICAL_DIST_PATHS.has(normalizedTargetPath) &&
      !allowOverwrite.includes(normalizedTargetPath)
    ) {
      throw new Error(
        `Overlay static copy targets critical public file without allowOverwrite: ${normalizedTargetPath}`
      );
    }
  }

  return { from, target };
}

export async function copyBuildOverlayStaticAssets(overlay, options = {}) {
  if (!overlay?.staticCopies?.length) {
    return [];
  }
  const distDir = options.distDir ?? 'build/dist';
  const logger = options.logger ?? console;
  const summaries = [];

  for (const copyRule of overlay.staticCopies) {
    const { from, target } = await assertCopyTargetAllowed({
      ...copyRule,
      distDir
    });
    await mkdir(resolve(distDir), { recursive: true });
    await cp(from, target, { recursive: true, force: true });
    summaries.push({ from, to: copyRule.to });
  }

  if (summaries.length > 0) {
    logger.log(
      `Overlay static copies: ${summaries
        .map((summary) => `${summary.from} -> ${summary.to}`)
        .sort()
        .join(', ')}`
    );
  }

  return summaries;
}
