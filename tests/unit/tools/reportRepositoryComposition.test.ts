import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scriptPath = resolve('tools/report-repository-composition.mjs');

function writeFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function writeRepositoryCompositionFixture(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'aiiinob-repository-composition-'));

  writeFile(
    root,
    'src/options/index.ts',
    [
      "import { bootstrapOptionsRuntime } from './runtimeEntry';",
      'bootstrapOptionsRuntime(platformServices);'
    ].join('\n')
  );
  writeFile(
    root,
    'src/options/runtimeEntry.ts',
    [
      "import { registerFallbackRepositories, registerRepositories } from '@shared/di/serviceRegistry';",
      'registerRepositories({',
      '  storage: platformServices.storage,',
      '  messaging: platformServices.messaging,',
      '  tabs: platformServices.tabs,',
      '  runtime: platformServices.runtime',
      '});',
      'registerFallbackRepositories();'
    ].join('\n')
  );
  writeFile(root, 'src/content/index.ts', 'initializeClipperRuntime({});\n');
  writeFile(root, 'src/content/runtime/contentRuntimeBootstrap.ts', 'registerRepositories({});\n');
  writeFile(root, 'src/background/index.ts', 'registerRepositories({});\n');
  writeFile(
    root,
    'src/onboarding/index.ts',
    ['registerRepositories({});', 'registerFallbackRepositories();'].join('\n')
  );
  writeFile(
    root,
    'src/shared/di/serviceRegistry.ts',
    [
      'export function registerRepositories(services: RepositoryPlatformServices): void {}',
      'export function registerFallbackRepositories(): void {}',
      'throw new Error("Register repositories in the composition root first.");'
    ].join('\n')
  );

  for (const [path, content] of Object.entries(overrides)) {
    writeFile(root, path, content);
  }

  return root;
}

function runReport(root: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8'
  });
}

describe('repository composition report', () => {
  it('accepts Options repository registration through runtimeEntry delegation', () => {
    const root = writeRepositoryCompositionFixture();
    try {
      const result = runReport(root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'src/options/index.ts requires "bootstrapOptionsRuntime(": yes'
      );
      expect(result.stdout).toContain(
        'src/options/runtimeEntry.ts requires "registerRepositories({": yes'
      );
      expect(result.stdout).toContain(
        'src/options/runtimeEntry.ts requires "registerFallbackRepositories()": yes'
      );
      expect(result.stdout).toContain(
        'src/content/index.ts requires "initializeClipperRuntime({": yes'
      );
      expect(result.stdout).toContain(
        'src/content/runtime/contentRuntimeBootstrap.ts requires "registerRepositories({": yes'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when Options runtimeEntry omits production repository registration', () => {
    const root = writeRepositoryCompositionFixture({
      'src/options/runtimeEntry.ts': 'registerFallbackRepositories();\n'
    });
    try {
      const result = runReport(root);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'src/options/runtimeEntry.ts requires "registerRepositories({": no'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when Options runtimeEntry omits preview fallback repositories', () => {
    const root = writeRepositoryCompositionFixture({
      'src/options/runtimeEntry.ts': 'registerRepositories({});\n'
    });
    try {
      const result = runReport(root);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        'src/options/runtimeEntry.ts requires "registerFallbackRepositories()": no'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
