import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readCiWorkflow(): string {
  return readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
}

function readFirefoxReleaseWorkflow(): string {
  return readFileSync(resolve('.github/workflows/release-firefox-amo.yml'), 'utf8');
}

function readPackageJson(): string {
  return readFileSync(resolve('package.json'), 'utf8');
}

function readWorkflowSupportFile(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('CI workflow wiring', () => {
  it('cancels superseded runs for the same workflow ref or PR', () => {
    const workflow = readCiWorkflow();

    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain(
      'group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}'
    );
    expect(workflow).toContain('cancel-in-progress: true');
  });

  it('splits independent checks into parallel jobs before packaging', () => {
    const workflow = readCiWorkflow();

    expect(workflow).toContain('static-preflight:');
    expect(workflow).toContain('static-release-surface:');
    expect(workflow).toContain('static-generated-artifacts:');
    expect(workflow).toContain('static-style-and-locale:');
    expect(workflow).toContain('static-reporting-audits:');
    expect(workflow).toContain('coverage:');
    expect(workflow).toContain('visual:');
    expect(workflow).toContain('e2e-vitest:');
    expect(workflow).toContain('browser-yaml:');
    expect(workflow).toContain('browser-reader-panel:');
    expect(workflow).toContain('browser-smoke:');
    expect(workflow).toContain('package:');
    expect(workflow).toContain('needs: [static-preflight]');
    expect(workflow).not.toContain('static-gates:');
    expect(workflow).not.toContain('  e2e:\n');
  });

  it('uses fast production builds after static gates have already run', () => {
    const workflow = readCiWorkflow();

    expect(workflow).not.toMatch(/run:\s*npm run build\s*(?:\n|$)/);
    expect(workflow).toContain('run: npm run build:fast');
    expect(workflow).toContain('npm run package:ci');
  });

  it('uses Node 24-compatible official actions', () => {
    const workflow = readCiWorkflow();
    const setupNodeAction = readWorkflowSupportFile('.github/actions/setup-node-deps/action.yml');

    expect(workflow).toContain('uses: actions/checkout@v6');
    expect(setupNodeAction).toContain('uses: actions/setup-node@v6');
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toContain('uses: actions/github-script@v8');
    expect(workflow).not.toMatch(/actions\/checkout@v[1-5]\b/);
    expect(setupNodeAction).not.toMatch(/actions\/setup-node@v[1-5]\b/);
    expect(workflow).not.toMatch(/actions\/upload-artifact@v[1-6]\b/);
    expect(workflow).not.toMatch(/actions\/github-script@v[1-7]\b/);
  });

  it('keeps Firefox AMO publishing on the GA production release path', () => {
    const workflow = readFirefoxReleaseWorkflow();
    const packageJson = readPackageJson();

    expect(workflow).toContain('name: Release Firefox AMO');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('uses: actions/checkout@v6');
    expect(workflow).toContain('uses: ./.github/actions/setup-node-deps');
    expect(workflow).toContain('WEB_EXT_API_KEY: ${{ secrets.WEB_EXT_API_KEY }}');
    expect(workflow).toContain('WEB_EXT_API_SECRET: ${{ secrets.WEB_EXT_API_SECRET }}');
    expect(workflow).toContain('FIREFOX_RELEASE_CHANNEL: listed');
    expect(workflow).toContain('id: release_channel');
    expect(workflow).toContain('GITHUB_EVENT_PATH');
    expect(workflow).toContain('FIREFOX_RELEASE_CHANNEL=%s\\n');
    expect(workflow).toContain('channel=%s\\n');
    expect(workflow).toContain('${safe_ref//[!A-Za-z0-9._-]/-}');
    expect(workflow).toContain('safe_ref=%s\\n');
    expect(workflow).toContain('ZENDIO_GA_MEASUREMENT_ID: ${{ secrets.ZENDIO_GA_MEASUREMENT_ID }}');
    expect(workflow).toContain('ZENDIO_GA_TRANSPORT_MODE: proxy');
    expect(workflow).toContain('ZENDIO_GA_PROXY_ENDPOINT: ${{ secrets.ZENDIO_GA_PROXY_ENDPOINT }}');
    expect(workflow).toContain('npm run analytics:validate:prod:required');
    expect(workflow).toContain('npm run build:firefox:prod:ga:ci');
    expect(workflow).toContain('node scripts/package-firefox.mjs "${sign_args[@]}"');
    expect(workflow).toContain('--approval-timeout 0');
    expect(workflow).toContain('npm run audit:ga:client-secret');
    expect(workflow).toContain('npm run audit:ga:release-surface -- "${archive_args[@]}"');
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toContain(
      'name: firefox-amo-${{ steps.release_channel.outputs.channel }}-${{ steps.release_channel.outputs.safe_ref }}-${{ github.run_number }}'
    );
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).not.toContain('inputs.channel ||');
    expect(workflow).not.toContain('github.ref_name }}');
    expect(workflow).not.toContain('npm run package:firefox\n');
    expect(workflow).not.toContain('node --env-file=.env.production.local');
    expect(packageJson).toContain(
      '"analytics:validate:prod:required": "node scripts/setup-error-analytics.js --require-env --require-zendio-env --require-proxy-transport"'
    );
    expect(packageJson).not.toContain('"analytics:validate:prod:required": "node --env-file');
  });
});
