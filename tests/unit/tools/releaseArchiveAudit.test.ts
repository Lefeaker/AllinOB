import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = resolve('tools/audit-release-archive.mjs');

function writeZipArchive(
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

function baseArchiveEntries(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Fixture',
      version: '1.0.0',
      default_locale: 'en',
      action: {
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
      }
    }),
    '_locales/en/messages.json': '{}',
    'background/index.js': '',
    'icons/icon-16.png': '',
    'options/index.html': '',
    ...extra
  };
}

function runAudit(archivePath: string) {
  return spawnSync(process.execPath, [scriptPath, '--archive', archivePath], {
    encoding: 'utf8'
  });
}

describe('release archive audit', () => {
  it('can be imported when process.argv[1] is undefined', async () => {
    const originalArgv = [...process.argv];
    process.argv.splice(1);

    try {
      await expect(
        import(`${pathToFileURL(scriptPath).href}?argv-undefined=${Date.now()}`)
      ).resolves.toHaveProperty('auditReleaseArchive');
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
    }
  });

  it('passes a clean packaged archive after extracting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiiinob-release-archive-test-'));
    const archive = writeZipArchive(dir, 'clean.zip', baseArchiveEntries());

    try {
      const result = runAudit(archive);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Audited extracted archive');
      expect(result.stdout).toContain('Forbidden Dev/Test Pseudo-Locale Members');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the packaged archive contains qps-ploc members or chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiiinob-release-archive-test-'));
    const archive = writeZipArchive(
      dir,
      'dirty.xpi',
      baseArchiveEntries({
        '_locales/qps-ploc/messages.json': '{}',
        'chunks/qps-ploc-fixture.js': ''
      })
    );

    try {
      const result = runAudit(archive);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('_locales/qps-ploc/messages.json');
      expect(result.stdout + result.stderr).toContain('chunks/qps-ploc-fixture.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the packaged archive contains secret-like files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiiinob-release-archive-test-'));
    const archive = writeZipArchive(
      dir,
      'secret.zip',
      baseArchiveEntries({
        '.env.production.local': 'TOKEN=secret',
        'overlay-assets/signing-key.pem': '-----BEGIN PRIVATE KEY-----'
      })
    );

    try {
      const result = runAudit(archive);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('.env.production.local');
      expect(result.stdout + result.stderr).toContain('signing-key.pem');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
