import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const setupErrorAnalyticsScript = 'scripts/setup-error-analytics.js';
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const setupErrorAnalyticsModuleUrl = new URL(
  '../../../scripts/setup-error-analytics.js',
  import.meta.url
);

type TrackedAnalyticsSourceContract = {
  clientRuntimeContainsApiSecret: boolean;
  runtimeCallsGoogleEndpointsDirectly: boolean;
  proxyBackedTransports: boolean;
  directDebugValidationIntent: boolean;
  debugSuccessSummaryRedacted: boolean;
  successLoggingScopedToDirectDebug: boolean;
  proxyContractSourcePresent: boolean;
  proxyContractBarrelExportPresent: boolean;
  proxyContractPublicAllowlistContractPresent: boolean;
  proxyContractSourceLeaksSensitiveAnchors: boolean;
  proxyContractReportSourceAnchorsPresent: boolean;
  typedAnalyticsEventMessageApiPresent: boolean;
};

type SetupErrorAnalyticsModule = {
  collectTrackedAnalyticsSourceContract: (projectRoot?: string) => TrackedAnalyticsSourceContract;
};

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '');
}

async function collectTrackedContract(): Promise<TrackedAnalyticsSourceContract> {
  const module = (await import(setupErrorAnalyticsModuleUrl.href)) as SetupErrorAnalyticsModule;
  return module.collectTrackedAnalyticsSourceContract(PROJECT_ROOT);
}

describe('setup-error-analytics script', () => {
  it('accepts the current proxy-first production analytics contracts without public env vars', () => {
    const result = spawnSync(process.execPath, [setupErrorAnalyticsScript], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ZENDIO_GA_MEASUREMENT_ID: '',
        ZENDIO_GA_TRANSPORT_MODE: '',
        ZENDIO_GA_PROXY_ENDPOINT: '',
        AIIINOB_GA_MEASUREMENT_ID: '',
        AIIINOB_GA_TRANSPORT_MODE: '',
        AIIINOB_GA_PROXY_ENDPOINT: ''
      }
    });

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).toBe(0);
    expect(output).toContain('Validation finished with 0 failures');
    expect(output).toContain('proxy-first');
    expect(output).toContain(
      'analytics proxy contract source/barrel/report anchors stay wired to the public allowlist contract'
    );
    expect(output).toContain('typed analytics runtime message facade is present');
  });

  it('fails required production validation when public GA env vars are missing', () => {
    const result = spawnSync(process.execPath, [setupErrorAnalyticsScript, '--require-env'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ZENDIO_GA_MEASUREMENT_ID: '',
        ZENDIO_GA_TRANSPORT_MODE: '',
        ZENDIO_GA_PROXY_ENDPOINT: '',
        AIIINOB_GA_MEASUREMENT_ID: '',
        AIIINOB_GA_TRANSPORT_MODE: '',
        AIIINOB_GA_PROXY_ENDPOINT: ''
      }
    });

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).not.toBe(0);
    expect(output).toContain('ZENDIO_GA_MEASUREMENT_ID/AIIINOB_GA_MEASUREMENT_ID is required');
    expect(output).toContain('ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE is required');
    expect(output).toContain('ZENDIO_GA_PROXY_ENDPOINT/AIIINOB_GA_PROXY_ENDPOINT is required');
  });

  it('passes required production validation when public GA env vars are complete', () => {
    const result = spawnSync(process.execPath, [setupErrorAnalyticsScript, '--require-env'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        ZENDIO_GA_MEASUREMENT_ID: 'G-ABCD1234',
        ZENDIO_GA_TRANSPORT_MODE: 'proxy',
        ZENDIO_GA_PROXY_ENDPOINT: 'https://analytics.example.test/ga4',
        AIIINOB_GA_MEASUREMENT_ID: '',
        AIIINOB_GA_TRANSPORT_MODE: '',
        AIIINOB_GA_PROXY_ENDPOINT: ''
      }
    });

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).toBe(0);
    expect(output).toContain('Validation finished with 0 failures');
    expect(output).toContain('measurementId format looks valid');
    expect(output).toContain('proxy endpoint format looks valid');
  });

  it('rejects legacy aliases for strict CI production validation', () => {
    const result = spawnSync(
      process.execPath,
      [
        setupErrorAnalyticsScript,
        '--require-env',
        '--require-zendio-env',
        '--require-proxy-transport'
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          ZENDIO_GA_MEASUREMENT_ID: '',
          ZENDIO_GA_TRANSPORT_MODE: '',
          ZENDIO_GA_PROXY_ENDPOINT: '',
          AIIINOB_GA_MEASUREMENT_ID: 'G-ABCD1234',
          AIIINOB_GA_TRANSPORT_MODE: 'proxy',
          AIIINOB_GA_PROXY_ENDPOINT: 'https://analytics.example.test/ga4'
        }
      }
    );

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).not.toBe(0);
    expect(output).toContain('ZENDIO_GA_MEASUREMENT_ID is required');
    expect(output).toContain('ZENDIO_GA_TRANSPORT_MODE is required');
    expect(output).toContain('ZENDIO_GA_PROXY_ENDPOINT is required');
  });

  it.each(['disabled', 'directDebug'])(
    'rejects %s transport for strict CI production validation',
    (transportMode) => {
      const result = spawnSync(
        process.execPath,
        [
          setupErrorAnalyticsScript,
          '--require-env',
          '--require-zendio-env',
          '--require-proxy-transport'
        ],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            ZENDIO_GA_MEASUREMENT_ID: 'G-ABCD1234',
            ZENDIO_GA_TRANSPORT_MODE: transportMode,
            ZENDIO_GA_PROXY_ENDPOINT: 'https://analytics.example.test/ga4',
            AIIINOB_GA_MEASUREMENT_ID: '',
            AIIINOB_GA_TRANSPORT_MODE: '',
            AIIINOB_GA_PROXY_ENDPOINT: ''
          }
        }
      );

      const output = stripAnsi(`${result.stdout}${result.stderr}`);

      expect(result.status).not.toBe(0);
      expect(output).toContain(
        `ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE must be proxy: ${transportMode}`
      );
    }
  );

  it('passes strict CI production validation with canonical Zendio proxy env vars', () => {
    const result = spawnSync(
      process.execPath,
      [
        setupErrorAnalyticsScript,
        '--require-env',
        '--require-zendio-env',
        '--require-proxy-transport'
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          ZENDIO_GA_MEASUREMENT_ID: 'G-ABCD1234',
          ZENDIO_GA_TRANSPORT_MODE: 'proxy',
          ZENDIO_GA_PROXY_ENDPOINT: 'https://analytics.example.test/ga4',
          AIIINOB_GA_MEASUREMENT_ID: '',
          AIIINOB_GA_TRANSPORT_MODE: '',
          AIIINOB_GA_PROXY_ENDPOINT: ''
        }
      }
    );

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).toBe(0);
    expect(output).toContain('Validation finished with 0 failures');
    expect(output).toContain('transport mode is proxy');
    expect(output).toContain('measurementId format looks valid');
    expect(output).toContain('proxy endpoint format looks valid');
  });

  it('rejects Google Measurement Protocol endpoints as public proxy endpoint env', () => {
    const endpoints = [
      'https://www.google-analytics.com/mp/collect',
      'https://www.google-analytics.com./mp/collect',
      'https://google-analytics.com./debug/mp/collect',
      'https://www.google-analytics.com/%6d%70/collect',
      'https://www.google-analytics.com/mp/%63ollect',
      'https://www.google-analytics.com/debug/%6d%70/collect'
    ];

    for (const endpoint of endpoints) {
      const result = spawnSync(process.execPath, [setupErrorAnalyticsScript], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          ZENDIO_GA_MEASUREMENT_ID: '',
          ZENDIO_GA_TRANSPORT_MODE: '',
          ZENDIO_GA_PROXY_ENDPOINT: '',
          AIIINOB_GA_MEASUREMENT_ID: 'G-ABCD1234',
          AIIINOB_GA_TRANSPORT_MODE: 'proxy',
          AIIINOB_GA_PROXY_ENDPOINT: endpoint
        }
      });

      const output = stripAnsi(`${result.stdout}${result.stderr}`);

      expect(result.status).not.toBe(0);
      expect(output).toContain('Google Measurement Protocol endpoint');
      expect(output).toContain('proxy endpoint');
    }
  }, 15_000);

  it('accepts owner proxy endpoint paths that resemble Measurement Protocol on non-Google hosts', () => {
    const result = spawnSync(process.execPath, [setupErrorAnalyticsScript], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ZENDIO_GA_MEASUREMENT_ID: '',
        ZENDIO_GA_TRANSPORT_MODE: '',
        ZENDIO_GA_PROXY_ENDPOINT: '',
        AIIINOB_GA_MEASUREMENT_ID: 'G-ABCD1234',
        AIIINOB_GA_TRANSPORT_MODE: 'proxy',
        AIIINOB_GA_PROXY_ENDPOINT: 'https://analytics.example.test/debug/mp/collect'
      }
    });

    const output = stripAnsi(`${result.stdout}${result.stderr}`);

    expect(result.status).toBe(0);
    expect(output).toContain('proxy endpoint format looks valid');
  });

  it('keeps client runtime free of server-only GA secrets', async () => {
    const contract = await collectTrackedContract();

    expect(contract.clientRuntimeContainsApiSecret).toBe(false);
  });

  it('keeps runtime transport off direct Google Measurement Protocol endpoints', async () => {
    const contract = await collectTrackedContract();

    expect(contract.runtimeCallsGoogleEndpointsDirectly).toBe(false);
    expect(contract.proxyBackedTransports).toBe(true);
    expect(contract.directDebugValidationIntent).toBe(true);
  });

  it('keeps directDebug success summaries redacted', async () => {
    const contract = await collectTrackedContract();

    expect(contract.debugSuccessSummaryRedacted).toBe(true);
    expect(contract.successLoggingScopedToDirectDebug).toBe(true);
  });

  it('requires the proxy contract source, barrel export, and report anchors in tracked production wiring', async () => {
    const contract = await collectTrackedContract();

    expect(contract.proxyContractSourcePresent).toBe(true);
    expect(contract.proxyContractBarrelExportPresent).toBe(true);
    expect(contract.proxyContractPublicAllowlistContractPresent).toBe(true);
    expect(contract.proxyContractSourceLeaksSensitiveAnchors).toBe(false);
    expect(contract.proxyContractReportSourceAnchorsPresent).toBe(true);
  });

  it('requires the typed analytics event message facade in tracked production wiring', async () => {
    const contract = await collectTrackedContract();

    expect(contract.typedAnalyticsEventMessageApiPresent).toBe(true);
  });
});
