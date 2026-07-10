import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = resolve('tools/report-release-surface.mjs');

interface FixtureOptions {
  manifest: Record<string, unknown>;
  files?: string[];
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0.0',
    default_locale: 'en',
    action: {
      default_title: 'Fixture',
      default_icon: {
        16: 'icons/icon-16.png'
      }
    },
    icons: {
      16: 'icons/icon-16.png'
    },
    background: {
      service_worker: 'background/index.js'
    },
    options_ui: {
      page: 'options/index.html'
    },
    web_accessible_resources: [
      {
        resources: ['chunks/*'],
        matches: ['<all_urls>']
      }
    ],
    ...overrides
  };
}

function createDist({ manifest, files = [] }: FixtureOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiiinob-release-surface-'));
  writeFile(dir, 'manifest.json', JSON.stringify(manifest));

  for (const file of [
    '_locales/en/messages.json',
    'background/index.js',
    'chunks/shared.js',
    'icons/icon-16.png',
    'options/index.html',
    ...files
  ]) {
    writeFile(dir, file, '');
  }

  return dir;
}

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function writeZipArchive(root: string, relativePath: string, entries: string[]): string {
  return writeZipArchiveWithContents(
    root,
    relativePath,
    Object.fromEntries(entries.map((entry) => [entry, '']))
  );
}

function writeZipArchiveWithContents(
  root: string,
  relativePath: string,
  entries: Record<string, string>
): string {
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
  writeFileSync(archivePath, Buffer.concat([...localEntries, centralDirectory, end]));
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

function runReport(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8'
  });
}

describe('report-release-surface', () => {
  it('fails when an action default popup target is missing', () => {
    const dist = createDist({
      manifest: baseManifest({
        action: {
          default_title: 'Fixture',
          default_icon: {
            16: 'icons/icon-16.png'
          },
          default_popup: 'popup.html'
        }
      })
    });

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('action.default_popup');
      expect(result.stdout + result.stderr).toContain('popup.html');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when production dist contains forbidden harness HTML', () => {
    const dist = createDist({
      manifest: baseManifest(),
      files: ['interaction-contract-harness.html']
    });

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('interaction-contract-harness.html');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when production dist contains forbidden harness JavaScript', () => {
    const dist = createDist({
      manifest: baseManifest(),
      files: ['runtime-observability-harness.js']
    });

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('runtime-observability-harness.js');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when production dist contains dev-only pseudo-locale artifacts', () => {
    const dist = createDist({
      manifest: baseManifest(),
      files: ['_locales/qps-ploc/messages.json', 'chunks/qps-ploc-fixture.js']
    });

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('_locales/qps-ploc/messages.json');
      expect(result.stdout + result.stderr).toContain('chunks/qps-ploc-fixture.js');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when production JavaScript contains dev-only pseudo-locale content', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'chunks/shared.js', 'const locale = "qps-ploc"; const marker = "Çòːñƒ";');

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('chunks/shared.js');
      expect(result.stdout + result.stderr).toContain('qps-ploc');
      expect(result.stdout + result.stderr).toContain('Çòːñƒ');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('passes clean Chrome and Firefox fixture manifests', () => {
    const firefoxManifest = baseManifest({
      content_scripts: [
        {
          matches: ['<all_urls>'],
          js: ['content/index.js'],
          css: ['content/content.css']
        }
      ]
    });
    const chromeDist = createDist({ manifest: baseManifest() });
    const firefoxDist = createDist({
      manifest: firefoxManifest,
      files: ['content/index.js', 'content/content.css']
    });

    try {
      expect(runReport(['--dist', chromeDist]).status).toBe(0);
      expect(runReport(['--dist', firefoxDist]).status).toBe(0);
    } finally {
      rmSync(chromeDist, { recursive: true, force: true });
      rmSync(firefoxDist, { recursive: true, force: true });
    }
  });

  it('does not scan non-text dist assets as secret content', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'icons/icon-16.png', '-----BEGIN PRIVATE KEY-----');

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('private-key');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when an archive contains a forbidden harness member even if dist is clean', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchive(dist, 'fixture.zip', ['content-orchestrator-harness.html']);

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('content-orchestrator-harness.html');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when an archive contains a dev-only pseudo-locale member', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchive(dist, 'fixture.zip', [
      '_locales/qps-ploc/messages.json',
      'chunks/qps-ploc-fixture.js'
    ]);

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('_locales/qps-ploc/messages.json');
      expect(result.stdout + result.stderr).toContain('chunks/qps-ploc-fixture.js');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('does not scan non-text archive assets as secret content', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchiveWithContents(dist, 'fixture.zip', {
      'icons/icon-16.png': '-----BEGIN PRIVATE KEY-----'
    });

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath]);

      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('private-key');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails when an archive contains dev-only pseudo-locale content', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchiveWithContents(dist, 'fixture.zip', {
      'chunks/shared.js': 'const locale = "qps-ploc"; const marker = "Çòːñƒ";'
    });

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('chunks/shared.js');
      expect(result.stdout + result.stderr).toContain('qps-ploc');
      expect(result.stdout + result.stderr).toContain('Çòːñƒ');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
