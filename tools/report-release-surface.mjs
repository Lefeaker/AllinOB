import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const REPORT_PATH = 'build/reports/release-surface.json';
const DEFAULT_DIST_DIR = 'build/dist';
const FORBIDDEN_HARNESS_BASENAMES = [
  'interaction-contract-harness',
  'content-orchestrator-harness',
  'runtime-observability-harness',
  'local-vault-write-harness'
];
const FORBIDDEN_HARNESS_RE = new RegExp(
  `(^|/)(${FORBIDDEN_HARNESS_BASENAMES.join('|')})\\.(html|js)$`
);
const FORBIDDEN_PSEUDO_LOCALE_RE = new RegExp(
  '(^|/)(?:_locales/qps-ploc/messages\\.json|chunks/qps-ploc-[^/]+\\.js)$'
);
const FORBIDDEN_PSEUDO_LOCALE_CONTENT_PATTERNS = [
  { name: 'qps-ploc', pattern: /qps-ploc/ },
  { name: 'Çòːñƒ', pattern: /Çòːñƒ/ }
];
const FORBIDDEN_SECRET_FILE_RE =
  /(^|\/)(?:\.env(?:$|[./].*)|.*(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|secret|token|credential|signing-key).*\.(?:json|txt|pem|key)|.*\.(?:pem|key|p12|pfx|crt|cer|der))$/i;
const FORBIDDEN_SECRET_CONTENT_PATTERNS = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'ga-api-secret',
    pattern: /\b(?:GA4_API_SECRET|ZENDIO_GA_API_SECRET|AIIINOB_GA_API_SECRET|api_secret)\b/
  }
];
const FORBIDDEN_MACHINE_LOCAL_CONTENT_PATTERNS = [
  {
    name: 'macos-user-home',
    pattern: /(?:^|[^A-Za-z0-9_./\\:-])\/Users\/[^/\\\s"'`<>]+(?:\/[^\s"'`<>]*)?/m
  },
  {
    name: 'linux-user-home',
    pattern: /(?:^|[^A-Za-z0-9_./\\:-])\/home\/[^/\\\s"'`<>]+(?:\/[^\s"'`<>]*)?/m
  },
  {
    name: 'linux-root-home',
    pattern: /(?:^|[^A-Za-z0-9_./\\:-])\/root\/[^/\\\s"'`<>]+(?:\/[^\s"'`<>]*)?/m
  },
  {
    name: 'windows-user-home-backslash',
    pattern: /(?:^|[^A-Za-z0-9_./\\-])[A-Za-z]:\\+Users[\\/]+[^/\\\s"'`<>]+(?:[\\/]+[^\s"'`<>]*)?/im
  },
  {
    name: 'windows-user-home-slash',
    pattern: /(?:^|[^A-Za-z0-9_./\\-])[A-Za-z]:\/+Users[\\/]+[^/\\\s"'`<>]+(?:[\\/]+[^\s"'`<>]*)?/im
  }
];
const SCANNED_CONTENT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json']);
const MACHINE_LOCAL_TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.svg',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
]);
const JSON_MACHINE_LOCAL_EXTENSIONS = new Set(['.json', '.map']);
const INLINE_SOURCE_MAP_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.mjs']);
const WEB_URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>]+/giu;
const WINDOWS_LOCAL_SCHEME_PREFIX_RE =
  /\b(?:file:(?:\/\/[^/\\\s"'`<>]+)?|(?:webpack|vite):)\/+(?=[A-Za-z]:[\\/]+Users[\\/])/giu;
const POSIX_LOCAL_SCHEME_PREFIX_RE =
  /\b(?:file:(?:\/\/[^/\\\s"'`<>]+)?|(?:webpack|vite):)\/+(?=(?:Users|home|root)\/)/giu;
const INLINE_SOURCE_MAP_PATTERN = {
  name: 'inline-source-map-data-url',
  pattern: /\bsourceMappingURL\s*=\s*data:/iu
};

function parseArgs(args) {
  const parsed = {
    distDir: DEFAULT_DIST_DIR,
    archives: [],
    writeJson: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dist' || arg === '--dist-dir') {
      parsed.distDir = args[index + 1];
      index += 1;
    } else if (arg === '--archive') {
      parsed.archives.push(args[index + 1]);
      index += 1;
    } else if (arg === '--json') {
      parsed.writeJson = true;
    } else if (arg === '--check') {
      parsed.check = true;
    }
  }

  return parsed;
}

function normalizeManifestPath(path) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        files.push(relative(root, absolute).replaceAll('\\', '/'));
      }
    }
  };
  visit(root);
  return files.sort();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectIconReferences(value, source) {
  if (!value) {
    return [];
  }
  if (typeof value === 'string') {
    return [{ source, path: normalizeManifestPath(value) }];
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .filter((entry) => typeof entry === 'string')
      .map((entry) => ({ source, path: normalizeManifestPath(entry) }));
  }
  return [];
}

function collectManifestReferences(manifest) {
  const references = [];
  const add = (source, path) => {
    if (typeof path === 'string' && path.length > 0) {
      references.push({ source, path: normalizeManifestPath(path) });
    }
  };

  add('background.service_worker', manifest.background?.service_worker);
  add('action.default_popup', manifest.action?.default_popup);
  add('options_ui.page', manifest.options_ui?.page);

  references.push(...collectIconReferences(manifest.icons, 'icons'));
  references.push(...collectIconReferences(manifest.action?.default_icon, 'action.default_icon'));

  for (const [index, script] of toArray(manifest.content_scripts).entries()) {
    for (const path of toArray(script.js)) {
      add(`content_scripts[${index}].js`, path);
    }
    for (const path of toArray(script.css)) {
      add(`content_scripts[${index}].css`, path);
    }
  }

  for (const [index, document] of toArray(manifest.offscreen_documents).entries()) {
    add(`offscreen_documents[${index}].page`, document.page);
  }

  for (const [index, resourceGroup] of toArray(manifest.web_accessible_resources).entries()) {
    for (const path of toArray(resourceGroup.resources)) {
      add(`web_accessible_resources[${index}].resources`, path);
    }
  }

  if (typeof manifest.default_locale === 'string' && manifest.default_locale.length > 0) {
    add('default_locale', `_locales/${manifest.default_locale}/messages.json`);
  }

  return references;
}

function globToRegExp(pattern) {
  const escaped = normalizeManifestPath(pattern)
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

function resolveReference(reference, files, distDir) {
  if (reference.path.includes('*')) {
    const matcher = globToRegExp(reference.path);
    const matches = files.filter((file) => matcher.test(file));
    return {
      ...reference,
      ok: matches.length > 0,
      matches
    };
  }

  return {
    ...reference,
    ok: existsSync(join(distDir, reference.path)),
    matches: existsSync(join(distDir, reference.path)) ? [reference.path] : []
  };
}

function shouldScanContent(path) {
  return !path.endsWith('.map') && SCANNED_CONTENT_EXTENSIONS.has(extname(path));
}

function shouldScanSecretContent(path) {
  return shouldScanContent(path) || /\.(?:pem|key|txt)$/i.test(path);
}

function scanForbiddenPseudoLocaleContent(path, content) {
  if (!shouldScanContent(path)) {
    return [];
  }
  return FORBIDDEN_PSEUDO_LOCALE_CONTENT_PATTERNS.filter(({ pattern }) =>
    pattern.test(content)
  ).map(({ name }) => ({ path, pattern: name }));
}

function scanForbiddenSecretContent(path, content) {
  if (!shouldScanSecretContent(path)) {
    return [];
  }
  return FORBIDDEN_SECRET_CONTENT_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ name }) => ({ path, pattern: name })
  );
}

function shouldScanMachineLocalContent(path) {
  return MACHINE_LOCAL_TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function decodeAsciiEscape(match, hex) {
  const codePoint = Number.parseInt(hex, 16);
  return codePoint <= 0x7f ? String.fromCodePoint(codePoint) : match;
}

function decodePercentAsciiEscape(match, hex) {
  const codePoint = Number.parseInt(hex, 16);
  const isWebUrlDelimiter =
    codePoint <= 0x20 ||
    codePoint === 0x22 ||
    codePoint === 0x27 ||
    codePoint === 0x3c ||
    codePoint === 0x3e ||
    codePoint === 0x60 ||
    codePoint === 0x7f;
  return codePoint <= 0x7f && !isWebUrlDelimiter ? String.fromCodePoint(codePoint) : match;
}

function canonicalizeCodeEscapes(content) {
  return content
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, decodeAsciiEscape)
    .replace(/\\u([0-9a-f]{4})/giu, decodeAsciiEscape)
    .replace(/\\x([0-9a-f]{2})/giu, decodeAsciiEscape)
    .replaceAll('\\/', '/');
}

function canonicalizePercentEscapes(content) {
  return content.replace(/%([0-9a-f]{2})/giu, decodePercentAsciiEscape);
}

function collectDecodedJsonStrings(path, content) {
  if (!JSON_MACHINE_LOCAL_EXTENSIONS.has(extname(path).toLowerCase())) {
    return [];
  }

  try {
    const strings = [];
    const pending = [JSON.parse(content)];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        strings.push(value);
      } else if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          strings.push(key);
          pending.push(child);
        }
      }
    }
    return strings;
  } catch {
    return [];
  }
}

function canonicalizeMachineLocalContent(path, content) {
  const decodedJsonStrings = collectDecodedJsonStrings(path, content);
  return canonicalizeCodeEscapes([content, ...decodedJsonStrings].join('\n'));
}

function scanForbiddenMachineLocalContent(path, content) {
  if (!shouldScanMachineLocalContent(path)) {
    return [];
  }

  const canonicalContent = canonicalizeMachineLocalContent(path, content);
  const contentWithoutExplicitWebUrls = canonicalContent.replace(WEB_URL_RE, '');
  const contentWithoutWebUrls = canonicalizePercentEscapes(contentWithoutExplicitWebUrls)
    .replace(WEB_URL_RE, '')
    .replace(WINDOWS_LOCAL_SCHEME_PREFIX_RE, '')
    .replace(POSIX_LOCAL_SCHEME_PREFIX_RE, '/');
  return FORBIDDEN_MACHINE_LOCAL_CONTENT_PATTERNS.filter(({ pattern }) =>
    pattern.test(contentWithoutWebUrls)
  ).map(({ name }) => ({ path, pattern: name }));
}

function scanForbiddenInlineSourceMapContent(path, content) {
  if (!INLINE_SOURCE_MAP_EXTENSIONS.has(extname(path).toLowerCase())) {
    return [];
  }
  return INLINE_SOURCE_MAP_PATTERN.pattern.test(content)
    ? [{ path, pattern: INLINE_SOURCE_MAP_PATTERN.name }]
    : [];
}

function shouldReadArchiveEntryContent(path) {
  const normalized = normalizeManifestPath(path);
  return (
    shouldScanContent(normalized) ||
    shouldScanSecretContent(normalized) ||
    shouldScanMachineLocalContent(normalized)
  );
}

function parseZipEntries(archivePath) {
  const buffer = readFileSync(archivePath);
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }

  if (endOffset === -1) {
    throw new Error(`Unable to locate ZIP end-of-central-directory record: ${archivePath}`);
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry in ${archivePath}`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const path = buffer.subarray(fileNameStart, fileNameEnd).toString('utf8');
    entries.push({
      path,
      content: shouldReadArchiveEntryContent(path)
        ? readZipEntryContent(buffer, {
            archivePath,
            compressedSize,
            compressionMethod,
            localHeaderOffset,
            path
          })
        : null
    });
    offset = fileNameEnd + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryContent(
  buffer,
  { archivePath, compressedSize, compressionMethod, localHeaderOffset, path }
) {
  if (path.endsWith('/')) {
    return null;
  }
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local file header for ${path} in ${archivePath}`);
  }
  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const contentStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(contentStart, contentStart + compressedSize);
  if (compressionMethod === 0) {
    return compressed.toString('utf8');
  }
  if (compressionMethod === 8) {
    return inflateRawSync(compressed).toString('utf8');
  }
  throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${path}`);
}

function buildReport({ distDir, archives }) {
  const failures = [];
  if (!existsSync(distDir)) {
    return {
      version: 1,
      distDir,
      files: [],
      manifestReferences: [],
      archives: [],
      forbiddenMachineLocalDistContent: [],
      forbiddenInlineSourceMapDistContent: [],
      failures: [`dist directory does not exist: ${distDir}`]
    };
  }

  const manifestPath = join(distDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      version: 1,
      distDir,
      files: [],
      manifestReferences: [],
      archives: [],
      forbiddenMachineLocalDistContent: [],
      forbiddenInlineSourceMapDistContent: [],
      failures: [`manifest is missing: ${manifestPath}`]
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = listFiles(distDir);
  const manifestReferences = collectManifestReferences(manifest).map((reference) =>
    resolveReference(reference, files, distDir)
  );
  const missingReferences = manifestReferences.filter((reference) => !reference.ok);
  const forbiddenDistFiles = files.filter((file) => FORBIDDEN_HARNESS_RE.test(file));
  const forbiddenPseudoLocaleDistFiles = files.filter((file) =>
    FORBIDDEN_PSEUDO_LOCALE_RE.test(file)
  );
  const forbiddenSecretDistFiles = files.filter((file) => FORBIDDEN_SECRET_FILE_RE.test(file));
  const forbiddenPseudoLocaleDistContent = files.flatMap((file) =>
    shouldScanContent(file)
      ? scanForbiddenPseudoLocaleContent(file, readFileSync(join(distDir, file), 'utf8'))
      : []
  );
  const forbiddenSecretDistContent = files.flatMap((file) =>
    shouldScanSecretContent(file)
      ? scanForbiddenSecretContent(file, readFileSync(join(distDir, file), 'utf8'))
      : []
  );
  const forbiddenMachineLocalDistContent = files.flatMap((file) =>
    shouldScanMachineLocalContent(file)
      ? scanForbiddenMachineLocalContent(file, readFileSync(join(distDir, file), 'utf8'))
      : []
  );
  const forbiddenInlineSourceMapDistContent = files.flatMap((file) =>
    shouldScanMachineLocalContent(file)
      ? scanForbiddenInlineSourceMapContent(file, readFileSync(join(distDir, file), 'utf8'))
      : []
  );

  failures.push(
    ...missingReferences.map(
      (reference) => `missing manifest reference: ${reference.source} -> ${reference.path}`
    ),
    ...forbiddenDistFiles.map((file) => `forbidden harness member in build/dist: ${file}`),
    ...forbiddenPseudoLocaleDistFiles.map(
      (file) => `forbidden dev-only pseudo-locale member in build/dist: ${file}`
    ),
    ...forbiddenSecretDistFiles.map(
      (file) => `forbidden secret-like member in build/dist: ${file}`
    ),
    ...forbiddenPseudoLocaleDistContent.map(
      ({ path, pattern }) =>
        `forbidden dev-only pseudo-locale content in build/dist: ${path} (${pattern})`
    ),
    ...forbiddenSecretDistContent.map(
      ({ path, pattern }) => `forbidden secret-like content in build/dist: ${path} (${pattern})`
    ),
    ...forbiddenMachineLocalDistContent.map(
      ({ path, pattern }) => `forbidden machine-local content in build/dist: ${path} (${pattern})`
    ),
    ...forbiddenInlineSourceMapDistContent.map(
      ({ path, pattern }) => `forbidden inline source map in build/dist: ${path} (${pattern})`
    )
  );

  const archiveReports = archives.map((archivePath) => {
    const archiveEntries = parseZipEntries(archivePath).map((entry) => ({
      ...entry,
      path: normalizeManifestPath(entry.path)
    }));
    const entries = archiveEntries.map((entry) => entry.path);
    const forbiddenEntries = entries.filter((entry) => FORBIDDEN_HARNESS_RE.test(entry));
    const forbiddenPseudoLocaleEntries = entries.filter((entry) =>
      FORBIDDEN_PSEUDO_LOCALE_RE.test(entry)
    );
    const forbiddenSecretEntries = entries.filter((entry) => FORBIDDEN_SECRET_FILE_RE.test(entry));
    const forbiddenPseudoLocaleContent = archiveEntries.flatMap((entry) =>
      typeof entry.content === 'string'
        ? scanForbiddenPseudoLocaleContent(entry.path, entry.content)
        : []
    );
    const forbiddenSecretContent = archiveEntries.flatMap((entry) =>
      typeof entry.content === 'string' ? scanForbiddenSecretContent(entry.path, entry.content) : []
    );
    const forbiddenMachineLocalContent = archiveEntries.flatMap((entry) =>
      typeof entry.content === 'string'
        ? scanForbiddenMachineLocalContent(entry.path, entry.content)
        : []
    );
    const forbiddenInlineSourceMapContent = archiveEntries.flatMap((entry) =>
      typeof entry.content === 'string'
        ? scanForbiddenInlineSourceMapContent(entry.path, entry.content)
        : []
    );
    failures.push(
      ...forbiddenEntries.map(
        (entry) => `forbidden harness member in archive ${archivePath}: ${entry}`
      ),
      ...forbiddenPseudoLocaleEntries.map(
        (entry) => `forbidden dev-only pseudo-locale member in archive ${archivePath}: ${entry}`
      ),
      ...forbiddenSecretEntries.map(
        (entry) => `forbidden secret-like member in archive ${archivePath}: ${entry}`
      ),
      ...forbiddenPseudoLocaleContent.map(
        ({ path, pattern }) =>
          `forbidden dev-only pseudo-locale content in archive ${archivePath}: ${path} (${pattern})`
      ),
      ...forbiddenSecretContent.map(
        ({ path, pattern }) =>
          `forbidden secret-like content in archive ${archivePath}: ${path} (${pattern})`
      ),
      ...forbiddenMachineLocalContent.map(
        ({ path, pattern }) =>
          `forbidden machine-local content in archive ${archivePath}: ${path} (${pattern})`
      ),
      ...forbiddenInlineSourceMapContent.map(
        ({ path, pattern }) =>
          `forbidden inline source map in archive ${archivePath}: ${path} (${pattern})`
      )
    );
    return {
      path: archivePath,
      entryCount: entries.length,
      forbiddenEntries,
      forbiddenPseudoLocaleEntries,
      forbiddenPseudoLocaleContent,
      forbiddenSecretContent,
      forbiddenSecretEntries,
      forbiddenMachineLocalContent,
      forbiddenInlineSourceMapContent
    };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    distDir,
    fileCount: files.length,
    forbiddenDistFiles,
    forbiddenPseudoLocaleDistFiles,
    forbiddenPseudoLocaleDistContent,
    forbiddenSecretDistContent,
    forbiddenSecretDistFiles,
    forbiddenMachineLocalDistContent,
    forbiddenInlineSourceMapDistContent,
    manifestReferences,
    archives: archiveReports,
    failures
  };
}

function formatReport(report) {
  const lines = [
    '# Release Surface Report',
    '',
    `Dist: ${report.distDir}`,
    `Files: ${report.fileCount ?? 0}`,
    '',
    '## Manifest References',
    '',
    '| Source | Path | Status |',
    '| --- | --- | --- |'
  ];

  for (const reference of report.manifestReferences ?? []) {
    lines.push(
      `| ${reference.source} | \`${reference.path}\` | ${reference.ok ? 'ok' : 'missing'} |`
    );
  }

  lines.push('', '## Forbidden Harness Members', '');
  if (report.forbiddenDistFiles?.length) {
    for (const file of report.forbiddenDistFiles) {
      lines.push(`- build/dist: \`${file}\``);
    }
  } else {
    lines.push('- build/dist: none');
  }

  for (const archive of report.archives ?? []) {
    if (archive.forbiddenEntries.length) {
      for (const entry of archive.forbiddenEntries) {
        lines.push(`- ${archive.path}: \`${entry}\``);
      }
    } else {
      lines.push(`- ${archive.path}: none`);
    }
  }

  lines.push('', '## Forbidden Machine-Local Content', '');
  if (report.forbiddenMachineLocalDistContent?.length) {
    for (const finding of report.forbiddenMachineLocalDistContent) {
      lines.push(`- build/dist content: \`${finding.path}\` (${finding.pattern})`);
    }
  } else {
    lines.push('- build/dist: none');
  }

  for (const archive of report.archives ?? []) {
    if (archive.forbiddenMachineLocalContent.length) {
      for (const finding of archive.forbiddenMachineLocalContent) {
        lines.push(`- ${archive.path} content: \`${finding.path}\` (${finding.pattern})`);
      }
    } else {
      lines.push(`- ${archive.path}: none`);
    }
  }

  lines.push('', '## Forbidden Inline Source Maps', '');
  if (report.forbiddenInlineSourceMapDistContent?.length) {
    for (const finding of report.forbiddenInlineSourceMapDistContent) {
      lines.push(`- build/dist content: \`${finding.path}\` (${finding.pattern})`);
    }
  } else {
    lines.push('- build/dist: none');
  }

  for (const archive of report.archives ?? []) {
    if (archive.forbiddenInlineSourceMapContent.length) {
      for (const finding of archive.forbiddenInlineSourceMapContent) {
        lines.push(`- ${archive.path} content: \`${finding.path}\` (${finding.pattern})`);
      }
    } else {
      lines.push(`- ${archive.path}: none`);
    }
  }

  lines.push('', '## Forbidden Secret-Like Members', '');
  if (report.forbiddenSecretDistFiles?.length) {
    for (const file of report.forbiddenSecretDistFiles) {
      lines.push(`- build/dist: \`${file}\``);
    }
  } else {
    lines.push('- build/dist: none');
  }
  if (report.forbiddenSecretDistContent?.length) {
    for (const finding of report.forbiddenSecretDistContent) {
      lines.push(`- build/dist content: \`${finding.path}\` (${finding.pattern})`);
    }
  }

  for (const archive of report.archives ?? []) {
    if (archive.forbiddenSecretEntries.length) {
      for (const entry of archive.forbiddenSecretEntries) {
        lines.push(`- ${archive.path}: \`${entry}\``);
      }
    } else {
      lines.push(`- ${archive.path}: none`);
    }
    if (archive.forbiddenSecretContent.length) {
      for (const finding of archive.forbiddenSecretContent) {
        lines.push(`- ${archive.path} content: \`${finding.path}\` (${finding.pattern})`);
      }
    }
  }

  lines.push('', '## Forbidden Dev/Test Pseudo-Locale Members', '');
  if (report.forbiddenPseudoLocaleDistFiles?.length) {
    for (const file of report.forbiddenPseudoLocaleDistFiles) {
      lines.push(`- build/dist: \`${file}\``);
    }
  } else {
    lines.push('- build/dist: none');
  }
  if (report.forbiddenPseudoLocaleDistContent?.length) {
    for (const finding of report.forbiddenPseudoLocaleDistContent) {
      lines.push(`- build/dist content: \`${finding.path}\` (${finding.pattern})`);
    }
  }

  for (const archive of report.archives ?? []) {
    if (archive.forbiddenPseudoLocaleEntries.length) {
      for (const entry of archive.forbiddenPseudoLocaleEntries) {
        lines.push(`- ${archive.path}: \`${entry}\``);
      }
    } else {
      lines.push(`- ${archive.path}: none`);
    }
    if (archive.forbiddenPseudoLocaleContent.length) {
      for (const finding of archive.forbiddenPseudoLocaleContent) {
        lines.push(`- ${archive.path} content: \`${finding.path}\` (${finding.pattern})`);
      }
    }
  }

  if (report.failures.length) {
    lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`));
  }

  return `${lines.join('\n')}\n`;
}

const options = parseArgs(process.argv.slice(2));
const report = buildReport(options);
console.log(formatReport(report));

if (options.writeJson) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

if (report.failures.length > 0) {
  process.exit(1);
}
