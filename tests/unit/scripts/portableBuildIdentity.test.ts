import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

type PortableSourceIdentity = {
  kind: 'overlay' | 'public';
  namespace: string;
  path: string;
  rootIndex: number | null;
};

type PortableBuildIdentity = {
  plugin: Plugin;
  sourceIdentity(path: string): PortableSourceIdentity;
};

type CssTextPluginOptions = {
  publicRoot?: string;
  sourceIdentity?: (path: string) => PortableSourceIdentity;
};

const cssTextPluginModuleUrl = new URL(
  '../../../scripts/plugins/cssTextPlugin.mjs',
  import.meta.url
).href;
const portableBuildIdentityModuleUrl = new URL(
  '../../../scripts/plugins/portableBuildIdentityPlugin.mjs',
  import.meta.url
).href;
const cssTextPluginModule = await vi.importActual<{
  cssTextPlugin(options?: CssTextPluginOptions): Plugin;
}>(cssTextPluginModuleUrl);
const portableBuildIdentityModule = await vi.importActual<{
  createPortableBuildIdentity(options: {
    overlayRoots?: string[];
    publicRoot: string;
  }): PortableBuildIdentity;
}>(portableBuildIdentityModuleUrl);
const cssTextPlugin = (options?: CssTextPluginOptions): Plugin =>
  cssTextPluginModule.cssTextPlugin(options);
const createPortableBuildIdentity = (options: {
  overlayRoots?: string[];
  publicRoot: string;
}): PortableBuildIdentity => portableBuildIdentityModule.createPortableBuildIdentity(options);

function writeFixtureFile(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function createPortableBuildFixture(parent: string) {
  const publicRoot = join(parent, 'public');
  const overlayRoot = join(parent, 'private-overlay');
  const outdir = join(parent, 'out');

  writeFixtureFile(
    join(publicRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: { '@fixture/*': ['src/*'] }
        }
      },
      null,
      2
    )}\n`
  );
  writeFixtureFile(join(publicRoot, 'src/styles.css'), '.portable { color: #123456; }\n');
  writeFixtureFile(
    join(publicRoot, 'src/styled.ts'),
    "import styles from './styles.css?inline';\nexport const styled = styles.length;\n"
  );
  writeFixtureFile(
    join(overlayRoot, 'shared.ts'),
    "import { styled } from '@fixture/styled';\nimport privateStyles from './private.css?inline';\nimport { duplicate as duplicateA } from './duplicateA';\nimport { duplicate as duplicateB } from './duplicateB';\nexport const shared = styled + privateStyles.length + duplicateA + duplicateB;\n"
  );
  writeFixtureFile(join(overlayRoot, 'private.css'), '.private { display: block; }\n');
  const duplicateSource =
    "console.log('portable-duplicate-loaded');\nexport const duplicate = 1;\n";
  writeFixtureFile(join(overlayRoot, 'duplicateA.ts'), duplicateSource);
  writeFixtureFile(join(overlayRoot, 'duplicateB.ts'), duplicateSource);
  for (const entry of ['content', 'options']) {
    writeFixtureFile(
      join(overlayRoot, `${entry}.ts`),
      `import { shared } from './shared';\nconsole.log(${JSON.stringify(entry)}, shared);\n`
    );
  }

  return { outdir, overlayRoot, publicRoot };
}

async function buildFixture(parent: string) {
  const fixture = createPortableBuildFixture(parent);
  const identity = createPortableBuildIdentity({
    overlayRoots: [fixture.overlayRoot],
    publicRoot: fixture.publicRoot
  });
  const result = await build({
    absWorkingDir: fixture.publicRoot,
    bundle: true,
    chunkNames: 'chunks/[name]-[hash]',
    entryPoints: {
      'content/runtime': join(fixture.overlayRoot, 'content.ts'),
      'options/index': join(fixture.overlayRoot, 'options.ts')
    },
    format: 'esm',
    minify: true,
    outdir: fixture.outdir,
    platform: 'browser',
    plugins: [
      identity.plugin,
      cssTextPlugin({
        publicRoot: fixture.publicRoot,
        sourceIdentity: (path) => identity.sourceIdentity(path)
      })
    ],
    splitting: true,
    tsconfig: join(fixture.publicRoot, 'tsconfig.json'),
    write: false
  });

  const snapshot = result.outputFiles
    .map((file) => ({
      bytes: Buffer.from(file.contents).toString('hex'),
      path: relative(fixture.outdir, file.path).replaceAll('\\', '/')
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const outputText = result.outputFiles.map((file) => file.text).join('\n');
  return { outputText, snapshot };
}

describe('portable build identity', () => {
  it('emits identical output member paths and bytes from distinct physical roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'zendio-portable-build-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'zendio-portable-build-b-'));

    try {
      const first = await buildFixture(rootA);
      const second = await buildFixture(rootB);

      expect(first.snapshot).toEqual(second.snapshot);
      expect(first.outputText.match(/portable-duplicate-loaded/g)).toHaveLength(2);
      expect(second.outputText.match(/portable-duplicate-loaded/g)).toHaveLength(2);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it('rejects missing sources, root escapes, and ambiguous root identities', () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-identity-errors-'));
    const fixture = createPortableBuildFixture(parent);
    const outside = join(parent, 'outside.ts');
    writeFixtureFile(outside, 'export const outside = true;\n');
    const dotDotNamedSource = join(fixture.overlayRoot, '..safe.ts');
    writeFixtureFile(dotDotNamedSource, 'export const safe = true;\n');
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      expect(() => identity.sourceIdentity(join(parent, 'missing.ts'))).toThrow(
        /PORTABLE_BUILD_SOURCE_MISSING/
      );
      expect(() => identity.sourceIdentity(outside)).toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
      expect(identity.sourceIdentity(dotDotNamedSource).path).toBe('overlay-0/..safe.ts');
      expect(() =>
        createPortableBuildIdentity({
          overlayRoots: [fixture.overlayRoot, fixture.overlayRoot],
          publicRoot: fixture.publicRoot
        })
      ).toThrow(/PORTABLE_BUILD_IDENTITY_COLLISION/);
      expect(() =>
        createPortableBuildIdentity({
          overlayRoots: [fixture.publicRoot],
          publicRoot: fixture.publicRoot
        })
      ).toThrow(/PORTABLE_BUILD_IDENTITY_COLLISION/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects relative overlay imports marked external by another plugin', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-relative-external-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(
      join(fixture.overlayRoot, 'externalEntry.ts'),
      "import './external-target';\n"
    );
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });
    const externalPlugin: Plugin = {
      name: 'relative-external-fixture',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /external-target$/ }, () => ({
          external: true,
          path: './external-target'
        }));
      }
    };

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'externalEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin, externalPlugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects absolute entry points outside every declared source root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-entry-escape-'));
    const fixture = createPortableBuildFixture(parent);
    const outside = join(parent, 'outside-entry.ts');
    writeFixtureFile(outside, 'console.log("outside");\n');
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [outside],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects forged identities from an untrusted relative custom namespace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-custom-namespace-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(join(fixture.overlayRoot, 'customEntry.ts'), "import './virtual-target';\n");
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });
    const customNamespacePlugin: Plugin = {
      name: 'untrusted-custom-namespace-fixture',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /virtual-target$/ }, () => ({
          namespace: 'untrusted-fixture',
          path: 'virtual-target',
          pluginData: {
            portableBuildIdentity: { kind: 'overlay', rootIndex: 0 }
          }
        }));
      }
    };

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'customEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin, customNamespacePlugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects relative inline CSS that resolves into the public root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-css-escape-'));
    const fixture = createPortableBuildFixture(parent);
    symlinkSync(
      join(fixture.publicRoot, 'src/styles.css'),
      join(fixture.overlayRoot, 'publicStyles.css')
    );
    writeFixtureFile(
      join(fixture.overlayRoot, 'cssEscapeEntry.ts'),
      "import styles from './publicStyles.css?inline';\nconsole.log(styles);\n"
    );
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'cssEscapeEntry.ts')],
          logLevel: 'silent',
          plugins: [
            identity.plugin,
            cssTextPlugin({
              publicRoot: fixture.publicRoot,
              sourceIdentity: (path) => identity.sourceIdentity(path)
            })
          ],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects relative overlay imports that escape through a symlink', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-symlink-escape-'));
    const fixture = createPortableBuildFixture(parent);
    const outside = join(parent, 'outside.ts');
    writeFixtureFile(outside, 'export const outside = true;\n');
    symlinkSync(outside, join(fixture.overlayRoot, 'escaped.ts'));
    writeFixtureFile(
      join(fixture.overlayRoot, 'symlinkEntry.ts'),
      "import { outside } from './escaped';\nconsole.log(outside);\n"
    );
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'symlinkEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects missing relative overlay imports with the portable failure code', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-missing-import-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(join(fixture.overlayRoot, 'missingEntry.ts'), "import './does-not-exist';\n");
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'missingEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_SOURCE_MISSING/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects unsupported overlay loaders before reading source bytes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-loader-'));
    const fixture = createPortableBuildFixture(parent);
    const unsupported = join(fixture.overlayRoot, 'unsupported.txt');
    writeFixtureFile(unsupported, 'not a supported overlay module\n');
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [unsupported],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_UNSUPPORTED_LOADER/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
