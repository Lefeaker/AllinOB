import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('report-platform-services-allowlist', () => {
  it('assigns the content composition root to the reusable runtime bootstrap only', () => {
    const output = execFileSync(
      process.execPath,
      [resolve('tools/report-platform-services-allowlist.mjs')],
      { encoding: 'utf8' }
    );

    expect(output).toContain(
      'src/content/runtime/contentRuntimeBootstrap.ts:43 getPlatformServices()'
    );
    expect(output).not.toContain('src/content/index.ts:');
    expect(output).toContain('Unexpected files: 0');
    expect(output).toContain('Missing allowlist files: 0');
  });
});
