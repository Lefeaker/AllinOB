import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const scriptPath = resolve('tools/report-production-build-graph.mjs');

interface ProductionBuildGraphFixtureReport {
  configuredEntrypoints: Record<string, string>;
  reachableSources: Record<string, { entrypointOwners: string[] }>;
  requiredEntrypoints: { missing: string[] };
}

function writeMetafile(payload: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aiiinob-production-build-graph-'));
  const path = join(dir, 'metafile.json');
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return { dir, path };
}

describe('report-production-build-graph', () => {
  it('uses production build defines when creating the audit graph', async () => {
    const module = (await import(pathToFileURL(scriptPath).href)) as {
      createProductionBuildGraphDefine: () => Record<string, string>;
    };

    const define = module.createProductionBuildGraphDefine();

    expect(define['process.env.NODE_ENV']).toBe(JSON.stringify('production'));
    expect(define.__DEV__).toBe('false');
  });

  it('reports structured entrypoint ownership from an esbuild metafile', () => {
    const fixture = writeMetafile({
      inputs: {
        'src/background/index.ts': { bytes: 10 },
        'src/content/index.ts': { bytes: 10 },
        'src/content/runtime/localVaultPermissionFrame.ts': { bytes: 10 },
        'src/offscreen/localVault.ts': { bytes: 10 },
        'src/options/index.ts': { bytes: 10 },
        'src/onboarding/index.ts': { bytes: 10 },
        'src/options/app/bootstrap.ts': { bytes: 10 }
      },
      outputs: {
        'build/audit/background/index.js': {
          entryPoint: 'src/background/index.ts',
          inputs: {
            'src/background/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/content/runtime.js': {
          entryPoint: 'src/content/index.ts',
          inputs: {
            'src/content/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/options/index.js': {
          entryPoint: 'src/options/index.ts',
          imports: [{ path: 'build/audit/chunk-options.js', kind: 'import-statement' }],
          inputs: {
            'src/options/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/chunk-options.js': {
          inputs: {
            'src/options/app/bootstrap.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/onboarding/index.js': {
          entryPoint: 'src/onboarding/index.ts',
          inputs: {
            'src/onboarding/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/local-vault-permission.js': {
          entryPoint: 'src/content/runtime/localVaultPermissionFrame.ts',
          inputs: {
            'src/content/runtime/localVaultPermissionFrame.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/offscreen/local-vault.js': {
          entryPoint: 'src/offscreen/localVault.ts',
          inputs: {
            'src/offscreen/localVault.ts': { bytesInOutput: 10 }
          }
        }
      }
    });

    try {
      const output = execFileSync(
        process.execPath,
        [
          scriptPath,
          '--input-metafile',
          fixture.path,
          '--write-json',
          join(fixture.dir, 'graph.json')
        ],
        { encoding: 'utf8' }
      );
      expect(output).toContain('Production Build Graph Report');
      expect(output).toContain('src/options/index.ts');
      expect(output).toContain('src/content/index.ts');

      const json = JSON.parse(
        readFileSync(join(fixture.dir, 'graph.json'), 'utf8')
      ) as ProductionBuildGraphFixtureReport;
      expect(json.reachableSources['src/options/index.ts'].entrypointOwners).toContain(
        'src/options/index.ts'
      );
      expect(json.reachableSources['src/options/app/bootstrap.ts'].entrypointOwners).toContain(
        'src/options/index.ts'
      );
      expect(Object.values(json.configuredEntrypoints)).toEqual(
        expect.arrayContaining([
          'src/background/index.ts',
          'src/content/index.ts',
          'src/options/index.ts',
          'src/onboarding/index.ts'
        ])
      );
      expect(Object.values(json.configuredEntrypoints)).not.toContain(
        'src/dev/interactionContractHarness.ts'
      );
      expect(
        Object.keys(json.reachableSources).filter((source) => source.startsWith('src/dev/'))
      ).toEqual([]);
      expect(json.requiredEntrypoints.missing).toEqual([]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('fails closed when required production entrypoints are missing', () => {
    const fixture = writeMetafile({
      inputs: {
        'src/options/index.ts': { bytes: 10 }
      },
      outputs: {
        'build/audit/options/index.js': {
          entryPoint: 'src/options/index.ts',
          inputs: {
            'src/options/index.ts': { bytesInOutput: 10 }
          }
        }
      }
    });

    try {
      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, '--input-metafile', fixture.path, '--no-write-json'],
          {
            encoding: 'utf8'
          }
        )
      ).toThrow();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('reports overlay entrypoints when an overlay manifest is provided with a metafile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiiinob-production-build-graph-'));
    const overlayRoot = join(dir, 'overlay');
    const content = join(overlayRoot, 'entrypoints/content.ts');
    mkdirSync(join(overlayRoot, 'entrypoints'), { recursive: true });
    writeFileSync(content, 'export {};');
    const canonicalContent = realpathSync(content);
    const fixture = writeMetafile({
      inputs: {
        'src/background/index.ts': { bytes: 10 },
        'src/content/index.ts': { bytes: 10 },
        'src/options/index.ts': { bytes: 10 },
        'src/onboarding/index.ts': { bytes: 10 },
        [canonicalContent]: { bytes: 10 }
      },
      outputs: {
        'build/audit/background/index.js': {
          entryPoint: 'src/background/index.ts',
          inputs: {
            'src/background/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/content/runtime.js': {
          entryPoint: canonicalContent,
          inputs: {
            [canonicalContent]: { bytesInOutput: 10 }
          }
        },
        'build/audit/options/index.js': {
          entryPoint: 'src/options/index.ts',
          inputs: {
            'src/options/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/onboarding/index.js': {
          entryPoint: 'src/onboarding/index.ts',
          inputs: {
            'src/onboarding/index.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/local-vault-permission.js': {
          entryPoint: 'src/content/runtime/localVaultPermissionFrame.ts',
          inputs: {
            'src/content/runtime/localVaultPermissionFrame.ts': { bytesInOutput: 10 }
          }
        },
        'build/audit/offscreen/local-vault.js': {
          entryPoint: 'src/offscreen/localVault.ts',
          inputs: {
            'src/offscreen/localVault.ts': { bytesInOutput: 10 }
          }
        }
      }
    });
    const overlayManifest = join(dir, 'overlay-manifest.json');
    writeFileSync(
      overlayManifest,
      JSON.stringify({
        schemaVersion: 1,
        allowedRoots: [overlayRoot],
        entryPoints: {
          'content/runtime': content
        }
      })
    );

    try {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--overlay-manifest',
          overlayManifest,
          '--input-metafile',
          fixture.path,
          '--write-json',
          join(fixture.dir, 'graph.json')
        ],
        { encoding: 'utf8' }
      );

      const graphText = readFileSync(join(fixture.dir, 'graph.json'), 'utf8');
      expect(graphText).toContain(`"content/runtime": "${canonicalContent}"`);
      expect(graphText).toContain(`"${canonicalContent}": {`);
      expect(graphText).toContain('"missing": []');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
