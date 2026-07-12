import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { validateFreezeComparisons } from '../../../scripts/preview-freeze-check.mjs';

interface FrozenArtifact {
  fileName: string;
  label: string;
  originalSha256: string;
  currentSha256: string;
}

const FROZEN_ARTIFACTS: readonly FrozenArtifact[] = [
  {
    fileName: 'index.html',
    label: 'original reference index.html vs current generated preview index.html',
    originalSha256: 'bb5ff6b884fffe81bc5dcc1d8e9c32d2d79d6645d23efbc68b13567d229a62ff',
    currentSha256: 'c74e262b77e804a25be4f43ac095f36d4dd69e63db9156b9fff7fe856659162c'
  },
  {
    fileName: 'styles.css',
    label: 'original reference styles.css vs current generated preview styles.css',
    originalSha256: '8df52cb64cbd04975f9f005641d087e4aeddcd0f62b7a86695432caf213e87b8',
    currentSha256: '79ec11e43c809fc1eb6b2a41fc07a9629c7c34bbe07c90b49575bb9c09aa8b04'
  },
  {
    fileName: 'index.js',
    label: 'original reference index.js vs current generated preview index.js',
    originalSha256: '9020ccbd91acd691eccd3fdf568b9a90efbddf0a35d79f36ef1caba702fa0c07',
    currentSha256: 'e928945d7356bb9c71c258509f9dba6fabdb2887df37263e3deb5faefc0415fb'
  }
];

const PREVIEW_NODE_MODULES = [
  ...readdirSync(resolve('node_modules/@esbuild')).map((entry) => `@esbuild/${entry}`),
  '@formatjs/fast-memoize',
  '@formatjs/icu-messageformat-parser',
  '@formatjs/icu-skeleton-parser',
  'esbuild',
  'intl-messageformat',
  'lucide',
  'tslib',
  'zod'
];

interface FreshCloneFixture {
  repoRoot: string;
  tempRoot: string;
}

function copyFixturePath(repoRoot: string, relativePath: string): void {
  const source = resolve(relativePath);
  const target = join(repoRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function createFreshCloneFixture(nodeModulesTopology: 'physical' | 'symlink'): FreshCloneFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), `zendio-preview-${nodeModulesTopology}-`));
  const repoRoot = join(tempRoot, 'AiiinOB');

  for (const relativePath of [
    'package.json',
    'scripts',
    'public',
    'src',
    'tests/fixtures/options-preview',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.base.json'
  ]) {
    copyFixturePath(repoRoot, relativePath);
  }

  const productionBuilt = join(repoRoot, 'build/dist/options/index.html');
  mkdirSync(dirname(productionBuilt), { recursive: true });
  copyFileSync(join(repoRoot, 'src/options/index.html'), productionBuilt);

  if (nodeModulesTopology === 'symlink') {
    symlinkSync(realpathSync(resolve('node_modules')), join(repoRoot, 'node_modules'), 'dir');
  } else {
    for (const packagePath of PREVIEW_NODE_MODULES) {
      const target = join(repoRoot, 'node_modules', packagePath);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(realpathSync(resolve('node_modules', packagePath)), target, {
        recursive: true,
        dereference: true
      });
    }
  }

  return { repoRoot, tempRoot };
}

function runDefaultFreeze(fixture: FreshCloneFixture): {
  result: SpawnSyncReturns<string>;
  indexSha256: string;
} {
  const result = spawnSync('npm', ['run', 'preview:freeze-check'], {
    cwd: fixture.repoRoot,
    encoding: 'utf8',
    timeout: 120_000
  });
  const indexSha256 = createHash('sha256')
    .update(
      readFileSync(
        join(fixture.repoRoot, '.tmp/preview-freeze-current/options-component-preview/index.js')
      )
    )
    .digest('hex');

  return { result, indexSha256 };
}

function usesOnlyTrackedDigestTruth(result: SpawnSyncReturns<string>): boolean {
  return result.stdout.includes('Truth source: tracked frozen digests\n');
}

function dependencySourceLabel(fixture: FreshCloneFixture): string | undefined {
  return readFileSync(
    join(fixture.repoRoot, '.tmp/preview-freeze-current/options-component-preview/index.js'),
    'utf8'
  )
    .split('\n')
    .find((line) => line.includes('node_modules/lucide/dist/esm/defaultAttributes.js'));
}

function createPassingComparisons(): Parameters<typeof validateFreezeComparisons>[0] {
  return [
    ...FROZEN_ARTIFACTS.map((artifact) => ({
      label: artifact.label,
      equal: false,
      missing: [],
      leftSha256: artifact.originalSha256,
      rightSha256: artifact.currentSha256
    })),
    {
      label: 'current generated standalone preview is non-empty',
      missing: [],
      nonEmpty: true
    },
    {
      label: 'production source options/index.html vs latest built options/index.html',
      equal: true,
      missing: []
    }
  ];
}

describe('preview freeze check', () => {
  it('passes the default command with identical bytes across physical and symlinked dependencies', () => {
    const physical = createFreshCloneFixture('physical');
    const symlink = createFreshCloneFixture('symlink');

    try {
      const physicalRun = runDefaultFreeze(physical);
      const symlinkRun = runDefaultFreeze(symlink);
      const topologyEvidence = JSON.stringify({
        physicalSha256: physicalRun.indexSha256,
        physicalSourceLabel: dependencySourceLabel(physical),
        symlinkSha256: symlinkRun.indexSha256,
        symlinkSourceLabel: dependencySourceLabel(symlink)
      });

      expect(usesOnlyTrackedDigestTruth(physicalRun.result)).toBe(true);
      expect(usesOnlyTrackedDigestTruth(symlinkRun.result)).toBe(true);

      expect(
        physicalRun.result.status,
        `${topologyEvidence}\n${physicalRun.result.stdout}\n${physicalRun.result.stderr}`
      ).toBe(0);
      expect(
        symlinkRun.result.status,
        `${topologyEvidence}\n${symlinkRun.result.stdout}\n${symlinkRun.result.stderr}`
      ).toBe(0);
      expect(physicalRun.indexSha256).toBe(symlinkRun.indexSha256);
    } finally {
      rmSync(physical.tempRoot, { recursive: true, force: true });
      rmSync(symlink.tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(FROZEN_ARTIFACTS)(
    'fails closed when the generated $fileName digest changes',
    (artifact) => {
      const comparisons = createPassingComparisons();
      const comparison = comparisons.find((item) => item.label === artifact.label);

      if (!comparison) {
        throw new Error(`Missing test comparison for ${artifact.label}`);
      }
      comparison.rightSha256 = '0'.repeat(64);

      expect(() => validateFreezeComparisons(comparisons)).toThrow(
        `${artifact.label}: drift does not match the explicit allowlist`
      );
    }
  );

  it('fails closed when an available external original digest changes', () => {
    const comparisons = createPassingComparisons();
    comparisons[0].leftSha256 = '0'.repeat(64);

    expect(() => validateFreezeComparisons(comparisons)).toThrow(
      'original reference index.html vs current generated preview index.html: drift does not match the explicit allowlist'
    );
  });

  it('requires a non-empty standalone generated by the current build', () => {
    const comparisons = createPassingComparisons();
    const standalone = comparisons.find(
      (item) => item.label === 'current generated standalone preview is non-empty'
    );

    if (!standalone) {
      throw new Error('Missing standalone comparison');
    }
    standalone.nonEmpty = false;

    expect(() => validateFreezeComparisons(comparisons)).toThrow(
      'current generated standalone preview is non-empty: expected a non-empty artifact from this build'
    );
  });
});
