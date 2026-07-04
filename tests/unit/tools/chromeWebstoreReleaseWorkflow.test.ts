import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function readChromeReleaseWorkflow(): string {
  return readFileSync(resolve('.github/workflows/release-chrome-webstore.yml'), 'utf8');
}

describe('Chrome Web Store release workflow contract', () => {
  it('passes the checked Chrome GA publish workflow contract', () => {
    expect(() => {
      execFileSync('node', ['tools/report-chrome-webstore-release-workflow.mjs', '--check'], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }).not.toThrow();
  });

  it('injects public GA config from protected environment variables before packaging', () => {
    const workflow = readChromeReleaseWorkflow();

    expect(workflow).toContain('ZENDIO_GA_MEASUREMENT_ID: ${{ vars.ZENDIO_GA_MEASUREMENT_ID }}');
    expect(workflow).toContain('ZENDIO_GA_TRANSPORT_MODE: ${{ vars.ZENDIO_GA_TRANSPORT_MODE }}');
    expect(workflow).toContain('ZENDIO_GA_PROXY_ENDPOINT: ${{ vars.ZENDIO_GA_PROXY_ENDPOINT }}');
    expect(workflow).toContain('ZENDIO_GA_TRANSPORT_MODE must be proxy');
    expect(workflow).toContain('npm run analytics:validate:prod:required');
    expect(workflow).toContain('node scripts/build.mjs --mode=prod --skip-checks');
  });

  it('binds release credentials to the protected Chrome Web Store environment', () => {
    const workflow = readChromeReleaseWorkflow();

    expect(workflow).toContain('environment:');
    expect(workflow).toContain('name: chrome-webstore-release');
    expect(workflow).toContain('ZENDIO_GA_MEASUREMENT_ID: ${{ vars.ZENDIO_GA_MEASUREMENT_ID }}');
    expect(workflow).toContain('CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}');
  });

  it('fails the contract when the protected release environment is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zendio-chrome-release-workflow-'));
    const workflowPath = join(tempDir, 'release-chrome-webstore.yml');
    const workflowWithoutEnvironment = readChromeReleaseWorkflow().replace(
      / {4}environment:\n {6}name: chrome-webstore-release\n/,
      ''
    );

    try {
      writeFileSync(workflowPath, workflowWithoutEnvironment);

      expect(() => {
        execFileSync(
          'node',
          ['tools/report-chrome-webstore-release-workflow.mjs', '--check', '--workflow', workflowPath],
          {
            encoding: 'utf8',
            stdio: 'pipe'
          }
        );
      }).toThrow(/environment-contract[\s\S]*name: chrome-webstore-release/);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('fails the contract when ordinary branch push releases are enabled', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zendio-chrome-release-workflow-'));
    const workflowPath = join(tempDir, 'release-chrome-webstore.yml');
    const workflowWithBranchPush = readChromeReleaseWorkflow().replace(
      "  push:\n    tags:\n      - 'v*'",
      "  push:\n    branches:\n      - main\n    tags:\n      - 'v*'"
    );

    try {
      writeFileSync(workflowPath, workflowWithBranchPush);

      expect(() => {
        execFileSync(
          'node',
          ['tools/report-chrome-webstore-release-workflow.mjs', '--check', '--workflow', workflowPath],
          {
            encoding: 'utf8',
            stdio: 'pipe'
          }
        );
      }).toThrow(/trigger-contract[\s\S]*branches/);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('fails the contract when release validation is downgraded to the local owner check', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'zendio-chrome-release-workflow-'));
    const workflowPath = join(tempDir, 'release-chrome-webstore.yml');
    const workflowWithNonStrictValidation = readChromeReleaseWorkflow().replace(
      'npm run analytics:validate:prod:required',
      'npm run analytics:validate:prod'
    );

    try {
      writeFileSync(workflowPath, workflowWithNonStrictValidation);

      expect(() => {
        execFileSync(
          'node',
          ['tools/report-chrome-webstore-release-workflow.mjs', '--check', '--workflow', workflowPath],
          {
            encoding: 'utf8',
            stdio: 'pipe'
          }
        );
      }).toThrow(/build-package-audit-contract[\s\S]*analytics:validate:prod:required/);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('publishes only after archive-level GA audits pass', () => {
    const workflow = readChromeReleaseWorkflow();
    const archiveAuditIndex = workflow.indexOf(
      'npm run audit:ga:release-surface -- --archive "${{ steps.package.outputs.zip_path }}"'
    );
    const publishIndex = workflow.indexOf(
      'node scripts/publish-chrome-webstore.mjs --publish --zip "${{ steps.package.outputs.zip_path }}"'
    );

    expect(archiveAuditIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(archiveAuditIndex);
    expect(workflow).not.toContain('npm run release:chrome');
    expect(workflow).not.toMatch(/publish-chrome-webstore\.mjs --zip/);
  });

  it('keeps the release package artifact on the current official action major', () => {
    const workflow = readChromeReleaseWorkflow();

    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toContain('name: chrome-webstore-package');
    expect(workflow).toContain('path: ${{ steps.package.outputs.zip_path }}');
    expect(workflow).not.toMatch(/actions\/upload-artifact@v[1-6]\b/);
  });
});
