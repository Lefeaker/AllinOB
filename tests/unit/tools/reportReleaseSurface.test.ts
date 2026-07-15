import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  entries: Record<string, string>,
  compressionMethod = 0
): string {
  const archivePath = join(root, relativePath);
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const [entry, contents] of Object.entries(entries)) {
    const payload = Buffer.from(contents);
    const localEntry = createLocalFileEntry(entry, payload, compressionMethod);
    localEntries.push(localEntry);
    centralEntries.push(
      createCentralDirectoryEntry(entry, payload.length, offset, compressionMethod)
    );
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

function createLocalFileEntry(entry: string, payload: Buffer, compressionMethod = 0): Buffer {
  const name = Buffer.from(entry);
  const buffer = Buffer.alloc(30 + name.length + payload.length);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(compressionMethod, 8);
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
  localHeaderOffset: number,
  compressionMethod = 0
): Buffer {
  const name = Buffer.from(entry);
  const buffer = Buffer.alloc(46 + name.length);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(compressionMethod, 10);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(name.length, 28);
  buffer.writeUInt32LE(localHeaderOffset, 42);
  name.copy(buffer, 46);
  return buffer;
}

function runReport(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

function readJsonReport(root: string): string {
  return readFileSync(join(root, 'build/reports/release-surface.json'), 'utf8');
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

  it('reports macOS, Linux, and Windows machine-local paths in dist text content', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/shared.js',
      [
        'const mac = "/Users/alice/work/zendio";',
        'const linux = "/home/alice/work/zendio";',
        'const windowsBackslash = "C:\\\\Users\\\\alice\\\\work\\\\zendio";',
        'const windowsSlash = "D:/Users/alice/work/zendio";'
      ].join('\n')
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Forbidden Machine-Local Content');
      expect(result.stdout + result.stderr).toContain(
        'forbidden machine-local content in build/dist'
      );
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/shared.js', pattern: 'macos-user-home' },
          { path: 'chunks/shared.js', pattern: 'linux-user-home' },
          { path: 'chunks/shared.js', pattern: 'windows-user-home-backslash' },
          { path: 'chunks/shared.js', pattern: 'windows-user-home-slash' }
        ]
      });
      expect(report).toContain('forbidden machine-local content in build/dist');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('does not treat web URLs or ordinary relative references as machine-local paths', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/shared.js',
      [
        'const macDocs = "https://docs.example.com/Users/alice/setup";',
        'const linuxDocs = "https://docs.example.com/home/alice/setup";',
        'const windowsDocs = "https://docs.example.com/C:/Users/alice/setup";',
        'const escapedWeb = "https:\\/\\/docs.example.com\\/guide?home=\\/Users\\/alice";',
        'const escapedHttpsQuery = "https:\\/\\/docs.example.com?q=/Users/alice";',
        'const escapedWssQuery = "wss:\\/\\/socket.example.com?q=/home/alice";',
        'const unicodeHttps = "\\u0068\\u0074\\u0074\\u0070\\u0073:\\/\\/docs.example.com?q=\\/Users\\/alice";',
        'const hexWss = "\\x77\\x73\\x73:\\/\\/socket.example.com?q=\\/home\\/alice";',
        'const percentMacDocs = "https://docs.example.com/%55sers/alice/setup";',
        'const percentLinuxDocs = "https://docs.example.com/home%2Falice/setup";',
        'const percentWss = "wss://socket.example.com?q=%2Fhome%2Falice";',
        'const percentHttps = "%68%74%74%70%73%3A%2F%2Fdocs.example.com%2FUsers%2Falice";',
        'const escapedPercentHttps = "https:\\/\\/docs.example.com\\/%55sers%2Falice";',
        'const percentSpaceHttps = "https://docs.example.com/a%20/Users/alice";',
        'const percentQuoteHttps = "https://docs.example.com/%22/Users/alice";',
        'const percentAngleHttps = "https://docs.example.com/%3C/Users/alice";',
        'const percentSpaceWss = "wss://socket.example.com/a%20/home/alice";',
        'const macRelative = "archive/Users/alice/preview.css";',
        'const linuxRelative = "archive/home/alice/preview.css";',
        'const windowsRelative = "archive/C:/Users/alice/preview.css";',
        'const escapedRelative = "archive\\/Users\\/alice\\/preview.css";',
        '//# sourceMappingURL=shared.js.map'
      ].join('\n')
    );

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain('Forbidden Machine-Local Content');
      expect(result.stdout + result.stderr).toContain('- build/dist: none');
      expect(result.stdout + result.stderr).not.toContain('forbidden machine-local content');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports machine-local macOS and Linux file URIs', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/shared.js',
      [
        'const macSource = "file:///Users/alice/work/zendio/source.ts";',
        'const linuxSource = "file:///home/alice/work/zendio/source.ts";'
      ].join('\n')
    );

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('macos-user-home');
      expect(result.stdout + result.stderr).toContain('linux-user-home');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports machine-local Windows file URIs', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/shared.js',
      'const windowsSource = "file:///C:/Users/alice/work/zendio/source.ts";'
    );

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('windows-user-home-slash');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports escaped-solidus machine-local paths in raw JSON and JavaScript', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'config/settings.json', '{"source":"\\/Users\\/alice\\/work\\/zendio"}');
    writeFile(dist, 'chunks/escaped.js', 'const source = "\\/Users\\/alice\\/work\\/zendio";');

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/escaped.js', pattern: 'macos-user-home' },
          { path: 'config/settings.json', pattern: 'macos-user-home' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports Unicode-escaped POSIX and Windows machine-local paths in raw JSON', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'config/unicode-posix.json',
      '{"source":"\\u002fUsers\\u002falice\\u002fwork"}'
    );
    writeFile(
      dist,
      'config/unicode-windows.json',
      '{"source":"C:\\u005cUsers\\u005calice\\u005cwork"}'
    );
    writeFile(
      dist,
      'config/unicode-segment.json',
      '{"source":"\\u002f\\u0055sers\\u002falice\\u002fwork"}'
    );
    writeFile(
      dist,
      'config/unicode-windows-segment.json',
      '{"source":"C:\\u005c\\u0055sers\\u005calice\\u005cwork"}'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'config/unicode-posix.json', pattern: 'macos-user-home' },
          { path: 'config/unicode-segment.json', pattern: 'macos-user-home' },
          { path: 'config/unicode-windows-segment.json', pattern: 'windows-user-home-backslash' },
          { path: 'config/unicode-windows.json', pattern: 'windows-user-home-backslash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports ASCII hex and code-point escaped machine-local paths in script and style text', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'chunks/hex-posix.js', 'const source = "\\x2f\\x55sers\\x2falice\\x2fwork";');
    writeFile(
      dist,
      'chunks/hex-windows.js',
      'const source = "\\x43\\x3a\\x5c\\x55sers\\x5calice\\x5cwork";'
    );
    writeFile(
      dist,
      'styles/code-point.css',
      '/* source: \\u{2f}\\u{55}sers\\u{2f}alice\\u{2f}work */'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/hex-posix.js', pattern: 'macos-user-home' },
          { path: 'chunks/hex-windows.js', pattern: 'windows-user-home-backslash' },
          { path: 'styles/code-point.css', pattern: 'macos-user-home' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports localhost and single-slash POSIX file URI variants without duplicates', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/file-uri-localhost.js',
      [
        'const mac = "file://localhost/Users/alice/work/zendio";',
        'const linux = "file://localhost/home/alice/work/zendio";'
      ].join('\n')
    );
    writeFile(
      dist,
      'chunks/file-uri-single-slash.js',
      [
        'const mac = "file:/Users/alice/work/zendio";',
        'const linux = "file:/home/alice/work/zendio";'
      ].join('\n')
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/file-uri-localhost.js', pattern: 'macos-user-home' },
          { path: 'chunks/file-uri-localhost.js', pattern: 'linux-user-home' },
          { path: 'chunks/file-uri-single-slash.js', pattern: 'macos-user-home' },
          { path: 'chunks/file-uri-single-slash.js', pattern: 'linux-user-home' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports localhost and single-slash Windows file URI variants', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/file-uri-win-localhost.js',
      'const source = "file://localhost/C:/Users/alice/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/file-uri-win-single-slash.js',
      'const source = "file:/C:/Users/alice/work/zendio";'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/file-uri-win-localhost.js', pattern: 'windows-user-home-slash' },
          { path: 'chunks/file-uri-win-single-slash.js', pattern: 'windows-user-home-slash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports arbitrary file authorities and percent-encoded local path segments', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/file-authority-linux.js',
      'const source = "file://runner.internal/home/alice/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/file-authority-mac.js',
      'const source = "file://build-mac.local/Users/alice/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/file-percent-separator.js',
      'const source = "file:///Users%2Falice/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/file-percent-user.js',
      'const source = "file:///%55sers/alice/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/file-percent-windows.js',
      'const source = "file:///C:/Users%2Falice/work/zendio";'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/file-authority-linux.js', pattern: 'linux-user-home' },
          { path: 'chunks/file-authority-mac.js', pattern: 'macos-user-home' },
          { path: 'chunks/file-percent-separator.js', pattern: 'macos-user-home' },
          { path: 'chunks/file-percent-user.js', pattern: 'macos-user-home' },
          { path: 'chunks/file-percent-windows.js', pattern: 'windows-user-home-slash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('preserves machine-local content before an encoded Web URL span', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/prefix-mac.js',
      'const source = "/Users/alice%20https%3A%2F%2Fdocs.example.com";'
    );
    writeFile(
      dist,
      'chunks/prefix-linux.js',
      'const source = "/home/alice-%68%74%74%70%73%3A%2F%2Fdocs.example.com";'
    );
    writeFile(
      dist,
      'chunks/prefix-windows.js',
      'const source = "C:%2FUsers%2Falice%2Fhttps%3A%2F%2Fdocs.example.com";'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/prefix-linux.js', pattern: 'linux-user-home' },
          { path: 'chunks/prefix-mac.js', pattern: 'macos-user-home' },
          { path: 'chunks/prefix-windows.js', pattern: 'windows-user-home-slash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports case-insensitive and mixed-separator Windows user paths', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'chunks/windows-lower.js', 'const source = "C:\\\\users\\\\alice\\\\work";');
    writeFile(dist, 'chunks/windows-mixed.js', 'const source = "C:\\\\Users/alice/work";');

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/windows-lower.js', pattern: 'windows-user-home-backslash' },
          { path: 'chunks/windows-mixed.js', pattern: 'windows-user-home-backslash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports machine-local paths in YAML and YML text content', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'config/source.yaml', 'source: /Users/alice/work/zendio');
    writeFile(dist, 'config/source.yml', 'source: /home/alice/work/zendio');

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'config/source.yaml', pattern: 'macos-user-home' },
          { path: 'config/source.yml', pattern: 'linux-user-home' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports direct and file URI variants of the CI root home', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(dist, 'chunks/root-direct.js', 'const source = "/root/work/zendio";');
    writeFile(dist, 'chunks/root-file-uri.js', 'const source = "file:///root/work/zendio";');
    writeFile(
      dist,
      'chunks/root-file-uri-localhost.js',
      'const source = "file://localhost/root/work/zendio";'
    );
    writeFile(
      dist,
      'chunks/root-file-uri-single-slash.js',
      'const source = "file:/root/work/zendio";'
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/root-direct.js', pattern: 'linux-root-home' },
          { path: 'chunks/root-file-uri-localhost.js', pattern: 'linux-root-home' },
          { path: 'chunks/root-file-uri-single-slash.js', pattern: 'linux-root-home' },
          { path: 'chunks/root-file-uri.js', pattern: 'linux-root-home' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports webpack and Vite source-map machine-local source paths', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/runtime.js.map',
      JSON.stringify({
        sources: [
          'webpack:///Users/alice/work/zendio/source.ts',
          'vite:///home/alice/work/zendio/source.ts',
          'webpack:///C:/Users/alice/work/zendio/source.ts'
        ]
      })
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(JSON.parse(report)).toMatchObject({
        forbiddenMachineLocalDistContent: [
          { path: 'chunks/runtime.js.map', pattern: 'macos-user-home' },
          { path: 'chunks/runtime.js.map', pattern: 'linux-user-home' },
          { path: 'chunks/runtime.js.map', pattern: 'windows-user-home-slash' }
        ]
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('reports inline base64 source maps as forbidden release content', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'chunks/inline-map.js',
      'const value = 1;\n//# sourceMappingURL=data:application/json;base64,e30='
    );

    try {
      const result = runReport(['--dist', dist, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Forbidden Inline Source Maps');
      expect(JSON.parse(report)).toMatchObject({
        forbiddenInlineSourceMapDistContent: [
          { path: 'chunks/inline-map.js', pattern: 'inline-source-map-data-url' }
        ]
      });
      expect(report).toContain('forbidden inline source map in build/dist');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('does not reject inline source-map examples in documentation text files', () => {
    const dist = createDist({ manifest: baseManifest() });
    writeFile(
      dist,
      'docs/source-maps.md',
      'Forbidden example: //# sourceMappingURL=data:application/json;base64,e30='
    );
    writeFile(
      dist,
      'docs/source-maps.txt',
      'Do not emit sourceMappingURL=data:application/json;base64,e30='
    );

    try {
      const result = runReport(['--dist', dist]);

      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain('Forbidden Inline Source Maps');
      expect(result.stdout + result.stderr).not.toContain('inline-source-map-data-url');
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

  it('reports machine-local paths in archive text content and JSON', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchiveWithContents(dist, 'fixture.zip', {
      'styles/preview.css': [
        '/* /Users/alice/work/zendio */',
        '/* /home/alice/work/zendio */',
        '/* C:\\\\Users\\\\alice\\\\work\\\\zendio */',
        '/* E:/Users/alice/work/zendio */'
      ].join('\n')
    });

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath, '--json'], dist);
      const report = readJsonReport(dist);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Forbidden Machine-Local Content');
      expect(result.stdout + result.stderr).toContain('forbidden machine-local content in archive');
      expect(JSON.parse(report)).toMatchObject({
        archives: [
          {
            forbiddenMachineLocalContent: [
              { path: 'styles/preview.css', pattern: 'macos-user-home' },
              { path: 'styles/preview.css', pattern: 'linux-user-home' },
              { path: 'styles/preview.css', pattern: 'windows-user-home-backslash' },
              { path: 'styles/preview.css', pattern: 'windows-user-home-slash' }
            ]
          }
        ]
      });
      expect(report).toContain('forbidden machine-local content in archive');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('fails closed when a scanned archive text member uses an unsupported compression method', () => {
    const dist = createDist({ manifest: baseManifest() });
    const archivePath = writeZipArchiveWithContents(
      dist,
      'unsupported-compression.zip',
      {
        'config/settings.json': '{"source":"/Users/alice/work/zendio"}'
      },
      12
    );

    try {
      const result = runReport(['--dist', dist, '--archive', archivePath]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'Unsupported ZIP compression method 12 for config/settings.json'
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
