import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/release-chrome-webstore.yml');

function readRequired(path) {
  if (!existsSync(path)) {
    throw new Error(`Required Chrome Web Store release workflow file is missing: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} is missing expected content: ${needle}`);
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label} still contains retired content: ${needle}`);
  }
}

function assertNotMatches(source, pattern, label) {
  if (pattern.test(source)) {
    throw new Error(`${label} still matches retired pattern: ${pattern}`);
  }
}

function assertOrdered(source, left, right, label) {
  const leftIndex = source.indexOf(left);
  const rightIndex = source.indexOf(right);

  if (leftIndex === -1) {
    throw new Error(`${label} is missing first marker: ${left}`);
  }

  if (rightIndex === -1) {
    throw new Error(`${label} is missing second marker: ${right}`);
  }

  if (leftIndex >= rightIndex) {
    throw new Error(`${label} must run "${left}" before "${right}".`);
  }
}

export function checkChromeWebstoreReleaseWorkflowContract({
  workflow = readRequired(WORKFLOW_PATH)
} = {}) {
  const failures = [];

  function recordCheck(label, callback) {
    try {
      callback();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  recordCheck('trigger-contract', () => {
    assertIncludes(workflow, 'workflow_dispatch:', 'Chrome Web Store release workflow');
    assertIncludes(workflow, "      - 'v*'", 'Chrome Web Store release workflow');
  });

  recordCheck('permissions-and-concurrency-contract', () => {
    assertIncludes(workflow, 'permissions:', 'Chrome Web Store release workflow');
    assertIncludes(workflow, 'contents: read', 'Chrome Web Store release workflow');
    assertIncludes(workflow, 'concurrency:', 'Chrome Web Store release workflow');
    assertIncludes(
      workflow,
      'group: ${{ github.workflow }}-${{ github.ref }}',
      'Chrome Web Store release workflow'
    );
    assertIncludes(workflow, 'cancel-in-progress: false', 'Chrome Web Store release workflow');
  });

  recordCheck('environment-contract', () => {
    assertIncludes(
      workflow,
      '    environment:\n      name: chrome-webstore-release',
      'Chrome Web Store release workflow'
    );
    assertOrdered(
      workflow,
      'name: chrome-webstore-release',
      'ZENDIO_GA_MEASUREMENT_ID: ${{ vars.ZENDIO_GA_MEASUREMENT_ID }}',
      'Chrome Web Store release workflow'
    );
    assertOrdered(
      workflow,
      'name: chrome-webstore-release',
      'CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}',
      'Chrome Web Store release workflow'
    );
  });

  recordCheck('node-action-contract', () => {
    assertIncludes(workflow, 'uses: actions/checkout@v6', 'Chrome Web Store release workflow');
    assertIncludes(
      workflow,
      'uses: ./.github/actions/setup-node-deps',
      'Chrome Web Store release workflow'
    );
    assertIncludes(
      workflow,
      'uses: actions/upload-artifact@v7',
      'Chrome Web Store release workflow'
    );
    assertNotMatches(workflow, /actions\/checkout@v[1-5]\b/, 'Chrome Web Store release workflow');
    assertNotMatches(
      workflow,
      /actions\/setup-node@v[1-5]\b/,
      'Chrome Web Store release workflow'
    );
    assertNotMatches(
      workflow,
      /actions\/upload-artifact@v[1-6]\b/,
      'Chrome Web Store release workflow'
    );
  });

  recordCheck('public-ga-config-contract', () => {
    const publicGaVars = [
      'ZENDIO_GA_MEASUREMENT_ID: ${{ vars.ZENDIO_GA_MEASUREMENT_ID }}',
      'ZENDIO_GA_TRANSPORT_MODE: ${{ vars.ZENDIO_GA_TRANSPORT_MODE }}',
      'ZENDIO_GA_PROXY_ENDPOINT: ${{ vars.ZENDIO_GA_PROXY_ENDPOINT }}'
    ];

    for (const publicGaVar of publicGaVars) {
      assertIncludes(workflow, publicGaVar, 'Chrome Web Store release workflow');
    }

    assertIncludes(
      workflow,
      '${ZENDIO_GA_MEASUREMENT_ID:?missing GitHub Environment variable ZENDIO_GA_MEASUREMENT_ID}',
      'Chrome Web Store release workflow'
    );
    assertIncludes(
      workflow,
      '${ZENDIO_GA_TRANSPORT_MODE:?missing GitHub Environment variable ZENDIO_GA_TRANSPORT_MODE}',
      'Chrome Web Store release workflow'
    );
    assertIncludes(
      workflow,
      '${ZENDIO_GA_PROXY_ENDPOINT:?missing GitHub Environment variable ZENDIO_GA_PROXY_ENDPOINT}',
      'Chrome Web Store release workflow'
    );
    assertNotIncludes(workflow, 'GA4_API_SECRET', 'Chrome Web Store release workflow');
    assertNotIncludes(workflow, 'ZENDIO_GA_API_SECRET', 'Chrome Web Store release workflow');
    assertNotIncludes(workflow, 'AIIINOB_GA_API_SECRET', 'Chrome Web Store release workflow');
  });

  recordCheck('build-package-audit-contract', () => {
    assertIncludes(workflow, 'npm run analytics:validate:prod', 'Chrome Web Store release workflow');
    assertIncludes(workflow, 'npm run quality', 'Chrome Web Store release workflow');
    assertIncludes(
      workflow,
      'node scripts/build.mjs --mode=prod --skip-checks',
      'Chrome Web Store release workflow'
    );
    assertIncludes(workflow, 'npm run package:ci', 'Chrome Web Store release workflow');
    assertIncludes(workflow, 'npm run audit:ga:client-secret', 'Chrome Web Store release workflow');
    assertIncludes(
      workflow,
      'npm run audit:ga:release-surface -- --archive "${{ steps.package.outputs.zip_path }}"',
      'Chrome Web Store release workflow'
    );
    assertOrdered(
      workflow,
      'npm run analytics:validate:prod',
      'node scripts/build.mjs --mode=prod --skip-checks',
      'Chrome Web Store release workflow'
    );
    assertOrdered(
      workflow,
      'node scripts/build.mjs --mode=prod --skip-checks',
      'npm run package:ci',
      'Chrome Web Store release workflow'
    );
    assertOrdered(
      workflow,
      'npm run package:ci',
      'npm run audit:ga:release-surface -- --archive "${{ steps.package.outputs.zip_path }}"',
      'Chrome Web Store release workflow'
    );
  });

  recordCheck('publish-contract', () => {
    const publishCommand =
      'node scripts/publish-chrome-webstore.mjs --publish --zip "${{ steps.package.outputs.zip_path }}"';
    const archiveAuditCommand =
      'npm run audit:ga:release-surface -- --archive "${{ steps.package.outputs.zip_path }}"';

    assertIncludes(workflow, 'CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}', 'publish step');
    assertIncludes(
      workflow,
      'CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}',
      'publish step'
    );
    assertIncludes(
      workflow,
      'CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}',
      'publish step'
    );
    assertIncludes(
      workflow,
      'CWS_EXTENSION_ID: ${{ secrets.CWS_EXTENSION_ID }}',
      'publish step'
    );
    assertIncludes(
      workflow,
      'CWS_PUBLISHER_ID: ${{ secrets.CWS_PUBLISHER_ID }}',
      'publish step'
    );
    assertIncludes(workflow, publishCommand, 'publish step');
    assertOrdered(workflow, archiveAuditCommand, publishCommand, 'publish step');
    assertNotIncludes(workflow, 'npm run release:chrome', 'Chrome Web Store release workflow');
    assertNotIncludes(workflow, 'npm run build\n', 'Chrome Web Store release workflow');
    assertNotIncludes(workflow, 'npm run package:prod:ga', 'Chrome Web Store release workflow');
    assertNotMatches(
      workflow,
      /publish-chrome-webstore\.mjs --zip\b/,
      'Chrome Web Store release workflow'
    );
  });

  return {
    ok: failures.length === 0,
    failures
  };
}

function readWorkflowFromCliArgs(argv) {
  const workflowArgIndex = argv.indexOf('--workflow');
  if (workflowArgIndex === -1) {
    return undefined;
  }

  const workflowPath = argv[workflowArgIndex + 1];
  if (!workflowPath || workflowPath.startsWith('--')) {
    throw new Error('--workflow requires a workflow file path');
  }

  return readRequired(resolve(workflowPath));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let result;
  try {
    result = checkChromeWebstoreReleaseWorkflowContract({
      workflow: readWorkflowFromCliArgs(process.argv.slice(2))
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }

  if (result && !result.ok) {
    console.error('Chrome Web Store release workflow contract failed:');
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else if (result && !process.argv.includes('--check')) {
    console.log('Chrome Web Store release workflow contract passed.');
  }
}
