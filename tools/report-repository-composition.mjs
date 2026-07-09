import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

const filesToCheck = {
  'src/options/index.ts': ['bootstrapOptionsRuntime('],
  'src/options/runtimeEntry.ts': ['registerRepositories({', 'registerFallbackRepositories()'],
  'src/content/index.ts': ['initializeClipperRuntime({'],
  'src/content/runtime/contentRuntimeBootstrap.ts': ['registerRepositories({'],
  'src/background/index.ts': ['registerRepositories({'],
  'src/onboarding/index.ts': ['registerRepositories({', 'registerFallbackRepositories()'],
  'src/shared/di/serviceRegistry.ts': [
    'export function registerRepositories(services: RepositoryPlatformServices): void',
    'export function registerFallbackRepositories(): void',
    'Register repositories in the composition root first.'
  ]
};

const forbiddenSnippets = {
  'src/shared/di/serviceRegistry.ts': [
    'ensureFallbackRepositoriesRegistered()',
    'if (typeof chrome !== \'undefined\' && typeof chrome.storage !== \'undefined\''
  ]
};

let hasFailure = false;

for (const [relativePath, requiredSnippets] of Object.entries(filesToCheck)) {
  const source = await readFile(join(root, relativePath), 'utf8');

  for (const snippet of requiredSnippets) {
    const present = source.includes(snippet);
    console.log(`${relativePath} requires "${snippet}": ${present ? 'yes' : 'no'}`);
    if (!present) {
      hasFailure = true;
    }
  }

  const forbidden = forbiddenSnippets[relativePath] ?? [];
  for (const snippet of forbidden) {
    const present = source.includes(snippet);
    console.log(`${relativePath} forbids "${snippet}": ${present ? 'present' : 'absent'}`);
    if (present) {
      hasFailure = true;
    }
  }
}

if (hasFailure) {
  process.exitCode = 1;
}
