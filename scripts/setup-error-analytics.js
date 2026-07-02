#!/usr/bin/env node
// @ts-check

/**
 * Read-only analytics setup validator.
 *
 * This script verifies that the repo is wired for proxy-first analytics and
 * that the current shell environment contains only public build config.
 *
 * It does not write files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const GOOGLE_ANALYTICS_HOST_PARTS = ['google-analytics', 'com'];
const GOOGLE_MEASUREMENT_PROTOCOL_PATH_PARTS = [
  ['mp', 'collect'],
  ['debug', 'mp', 'collect']
];

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

let failures = 0;
let warnings = 0;

function readFromRoot(projectRoot, filePath) {
  return fs.readFileSync(path.join(projectRoot, filePath), 'utf8');
}

function existsFromRoot(projectRoot, filePath) {
  return fs.existsSync(path.join(projectRoot, filePath));
}

export function extractAnalyticsTransportModes(sourceText, sourcePath = 'analyticsEnvironment.ts') {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== 'AnalyticsTransportMode') {
      continue;
    }
    if (!ts.isUnionTypeNode(statement.type)) {
      return [];
    }
    return statement.type.types
      .filter(ts.isLiteralTypeNode)
      .map((node) =>
        ts.isStringLiteral(node.literal) || ts.isNoSubstitutionTemplateLiteral(node.literal)
          ? node.literal.text
          : null
      )
      .filter((value) => typeof value === 'string');
  }
  return [];
}

function extractNamedExports(sourceText, sourcePath = 'module.ts') {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const exportNames = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exportNames.add(element.name.text);
        }
      }
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectExportedBindingNames(declaration.name, exportNames);
      }
      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      exportNames.add(statement.name.text);
    }
  }

  return exportNames;
}

function hasExportModifier(statement) {
  return (
    Array.isArray(statement.modifiers) &&
    statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function collectExportedBindingNames(bindingName, exportNames) {
  if (ts.isIdentifier(bindingName)) {
    exportNames.add(bindingName.text);
    return;
  }

  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      collectExportedBindingNames(element.name, exportNames);
    }
  }
}

function hasAllExportedNames(exportNames, expectedNames) {
  return expectedNames.every((name) => exportNames.has(name));
}

export function collectTrackedAnalyticsSourceContract(projectRoot = rootDir) {
  const analyticsEventMessage = readFromRoot(
    projectRoot,
    'src/shared/analytics/analyticsEventMessage.ts'
  );
  const analyticsIndex = readFromRoot(projectRoot, 'src/shared/analytics/index.ts');
  const analyticsEnvironment = readFromRoot(
    projectRoot,
    'src/shared/analytics/analyticsEnvironment.ts'
  );
  const analyticsConsent = readFromRoot(projectRoot, 'src/shared/analytics/analyticsConsent.ts');
  const analyticsQueue = readFromRoot(projectRoot, 'src/shared/analytics/analyticsQueue.ts');
  const analyticsTransport = readFromRoot(
    projectRoot,
    'src/shared/analytics/analyticsTransport.ts'
  );
  const analyticsProxyContractPath = 'src/shared/analytics/analyticsProxyContract.ts';
  const analyticsProxyContractExists = existsFromRoot(projectRoot, analyticsProxyContractPath);
  const analyticsProxyContract = analyticsProxyContractExists
    ? readFromRoot(projectRoot, analyticsProxyContractPath)
    : '';
  const analyticsProxyContractReportPath = 'tools/report-ga-proxy-contract.mjs';
  const analyticsProxyContractReportExists = existsFromRoot(
    projectRoot,
    analyticsProxyContractReportPath
  );
  const analyticsProxyContractReport = analyticsProxyContractReportExists
    ? readFromRoot(projectRoot, analyticsProxyContractReportPath)
    : '';
  const analyticsTypes = readFromRoot(projectRoot, 'src/shared/types/analytics.ts');
  const analyticsConfig = readFromRoot(
    projectRoot,
    'src/shared/errors/analytics/analyticsConfig.ts'
  );
  const analyticsReporter = readFromRoot(
    projectRoot,
    'src/shared/errors/analytics/googleAnalyticsReporter.ts'
  );
  const analyticsEvents = readFromRoot(projectRoot, 'src/background/services/analyticsEvents.ts');
  const clientRuntimeSource = [
    analyticsEnvironment,
    analyticsConsent,
    analyticsQueue,
    analyticsTransport,
    analyticsConfig,
    analyticsReporter,
    analyticsEvents,
    readFromRoot(projectRoot, 'src/options/app/productionStitchPersistence.ts'),
    readFromRoot(projectRoot, 'src/options/app/productionStitchFinalAnalyticsEvent.ts'),
    readFromRoot(projectRoot, 'src/options/app/productionStitchShellActionRuntime.ts')
  ].join('\n');
  const analyticsLogSummaryBlock = sliceBetween(
    analyticsEvents,
    'function buildAnalyticsTransportLogSummary(',
    'function logAnalyticsTransportResult('
  );
  const analyticsBarrelExports = extractNamedExports(analyticsIndex, 'index.ts');
  const analyticsProxyContractExports = extractNamedExports(
    analyticsProxyContract,
    'analyticsProxyContract.ts'
  );

  return {
    transportModes: extractAnalyticsTransportModes(analyticsEnvironment),
    typedAnalyticsEventMessageApiPresent:
      hasAll(analyticsEventMessage, [
        'ANALYTICS_EVENT_MESSAGE',
        'createAnalyticsEventMessage',
        'isAnalyticsRuntimeEventMessage'
      ]) &&
      hasAll(analyticsTypes, [
        'ANALYTICS_EVENT_MESSAGE',
        'createAnalyticsEventMessage',
        'isAnalyticsRuntimeEventMessage'
      ]),
    clientRuntimeContainsApiSecret:
      /\bapi_secret\b/i.test(clientRuntimeSource) || /\bapiSecret\b/.test(clientRuntimeSource),
    trackedConfigUsesPublicBuildConfigOnly: hasAll(analyticsConfig, [
      'PUBLIC_BUILD_ANALYTICS_CONFIG.measurementId',
      "PUBLIC_BUILD_ANALYTICS_CONFIG.transportMode ?? 'disabled'",
      'PUBLIC_BUILD_ANALYTICS_CONFIG.proxyEndpoint'
    ]),
    errorReporterUsesQueueTransportAndLiveConsent: hasAll(analyticsReporter, [
      'createAnalyticsEventQueue',
      'sendAnalyticsTransportEvent',
      'resolveAnalyticsConfig',
      'liveConfig?.userConsent ?? this.config.userConsent'
    ]),
    runtimeCallsGoogleEndpointsDirectly: hasAny(analyticsTransport, [
      'google-analytics.com/mp/collect',
      'google-analytics.com/debug/mp/collect'
    ]),
    proxyBackedTransports: hasAll(analyticsTransport, [
      "transportMode === 'proxy' || transportMode === 'directDebug'",
      'normalizeProxyEndpoint(config.proxyEndpoint)',
      'postAnalyticsPayload(proxyEndpoint, proxyPayload, transportMode, requestFetch)'
    ]),
    directDebugValidationIntent: analyticsTransport.includes(
      "validation_behavior: 'ENFORCE_RECOMMENDATIONS'"
    ),
    consentHelperExists: hasAll(analyticsConsent, [
      'getConsentScopeForAnalyticsEvent',
      'hasConsentForAnalyticsEvent'
    ]),
    queueUsesSharedConsentHelper: hasAll(analyticsQueue, [
      "import { hasConsentForAnalyticsEvent } from './analyticsConsent';",
      'hasConsentForAnalyticsEvent(config, entry.eventName)',
      'sendAnalyticsTransportEvent'
    ]),
    transportAppliesEventClassConsent: hasAll(analyticsTransport, [
      "import { hasConsentForAnalyticsEvent } from './analyticsConsent';",
      'hasConsentForAnalyticsEvent(config, eventName)'
    ]),
    debugSuccessSummaryRedacted:
      analyticsLogSummaryBlock !== null &&
      hasAll(analyticsLogSummaryBlock, [
        'eventName',
        'transportMode: result.transportMode',
        'responseStatus: result.responseStatus',
        'validation: summarizeDebugResponse(result.debugResponse)'
      ]) &&
      !hasAny(analyticsLogSummaryBlock, ['params', 'payload', 'client_id', 'measurement_id']),
    successLoggingScopedToDirectDebug: analyticsEvents.includes(
      "if (result.transportMode !== 'directDebug')"
    ),
    proxyContractSourcePresent: analyticsProxyContractExists,
    proxyContractBarrelExportPresent: hasAllExportedNames(analyticsBarrelExports, [
      'analyticsProxyContract',
      'buildAnalyticsProxyContract',
      'AnalyticsProxyContract',
      'AnalyticsProxyEventContract'
    ]),
    proxyContractPublicAllowlistContractPresent:
      analyticsProxyContractExists &&
      hasAllExportedNames(analyticsProxyContractExports, [
        'ANALYTICS_PROXY_CONTRACT',
        'buildAnalyticsProxyContract',
        'AnalyticsProxyContract',
        'AnalyticsProxyEventContract'
      ]) &&
      hasAll(analyticsProxyContract, [
        "generatedAtSource: 'extension-schema'",
        'transports: ANALYTICS_PROXY_CONTRACT_TRANSPORTS',
        'measurementIdPattern: ANALYTICS_PROXY_MEASUREMENT_ID_PATTERN',
        'allowedParams',
        'paramValidators',
        'events'
      ]),
    proxyContractSourceLeaksSensitiveAnchors:
      /\bproxyEndpoint\b|\bclientId\b|\bsessionId\b|\bapi_secret\b|\bapiSecret\b|\bAPI_SECRET\b/.test(
        analyticsProxyContract
      ) || /(?:\bmeasurementId\b|['"]measurementId['"])\s*:/.test(analyticsProxyContract),
    proxyContractReportSourceAnchorsPresent:
      analyticsProxyContractReportExists &&
      hasAll(analyticsProxyContractReport, [
        "CONTRACT_ENTRYPOINT = 'src/shared/analytics/analyticsProxyContract.ts'",
        'SOURCE_FILES_TO_SCAN = [',
        "'src/shared/analytics/analyticsProxyContract.ts'",
        'contractModule.ANALYTICS_PROXY_CONTRACT',
        'contractModule.buildAnalyticsProxyContract'
      ])
  };
}

function paint(color, message) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function ok(message) {
  paint('green', `OK  ${message}`);
}

function info(message) {
  paint('blue', `INFO ${message}`);
}

function warn(message) {
  warnings += 1;
  paint('yellow', `WARN ${message}`);
}

function fail(message) {
  failures += 1;
  paint('red', `FAIL ${message}`);
}

function read(filePath) {
  return fs.readFileSync(path.join(rootDir, filePath), 'utf8');
}

function exists(filePath) {
  return fs.existsSync(path.join(rootDir, filePath));
}

function hasAll(source, fragments) {
  return fragments.every((fragment) => source.includes(fragment));
}

function hasAny(source, fragments) {
  return fragments.some((fragment) => source.includes(fragment));
}

function sliceBetween(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  if (startIndex === -1) {
    return null;
  }

  const endIndex = source.indexOf(endMarker, startIndex);
  if (endIndex === -1) {
    return null;
  }

  return source.slice(startIndex, endIndex);
}

function validateRequiredFiles() {
  info('Checking required analytics files');

  const requiredFiles = [
    'src/shared/analytics/analyticsEventMessage.ts',
    'src/shared/analytics/index.ts',
    'src/shared/analytics/analyticsEnvironment.ts',
    'src/shared/analytics/analyticsConsent.ts',
    'src/shared/analytics/analyticsQueue.ts',
    'src/shared/analytics/analyticsTransport.ts',
    'src/shared/analytics/analyticsProxyContract.ts',
    'src/shared/errors/analytics/analyticsConfig.ts',
    'src/shared/errors/analytics/googleAnalyticsReporter.ts',
    'src/background/services/analyticsEvents.ts',
    'src/options/app/productionStitchPersistence.ts',
    'src/options/app/productionStitchFinalAnalyticsEvent.ts',
    'src/options/app/productionStitchShellActionRuntime.ts',
    'scripts/build.mjs',
    'tools/report-ga-proxy-contract.mjs'
  ];

  for (const file of requiredFiles) {
    if (exists(file)) {
      ok(`${file} exists`);
    } else {
      fail(`${file} is missing`);
    }
  }

  const legacyPrivacyView = 'src/ui/domains/privacy/PrivacySettingsView.ts';
  if (!exists(legacyPrivacyView)) {
    warn(
      `${legacyPrivacyView} is absent; production validation now relies on Stitch privacy wiring`
    );
    return;
  }

  const legacyPrivacySource = read(legacyPrivacyView);
  if (hasAll(legacyPrivacySource, ['toggleDebugMode', 'saveSettings'])) {
    warn(
      `${legacyPrivacyView} still exists as a legacy compatibility surface; it is no longer the production privacy owner`
    );
  } else {
    warn(
      `${legacyPrivacyView} changed from the legacy consent actions; production validation no longer depends on it`
    );
  }
}

function validateTrackedConfig() {
  info('Checking tracked analytics source contracts');

  const trackedContract = collectTrackedAnalyticsSourceContract(rootDir);

  if (trackedContract.clientRuntimeContainsApiSecret) {
    fail('client runtime still contains api_secret/apiSecret/API_SECRET');
  } else {
    ok('client runtime contains no api_secret/apiSecret/API_SECRET');
  }

  if (trackedContract.trackedConfigUsesPublicBuildConfigOnly) {
    ok('tracked analytics config reads only public build analytics config');
  } else {
    fail('tracked analytics config no longer matches the public build config contract');
  }

  if (trackedContract.typedAnalyticsEventMessageApiPresent) {
    ok('typed analytics runtime message facade is present');
  } else {
    fail('typed analytics runtime message facade is missing');
  }

  if (
    trackedContract.proxyContractSourcePresent &&
    trackedContract.proxyContractBarrelExportPresent &&
    trackedContract.proxyContractPublicAllowlistContractPresent &&
    !trackedContract.proxyContractSourceLeaksSensitiveAnchors &&
    trackedContract.proxyContractReportSourceAnchorsPresent
  ) {
    ok(
      'analytics proxy contract source/barrel/report anchors stay wired to the public allowlist contract'
    );
  } else {
    if (!trackedContract.proxyContractSourcePresent) {
      fail('analytics proxy contract source is missing');
    }

    if (!trackedContract.proxyContractBarrelExportPresent) {
      fail('analytics barrel is missing the public analyticsProxyContract export contract');
    }

    if (!trackedContract.proxyContractPublicAllowlistContractPresent) {
      fail('analytics proxy contract source drifted from the public allowlist contract anchors');
    }

    if (trackedContract.proxyContractSourceLeaksSensitiveAnchors) {
      fail('analytics proxy contract source must not expose endpoint/id/secret-like anchors');
    }

    if (!trackedContract.proxyContractReportSourceAnchorsPresent) {
      fail('proxy contract report tool drifted from the proxy contract source anchors');
    }
  }

  if (
    trackedContract.transportModes.length === 3 &&
    trackedContract.transportModes.join(',') === 'disabled,proxy,directDebug'
  ) {
    ok('analytics environment exposes the expected transport modes');
  } else {
    fail('analytics environment transport modes drifted');
  }

  if (trackedContract.errorReporterUsesQueueTransportAndLiveConsent) {
    ok('error reporter stays wired to the queue, transport, and live consent config');
  } else {
    fail('error reporter drifted from the queue/transport/live consent contract');
  }

  if (trackedContract.runtimeCallsGoogleEndpointsDirectly) {
    fail('runtime transport must not call Google Measurement Protocol endpoints directly');
  } else {
    ok('runtime transport does not call Google Measurement Protocol endpoints directly');
  }

  if (trackedContract.proxyBackedTransports) {
    ok('proxy and directDebug transports stay proxy-backed');
  } else {
    fail('proxy/directDebug routing no longer stays proxy-backed');
  }

  if (trackedContract.directDebugValidationIntent) {
    ok('directDebug transport marks debug validation intent for the owner proxy');
  } else {
    fail('directDebug transport is missing debug validation intent');
  }

  if (trackedContract.consentHelperExists) {
    ok('event-class analytics consent helper exists');
  } else {
    fail('event-class analytics consent helper is missing');
  }

  if (trackedContract.queueUsesSharedConsentHelper) {
    ok('analytics queue uses the shared consent helper and transport sender');
  } else {
    fail('analytics queue no longer uses the shared consent helper contract');
  }

  if (trackedContract.transportAppliesEventClassConsent) {
    ok('analytics transport applies event-class consent with eventName');
  } else {
    fail('analytics transport no longer applies event-class consent with eventName');
  }

  if (trackedContract.debugSuccessSummaryRedacted) {
    ok('production debug success log summary excludes payload and params');
  } else {
    fail('production debug success log summary drifted from the redacted P02 contract');
  }

  if (trackedContract.successLoggingScopedToDirectDebug) {
    ok('production success logging stays scoped to directDebug');
  } else {
    fail('production success logging is no longer scoped to directDebug');
  }
}

function validateBuildInjection() {
  info('Checking build-time public config injection');

  const buildScript = read('scripts/build.mjs');
  const expectedDefines = [
    '__ZENDIO_GA_MEASUREMENT_ID__',
    '__ZENDIO_GA_TRANSPORT_MODE__',
    '__ZENDIO_GA_PROXY_ENDPOINT__',
    '__AIIINOB_GA_MEASUREMENT_ID__',
    '__AIIINOB_GA_TRANSPORT_MODE__',
    '__AIIINOB_GA_PROXY_ENDPOINT__'
  ];

  for (const defineName of expectedDefines) {
    if (buildScript.includes(defineName)) {
      ok(`build injects ${defineName}`);
    } else {
      fail(`build no longer injects ${defineName}`);
    }
  }

  if (
    hasAll(buildScript, [
      "resolveGaEnv('MEASUREMENT_ID')",
      "resolveGaEnv('TRANSPORT_MODE')",
      "resolveGaEnv('PROXY_ENDPOINT')"
    ])
  ) {
    ok('build reads the expected public GA env aliases');
  } else {
    fail('build is no longer reading the expected public GA env aliases');
  }

  const forbiddenGaSecretBuildTokens = [
    "resolveGaEnv('API_SECRET')",
    "resolveGaEnv('GA4_API_SECRET')",
    '__ZENDIO_GA_API_SECRET__',
    '__AIIINOB_GA_API_SECRET__'
  ];
  if (hasAny(buildScript, forbiddenGaSecretBuildTokens)) {
    fail('build script must not inject GA api_secret or secret-like aliases');
  } else {
    ok('build script injects only public GA measurement/transport/proxy config');
  }
}

function validatePrivacyWiring() {
  info('Checking privacy and consent wiring');

  const persistence = read('src/options/app/productionStitchPersistence.ts');
  const finalAnalyticsEvent = read('src/options/app/productionStitchFinalAnalyticsEvent.ts');
  const shellActionRuntime = read('src/options/app/productionStitchShellActionRuntime.ts');

  if (
    hasAll(persistence, [
      "createAnalyticsEventMessage('privacy_consent_changed'",
      'persistPrivacyConsentAction',
      'setAnalyticsConsent',
      'updateErrorAnalyticsConfig'
    ])
  ) {
    ok('production Stitch privacy consent change wiring is present');
  } else {
    fail('production Stitch privacy consent change wiring is missing');
  }

  if (
    hasAll(persistence, ['prepareAnalyticsDataClearedEvent', 'clearAnalyticsPrivacyData']) &&
    hasAll(finalAnalyticsEvent, ["'analytics_data_cleared'", 'sendAnalyticsTransportEvent']) &&
    hasAll(shellActionRuntime, [
      'trackResourceOpen',
      "'privacy-policy': 'privacy'",
      "'data-usage': 'privacy'"
    ])
  ) {
    ok('production Stitch privacy resources and analytics data clear wiring are present');
  } else {
    fail('production Stitch privacy resource or analytics data clear wiring is missing');
  }
}

function resolvePublicEnv(newName, oldName) {
  return (process.env[newName] || process.env[oldName] || '').trim();
}

function isGoogleMeasurementProtocolEndpointUrl(url) {
  const hostname = canonicalizeEndpointHostname(url.hostname);
  if (!isGoogleAnalyticsHost(hostname)) {
    return false;
  }

  const pathParts = canonicalizeEndpointPathParts(url.pathname);
  if (!pathParts) {
    return true;
  }

  return (
    pathParts.length > 0 &&
    GOOGLE_MEASUREMENT_PROTOCOL_PATH_PARTS.some((parts) => pathParts.join('/') === parts.join('/'))
  );
}

function canonicalizeEndpointHostname(hostname) {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

function canonicalizeEndpointPathParts(pathname) {
  const parts = pathname
    .replace(/\/+$/, '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  try {
    return parts.map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return undefined;
  }
}

function isGoogleAnalyticsHost(hostname) {
  const googleAnalyticsHost = GOOGLE_ANALYTICS_HOST_PARTS.join('.');
  return hostname === googleAnalyticsHost || hostname.endsWith(`.${googleAnalyticsHost}`);
}

function validateEnvironmentVariables({
  requirePublicEnv = false,
  requireZendioEnv = false,
  requiredTransportMode
} = {}) {
  info('Checking current shell environment');

  const zendioMeasurementId = (process.env.ZENDIO_GA_MEASUREMENT_ID || '').trim();
  const zendioTransportMode = (process.env.ZENDIO_GA_TRANSPORT_MODE || '').trim();
  const zendioProxyEndpoint = (process.env.ZENDIO_GA_PROXY_ENDPOINT || '').trim();
  const measurementId = resolvePublicEnv('ZENDIO_GA_MEASUREMENT_ID', 'AIIINOB_GA_MEASUREMENT_ID');
  const transportMode = resolvePublicEnv('ZENDIO_GA_TRANSPORT_MODE', 'AIIINOB_GA_TRANSPORT_MODE');
  const proxyEndpoint = resolvePublicEnv('ZENDIO_GA_PROXY_ENDPOINT', 'AIIINOB_GA_PROXY_ENDPOINT');
  const secretLikePattern = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+|token|password|secret)/i;
  const forbiddenSecretEnvNames = [
    'GA4_API_SECRET',
    'ZENDIO_GA_API_SECRET',
    'AIIINOB_GA_API_SECRET',
    'ZENDIO_GA_SECRET',
    'AIIINOB_GA_SECRET'
  ];

  const populatedSecretEnvNames = forbiddenSecretEnvNames.filter((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });

  if (populatedSecretEnvNames.length > 0) {
    fail(
      `server-only GA secret env vars are set in the local shell/build env: ${populatedSecretEnvNames.join(', ')}`
    );
  } else {
    ok('local shell/build env contains only public GA config keys');
  }

  if (requireZendioEnv) {
    if (!zendioTransportMode) {
      fail('ZENDIO_GA_TRANSPORT_MODE is required');
    }
    if (!zendioMeasurementId) {
      fail('ZENDIO_GA_MEASUREMENT_ID is required');
    }
    if (!zendioProxyEndpoint) {
      fail('ZENDIO_GA_PROXY_ENDPOINT is required');
    }
  }

  if (!transportMode) {
    if (requirePublicEnv) {
      fail('ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE is required');
    }
    warn(
      'ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE is unset; builds will default to disabled'
    );
  } else if (!['disabled', 'proxy', 'directDebug'].includes(transportMode)) {
    fail(`ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE is invalid: ${transportMode}`);
  } else {
    ok(`transport mode is ${transportMode}`);
  }

  if (
    typeof requiredTransportMode === 'string' &&
    requiredTransportMode.length > 0 &&
    transportMode &&
    transportMode !== requiredTransportMode
  ) {
    fail(
      `ZENDIO_GA_TRANSPORT_MODE/AIIINOB_GA_TRANSPORT_MODE must be ${requiredTransportMode}: ${transportMode}`
    );
  }

  if (!measurementId) {
    if (requirePublicEnv) {
      fail('ZENDIO_GA_MEASUREMENT_ID/AIIINOB_GA_MEASUREMENT_ID is required');
    }
    warn('ZENDIO_GA_MEASUREMENT_ID/AIIINOB_GA_MEASUREMENT_ID is unset');
  } else if (!/^G-[A-Z0-9-]{4,48}$/i.test(measurementId) || /X{4,}/i.test(measurementId)) {
    fail(`measurementId format is invalid: ${measurementId}`);
  } else {
    ok(`measurementId format looks valid: ${measurementId}`);
  }

  if (proxyEndpoint) {
    try {
      const url = new URL(proxyEndpoint);
      const isHttps = url.protocol === 'https:';
      const isLocalHttp =
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
      if (!isHttps && !isLocalHttp) {
        fail(`proxy endpoint must be https or localhost http: ${proxyEndpoint}`);
      } else if (secretLikePattern.test(proxyEndpoint)) {
        fail('proxy endpoint looks like it embeds a secret-like value');
      } else if (isGoogleMeasurementProtocolEndpointUrl(url)) {
        fail(
          'proxy endpoint must be an owner proxy endpoint, not a Google Measurement Protocol endpoint'
        );
      } else {
        ok(`proxy endpoint format looks valid: ${proxyEndpoint}`);
      }
    } catch {
      fail(`proxy endpoint is not a valid URL: ${proxyEndpoint}`);
    }
  } else if (transportMode === 'proxy' || transportMode === 'directDebug') {
    fail(`${transportMode} transport requires ZENDIO_GA_PROXY_ENDPOINT/AIIINOB_GA_PROXY_ENDPOINT`);
  } else {
    if (requirePublicEnv) {
      fail('ZENDIO_GA_PROXY_ENDPOINT/AIIINOB_GA_PROXY_ENDPOINT is required');
    }
    warn('ZENDIO_GA_PROXY_ENDPOINT/AIIINOB_GA_PROXY_ENDPOINT is unset');
  }
}

function printSummary() {
  console.log('');
  if (failures > 0) {
    paint('red', `FAIL Validation finished with ${failures} failure(s) and ${warnings} warning(s)`);
    process.exitCode = 1;
    return;
  }

  ok(`Validation finished with 0 failures and ${warnings} warning(s)`);
  info('The repo remains proxy-first and client-side public-config-only.');
}

export function runAnalyticsValidation({
  requirePublicEnv = false,
  requireZendioEnv = false,
  requiredTransportMode
} = {}) {
  failures = 0;
  warnings = 0;
  validateRequiredFiles();
  validateTrackedConfig();
  validateBuildInjection();
  validatePrivacyWiring();
  validateEnvironmentVariables({ requirePublicEnv, requireZendioEnv, requiredTransportMode });
  printSummary();
  return { failures, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runAnalyticsValidation({
    requirePublicEnv: process.argv.includes('--require-env'),
    requireZendioEnv: process.argv.includes('--require-zendio-env'),
    requiredTransportMode: process.argv.includes('--require-proxy-transport') ? 'proxy' : undefined
  });
}
