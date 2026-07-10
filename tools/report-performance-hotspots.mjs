import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

const MAX_LINE_BUDGETS = new Map([
  ['src/i18n/generated/localeRegistry.generated.ts', 8899],
  ['src/i18n/generated/schemaMessages.generated.ts', 481],
  // 2026-06-29 v0.2.1 changelog sync: schema core now carries the accepted
  // Options/Stitch release-note keys in addition to existing resource copy.
  ['src/i18n/generated/schemaCore.generated.ts', 444],
  // 2026-06-29 v0.2.1 changelog sync: generated runtime messages carry the
  // accepted Options/Stitch release-note catalog keys.
  ['src/i18n/generated/messages.generated.ts', 1137],
  ['src/i18n/generated/locales/fr.generated.ts', 785],
  ['src/i18n/generated/locales/es-419.generated.ts', 777],
  ['src/i18n/generated/locales/es-ES.generated.ts', 777],
  ['src/i18n/generated/locales/de.generated.ts', 776],
  ['src/i18n/generated/locales/it.generated.ts', 769],
  ['src/i18n/generated/locales/pt-BR.generated.ts', 769],
  ['src/i18n/generated/locales/ru.generated.ts', 767],
  ['src/i18n/generated/locales/en.generated.ts', 744],
  ['src/i18n/generated/locales/ja.generated.ts', 744],
  ['src/i18n/generated/locales/ko.generated.ts', 732],
  ['src/i18n/generated/locales/zh-CN.generated.ts', 695],
  ['src/i18n/generated/locales/zh-TW.generated.ts', 690],
  ['src/options/stitch/content.ts', 841],
  ['src/options/yaml-config-editor/view.ts', 746],
  // 2026-06-23 P05 Options/Stitch decomposition: extracted YAML row DOM
  // rendering keeps the public YAML editor facade stable.
  ['src/options/yaml-config-editor/fieldRowsView.ts', 257],
  // 2026-06-23 P05 Options/Stitch decomposition: domain override table
  // rendering moved behind the YAML editor facade.
  ['src/options/yaml-config-editor/domainRulesView.ts', 282],
  // 2026-06-20 Options/onboarding closeout: current Stitch schema type surface
  // includes the accepted resource modal and first-run setup contracts.
  ['src/options/stitch/types.ts', 771],
  // 2026-06-23 P05 Options/Stitch decomposition: schema/context type owner
  // carries the browser-target field while the legacy type path remains a facade.
  ['src/options/stitch/types/schemaTypes.ts', 366],
  ['src/options/stitch/ui/components.ts', 592],
  ['src/third_party/ai-chat-exporter/platforms/gemini.ts', 576],
  // 2026-06-25 AI chat parser P09 repair: Perplexity keeps readable
  // selector arrays; the explicit budget tracks the restored parser hotspot.
  ['src/third_party/ai-chat-exporter/platforms/perplexity.ts', 281],
  ['src/options/stitch/schema/builders/surfaces.ts', 558],
  // 2026-06-23 P05 Options/Stitch decomposition: shared surface chrome
  // helpers back the stable surface-builder facade.
  ['src/options/stitch/schema/builders/surfaceChrome.ts', 275],
  ['src/shared/attachments/videoScreenshotAttachmentTemplates.ts', 523],
  ['src/options/app/productionStitchStateMapper.ts', 517],
  // 2026-06-23 P05 Options/Stitch decomposition: pure theme/state seed
  // mapping moved behind the production state mapper facade.
  ['src/options/app/stateMapper/themeStateMapper.ts', 206],
  ['src/content/clipper/components/clipperDialogController.ts', 511],
  ['src/content/reader/services/highlightManager.ts', 505],
  ['src/shared/di/serviceRegistry.ts', 496],
  // 2026-06-12 P03b: accepted P02 telemetry contract schema growth.
  ['src/shared/analytics/eventCatalog.ts', 541],
  // 2026-06-13 GA P01: schema-owned contract replaces duplicated catalog and
  // sanitizer tables; current exact schema hotspot budget is the new source of truth.
  ['src/shared/analytics/schema/analyticsSchema.ts', 527],
  ['src/content/video/sessionOperations.ts', 433],
  ['src/content/video/platforms/bilibiliRichText.ts', 302],
  ['src/content/video/platforms/bilibiliPlatformObserver.ts', 286],
  ['src/ui/domains/video/VideoDialog.ts', 468],
  // 2026-06-20 Options/onboarding closeout: keep current video prompt lifecycle
  // line count explicit so the hotspot gate reaches later CI checks.
  ['src/content/video/videoPromptLifecycle.ts', 491],
  ['src/shared/analytics/analyticsSanitizers.ts', 460],
  ['src/background/pipelines/connectionTest.ts', 697],
  ['src/onboarding/bootstrap.ts', 556],
  ['src/background/services/notifications.ts', 451],
  ['src/background/trialLifecycle.ts', 276],
  ['src/shared/config/optionsMerger.ts', 406],
  ['src/dev/localVaultWriteHarness.ts', 411],
  // 2026-06-11: Session mutation architecture adds fail-closed terminal draft
  // finalization and shared transaction plumbing across reader/video surfaces.
  ['src/content/video/videoSessionRuntime.ts', 531],
  // 2026-06-13 final combined integration: queue now carries explicit visible
  // capture request tracking while preserving the lazy screenshot preparation split.
  ['src/content/video/videoScreenshotPreparationQueue.ts', 401],
  // 2026-06-14 video screenshot cache P02: storage repository is lazy-owned by
  // draft restore/write-through milestones and keeps image bytes outside drafts.
  ['src/content/video/videoScreenshotCacheRepository.ts', 423],
  // 2026-07-11 P11 review: the extracted types barrel must stay below discovery.
  ['src/content/video/videoScreenshotCacheTypes.ts', 250],
  // 2026-06-17 video screenshot cache P09: background-owned IndexedDB blob store
  // keeps screenshot bytes outside storage.local and owns the DOM IDB facade.
  ['src/background/services/videoScreenshotCacheIndexedDbStore.ts', 331],
  // 2026-07-10 P11: live policy discrimination and repository lifecycle moved
  // behind a focused runtime; keep the service below the discovery threshold.
  ['src/background/services/videoScreenshotCacheService.ts', 250],
  // 2026-06-17 video screenshot cache main integration: draft screenshot restore,
  // terminal cleanup, and best-effort cache maintenance stay in a focused helper.
  ['src/content/video/videoSessionDraftScreenshotCache.ts', 251],
  // 2026-06-13 final combined integration: request state moved out of the lazy
  // coordinator and now tracks explicit visible requests so dependency-cruiser can
  // enforce the screenshot preparation split without cycles.
  ['src/content/video/videoScreenshotPreparationRequestStore.ts', 294],
  ['src/content/video/videoScreenshotPreparationCoordinator.ts', 147],
  ['src/content/reader/ui/ReaderDialogPanel.ts', 405],
  ['src/content/reader/session.ts', 575],
  ['src/content/video/videoControlBarButton.ts', 299],
  // 2026-06-20 support-link closeout: runtime surface copy now uses the shared
  // Zendio link registry while preserving the existing surface renderer split.
  ['src/content/stitch/runtimeSurfaceContent.ts', 409],
  ['src/options/components/infrastructure/listBuilder.ts', 378],
  ['src/shared/exportDestination.ts', 369],
  ['src/ui/domains/reading/ReaderDialog.ts', 371],
  // 2026-06-13 final combined integration: screenshot status dots and add-note
  // focus/layout regressions are covered in the panel while retaining the current UI.
  ['src/content/video/ui/VideoDialogPanel.ts', 392],
  ['src/options/app/productionStitchPersistence.ts', 379],
  ['src/shared/errors/analytics/analyticsConfig.template.ts', 364],
  ['src/shared/errors/analytics/analyticsConfig.ts', 383],
  ['src/dev/contentOrchestratorHarness.ts', 359],
  ['src/options/app/productionStitchShellActionRuntime.ts', 358],
  ['src/background/services/obsidianWriter.ts', 423],
  ['src/background/vault-router.ts', 422],
  ['src/shared/state/globalStateManager.ts', 345],
  ['src/content/reader/sessionOperations.ts', 643],
  ['src/i18n/config.ts', 343],
  ['src/content/ui/supportPrompt.ts', 345],
  ['src/options/services/connectionTester.ts', 368],
  ['src/shared/config/provider.ts', 325],
  ['src/shared/errors/analytics/googleAnalyticsReporter.ts', 260],
  ['src/content/video/platforms/baseVideoPlatform.ts', 291],
  ['src/shared/errors/analytics/dataSanitizer.ts', 316],
  ['src/content/video/videoPromptMountLifecycle.ts', 313],
  // 2026-06-20 Options/onboarding closeout: diagnostics remains a current
  // production hotspot and is tracked at its exact branch line count.
  ['src/options/components/diagnostics.ts', 627],
  // 2026-06-23 P05 Options/Stitch decomposition: diagnostics rendering and
  // fix actions moved behind the diagnostics facade without changing exports.
  ['src/options/components/diagnostics/diagnosticsRenderer.ts', 85],
  // 2026-06-23 P05 Options/Stitch decomposition: diagnostics model building
  // moved behind the diagnostics facade as the production report owner.
  ['src/options/components/diagnostics/diagnosticsModel.ts', 325],
  ['src/options/state/vaultRouterStore.ts', 308],
  ['src/components/trial-notice.ts', 376],
  ['src/content/clipper/services/contextCapture.ts', 305],
  // 2026-06-12 P03: video session draft ownership moved into a focused controller.
  ['src/content/video/videoSessionDraftController.ts', 401],
  ['src/options/app/productionStitchActions.ts', 302],
  ['src/options/app/productionStitchLocalization.ts', 350],
  ['src/options/app/vaultConnectionTests.ts', 290],
  ['src/options/stitch/schema/settings/overview.ts', 429],
  ['src/options/stitch/schema/settings/capture-behavior.ts', 271],
  ['src/content/video/videoPromptRenderer.ts', 291],
  ['src/options/stitch/schema/settings/output.ts', 333],
  ['src/content/reader/utils/markdownBuilder.ts', 288],
  ['src/options/app/productionStitchShellState.ts', 254],
  ['src/content/bootstrap.ts', 252],
  ['src/platform/chrome/contextMenus.ts', 285],
  ['src/content/shared/panels/sessionPanelResize.ts', 284],
  ['src/background/application/clipProcessor.ts', 470],
  ['src/infrastructure/restClient.ts', 266],
  ['src/shared/services/yamlConfigSanitize.ts', 277],
  ['src/ui/domains/vault-router/VaultRouterView.ts', 277],
  ['src/options/stitch/render/nodeRenderers.ts', 274],
  ['src/third_party/ai-chat-exporter/shared/markdownLanguage.ts', 273],
  ['src/options/stitch/schema/settings/capture-sources.ts', 272],
  ['src/options/yaml-config-editor/validation.ts', 269],
  ['src/background/llm/classifier.ts', 262],
  // 2026-06-13 final combined integration: runtime messages own the visible-tab
  // screenshot request boundary used by video export preparation.
  // 2026-07-10 P11: the live screenshot policy input remains a one-line
  // composition-root seam after the shared input type extraction.
  ['src/background/listeners/runtimeMessages.ts', 376],
  ['src/background/services/usageStats.ts', 266],
  ['src/background/application/videoScreenshotAttachmentPlanner.ts', 269],
  ['src/third_party/ai-chat-exporter/platforms/tongyi.ts', 274],
  ['src/options/utils/localizedText.ts', 264],
  ['src/options/services/connectionTestRunner.ts', 338],
  ['src/content/video/sessionPlatformController.ts', 260],
  ['src/content/runtime/contentMessageHandlers.ts', 259],
  ['src/i18n/adapters/domBindingAdapter.ts', 257],
  ['src/background/listeners/contextMenusCoordinator.ts', 258],
  ['src/content/runtime/contentLazyRuntime.ts', 258],
  // 2026-06-18 options support closeout: modal link rendering and QR overlay
  // wiring live in the shared content renderer to keep Stitch schemas declarative.
  ['src/options/stitch/render/contentRenderers.ts', 406],
  // 2026-06-20 Options/onboarding closeout: shell builder ownership stays in
  // the render layer and is now tracked once it crosses the hotspot threshold.
  ['src/options/stitch/render/shellBuilders.ts', 257],
  ['src/shared/guards/dom.ts', 256],
  ['src/content/reader/services/exporter.ts', 255],
  ['src/content/video/fragmentHighlighter.ts', 254],
  ['src/ui/domains/privacy/PrivacySettingsView.ts', 254],
  ['src/options/app/productionStitchShellMount.ts', 254],
  ['src/options/app/productionStitchRenderLifecycle.ts', 253],
  // 2026-06-19 Options YAML editor stabilization: row aggregation, editable
  // domain override cells, and scroll-target ownership stay in this row model.
  ['src/options/yaml-config-editor/rowModel.ts', 269],
  // 2026-07-10 P11: owner action handlers are explicitly threaded from the
  // public bootstrap into the production shell and are guarded by unit tests.
  ['src/options/app/bootstrap.ts', 258],
  ['src/options/stitch/schema/resources/onboarding.ts', 251],
  // 2026-06-20 onboarding closeout: Chrome/Firefox first-run setup guidance
  // keeps Local Folder and REST fallback instructions centralized here.
  ['src/options/stitch/schema/resources/setup-guide.ts', 255],
  ['src/third_party/ai-chat-exporter/platforms/kimi.ts', 258],
  ['src/i18n/catalog/languages.ts', 280],
  ['src/content/sessionDrafts/sessionDraftRepository.ts', 398],
  ['src/content/reader/sessionDrafts.ts', 299],
  ['src/utils/trial-manager.ts', 363],
  ['src/content/runtime/localVaultPermissionFrame.ts', 345],
  ['src/content/extractors/aiChatExtractor.ts', 299],
  ['src/content/ui/supportPromptMessages.ts', 301],
  // 2026-06-18 options support closeout: runtime support prompt toast lifecycle
  // was split into a dedicated controller with deterministic cleanup.
  ['src/content/ui/supportPrompt/SupportPromptToastController.ts', 300],
  // 2026-06-18 options support closeout: task-success surface owns the feedback
  // and support schema copy used by production runtime previews.
  ['src/options/stitch/schema/surfaces/task-success.ts', 276],
  // 2026-06-23 P05 Options/Stitch decomposition: runtime surface content moved
  // out of the monolithic Stitch content seed behind the stable facade.
  ['src/options/stitch/content/runtimeSurfaceContent.ts', 283],
  ['src/background/pipelines/clipPipeline.ts', 253],
  // 2026-06-19 Options shortcut copy stabilization: platform-aware modifier
  // labels and keyboard mappings are centralized for Options rendering.
  ['src/options/app/fragmentModifierOptions.ts', 277],
  // 2026-06-19 Options YAML editor stabilization: preview generation is owned
  // by current editor state plus active content-type/filter selection.
  ['src/options/yaml-config-editor/preview.ts', 262],
  // 2026-06-20 onboarding closeout: first-run resources render through a local
  // lightweight modal instead of importing the full Options/Stitch renderer.
  ['src/onboarding/resourceModal.ts', 585],
  // 2026-06-18 GA telemetry acceptance: activation lifecycle, bounded event
  // transport, and release smoke wiring are production hotspots in the final
  // GA integration branch; these budgets are exact current-line gates.
  ['src/background/services/analyticsActivation.ts', 265],
  ['src/background/services/analyticsEvents.ts', 363],
  ['src/shared/analytics/analyticsTransport.ts', 265],
  // 2026-06-18 GA telemetry acceptance: reader/video export shape telemetry
  // adds small guarded hotspots around existing mutation and completion flows.
  ['src/content/video/videoCaptureMutationTransaction.ts', 257]
]);

const PATTERNS = [
  ['deepClone', /\bdeepClone\b/g],
  ['JSON.stringify', /JSON\.stringify/g],
  ['querySelector', /\.querySelector(All)?\(/g],
  ['getElementById', /\.getElementById\(/g],
  ['addEventListener', /\.addEventListener\(/g],
  ['setInterval', /\bsetInterval\(/g],
  ['MutationObserver', /\bMutationObserver\b/g],
  ['ResizeObserver', /\bResizeObserver\b/g]
];

function parseArgs(argv) {
  const options = {
    root: ROOT,
    budgetJson: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a value');
      }
      options.root = value;
      index += 1;
      continue;
    }
    if (arg === '--budget-json') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--budget-json requires a value');
      }
      options.budgetJson = value;
      index += 1;
      continue;
    }
    if (arg === '--check') {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function normalizeRelativePath(path) {
  return path.replaceAll('\\', '/');
}

function readBudgetMap(budgetJson) {
  if (!budgetJson) {
    return new Map(MAX_LINE_BUDGETS);
  }

  const parsed = JSON.parse(readFileSync(budgetJson, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--budget-json must contain an object of relative path to line budget');
  }

  return new Map(
    Object.entries(parsed).map(([relativePath, budget]) => {
      if (!Number.isInteger(budget) || budget < 1) {
        throw new Error(`Invalid line budget for ${relativePath}: ${budget}`);
      }
      return [normalizeRelativePath(relativePath), budget];
    })
  );
}

function isSourceModulePath(relativePath) {
  return (
    relativePath.startsWith('src/') &&
    (relativePath.endsWith('.ts') || relativePath.endsWith('.tsx'))
  );
}

function readGitPaths(root, args) {
  const output = execFileSync('git', ['-C', root, 'ls-files', ...args], {
    encoding: 'utf8'
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeRelativePath)
    .filter(isSourceModulePath)
    .filter((relativePath) => existsSync(join(root, relativePath)));
}

function listCurrentSourceFiles(root) {
  return [
    ...new Set([
      ...readGitPaths(root, ['--', 'src']),
      ...readGitPaths(root, ['--others', '--exclude-standard', '--', 'src'])
    ])
  ].sort((left, right) => left.localeCompare(right));
}

function countMatches(source) {
  return Object.fromEntries(
    PATTERNS.map(([label, pattern]) => [label, [...source.matchAll(pattern)].length])
  );
}

function countLines(source) {
  return source.split('\n').length;
}

export function collectPerformanceHotspots({
  root = ROOT,
  budgets = new Map(MAX_LINE_BUDGETS),
  sourceFiles = listCurrentSourceFiles(root)
} = {}) {
  const trackedSourceSet = new Set(sourceFiles);
  const staleBudgetPaths = [...budgets.keys()].filter(
    (relativePath) => !trackedSourceSet.has(relativePath)
  );

  const rows = sourceFiles
    .map((relativePath) => {
      const source = readFileSync(join(root, relativePath), 'utf8');
      return {
        relativePath,
        lineCount: countLines(source),
        counters: countMatches(source),
        lineBudget: budgets.get(relativePath)
      };
    })
    .filter((row) => row.lineCount > 250)
    .sort(
      (left, right) =>
        right.lineCount - left.lineCount || left.relativePath.localeCompare(right.relativePath)
    );

  const missingBudgetPaths = rows
    .filter((row) => row.lineBudget === undefined)
    .map((row) => row.relativePath);
  const exceededBudgetRows = rows.filter(
    (row) => row.lineBudget !== undefined && row.lineCount > row.lineBudget
  );

  return {
    rows,
    sourceFileCount: sourceFiles.length,
    dynamicHotspotCount: rows.length,
    registeredBudgetCount: budgets.size,
    missingBudgetPaths,
    staleBudgetPaths,
    exceededBudgetRows,
    ok:
      missingBudgetPaths.length === 0 &&
      staleBudgetPaths.length === 0 &&
      exceededBudgetRows.length === 0
  };
}

export function formatPerformanceHotspots(report) {
  const lines = report.rows.map((row) => {
    const counters = PATTERNS.map(([label]) => `${label}=${row.counters[label]}`).join(', ');
    return `${row.relativePath}: lines=${row.lineCount}, ${counters}`;
  });

  lines.push(
    `dynamic hotspot coverage: sourceFiles=${report.sourceFileCount}, hotspotsOver250=${report.dynamicHotspotCount}, registeredLineBudgets=${report.registeredBudgetCount}`
  );

  return lines.join('\n');
}

function printFailures(report) {
  if (report.missingBudgetPaths.length > 0) {
    console.error(
      `Missing line budgets for dynamically discovered hotspots:\n${report.missingBudgetPaths
        .map((relativePath) => `- ${relativePath}`)
        .join('\n')}`
    );
  }
  if (report.staleBudgetPaths.length > 0) {
    console.error(
      `Stale line budgets reference non-current src files:\n${report.staleBudgetPaths
        .map((relativePath) => `- ${relativePath}`)
        .join('\n')}`
    );
  }
  for (const row of report.exceededBudgetRows) {
    console.error(
      `${row.relativePath} exceeds hotspot line budget: ${row.lineCount} > ${row.lineBudget}`
    );
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = collectPerformanceHotspots({
    root: options.root,
    budgets: readBudgetMap(options.budgetJson)
  });

  console.log(formatPerformanceHotspots(report));
  if (!report.ok) {
    printFailures(report);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
