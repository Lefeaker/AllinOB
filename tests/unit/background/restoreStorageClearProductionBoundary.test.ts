/* @vitest-environment node */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function productionSources(root: string): string[] {
  return readdirSync(root)
    .sort()
    .flatMap((entry) => {
      const path = join(root, entry);
      return statSync(path).isDirectory()
        ? productionSources(path)
        : /\.tsx?$/u.test(entry)
          ? [path]
          : [];
    });
}

function destructiveBlobCallSites(): Array<{ file: string; method: string }> {
  const calls: Array<{ file: string; method: string }> = [];
  for (const path of productionSources(SRC)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'countAll' || node.expression.name.text === 'deleteAll')
      ) {
        calls.push({
          file: relative(ROOT, path),
          method: node.expression.name.text
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

describe('production restore storage clear boundary', () => {
  it('keeps countAll and deleteAll reachable only from the explicit clear owner', () => {
    expect(destructiveBlobCallSites()).toEqual([
      { file: 'src/background/services/restoreStorageClearOwner.ts', method: 'deleteAll' },
      { file: 'src/background/services/restoreStorageClearOwner.ts', method: 'countAll' }
    ]);

    const composition = readFileSync(
      join(ROOT, 'src/background/services/videoScreenshotCacheService.ts'),
      'utf8'
    );
    expect(composition).toContain(
      'clearRestoreData: (operationId) => clearOwner.clear(operationId)'
    );
    expect(composition).toContain("message.operation === 'clearAllRestoreData'");
  });
});
