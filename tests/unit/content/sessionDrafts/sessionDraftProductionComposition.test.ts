/* @vitest-environment node */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(`${ROOT}/${path}`, 'utf8');
}

describe('production session draft composition', () => {
  it.each([
    'src/content/reader/readerSessionDraftController.ts',
    'src/content/video/videoSessionDraftController.ts',
    'src/content/runtime/sessionDraftAutoRestore.ts'
  ])('does not compose the direct local repository in %s', (path) => {
    expect(source(path)).not.toContain('createSessionDraftRepository');
  });

  it('composes reader and video dependencies with the background client repository', () => {
    expect(source('src/content/reader/sessionDependencies.ts')).toContain(
      'createSessionDraftClientRepository'
    );
    expect(source('src/content/video/sessionDependencies.ts')).toContain(
      'createSessionDraftClientRepository'
    );
  });

  it('routes auto-restore through runtime messaging instead of storage.local', () => {
    const autoRestore = source('src/content/runtime/sessionDraftAutoRestore.ts');
    expect(autoRestore).toContain('createSessionDraftClientRepository');
    expect(autoRestore).not.toContain('options.storage.local');
  });
});
