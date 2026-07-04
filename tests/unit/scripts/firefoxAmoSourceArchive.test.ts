import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditFirefoxAmoSourceArchive,
  createFirefoxAmoSourceArchive,
  readFirefoxAmoSourceArchiveEntries
} from '../../../scripts/utils/firefoxAmoSourceArchive.mjs';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiiinob-firefox-amo-source-test-'));
  tempRoots.push(root);
  return root;
}

async function writeFixtureFile(root: string, relativePath: string, contents = ''): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function writeZipArchive(
  root: string,
  relativePath: string,
  entries: Record<string, string>
): Promise<string> {
  const archivePath = join(root, relativePath);
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const [entry, contents] of Object.entries(entries)) {
    const payload = Buffer.from(contents);
    const localEntry = createLocalFileEntry(entry, payload);
    localEntries.push(localEntry);
    centralEntries.push(createCentralDirectoryEntry(entry, payload.length, offset));
    offset += localEntry.length;
  }

  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(archivePath, Buffer.concat([...localEntries, centralDirectory, end]));
  return archivePath;
}

function createLocalFileEntry(entry: string, payload: Buffer): Buffer {
  const name = Buffer.from(entry);
  const buffer = Buffer.alloc(30 + name.length + payload.length);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt32LE(payload.length, 18);
  buffer.writeUInt32LE(payload.length, 22);
  buffer.writeUInt16LE(name.length, 26);
  name.copy(buffer, 30);
  payload.copy(buffer, 30 + name.length);
  return buffer;
}

function createCentralDirectoryEntry(
  entry: string,
  size: number,
  localHeaderOffset: number
): Buffer {
  const name = Buffer.from(entry);
  const buffer = Buffer.alloc(46 + name.length);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(name.length, 28);
  buffer.writeUInt32LE(localHeaderOffset, 42);
  name.copy(buffer, 46);
  return buffer;
}

async function createSourceFixture(root: string): Promise<void> {
  await writeFixtureFile(root, '.nvmrc', '20.20.2\n');
  await writeFixtureFile(
    root,
    'package.json',
    JSON.stringify({
      name: 'zendio-fixture',
      version: '0.2.1',
      scripts: {
        'analytics:validate:prod:required':
          'node scripts/setup-error-analytics.js --require-env --require-zendio-env --require-proxy-transport'
      }
    })
  );
  await writeFixtureFile(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  await writeFixtureFile(root, 'LICENSE', 'license\n');
  await writeFixtureFile(root, 'THIRD_PARTY_NOTICES.md', 'notices\n');
  await writeFixtureFile(root, 'tsconfig.json', '{}\n');
  await writeFixtureFile(root, 'src/background/index.ts', 'console.info("source");\n');
  await writeFixtureFile(root, 'src/styles/design-tokens.css', ':root { --z: 1; }\n');
  await writeFixtureFile(root, 'public/manifest.firefox.json', '{"manifest_version":3}\n');
  await writeFixtureFile(root, 'scripts/build.mjs', 'console.info("build");\n');
  await writeFixtureFile(root, 'scripts/package-firefox.mjs', 'console.info("package");\n');
  await writeFixtureFile(
    root,
    'scripts/setup-error-analytics.js',
    'console.info("analytics validator");\n'
  );
  await writeFixtureFile(root, 'scripts/utils/archive.mjs', 'export const archive = true;\n');
  await writeFixtureFile(root, 'tools/audit-release-archive.mjs', 'console.info("audit");\n');
  await writeFixtureFile(root, 'tools/report-release-surface.mjs', 'console.info("surface");\n');

  await writeFixtureFile(root, '.env.production.local', 'WEB_EXT_API_SECRET=secret\n');
  await writeFixtureFile(root, 'build/dist/content/runtime.js', 'generated\n');
  await writeFixtureFile(root, 'node_modules/web-ext/index.js', 'dependency\n');
  await writeFixtureFile(root, '.worktrees/stale/file.txt', 'worktree\n');
  await writeFixtureFile(root, 'Zendio-All in Obsidian-v0.2.1.xpi', 'package\n');
  await writeFixtureFile(root, 'src/.DS_Store', 'finder metadata\n');
}

describe('Firefox AMO source archive', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('creates a reviewer source archive from a repository whitelist and excludes local secrets', async () => {
    const root = await createTempRoot();
    await createSourceFixture(root);

    const result = await createFirefoxAmoSourceArchive(
      {
        repoRoot: root,
        outputDir: join(root, 'build', 'firefox-source'),
        artifactBaseName: 'Zendio-All in Obsidian-v0.2.1',
        releaseXpiName: 'Zendio-All in Obsidian-v0.2.1.xpi',
        version: '0.2.1'
      },
      { logger: { log: vi.fn(), warn: vi.fn() } }
    );

    expect(result.archivePath).toBe(
      join(root, 'build', 'firefox-source', 'Zendio-All in Obsidian-v0.2.1-source.zip')
    );

    const entries = await readFirefoxAmoSourceArchiveEntries(result.archivePath);
    const entryPaths = entries.map((entry) => entry.path).sort();

    expect(entryPaths).toContain('AMO_SOURCE_REVIEW.md');
    expect(entryPaths).toContain('.nvmrc');
    expect(entryPaths).toContain('package.json');
    expect(entryPaths).toContain('package-lock.json');
    expect(entryPaths).toContain('src/background/index.ts');
    expect(entryPaths).toContain('public/manifest.firefox.json');
    expect(entryPaths).toContain('scripts/build.mjs');
    expect(entryPaths).toContain('scripts/package-firefox.mjs');
    expect(entryPaths).toContain('tools/audit-release-archive.mjs');
    expect(entryPaths).not.toContain('.env.production.local');
    expect(entryPaths).not.toContain('build/dist/content/runtime.js');
    expect(entryPaths).not.toContain('node_modules/web-ext/index.js');
    expect(entryPaths).not.toContain('.worktrees/stale/file.txt');
    expect(entryPaths).not.toContain('Zendio-All in Obsidian-v0.2.1.xpi');
    expect(entryPaths).not.toContain('src/.DS_Store');

    const readme = entries.find((entry) => entry.path === 'AMO_SOURCE_REVIEW.md')?.content;
    expect(readme).toContain('Zendio-All in Obsidian-v0.2.1.xpi');
    expect(readme).toContain('ZENDIO_GA_MEASUREMENT_ID');
    expect(readme).toContain('ZENDIO_GA_TRANSPORT_MODE=proxy');
    expect(readme).toContain('node scripts/build.mjs --mode=prod --skip-checks --firefox');
    expect(readme).toContain('node scripts/package-firefox.mjs --dist-dir build/dist');

    await expect(auditFirefoxAmoSourceArchive(result.archivePath)).resolves.toMatchObject({
      ok: true
    });
  });

  it('rejects source archives that contain generated packages, secret files, or miss build inputs', async () => {
    const root = await createTempRoot();
    const archivePath = await writeZipArchive(root, 'bad-source.zip', {
      'AMO_SOURCE_REVIEW.md': 'incomplete instructions\n',
      'package.json': '{}\n',
      '.env.production.local': 'WEB_EXT_API_SECRET=secret\n',
      'build/dist/content/runtime.js': 'generated\n',
      'node_modules/web-ext/index.js': 'dependency\n',
      'Zendio-All in Obsidian-v0.2.1.xpi': 'package\n'
    });

    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /forbidden archive entry: \.env\.production\.local/
    );
    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /forbidden archive entry: build\/dist\/content\/runtime\.js/
    );
    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /forbidden archive entry: node_modules\/web-ext\/index\.js/
    );
    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /forbidden archive entry: Zendio-All in Obsidian-v0\.2\.1\.xpi/
    );
    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /missing required source entry: scripts\/build\.mjs/
    );
    await expect(auditFirefoxAmoSourceArchive(archivePath)).rejects.toThrow(
      /AMO_SOURCE_REVIEW\.md is missing: ZENDIO_GA_MEASUREMENT_ID/
    );
  });
});
