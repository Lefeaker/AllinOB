import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
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

type LogicalSourceKind = 'overlay' | 'public';

type ExternalImportCase = {
  entryKind: LogicalSourceKind;
  specifierKind: 'bare' | 'relative';
};

type AdversarialIdentityCase = {
  fileName: string;
  rootKind: LogicalSourceKind;
};

const externalImportCases: ExternalImportCase[] = [
  { entryKind: 'public', specifierKind: 'relative' },
  { entryKind: 'public', specifierKind: 'bare' },
  { entryKind: 'overlay', specifierKind: 'relative' },
  { entryKind: 'overlay', specifierKind: 'bare' }
];

const adversarialIdentityCases: AdversarialIdentityCase[] = [
  { fileName: 'back\\slash.ts', rootKind: 'public' },
  { fileName: 'C:drive.ts', rootKind: 'public' },
  { fileName: 'back\\slash.ts', rootKind: 'overlay' },
  { fileName: 'C:drive.ts', rootKind: 'overlay' }
];

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
    metafile: true,
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
  return {
    moduleIdentities: Object.keys(result.metafile.inputs).sort(),
    outputText,
    snapshot
  };
}

async function buildLocalPublicPackageFixture(parent: string) {
  const fixture = createPortableBuildFixture(parent);
  const packageRoot = join(fixture.publicRoot, 'node_modules', 'portable-package');
  writeFixtureFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        exports: { '.': './dist/exported.js' },
        name: 'portable-package',
        type: 'module'
      },
      null,
      2
    )}\n`
  );
  writeFixtureFile(
    join(packageRoot, 'dist', 'exported.js'),
    "export const packageValue = 'root-local-package-export';\n"
  );
  const entry = join(fixture.publicRoot, 'src', 'publicPackageEntry.ts');
  writeFixtureFile(
    entry,
    "import { packageValue } from 'portable-package';\nconsole.log(packageValue);\n"
  );
  const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });
  const result = await build({
    absWorkingDir: fixture.publicRoot,
    bundle: true,
    entryPoints: [entry],
    logLevel: 'silent',
    metafile: true,
    plugins: [identity.plugin],
    write: false
  });
  return {
    moduleIdentities: Object.keys(result.metafile.inputs).sort(),
    outputBytes: Buffer.from(result.outputFiles[0].contents).toString('hex')
  };
}

describe('portable build identity', () => {
  it('emits identical output member paths and bytes from distinct physical roots', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'zendio-portable-build-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'zendio-portable-build-b-'));

    try {
      const first = await buildFixture(rootA);
      const second = await buildFixture(rootB);

      expect(first.snapshot).toEqual(second.snapshot);
      expect(first.moduleIdentities).toEqual(second.moduleIdentities);
      expect(
        first.moduleIdentities.every(
          (identity) =>
            identity.startsWith('portable-overlay-source:overlay-0/') ||
            identity.startsWith('p:src/') ||
            identity.startsWith('css-text:portable-overlay-source/overlay-0/') ||
            identity.startsWith('css-text:p/src/')
        )
      ).toBe(true);
      expect(first.moduleIdentities).toEqual(
        expect.arrayContaining([
          'portable-overlay-source:overlay-0/content.ts',
          'portable-overlay-source:overlay-0/shared.ts',
          'p:src/styled.ts'
        ])
      );
      expect(first.moduleIdentities.some((identity) => identity.includes(rootA))).toBe(false);
      expect(second.moduleIdentities.some((identity) => identity.includes(rootB))).toBe(false);
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

  it.each(adversarialIdentityCases)(
    'rejects the POSIX adversarial identity $fileName in the $rootKind root',
    ({ fileName, rootKind }: AdversarialIdentityCase) => {
      if (sep !== '/') {
        return;
      }
      const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-adversarial-identity-'));
      const fixture = createPortableBuildFixture(parent);
      const sourceRoot = rootKind === 'public' ? fixture.publicRoot : fixture.overlayRoot;
      const source = join(sourceRoot, fileName);
      writeFixtureFile(source, 'export const adversarial = true;\n');
      const identity = createPortableBuildIdentity({
        overlayRoots: [fixture.overlayRoot],
        publicRoot: fixture.publicRoot
      });

      try {
        expect(() => identity.sourceIdentity(source)).toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  );

  it.each(externalImportCases)(
    'rejects a $specifierKind external import from a logical $entryKind source',
    async ({ entryKind, specifierKind }: ExternalImportCase) => {
      const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-logical-external-'));
      const fixture = createPortableBuildFixture(parent);
      const entryRoot =
        entryKind === 'public' ? join(fixture.publicRoot, 'src') : fixture.overlayRoot;
      const entry = join(entryRoot, 'externalEntry.ts');
      const specifier = specifierKind === 'relative' ? './external-target' : 'external-target';
      writeFixtureFile(entry, `import ${JSON.stringify(specifier)};\n`);
      const identity = createPortableBuildIdentity({
        overlayRoots: [fixture.overlayRoot],
        publicRoot: fixture.publicRoot
      });
      const externalPlugin: Plugin = {
        name: 'logical-external-fixture',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /external-target$/ }, (args) => ({
            external: true,
            path: args.path
          }));
        }
      };

      try {
        await expect(
          build({
            absWorkingDir: fixture.publicRoot,
            bundle: true,
            entryPoints: [entry],
            logLevel: 'silent',
            plugins: [identity.plugin, externalPlugin],
            write: false
          })
        ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  );

  it('binds exact relative public and absolute public/overlay entries to logical identities', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-exact-entries-'));
    const fixture = createPortableBuildFixture(parent);
    const relativePublic = join(fixture.publicRoot, 'src', 'relativePublicEntry.ts');
    const absolutePublic = join(fixture.publicRoot, 'src', 'absolutePublicEntry.ts');
    const absoluteOverlay = join(fixture.overlayRoot, 'absoluteOverlayEntry.ts');
    writeFixtureFile(relativePublic, "console.log('relative-public-entry');\n");
    writeFixtureFile(absolutePublic, "console.log('absolute-public-entry');\n");
    writeFixtureFile(absoluteOverlay, "console.log('absolute-overlay-entry');\n");
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      const result = await build({
        absWorkingDir: fixture.publicRoot,
        bundle: true,
        entryPoints: {
          'absolute-overlay': absoluteOverlay,
          'absolute-public': absolutePublic,
          'relative-public': 'src/relativePublicEntry.ts'
        },
        logLevel: 'silent',
        metafile: true,
        outdir: fixture.outdir,
        plugins: [identity.plugin],
        write: false
      });
      const moduleIdentities = Object.keys(result.metafile.inputs).sort();

      expect(moduleIdentities).toEqual([
        'p:src/absolutePublicEntry.ts',
        'p:src/relativePublicEntry.ts',
        'portable-overlay-source:overlay-0/absoluteOverlayEntry.ts'
      ]);
      expect(
        moduleIdentities.every(
          (moduleIdentity) =>
            moduleIdentity.startsWith('p:') || moduleIdentity.startsWith('portable-overlay-source:')
        )
      ).toBe(true);
      expect(moduleIdentities.some((moduleIdentity) => moduleIdentity.includes(parent))).toBe(
        false
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each(['public', 'overlay'])(
    'rejects a relative extensionless %s entry instead of resolving its matching TypeScript file',
    async (entryKind: string) => {
      const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-extensionless-entry-'));
      const fixture = createPortableBuildFixture(parent);
      const entryRoot =
        entryKind === 'public' ? join(fixture.publicRoot, 'src') : fixture.overlayRoot;
      const source = join(entryRoot, 'extensionlessEntry.ts');
      const declaredEntry = relative(fixture.publicRoot, source.slice(0, -'.ts'.length));
      writeFixtureFile(source, "console.log('extensionless-entry');\n");
      const identity = createPortableBuildIdentity({
        overlayRoots: [fixture.overlayRoot],
        publicRoot: fixture.publicRoot
      });

      try {
        await expect(
          build({
            absWorkingDir: fixture.publicRoot,
            bundle: true,
            entryPoints: [declaredEntry],
            logLevel: 'silent',
            plugins: [identity.plugin],
            write: false
          })
        ).rejects.toThrow(/PORTABLE_BUILD_SOURCE_MISSING/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  );

  it('rejects a bare installed-package entry instead of falling through to file identity', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-bare-package-entry-'));
    const fixture = createPortableBuildFixture(parent);
    const packageRoot = join(fixture.publicRoot, 'node_modules', 'portable-entry-package');
    writeFixtureFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ exports: './dist/entry.js', name: 'portable-entry-package' })}\n`
    );
    writeFixtureFile(join(packageRoot, 'dist', 'entry.js'), "console.log('package-entry');\n");
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: ['portable-entry-package'],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_SOURCE_MISSING/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a bare tsconfig-alias entry instead of falling through to file identity', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-bare-alias-entry-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(
      join(fixture.publicRoot, 'src', 'aliasEntry.ts'),
      "console.log('tsconfig-alias-entry');\n"
    );
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: ['@portable-entry'],
          logLevel: 'silent',
          plugins: [identity.plugin],
          tsconfigRaw: {
            compilerOptions: {
              baseUrl: '.',
              paths: { '@portable-entry': ['src/aliasEntry.ts'] }
            }
          },
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_SOURCE_MISSING/);
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

  it('rejects a bare public package that resolves through a symlink outside every root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-public-package-'));
    const fixture = createPortableBuildFixture(parent);
    const externalNodeModules = join(parent, 'external-node_modules');
    writeFixtureFile(
      join(externalNodeModules, 'portable-package', 'index.js'),
      "export const packageValue = 'portable-package';\n"
    );
    symlinkSync(externalNodeModules, join(fixture.publicRoot, 'node_modules'), 'dir');
    writeFixtureFile(
      join(fixture.publicRoot, 'src', 'publicPackageEntry.ts'),
      "import { packageValue } from 'portable-package';\nconsole.log(packageValue);\n"
    );
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.publicRoot, 'src', 'publicPackageEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('binds package exports inside publicRoot node_modules with portable identities', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'zendio-portable-local-package-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'zendio-portable-local-package-b-'));

    try {
      const first = await buildLocalPublicPackageFixture(rootA);
      const second = await buildLocalPublicPackageFixture(rootB);
      const packageIdentities = first.moduleIdentities.filter((identity) =>
        identity.includes('node_modules/portable-package/')
      );

      expect(first.outputBytes).toBe(second.outputBytes);
      expect(first.moduleIdentities).toEqual(second.moduleIdentities);
      expect(packageIdentities).toEqual(['p:node_modules/portable-package/dist/exported.js']);
      expect(packageIdentities.every((identity) => identity.startsWith('p:node_modules/'))).toBe(
        true
      );
      expect(first.moduleIdentities.some((identity) => identity.includes(rootA))).toBe(false);
      expect(second.moduleIdentities.some((identity) => identity.includes(rootB))).toBe(false);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it.each(['public', 'overlay'])(
    'rejects a bare tsconfig paths alias from a %s entry that resolves outside every declared root',
    async (entryKind: string) => {
      const parent = mkdtempSync(join(tmpdir(), `zendio-portable-${entryKind}-alias-escape-`));
      const fixture = createPortableBuildFixture(parent);
      const outside = join(parent, 'outside.ts');
      const entryRoot =
        entryKind === 'public' ? join(fixture.publicRoot, 'src') : fixture.overlayRoot;
      const entry = join(entryRoot, 'aliasEscapeEntry.ts');
      writeFixtureFile(outside, 'export const outside = true;\n');
      writeFixtureFile(entry, "import { outside } from '@alias/outside';\nconsole.log(outside);\n");
      const identity = createPortableBuildIdentity({
        overlayRoots: [fixture.overlayRoot],
        publicRoot: fixture.publicRoot
      });

      try {
        await expect(
          build({
            absWorkingDir: fixture.publicRoot,
            bundle: true,
            entryPoints: [entry],
            logLevel: 'silent',
            plugins: [identity.plugin],
            tsconfigRaw: {
              compilerOptions: {
                baseUrl: fixture.publicRoot,
                paths: { '@alias/outside': ['../outside.ts'] }
              }
            },
            write: false
          })
        ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  );

  it('rejects public sources without an explicit or allowlisted loader', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-public-loader-'));
    const fixture = createPortableBuildFixture(parent);
    const unsupported = join(fixture.publicRoot, 'src', 'unsupported.txt');
    writeFixtureFile(unsupported, "console.log('valid-javascript-without-a-loader');\n");
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });

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

  it('honors an explicitly configured loader for public sources', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-configured-public-loader-'));
    const fixture = createPortableBuildFixture(parent);
    const configured = join(fixture.publicRoot, 'src', 'configured.txt');
    writeFixtureFile(configured, "console.log('configured-public-loader');\n");
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });

    try {
      const result = await build({
        absWorkingDir: fixture.publicRoot,
        bundle: true,
        entryPoints: [configured],
        loader: { '.txt': 'js' },
        logLevel: 'silent',
        plugins: [identity.plugin],
        write: false
      });
      expect(result.outputFiles[0].text).toContain('configured-public-loader');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps public and overlay sources with the same logical path distinct by namespace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-composite-key-'));
    const fixture = createPortableBuildFixture(parent);
    const publicSource = join(fixture.publicRoot, 'overlay-0', 'same.ts');
    writeFixtureFile(publicSource, "export const publicSame = 'public-same';\n");
    writeFixtureFile(
      join(fixture.overlayRoot, 'same.ts'),
      "export const overlaySame = 'overlay-same';\n"
    );
    writeFixtureFile(
      join(fixture.overlayRoot, 'compositeEntry.ts'),
      `import { publicSame } from ${JSON.stringify(publicSource)};\nimport { overlaySame } from './same';\nconsole.log(publicSame, overlaySame);\n`
    );
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      const result = await build({
        absWorkingDir: fixture.publicRoot,
        bundle: true,
        entryPoints: [join(fixture.overlayRoot, 'compositeEntry.ts')],
        logLevel: 'silent',
        metafile: true,
        plugins: [identity.plugin],
        write: false
      });
      expect(Object.keys(result.metafile.inputs).sort()).toEqual(
        expect.arrayContaining(['p:overlay-0/same.ts', 'portable-overlay-source:overlay-0/same.ts'])
      );
      expect(result.outputFiles[0].text).toContain('public-same');
      expect(result.outputFiles[0].text).toContain('overlay-same');
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

  it('rejects forged identities from an untrusted bare custom namespace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-bare-custom-namespace-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(join(fixture.overlayRoot, 'bareCustomEntry.ts'), "import 'virtual-bare';\n");
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });
    const customNamespacePlugin: Plugin = {
      name: 'untrusted-bare-custom-namespace-fixture',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^virtual-bare$/ }, () => ({
          namespace: 'untrusted-fixture',
          path: 'virtual-bare',
          pluginData: {
            portableBuildIdentity: { kind: 'overlay', rootIndex: 0 }
          }
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: 'untrusted-fixture' }, () => ({
          contents: 'export const bareCustom = true;',
          loader: 'js'
        }));
      }
    };

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'bareCustomEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin, customNamespacePlugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_ROOT_ESCAPE/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects an untrusted resolver that relays importer pluginData', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-plugin-data-relay-'));
    const fixture = createPortableBuildFixture(parent);
    writeFixtureFile(join(fixture.overlayRoot, 'relayEntry.ts'), "import 'virtual-relay';\n");
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot],
      publicRoot: fixture.publicRoot
    });
    const relayPlugin: Plugin = {
      name: 'untrusted-plugin-data-relay-fixture',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^virtual-relay$/ }, (args) => {
          const relayedPluginData: unknown = args.pluginData;
          return {
            namespace: 'untrusted-relay-fixture',
            path: 'virtual-relay',
            pluginData: relayedPluginData
          };
        });
        pluginBuild.onLoad({ filter: /.*/, namespace: 'untrusted-relay-fixture' }, () => ({
          contents: 'export const relayed = true;',
          loader: 'js'
        }));
      }
    };

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'relayEntry.ts')],
          logLevel: 'silent',
          plugins: [identity.plugin, relayPlugin],
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

  it('rejects absolute inline CSS imports that cross declared overlay roots', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-absolute-css-escape-'));
    const fixture = createPortableBuildFixture(parent);
    const secondOverlayRoot = join(parent, 'second-private-overlay');
    const secondOverlayCss = join(secondOverlayRoot, 'second.css');
    writeFixtureFile(secondOverlayCss, '.second { display: block; }\n');
    writeFixtureFile(
      join(fixture.overlayRoot, 'absoluteCssEscapeEntry.ts'),
      `import styles from ${JSON.stringify(`${secondOverlayCss}?inline`)};\nconsole.log(styles);\n`
    );
    const identity = createPortableBuildIdentity({
      overlayRoots: [fixture.overlayRoot, secondOverlayRoot],
      publicRoot: fixture.publicRoot
    });

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [join(fixture.overlayRoot, 'absoluteCssEscapeEntry.ts')],
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

  it('reports a changed shared source binding as a logical source binding', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'zendio-portable-binding-drift-'));
    const fixture = createPortableBuildFixture(parent);
    const entry = join(fixture.publicRoot, 'src', 'bindingDrift.ts');
    const replacement = join(fixture.publicRoot, 'src', 'bindingReplacement.ts');
    writeFixtureFile(entry, "console.log('original-binding');\n");
    writeFixtureFile(replacement, "console.log('replacement-binding');\n");
    const identity = createPortableBuildIdentity({ publicRoot: fixture.publicRoot });
    const bindingMutatorPlugin: Plugin = {
      name: 'portable-binding-drift-fixture',
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /^src\/bindingDrift\.ts$/, namespace: 'p' }, () => {
          rmSync(entry);
          symlinkSync(replacement, entry);
          return undefined;
        });
      }
    };

    try {
      await expect(
        build({
          absWorkingDir: fixture.publicRoot,
          bundle: true,
          entryPoints: [entry],
          logLevel: 'silent',
          plugins: [bindingMutatorPlugin, identity.plugin],
          write: false
        })
      ).rejects.toThrow(/PORTABLE_BUILD_IDENTITY_COLLISION.*logical source binding changed/);
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
