import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

describe('report-performance-hotspots', () => {
  const toolPath = resolve('tools/report-performance-hotspots.mjs');

  it('registers the background screenshot cache service before it can become an unowned hotspot', () => {
    expect(readFileSync(toolPath, 'utf8')).toContain(
      "['src/background/services/videoScreenshotCacheService.ts',"
    );
  });

  it('locks the extracted screenshot cache types barrel to the proactive owner budget', () => {
    expect(readFileSync(toolPath, 'utf8')).toContain(
      "['src/content/video/videoScreenshotCacheTypes.ts', 250]"
    );
  });

  function createFixtureRepo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'aiiinob-hotspots-'));

    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, source);
    }
    execFileSync('git', ['add', 'src'], { cwd: root, stdio: 'ignore' });

    return root;
  }

  function createSourceWithLines(lineCount: number) {
    return Array.from(
      { length: lineCount },
      (_, index) => `export const line${index} = ${index};`
    ).join('\n');
  }

  it('tracks current src files that remain over 250 LOC', () => {
    const output = execFileSync(process.execPath, [toolPath], {
      encoding: 'utf8'
    });

    expect(output).toContain('src/i18n/generated/schemaCore.generated.ts');
    expect(output).toContain('src/content/reader/utils/markdownBuilder.ts');
    expect(output).toContain('src/options/app/productionStitchLocalization.ts');
    expect(output).toContain('src/ui/domains/privacy/PrivacySettingsView.ts');
    expect(output).toContain('src/content/video/videoScreenshotPreparationRequestStore.ts');
    expect(output).toContain('src/background/listeners/runtimeMessages.ts');
    expect(output).toContain('src/content/video/videoCaptureMutationTransaction.ts: lines=');
    expect(output).not.toContain('src/options/app/productionStitchShellMount.ts: lines=');
    expect(output).not.toContain('src/i18n/schemaShellMessages.ts: lines=');
  });

  it('fails when a newly discovered >250 LOC src file has no registered budget', () => {
    const root = createFixtureRepo({
      'src/newLargeFile.ts': createSourceWithLines(251)
    });
    const budgetPath = join(root, 'budgets.json');
    writeFileSync(budgetPath, '{}');

    try {
      expect(() =>
        execFileSync(process.execPath, [toolPath, '--root', root, '--budget-json', budgetPath], {
          encoding: 'utf8',
          stdio: 'pipe'
        })
      ).toThrow(/Missing line budgets.*src\/newLargeFile\.ts/s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a registered budget points to a file that no longer exists', () => {
    const root = createFixtureRepo({
      'src/currentSmallFile.ts': createSourceWithLines(20)
    });
    const budgetPath = join(root, 'budgets.json');
    writeFileSync(
      budgetPath,
      JSON.stringify({
        'src/deletedLargeFile.ts': 300
      })
    );

    try {
      expect(() =>
        execFileSync(process.execPath, [toolPath, '--root', root, '--budget-json', budgetPath], {
          encoding: 'utf8',
          stdio: 'pipe'
        })
      ).toThrow(/Stale line budgets.*src\/deletedLargeFile\.ts/s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips tracked src files deleted in the working tree before reading source', () => {
    const root = createFixtureRepo({
      'src/currentSmallFile.ts': createSourceWithLines(20),
      'src/pendingDelete.ts': createSourceWithLines(20)
    });
    const budgetPath = join(root, 'budgets.json');
    writeFileSync(budgetPath, '{}');
    rmSync(join(root, 'src/pendingDelete.ts'));

    try {
      const output = execFileSync(
        process.execPath,
        [toolPath, '--root', root, '--budget-json', budgetPath],
        {
          encoding: 'utf8',
          stdio: 'pipe'
        }
      );

      expect(output).toContain('dynamic hotspot coverage: sourceFiles=1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes untracked current src files in hotspot coverage truth', () => {
    const root = createFixtureRepo({
      'src/currentSmallFile.ts': createSourceWithLines(20)
    });
    const budgetPath = join(root, 'budgets.json');
    writeFileSync(join(root, 'src/generatedLargeFile.ts'), createSourceWithLines(251), 'utf8');
    writeFileSync(
      budgetPath,
      JSON.stringify({
        'src/generatedLargeFile.ts': 251
      })
    );

    try {
      const output = execFileSync(
        process.execPath,
        [toolPath, '--root', root, '--budget-json', budgetPath],
        {
          encoding: 'utf8',
          stdio: 'pipe'
        }
      );

      expect(output).toContain('src/generatedLargeFile.ts: lines=251');
      expect(output).toContain('dynamic hotspot coverage: sourceFiles=2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
