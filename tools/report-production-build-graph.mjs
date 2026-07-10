import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cssTextPlugin } from '../scripts/plugins/cssTextPlugin.mjs';
import {
  HARNESS_ENTRYPOINTS,
  createBuildEntrypointPlan,
  createConfiguredEntrypoints,
  createRequiredEntrypoints,
  isOverlaySourcePath,
  loadBuildOverlayManifest
} from '../scripts/utils/buildOverlayManifest.mjs';

const REPORT_PATH = 'build/reports/production-build-graph.json';

function resolveBooleanEnv(value) {
  return value === '1' || value === 'true';
}

function resolveEnvAlias(newName, oldName, fallback = '') {
  return process.env[newName] ?? process.env[oldName] ?? fallback;
}

function resolveSentryEnv(name, fallback = '') {
  return resolveEnvAlias(`ZENDIO_SENTRY_${name}`, `AIIINOB_SENTRY_${name}`, fallback);
}

function createProductionBuildGraphDefine() {
  return {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __DEV__: 'false',
    __ZENDIO_SENTRY_DSN__: JSON.stringify(resolveSentryEnv('DSN')),
    __ZENDIO_SENTRY_ENVIRONMENT__: JSON.stringify(resolveSentryEnv('ENVIRONMENT', 'production')),
    __ZENDIO_SENTRY_RELEASE__: JSON.stringify(resolveSentryEnv('RELEASE', '0.2.1')),
    __ZENDIO_SENTRY_ENABLED__: resolveBooleanEnv(resolveSentryEnv('ENABLED')) ? 'true' : 'false',
    __AIIINOB_SENTRY_DSN__: JSON.stringify(resolveSentryEnv('DSN')),
    __AIIINOB_SENTRY_ENVIRONMENT__: JSON.stringify(resolveSentryEnv('ENVIRONMENT', 'production')),
    __AIIINOB_SENTRY_RELEASE__: JSON.stringify(resolveSentryEnv('RELEASE', '0.2.1')),
    __AIIINOB_SENTRY_ENABLED__: resolveBooleanEnv(resolveSentryEnv('ENABLED')) ? 'true' : 'false'
  };
}

function normalizePath(path) {
  return path.replace(/^\.\//, '');
}

function normalizeSourcePath(path, overlay) {
  const normalized = normalizePath(path);
  if (normalized.startsWith('src/') || normalized.startsWith('node_modules/')) {
    return normalized;
  }
  if (!isOverlaySourcePath(normalized, overlay)) {
    return normalized;
  }

  const absolute = isAbsolute(normalized) ? resolve(normalized) : resolve(normalized);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function sharedBuildOptions() {
  return {
    bundle: true,
    platform: 'browser',
    sourcemap: false,
    minify: true,
    write: false,
    metafile: true,
    define: createProductionBuildGraphDefine(),
    charset: 'utf8',
    loader: {
      '.css': 'text'
    },
    plugins: [cssTextPlugin()]
  };
}

function mergeMetafiles(metafiles) {
  return {
    inputs: Object.assign({}, ...metafiles.map((metafile) => metafile.inputs ?? {})),
    outputs: Object.assign({}, ...metafiles.map((metafile) => metafile.outputs ?? {}))
  };
}

async function createMetafile(entrypointPlan) {
  const shared = sharedBuildOptions();
  const background = await build({
    ...shared,
    entryPoints: entrypointPlan.backgroundEntryPoints,
    format: 'iife',
    outfile: 'build/audit/background/index.js'
  });
  const app = await build({
    ...shared,
    entryPoints: entrypointPlan.appEntryPoints,
    format: 'esm',
    splitting: true,
    outdir: 'build/audit'
  });

  if (!background.metafile || !app.metafile) {
    throw new Error('esbuild metafile is missing; production build graph cannot be proven');
  }

  return mergeMetafiles([background.metafile, app.metafile]);
}

function shouldIncludeReachableSource(source, overlay) {
  return (
    source.startsWith('src/') ||
    (!source.startsWith('node_modules/') && isOverlaySourcePath(source, overlay))
  );
}

function collectReachableSources(metafile, overlay) {
  const reachable = {};
  const outputEntrypoints = new Set();
  const outputOwners = collectOutputEntrypointOwners(metafile, overlay);

  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    const entrypoint = output.entryPoint ? normalizeSourcePath(output.entryPoint, overlay) : null;
    if (entrypoint) {
      outputEntrypoints.add(entrypoint);
    }

    for (const [inputPath, input] of Object.entries(output.inputs ?? {})) {
      const source = normalizeSourcePath(inputPath, overlay);
      if (!shouldIncludeReachableSource(source, overlay)) {
        continue;
      }
      const entrypointOwners = outputOwners.get(outputPath) ?? (entrypoint ? [entrypoint] : []);
      const current = reachable[source] ?? {
        entrypointOwners: [],
        outputOwners: [],
        bytesInOutput: 0
      };
      for (const owner of entrypointOwners) {
        if (!current.entrypointOwners.includes(owner)) {
          current.entrypointOwners.push(owner);
        }
      }
      if (!current.outputOwners.includes(outputPath)) {
        current.outputOwners.push(outputPath);
      }
      current.bytesInOutput += input.bytesInOutput ?? 0;
      reachable[source] = current;
    }
  }

  for (const value of Object.values(reachable)) {
    value.entrypointOwners.sort();
    value.outputOwners.sort();
  }

  return { reachable, outputEntrypoints };
}

function collectOutputEntrypointOwners(metafile, overlay) {
  const outputs = metafile.outputs ?? {};
  const owners = new Map();
  const importers = new Map();

  for (const [outputPath, output] of Object.entries(outputs)) {
    if (output.entryPoint) {
      owners.set(outputPath, new Set([normalizeSourcePath(output.entryPoint, overlay)]));
    }
    for (const imported of output.imports ?? []) {
      if (imported.kind !== 'import-statement' && imported.kind !== 'dynamic-import') {
        continue;
      }
      const importedPath = normalizePath(imported.path);
      const list = importers.get(importedPath) ?? [];
      list.push(outputPath);
      importers.set(importedPath, list);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [outputPath] of Object.entries(outputs)) {
      const current = owners.get(outputPath) ?? new Set();
      for (const importer of importers.get(outputPath) ?? []) {
        for (const owner of owners.get(importer) ?? []) {
          if (!current.has(owner)) {
            current.add(owner);
            changed = true;
          }
        }
      }
      if (current.size) {
        owners.set(outputPath, current);
      }
    }
  }

  return new Map(
    Array.from(owners.entries()).map(([outputPath, entrypointOwners]) => [
      outputPath,
      Array.from(entrypointOwners).sort()
    ])
  );
}

function buildProductionGraphReport({
  entrypointPlan = createBuildEntrypointPlan(),
  metafile,
  overlay = null
}) {
  if (!metafile || !metafile.inputs || !metafile.outputs) {
    throw new Error('missing esbuild metafile inputs/outputs');
  }

  const { reachable, outputEntrypoints } = collectReachableSources(metafile, overlay);
  const allEntrypoints = createConfiguredEntrypoints(entrypointPlan);
  const configuredEntrypoints = Object.values(allEntrypoints);
  const requiredEntrypoints = createRequiredEntrypoints(entrypointPlan);
  const missingConfiguredEntrypoints = configuredEntrypoints.filter(
    (entrypoint) => existsSync(entrypoint) && !outputEntrypoints.has(entrypoint)
  );
  const missingRequiredEntrypoints = requiredEntrypoints.filter(
    (entrypoint) => !outputEntrypoints.has(entrypoint)
  );
  const missingReachableRequiredSources = requiredEntrypoints.filter(
    (entrypoint) => !reachable[entrypoint]
  );
  const failures = [
    ...missingRequiredEntrypoints.map((entrypoint) => `missing required entrypoint: ${entrypoint}`),
    ...missingReachableRequiredSources.map(
      (entrypoint) => `required entrypoint is not reachable: ${entrypoint}`
    ),
    ...missingConfiguredEntrypoints.map(
      (entrypoint) => `configured build entrypoint did not appear in metafile: ${entrypoint}`
    )
  ];

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    configuredEntrypoints: allEntrypoints,
    excludedHarnessEntrypoints: HARNESS_ENTRYPOINTS,
    requiredEntrypoints: {
      expected: requiredEntrypoints,
      missing: Array.from(
        new Set([...missingRequiredEntrypoints, ...missingReachableRequiredSources])
      )
    },
    sourceCount: Object.keys(reachable).length,
    reachableSources: reachable,
    failures: Array.from(new Set(failures))
  };
}

function formatProductionBuildGraphReport(report) {
  const lines = [
    '# Production Build Graph Report',
    '',
    `Source count: ${report.sourceCount}`,
    '',
    '## Required Entrypoints',
    '',
    `Missing: ${report.requiredEntrypoints.missing.length ? report.requiredEntrypoints.missing.join(', ') : 'none'}`,
    '',
    '## Reachable Sources',
    '',
    '| Source | Entrypoint owners | Output owners |',
    '| --- | --- | --- |'
  ];

  for (const [source, owners] of Object.entries(report.reachableSources).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(
      `| \`${source}\` | ${owners.entrypointOwners.join(', ') || 'none'} | ${owners.outputOwners.join(', ') || 'none'} |`
    );
  }

  if (report.failures.length) {
    lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`));
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(args) {
  const parsed = {
    writeJson: REPORT_PATH
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input-metafile') {
      parsed.inputMetafile = args[index + 1];
      index += 1;
    } else if (arg === '--overlay-manifest') {
      parsed.overlayManifest = args[index + 1];
      index += 1;
    } else if (arg === '--write-json' || arg === '--write-build-graph') {
      parsed.writeJson = args[index + 1];
      index += 1;
    } else if (arg === '--no-write-json') {
      parsed.writeJson = null;
    }
  }
  return parsed;
}

function writeJsonReport(path, report) {
  if (!path) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const overlay = loadBuildOverlayManifest(args.overlayManifest);
  const entrypointPlan = createBuildEntrypointPlan({ overlay });
  const metafile = args.inputMetafile
    ? JSON.parse(readFileSync(args.inputMetafile, 'utf8'))
    : await createMetafile(entrypointPlan);
  const report = buildProductionGraphReport({ entrypointPlan, metafile, overlay });
  writeJsonReport(args.writeJson, report);
  process.stdout.write(formatProductionBuildGraphReport(report));
  if (report.failures.length > 0) {
    process.exit(1);
  }
}

export {
  buildProductionGraphReport,
  createBuildEntrypointPlan,
  createProductionBuildGraphDefine,
  formatProductionBuildGraphReport
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
