import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const targetDir = join(root, 'src');
const allowlist = new Set([
  'src/background/index.ts',
  'src/content/runtime/contentRuntimeBootstrap.ts',
  'src/onboarding/index.ts',
  'src/options/index.ts',
  'src/platform/services.ts'
]);

const usagePattern = /getPlatformServices\s*\(/g;

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) {
      continue;
    }

    if (fullPath.includes('.test.') || fullPath.includes('.spec.')) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function toRelativePath(file) {
  return file.replace(`${root}/`, '');
}

const files = await collectFiles(targetDir);
const findings = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');

  for (const match of source.matchAll(usagePattern)) {
    const before = source.slice(0, match.index);
    findings.push({
      file: toRelativePath(file),
      line: before.split('\n').length
    });
  }
}

const uniqueFiles = new Set(findings.map((finding) => finding.file));
const unexpectedFiles = [...uniqueFiles].filter((file) => !allowlist.has(file)).sort();
const missingAllowlistFiles = [...allowlist].filter((file) => !uniqueFiles.has(file)).sort();

for (const finding of findings) {
  console.log(`${finding.file}:${finding.line} getPlatformServices()`);
}

if (findings.length === 0) {
  console.log('No getPlatformServices() usages found.');
}

console.log('');
console.log(`Allowlist files expected: ${allowlist.size}`);
console.log(`Files with usages found: ${uniqueFiles.size}`);
console.log(`Unexpected files: ${unexpectedFiles.length}`);
console.log(`Missing allowlist files: ${missingAllowlistFiles.length}`);

if (unexpectedFiles.length > 0) {
  console.log('');
  console.log('Unexpected usage files:');
  for (const file of unexpectedFiles) {
    console.log(`- ${file}`);
  }
}

if (missingAllowlistFiles.length > 0) {
  console.log('');
  console.log('Allowlist files without usage:');
  for (const file of missingAllowlistFiles) {
    console.log(`- ${file}`);
  }
}

if (unexpectedFiles.length > 0 || missingAllowlistFiles.length > 0) {
  process.exitCode = 1;
}
