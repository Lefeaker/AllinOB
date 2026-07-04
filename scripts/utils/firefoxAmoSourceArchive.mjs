import { readFileSync } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { zipDirectory } from './archive.mjs';

export const FIREFOX_AMO_SOURCE_ARCHIVE_SUFFIX = '-source';

const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  'AMO_SOURCE_REVIEW.md',
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'src/background/index.ts',
  'public/manifest.firefox.json',
  'scripts/build.mjs',
  'scripts/package-firefox.mjs',
  'scripts/setup-error-analytics.js',
  'tools/audit-release-archive.mjs',
  'tools/report-release-surface.mjs'
]);

const ROOT_FILE_CANDIDATES = Object.freeze([
  '.nvmrc',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.app.json',
  'tsconfig.preview.json',
  'tsconfig.strict.json',
  'tsconfig.tests.json',
  'vitest.shared.ts',
  'vitest.config.ts',
  'vitest.unit.config.ts'
]);

const ROOT_DIR_CANDIDATES = Object.freeze(['src', 'public', 'scripts', 'tools']);

const SUPPORTING_DOC_CANDIDATES = Object.freeze([
  'docs/firefox-compatibility-guide.md',
  'docs/engineering-entrypoints.md',
  'docs/source-of-truth-index.md'
]);

const FORBIDDEN_TOP_LEVEL_DIRS = new Set([
  '.git',
  '.tmp',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp'
]);

const FORBIDDEN_ARCHIVE_EXTENSIONS = new Set([
  '.crx',
  '.key',
  '.pem',
  '.p12',
  '.pfx',
  '.xpi',
  '.zip'
]);

const REQUIRED_README_SNIPPETS = Object.freeze([
  'ZENDIO_GA_MEASUREMENT_ID',
  'ZENDIO_GA_TRANSPORT_MODE=proxy',
  'ZENDIO_GA_PROXY_ENDPOINT',
  'node scripts/setup-error-analytics.js --require-env --require-zendio-env --require-proxy-transport',
  'node scripts/build.mjs --mode=prod --skip-checks --firefox',
  'node scripts/package-firefox.mjs --dist-dir build/dist'
]);

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function normalizeArchiveEntryPath(entryPath) {
  const slashPath = entryPath.replaceAll('\\', '/');
  if (slashPath.startsWith('/') || /^[a-zA-Z]:/.test(slashPath) || slashPath.includes('\0')) {
    throw new Error(`Unsafe absolute archive entry path: ${entryPath}`);
  }

  const normalized = normalize(slashPath).replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('../')) {
    throw new Error(`Unsafe parent-traversal archive entry path: ${entryPath}`);
  }

  return normalized;
}

function isDotEnvPath(entryPath) {
  return entryPath.split('/').some((segment) => segment === '.env' || segment.startsWith('.env.'));
}

function isForbiddenArchiveEntryPath(entryPath) {
  const normalized = normalizeArchiveEntryPath(entryPath);
  const segments = normalized.split('/');
  const fileName = basename(normalized);
  const extension = extname(fileName).toLowerCase();

  return (
    segments.some((segment) => FORBIDDEN_TOP_LEVEL_DIRS.has(segment)) ||
    fileName === '.DS_Store' ||
    isDotEnvPath(normalized) ||
    FORBIDDEN_ARCHIVE_EXTENSIONS.has(extension)
  );
}

async function copySourceFile(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { force: true });
}

async function copySourceDirectory(sourceRoot, targetRoot, relativeDir) {
  const sourceDir = join(sourceRoot, relativeDir);
  if (!(await pathExists(sourceDir))) {
    return;
  }

  const visit = async (relativePath) => {
    const absolutePath = join(sourceRoot, relativePath);
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      const childRelativePath = join(relativePath, entry.name).replaceAll('\\', '/');
      if (isForbiddenArchiveEntryPath(childRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(childRelativePath);
      } else if (entry.isFile()) {
        await copySourceFile(
          absolutePathFor(sourceRoot, childRelativePath),
          join(targetRoot, childRelativePath)
        );
      }
    }
  };

  await visit(relativeDir);
}

function absolutePathFor(root, relativePath) {
  return join(root, ...relativePath.split('/'));
}

async function copyCandidateFiles(sourceRoot, targetRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    if (isForbiddenArchiveEntryPath(relativePath)) {
      continue;
    }

    const sourcePath = absolutePathFor(sourceRoot, relativePath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await copySourceFile(sourcePath, absolutePathFor(targetRoot, relativePath));
  }
}

async function readNodeVersion(repoRoot) {
  try {
    return (await readFile(join(repoRoot, '.nvmrc'), 'utf8')).trim();
  } catch {
    return 'see .nvmrc';
  }
}

function createAmoSourceReadme({ artifactBaseName, releaseXpiName, version, nodeVersion }) {
  return `# AMO Source Review

This archive contains the human-readable source code and local build instructions for the Firefox AMO submission.

- Extension version: ${version}
- Submitted unsigned XPI: ${releaseXpiName}
- Release artifact base name: ${artifactBaseName}
- Node.js version: ${nodeVersion}

## Build Inputs

The production Firefox bundle is generated from the tracked source, public assets, build scripts, and package lockfile in this archive. The release workflow injects only public client analytics configuration into the browser bundle.

Do not provide AMO API credentials, Google Analytics client secrets, or local .env files to reproduce the unsigned package. The required GA values below are public client configuration values already present in the submitted extension package.

## Reproduce the Submitted Unsigned XPI

\`\`\`bash
npm ci

export ZENDIO_GA_MEASUREMENT_ID="<same public GA measurement id used for this release>"
export ZENDIO_GA_TRANSPORT_MODE=proxy
export ZENDIO_GA_PROXY_ENDPOINT="<same public GA proxy endpoint used for this release>"

node scripts/setup-error-analytics.js --require-env --require-zendio-env --require-proxy-transport
node scripts/build.mjs --mode=prod --skip-checks --firefox
node scripts/package-firefox.mjs --dist-dir build/dist
\`\`\`

The final command writes \`${releaseXpiName}\` in the archive root. Compare that generated XPI with the submitted AMO package contents.
`;
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
    return compressed;
  }
  if (compressionMethod === 8) {
    return inflateRawSync(compressed);
  }
  return null;
}

export async function readFirefoxAmoSourceArchiveEntries(archivePath) {
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
    const path = normalizeArchiveEntryPath(
      buffer.subarray(fileNameStart, fileNameEnd).toString('utf8')
    );
    const contentBuffer = readZipEntryContent(buffer, {
      archivePath,
      compressedSize,
      compressionMethod,
      localHeaderOffset,
      path
    });
    entries.push({
      path,
      content: contentBuffer ? contentBuffer.toString('utf8') : null
    });
    offset = fileNameEnd + extraLength + commentLength;
  }

  return entries;
}

export async function auditFirefoxAmoSourceArchive(archivePath, options = {}) {
  const { logger = console } = options;
  const entries = await readFirefoxAmoSourceArchiveEntries(archivePath);
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const findings = [];

  for (const entry of entries) {
    if (isForbiddenArchiveEntryPath(entry.path)) {
      findings.push(`forbidden archive entry: ${entry.path}`);
    }
  }

  for (const requiredEntry of REQUIRED_ARCHIVE_ENTRIES) {
    if (!entryPaths.has(requiredEntry)) {
      findings.push(`missing required source entry: ${requiredEntry}`);
    }
  }

  const readme = entries.find((entry) => entry.path === 'AMO_SOURCE_REVIEW.md')?.content ?? '';
  for (const snippet of REQUIRED_README_SNIPPETS) {
    if (!readme.includes(snippet)) {
      findings.push(`AMO_SOURCE_REVIEW.md is missing: ${snippet}`);
    }
  }

  if (findings.length > 0) {
    throw new Error(
      [
        `Firefox AMO source archive audit failed for ${archivePath}:`,
        ...findings.map((finding) => `- ${finding}`)
      ].join('\n')
    );
  }

  logger.log(`Audited Firefox AMO source archive: ${archivePath} (${entries.length} entries)`);
  return {
    ok: true,
    archivePath,
    entryCount: entries.length,
    findings: []
  };
}

export async function createFirefoxAmoSourceArchive(options, dependencies = {}) {
  const {
    repoRoot = process.cwd(),
    outputDir = 'build/firefox-source',
    artifactBaseName,
    releaseXpiName = `${artifactBaseName}.xpi`,
    version
  } = options;
  const { logger = console, zipDirectoryImpl = zipDirectory } = dependencies;

  if (!artifactBaseName) {
    throw new Error('artifactBaseName is required to create the Firefox AMO source archive.');
  }
  if (!version) {
    throw new Error('version is required to create the Firefox AMO source archive.');
  }

  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedOutputDir = resolve(resolvedRepoRoot, outputDir);
  const archiveName = `${artifactBaseName}${FIREFOX_AMO_SOURCE_ARCHIVE_SUFFIX}.zip`;
  const archivePath = join(resolvedOutputDir, archiveName);
  const stagingRoot = await mkdtemp(join(tmpdir(), 'aiiinob-firefox-amo-source-'));

  try {
    await mkdir(resolvedOutputDir, { recursive: true });
    await rm(archivePath, { force: true });

    await writeFile(
      join(stagingRoot, 'AMO_SOURCE_REVIEW.md'),
      createAmoSourceReadme({
        artifactBaseName,
        releaseXpiName,
        version,
        nodeVersion: await readNodeVersion(resolvedRepoRoot)
      }),
      'utf8'
    );

    await copyCandidateFiles(resolvedRepoRoot, stagingRoot, ROOT_FILE_CANDIDATES);
    await copyCandidateFiles(resolvedRepoRoot, stagingRoot, SUPPORTING_DOC_CANDIDATES);
    for (const relativeDir of ROOT_DIR_CANDIDATES) {
      await copySourceDirectory(resolvedRepoRoot, stagingRoot, relativeDir);
    }

    await zipDirectoryImpl(stagingRoot, archivePath, { ignore: ['**/.DS_Store'] });
    const audit = await auditFirefoxAmoSourceArchive(archivePath, { logger });

    logger.log(`✅ Firefox AMO source archive generated: ${archivePath}`);
    return {
      archivePath,
      archiveName,
      entryCount: audit.entryCount
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
