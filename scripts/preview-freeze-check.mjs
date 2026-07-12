import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function findOriginalReferenceRoot(startDir) {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, 'future/options-component-preview 2');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

const trackedDigestsOnly = process.argv.includes('--tracked-digests-only');
const originalReferenceRoot = trackedDigestsOnly ? null : findOriginalReferenceRoot(repoRoot);
const currentRoot = path.join(repoRoot, '.tmp/preview-freeze-current/options-component-preview');
const reportPath = path.join(repoRoot, '.tmp/preview-freeze-current/report.json');
const productionSourceHtml = path.join(repoRoot, 'src/options/index.html');
const productionBuiltHtml = path.join(repoRoot, 'build/dist/options/index.html');
const updateBaseline = process.argv.includes('--update-baseline');
const REQUIRED_EQUAL_COMPARISONS = new Set([
  'production source options/index.html vs latest built options/index.html'
]);
const REQUIRED_NON_EMPTY_COMPARISONS = new Set([
  'current generated standalone preview is non-empty'
]);
const ALLOWED_PREVIEW_DRIFT = new Map([
  [
    'original reference index.html vs current generated preview index.html',
    {
      reason:
        'Generated Stitch Secondary preview HTML intentionally carries the owner-approved Zendio title from scripts/build-preview.mjs while preserving the frozen original reference as the truth source. This drift is backed by the Zendio assets/marketing evidence and is limited to the deterministic product-title refresh.',
      leftSha256: 'bb5ff6b884fffe81bc5dcc1d8e9c32d2d79d6645d23efbc68b13567d229a62ff',
      rightSha256: 'c74e262b77e804a25be4f43ac095f36d4dd69e63db9156b9fff7fe856659162c'
    }
  ],
  [
    'original reference styles.css vs current generated preview styles.css',
    {
      reason:
        'Generated Stitch Secondary runtime CSS intentionally includes production-only parity rules, schema-registered floating prompt styles, the product-approved non-blocking Reader/Video bottom-right floating runtime placement, the Clipper no-backdrop-blur runtime overlay, compact one-to-two-line Clipper comments, compact session headers, lighter video capture markers, shrink-safe session footer actions, unified video add marker colors, the resizable session panel handle, collapsible Reader/Video session headers that align the collapse control with the title line, shrink to content-fit bottom-right title-only header chrome, hide collapsed subtitle/expand controls, and release the collapsed transparent area from pointer hit testing, reduced session icon chrome, no-glow session export buttons, bottom-aligned compact resource links, non-compressing Reader/Video session item rows, two-line expandable captured text previews, shared Clipper/Reader/Video export destination preview/dropdown styling with Clipper opening downward outside the Clipper window bounds, Clipper destination dropdown vault/path values kept on one line, Reader/Video destination dropdown values wrapping only when needed, caret-free export destination summaries, session destination and footer sharing one divider line, compact session footer buttons/counter alignment, session panels opening upward, light runtime border tokens aligned to the Stitch accent instead of gray/black chrome, the release-hidden Experimental panel card selector, inline-scrolling YAML field tables with sticky headers, polished Stitch-token YAML action/delete buttons, release-hidden Deep Research styles, and the production bottom-right content-fit task-success panel with contiguous header/support/feedback sections plus a Stitch-tokenized bottom-right support toast absent from the frozen original reference. The session content UI landing refreshes Reader/Video/Clipper content density tokens, centers video timestamp markers, and makes the timestamp-to-fragment gap share the adjacent timestamp gap while preserving the frozen reference and preview runtime contract. Fragment modifier single-select adds the warning helper line wrapping for shortcut-conflict guidance while preserving the frozen reference and preview runtime contract. The Options support resource refresh adds non-compressing resource-card icons and QR previews plus task-success QR image styling while preserving the frozen reference and preview runtime contract. The icon theme contract refresh keeps resource/support SVG icons unfiltered in light mode and scopes the dark-mode inversion to document and runtime-surface theme hosts while preserving QR and image media without filters.',
      leftSha256: '8df52cb64cbd04975f9f005641d087e4aeddcd0f62b7a86695432caf213e87b8',
      rightSha256: '79ec11e43c809fc1eb6b2a41fc07a9629c7c34bbe07c90b49575bb9c09aa8b04'
    }
  ],
  [
    'original reference index.js vs current generated preview index.js',
    {
      reason: [
        'Generated Stitch Secondary preview JS intentionally carries the previously approved SVG-aware Stitch DOM helper, production parity/runtime harness wiring, schema-registered runtime surfaces, Reader/Video item-level session controls, the shared Reader/Video collapse action, Clipper removal of preview-incompatible visible cancel/comment/selection labels and the empty comment preview block, the inline video capture action plus readonly add-note trigger, persistent video control-bar auto-pause/screenshot preferences, the System interface theme preference, shared Clipper/Reader/Video export destination preview/dropdown content without visible destination carets, shared session width/height resize handle wiring, video fragment captures rendered as reader-style numbered text items with text-note placeholders, Zendio production branding, QR-free task-success feedback toasts, the product-approved removal of the visible Settings sidebar title, production onboarding page routing from the Options resource link, release-hidden Experimental panel, Deep Research, AI timestamp, advanced video schema, prompt label/shortcut controls, and classifier placeholders, the performance branch classification timeout fallback enum, one-month Usage Dashboard history padding, Fragment modifier in-place chip sync, YAML button event containment, mouse-scroll-stable Stitch action buttons, render scroll restoration for Options actions, the video note-button switch and screenshot-dot guidance rendered in Video Prompt & Entry body rows, default Domain Mappings restoration with an editable blank row only after user deletion plus inline-scrolling table chrome, Routing Rules canonical de-duplication, video timestamp screenshot toggle state rendered before the timestamp label, and the product-approved Reader/Video/task-success bottom-right floating runtime contract with no static task-success toast previews, compact feedback row, and Stitch-tokenized runtime toast root. Batch 2.5 additionally adds REST and vault local-folder File System Access controls, local-folder picker/remove/reauthorization actions, default-vault local-folder metadata syncing, storage schema wiring for local-folder rows, Options runtime routing/bootstrap preservation, button-action scroll preservation, and a task-success progress schema/content field absent from the frozen original reference. Milestone 7 relocates the preview-backed verification runtime from the retired source tree to tests/fixtures/options-preview while preserving the same frozen reference comparison contract. Milestone 10 splits the YAML Config Widget into adapter, controller, model conversion, validation presentation, field table rendering, and domain override rendering modules while preserving the production Stitch runtime contract. Milestone 13 splits the Stitch renderer into action, form, content, and node renderer modules while preserving the production Stitch runtime contract. Final verification stabilizes the preview bundle hash after the legacy fragment collectChanges return simplification without changing the frozen reference, freeze-check logic, or production behavior. The completion-audit format pass refreshes the generated JS hash after repo-wide Prettier normalization without changing the frozen reference or preview behavior. M3.1 splits the schema runtime renderer into context, widget lifecycle, hero, control, table, structural, element, node dispatch, and view modules while preserving the frozen reference and production Stitch runtime behavior. M5.4 refreshes the generated preview JS hash after the direct esbuild upgrade from ^0.23.0 to ^0.28.0. M3.3 refreshes the generated preview JS hash after production YAML sanitize guard narrowing changed bundled helper output while preserving the preview source, frozen reference, and Stitch runtime contract. M4 extracts native YAML widget DOM helpers into a thin typed module while preserving the preview source, frozen reference, and Stitch runtime contract. C1/C2 adds the config transfer sanitizer and StoredOptions root strip policy to the preview-backed Options runtime bundle while preserving the frozen reference, production copy/import behavior, and Stitch runtime contract. C3/C4 hardens classification and clip boundary schemas with strip semantics and bounded production meta fields, which changes only the schema runtime emitted into the preview bundle while preserving the frozen reference and visual/runtime preview contract. Plan 02 switches the preview YAML adapter to YamlConfigEditorWidgetAdapter while preserving widgetType: yaml-config, the Stitch runtime contract, and the original reference. Plan 09 strict typing repair refreshes the generated JS hash after exactOptionalPropertyTypes-safe YAML editor object construction without changing the frozen reference, freeze-check logic, or Stitch runtime behavior. YAML/Options retirement repair refreshes the generated JS hash after wiring the current YAML editor labels to injected i18n messages and default runtime message fallback while preserving the same Stitch widget contract. YAML runtime gap repair refreshes the generated JS hash after preserving disabled overrides for default custom fields and moving import-time YAML legacy-shape normalization ahead of StoredOptions schema validation while preserving the frozen reference and Stitch widget contract. YAML default custom field identity repair refreshes the generated JS hash after locking default custom field delete/rename controls and diffing default custom field overrides by stable baseline identity while preserving the frozen reference and Stitch widget contract. YAML default custom field cell-scope repair refreshes the generated JS hash after making non-owner content-type cells non-operable for default custom field rows while preserving explicit Add field behavior, baseline diff semantics, the frozen reference, and Stitch widget contract. YAML row-model shape repair refreshes the generated JS hash after extracting YAML field row aggregation/cell operability into a dedicated row model module while preserving runtime behavior and the frozen reference contract. The session content UI landing adds video capture kind dataset markers so runtime CSS can distinguish timestamps from fragments while preserving the frozen reference and preview runtime contract. The video comment editor playback policy repair refreshes the generated preview JS hash after adding the video.commentEditorAutoPause Options/Stitch control, schema/default option wiring, and config merger output while preserving the frozen reference and Stitch runtime contract. M07 refreshes the generated preview JS hash after moving schema shell copy into generated catalog/schema artifacts while preserving the frozen reference and Stitch runtime contract. M09 refreshes the generated preview JS hash after enabling the dev-only qps pseudo locale catalog/registry path in preview builds while preserving production NODE_ENV gating, the frozen reference, and Stitch runtime behavior. M12 refreshes the generated preview JS hash after replacing handwritten locale modules with catalog JSON source plus generated locale modules while preserving the frozen reference, production NODE_ENV gating, and Stitch runtime behavior. The Zendio rename/main reconciliation refreshes the generated preview JS hash after merging current main GA telemetry and i18n catalog artifacts into the Zendio rename integration branch while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'Zendio 0.2.0 hides Advanced Connection Schema and Output Presets from Options, refreshing the generated preview JS hash while preserving the frozen reference and underlying storage/preset logic. The Options UI closeout refreshes the generated preview JS hash after changing Local Folder deletion from a popover to an in-place delete state, moving Video Prompt & Entry switches into body rows, and making sidebar navigation set the main scroller immediately while preserving the frozen reference and Stitch runtime contract.',
        'Fragment modifier single-select and Vault guidance refresh adds the modifier conflict guidance, Storage/Reading plugin support notes, and structured local-folder/HTTPS/HTTP Vault List connection results with HTTPS certificate trust links while preserving the Stitch runtime contract.',
        'The accepted video screenshot attachment location follow-up refreshes the generated preview JS hash after adding the Options controls, nested video screenshot attachment state wiring, and screenshot attachment copy needed for the feature while preserving the frozen reference and Stitch runtime contract. The final integration ratchet repair refreshes the generated preview JS hash after removing accepted feature-local unknown/cast debt and restoring the planner hotspot line budget without changing the frozen reference or Stitch runtime contract.',
        'The PR #26 main sync refreshes the generated preview JS hash after combining the accepted video screenshot attachment location controls with the Options fragment modifier and Vault guidance runtime while preserving the frozen reference and Stitch runtime contract.',
        'The video legacy recovery integration refreshes the generated preview JS hash after making video timestamp note inputs use the stable draft/comment value authority and preserving the screenshot-toggle-before-timestamp runtime contract without changing the frozen reference or Stitch runtime contract.',
        'The P14 final integration refreshes the generated preview JS hash after accepted i18n finalization, stop-unknown orphan deletion, dependency-cruiser cycle repair, and lint-only callback/parser tightening while preserving the frozen reference and Stitch runtime contract.',
        'The video attachment layout i18n sync refreshes the generated preview JS hash after merging the accepted Options 12-language catalog baseline with the video entry/attachment path layout, hiding Output Presets, splitting the capture-sources video schema helper, and removing unnecessary helper-local type assertions while preserving the frozen reference and Stitch runtime contract.',
        'The post-audit Options i18n repair refreshes the generated preview JS hash after restoring the full schema-backed changelog release notes across 12 languages and removing the stale Deep Research navigation hint while preserving the frozen reference and Stitch runtime contract.',
        'The video control-bar UI debt migration refreshes the generated preview JS hash after adding the schema-registered video-control-bar popover runtime surface, moving static video panel role attributes into Stitch-owned schema output, and threading optional ButtonNode datasets through the existing Stitch button renderer while preserving the frozen reference, control-bar geometry contract, and Stitch runtime behavior.',
        'This accepted cumulative hash refresh also includes P01 runtime/schema i18n split, P02 analytics contract bundling, P05 shared template-default owner plus platform runtime-port import graph changes, and the video screenshot export-state repair with explicit off/pending/on screenshot state through the Video runtime surface and Stitch timestamp marker schema while preserving the frozen reference, existing toggle geometry, export-without-recapture contract, control-bar geometry contract, and Stitch runtime behavior.',
        'P02 refreshes the generated preview JS hash again because catalogizing Options/Stitch preview schema and sample copy adds the new schema-backed preview message keys and regenerated schema messages while preserving the frozen reference and preview runtime contract.',
        'The follow-up P02 stat-label preservation keeps the historical preview copy `Total saved` via the narrow schemaPreviewUsageTotalLabel key, which changes only the generated preview/schema message bundle while preserving the frozen reference and production runtime contract.',
        'P03 refreshes the generated preview JS hash after replacing Options resource schema inline English fallback prose with typed catalog-backed fallback resolution. This changes the generated preview bundle while preserving the frozen reference and keeping the Stitch runtime contract under verify:stitch-secondary.',
        'P04 refreshes the generated preview JS hash after removing the remaining Options settings/surfaces catalog fallback literals, including the controller-audited overview consent fallback, while preserving the frozen reference and Stitch runtime contract.',
        'P07 refreshes the generated preview JS hash after splitting generated schema messages into schemaCore plus per-locale schema modules and keeping the preview path on the English schema fallback only, while preserving the frozen reference and Stitch runtime contract.',
        'P07b refreshes the generated preview JS hash after making production Stitch localization preserve omitted optional runtime destination fields under exactOptionalPropertyTypes while preserving the frozen reference and Stitch runtime contract.',
        'The English uncatalogued-copy audit coverage follow-up refreshes the generated preview JS hash after replacing preview seed hint/subtitle/body literals with catalog-backed message lookups and extracting preview navigation seed ownership while preserving the frozen reference and Stitch runtime contract.',
        'The English numbered UI title audit follow-up refreshes the generated preview JS hash after replacing plugin setup preview seed raw numbered step titles with existing catalog-backed schema message lookups while preserving the frozen reference and Stitch runtime contract.',
        'The 0.2.0 release-gates repair also replaces YAML editor fallback value imports and preview-reachable Options formatMessage barrel imports with slim local fallback copy plus the lightweight @i18n/messageFormatter entry, removing the full i18n runtime/localeService/generated-locale graph from the preview bundle while preserving YAML labels, fragment modifier warnings, and the Stitch preview contract. The English gate/main merge keeps Options/Stitch fallback copy catalog-backed through the English runtime catalog source plus the generated English schema fallback, without restoring localeService or the generated all-locale registry.',
        'The Options support resource refresh replaces the old Afdian support channel with a WeChat reward icon plus cropped QR image, adds icons to support/suggestion resource cards, removes the visible Support Scope section, and keeps the task-success runtime support strip on the same Stitch schema contract.',
        'The Options resource URL resolver repair refreshes the generated preview JS hash after routing resource-card icon and preview image paths through the production extension-root asset resolver while preserving the frozen reference and Stitch runtime contract.',
        'The runtime support prompt repair refreshes the generated preview JS hash after removing terminal-progress auto dismiss, threading Stitch runtime action args, and making the task-success WeChat reward QR an explicit click-to-expand image while preserving the frozen reference and Stitch runtime contract.',
        'The support resource QR modal repair refreshes the generated preview JS hash after moving Options WeChat reward QR display from inline card preview to a centered image modal, removing visible resource-card Open actions, making Contact cards link by platform name without visible URLs, and changing runtime task-success WeChat reward clicks from inline QR expansion to a non-auto-dismiss support toast QR dialog while preserving the frozen reference and Stitch runtime contract.',
        'The Options contact/suggestions refresh updates the generated preview JS hash after replacing Contact cards with one catalog-backed linked paragraph, replacing Suggestions cards with one linked paragraph plus a Xiaohongshu QR popover image, updating the author email to zendio@sxnian.com, and preserving the existing Stitch schema renderer contract.',
        'The Options and runtime feedback QR repair refreshes the generated preview JS hash after changing the Suggestions Xiaohongshu trigger from a target=_blank link to an in-page popover button and simplifying task-success dislike feedback labels to Reddit plus Xiaohongshu while preserving the existing Stitch schema renderer contract.',
        'The Xiaohongshu QR caption and layering repair refreshes the generated preview JS hash after adding the requested QR caption message, changing the Suggestions QR trigger to a button-plus-popover-host structure, and preserving the existing Stitch schema renderer contract. The follow-up Xiaohongshu caption localization refreshes the generated preview JS hash after moving the QR caption into all release-language runtime/schema catalogs and tightening the Options trigger popover placement/weight while preserving the same Stitch schema renderer contract.',
        'The Options table alignment refresh updates the generated preview JS hash after giving Vault List and Routing Rules dedicated table wrapper classes and capitalizing platform-specific fragment modifier labels while preserving the frozen reference and Stitch runtime contract.',
        'The fragment keyboard shortcut hint refresh updates the generated preview JS hash after moving the direct-clip shortcut copy to platform-aware catalog keys and deriving runtime catalog generation keys from the English source catalog while preserving the frozen reference and Stitch runtime contract.',
        'The YAML editor dynamic preview refresh updates the generated preview JS hash after moving YAML preview generation into the production YAML widget state/filter owner and removing the static article-only output seed while preserving the frozen reference and Stitch runtime contract. The YAML editor divergent-value refresh updates the generated preview JS hash after keeping all-view built-in YAML default/value-path cells blank when content types disagree, while preserving per-content editing through the existing content-type filters and the Stitch runtime contract. The YAML domain-rule table refresh updates the generated preview JS hash after replacing stacked domain override field controls with the same table-shell structure used by other Options tables while preserving domain override state, validation, and Stitch runtime contracts. The YAML add-field scroll refresh updates the generated preview JS hash after making newly added YAML and domain override fields start blank, preserving table scroll across re-rendered field actions, scrolling explicit add actions to their new row, and splitting scroll preservation into a dedicated YAML editor module while preserving validation and serialization contracts.',
        'The Options capture-source layout refresh updates the generated preview JS hash after hiding the AI user display-name controls from production Options, replacing the video prompt helper with catalog-backed links plus screenshot-dot examples, moving attachment and fragment shortcut helper copy into the control column, adding schema-key generation from English schema source, removing the retired whole-sentence video prompt schema key, and constraining the YAML config table scroll shell inside the card while preserving the frozen reference and Stitch runtime contract.',
        'The Options setup guide consolidation refreshes the generated preview JS hash after folding the visible Plugin Setup resource into the single Setup Guide entry, keeping plugin-setup as a hidden compatibility alias, and moving the shared Obsidian connection/setup/checklist view into one resource builder while preserving the frozen reference and Stitch runtime contract.',
        'The onboarding platform connection refresh updates the generated preview JS hash after making Chrome/Chromium setup copy recommend Local Folder first with Obsidian Local REST API as fallback, keeping Firefox on Obsidian Local REST API, and reusing the shared Options resource modals for Suggestions, Support, and Contact while preserving the frozen reference and Stitch runtime contract.',
        'The onboarding setup-guide copy refresh updates the generated preview JS hash after adding certificate-trust guidance to REST API fallback copy, keeping the onboarding resource footer links on one row, and adding the catalog-backed 48-hour / 5-page unsaved reading and video draft restore feature bullet while preserving the frozen reference and Stitch runtime contract.',
        'The onboarding first-run agreement refresh updates the generated preview JS hash after adding the official website and changelog footer actions, the schema-backed terms-of-use resource, and privacy consent controls shared with Options privacy preferences while preserving the frozen reference, the shared resource modal contract, and the Stitch runtime behavior.',
        'The onboarding website-link and consent-switch refresh updates the generated preview JS hash after routing official website clicks by active interface language, rendering first-run analytics/error-reporting consent with the shared Options switch structure, and adding the requested catalog-backed v0.1.0/v0.2.0 changelog bullets while preserving the frozen reference and shared resource modal contract. The changelog summary placement repair refreshes the generated preview JS hash after moving those two release lines from bullet list items into version-level summary paragraphs rendered directly below each release header while preserving the frozen reference and shared resource modal contract. The onboarding/changelog copy cleanup refreshes the generated preview JS hash after removing v0.2.0 usage advice notes, deleting the first-run AI-forward-looking bullet, and adding the catalog-backed video screenshot capability bullet while preserving the shared resource modal and setup-guide contracts.',
        'The legal resources refresh updates the generated preview JS hash after replacing the short terms/privacy resources with complete catalog-backed Chinese/English legal sections and shared onboarding/options language routing while preserving the frozen reference and resource modal contract.',
        'The legal contact and privacy consent persistence refresh updates the generated preview JS hash after rendering terms/privacy contact sections with legal-specific email and GitHub Issues links instead of the general author contact paragraph, preserving Chinese/English legal language routing, and adding first-class privacyPreferences storage schema/default/merge support so Options and first-run consent toggles survive reloads while preserving the frozen reference and resource modal contract.',
        'The analytics debug-mode release-surface repair refreshes the generated preview JS hash after routing the Options debug-mode row through a build capability context and keeping production imports from preserving the dev-only debug flag while preserving the frozen reference and privacy consent contract.',
        'The video icon and Options brand-link refresh updates the generated preview JS hash after threading the shared 60px video mode icon through the video runtime surface preview contract and rendering the brand title through the reusable shell link node while preserving the frozen reference and Stitch runtime behavior.',
        'The video path template refresh updates the generated preview JS hash after adding the separate Options video path template row plus template state wiring while keeping the existing article template row as article-only user copy and preserving the frozen reference and Stitch runtime behavior.',
        'The i18n chunk-loading repair refreshes the generated preview JS hash after replacing generated locale/schema dynamic imports with static release registries so extension pages do not depend on runtime-loaded i18n chunks, while preserving the frozen reference, locale fallback semantics, and Stitch runtime behavior.',
        'The support resource closeout refreshes the generated preview JS hash after deleting retired Support Scope schema messages, neutralizing AI-assisted product-positioning copy in cataloged experimental settings, and routing support/contact/suggestion links through the shared Zendio resource link registry while preserving the frozen reference and Stitch resource modal/runtime surface behavior.',
        'The Firefox runtime boundary and reader focus main merge refreshes the generated preview JS hash while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'P05 refreshes the generated preview JS hash after facade-preserving Options/Stitch owner decomposition, runtime-threaded asset URL resolution, and schema-context browser target routing while focused Options/Stitch tests and visual:stitch preserve the frozen reference and Stitch runtime contract.',
        'The post-P05 hardcoded-config repair refreshes the generated preview JS hash after routing Options resource and YAML sample REST URLs through configProvider.getRestDefaults(), preserving the visible default and offset sample values while keeping the hardcoded config guard intact.',
        'P08 Options AI platform surface sync refreshes the generated preview JS hash after aligning the supported AI chat platform product surface and generated schema/i18n catalog output while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The AI chat abstraction tuning refreshes the generated preview JS hash after deriving Options supported-platform labels and links from canonical lightweight platform metadata while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The AI chat metadata-boundary refresh updates the generated preview JS hash after moving Options supported-platform labels and links onto the dedicated platformProductSurface metadata owner while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The v0.2.1 changelog refresh updates the generated preview JS hash after adding the catalog-backed Options/Stitch release notes and regenerated schema message keys while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The zero-state Usage Dashboard repair refreshes the generated preview JS hash after extracting the Stitch usage chart renderer from the hotspot components module and making chart-domain math fail closed for all-zero or non-finite values while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The v0.2.1 release version bump refreshes the generated preview JS hash after updating the Options runtime version label and regenerated runtime locale artifacts while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The v0.2.1 user-facing changelog and version source-of-truth refresh updates the generated preview JS hash after replacing technical release-note prose with user-readable export stability copy, deriving manifest/build release metadata from package.json, and adding the release metadata guard while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'P02 public provider bootstrap composition refreshes the generated preview JS hash after Options bootstrap accepts an injected Stitch assets provider while its default still imports productionStitchAssets, preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'The Zendio display-name punctuation refresh updates the generated preview JS hash after replacing the Chinese dash in Zendio-All in Obsidian with the product-approved ASCII hyphen across catalog-backed runtime/static copy and release artifact names while preserving the frozen reference, preview freeze logic, and Stitch runtime contract.',
        'P12 closes the inherited stale exact hash after two independent P11-base builds and two independent P12-current builds produced the same preview JS bytes, preserving the frozen reference and exact-hash comparison without adding private text or dependencies.',
        'The portable source-label stabilization enables esbuild preserveSymlinks for preview bundling so dependency modules retain the checkout-local node_modules identity instead of embedding realpath-derived workspace traversal comments. Physical and symlinked dependency layouts now produce identical raw preview JS bytes without changing runtime code, sourcemap policy, legal comments, or freeze-check normalization.'
      ].join(' '),
      leftSha256: '9020ccbd91acd691eccd3fdf568b9a90efbddf0a35d79f36ef1caba702fa0c07',
      // 2026-07-13 portable source-label proof across physical and symlinked node_modules.
      rightSha256: 'e928945d7356bb9c71c258509f9dba6fabdb2887df37263e3deb5faefc0415fb'
    }
  ]
]);

function runBuildPreview(outdir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, 'scripts/build-preview.mjs'), '--outdir', outdir],
      {
        cwd: repoRoot,
        stdio: 'inherit'
      }
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(`Preview build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`)
      );
    });
  });
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : limit;
}

function isAllowedPreviewDrift(comparison) {
  const allowlistEntry = ALLOWED_PREVIEW_DRIFT.get(comparison.label);
  if (!allowlistEntry || comparison.equal) {
    return false;
  }
  return (
    comparison.leftSha256 === allowlistEntry.leftSha256 &&
    comparison.rightSha256 === allowlistEntry.rightSha256
  );
}

function validateFreezeComparisons(comparisons) {
  const failures = [];

  for (const comparison of comparisons) {
    if (comparison.missing?.length) {
      failures.push(`${comparison.label}: missing ${comparison.missing.join(', ')}`);
      continue;
    }

    if (REQUIRED_EQUAL_COMPARISONS.has(comparison.label) && !comparison.equal) {
      failures.push(`${comparison.label}: expected exact match`);
      continue;
    }

    if (ALLOWED_PREVIEW_DRIFT.has(comparison.label) && !isAllowedPreviewDrift(comparison)) {
      failures.push(`${comparison.label}: drift does not match the explicit allowlist`);
      continue;
    }

    if (REQUIRED_NON_EMPTY_COMPARISONS.has(comparison.label) && !comparison.nonEmpty) {
      failures.push(`${comparison.label}: expected a non-empty artifact from this build`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Preview freeze check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
    );
  }
}

async function summarizePair(label, leftFile, rightFile) {
  const [left, right] = await Promise.all([readOptional(leftFile), readOptional(rightFile)]);
  const missing = [...(left === null ? [leftFile] : []), ...(right === null ? [rightFile] : [])];

  if (left === null || right === null) {
    return {
      label,
      leftFile,
      rightFile,
      equal: false,
      missing
    };
  }

  return {
    label,
    leftFile,
    rightFile,
    equal: left === right,
    leftLength: left.length,
    rightLength: right.length,
    leftSha256: sha256(left),
    rightSha256: sha256(right),
    firstDifference: firstDifference(left, right)
  };
}

async function summarizeFrozenPreviewArtifact(label, fileName) {
  const allowlistEntry = ALLOWED_PREVIEW_DRIFT.get(label);
  if (!allowlistEntry) {
    throw new Error(`Missing frozen digest contract for ${label}`);
  }

  const rightFile = path.join(currentRoot, fileName);
  const right = await readOptional(rightFile);
  const leftFile = originalReferenceRoot ? path.join(originalReferenceRoot, fileName) : null;
  const left = leftFile ? await readOptional(leftFile) : null;
  const missing = [
    ...(right === null ? [rightFile] : []),
    ...(leftFile && left === null ? [leftFile] : [])
  ];

  return {
    label,
    leftFile,
    rightFile,
    referenceSource: leftFile ? 'external-reference-and-tracked-digest' : 'tracked-digest',
    equal: left !== null && right !== null ? left === right : false,
    missing,
    leftLength: left?.length,
    rightLength: right?.length,
    leftSha256: left === null ? allowlistEntry.leftSha256 : sha256(left),
    rightSha256: right === null ? undefined : sha256(right),
    firstDifference: left !== null && right !== null ? firstDifference(left, right) : undefined
  };
}

async function summarizeNonEmptyArtifact(label, file) {
  const content = await readOptional(file);

  return {
    label,
    file,
    missing: content === null ? [file] : [],
    nonEmpty: content !== null && content.length > 0,
    length: content?.length,
    sha256: content === null ? undefined : sha256(content)
  };
}

async function run() {
  if (updateBaseline) {
    throw new Error(
      'Refusing to update preview baseline. Tracked frozen digests are code truth; the external original reference is optional cross-check evidence.'
    );
  }

  await rm(currentRoot, { recursive: true, force: true });
  await runBuildPreview(currentRoot);

  const comparisons = await Promise.all([
    summarizeFrozenPreviewArtifact(
      'original reference index.html vs current generated preview index.html',
      'index.html'
    ),
    summarizeFrozenPreviewArtifact(
      'original reference styles.css vs current generated preview styles.css',
      'styles.css'
    ),
    summarizeFrozenPreviewArtifact(
      'original reference index.js vs current generated preview index.js',
      'index.js'
    ),
    summarizeNonEmptyArtifact(
      'current generated standalone preview is non-empty',
      path.join(currentRoot, 'options-preview-stitch-secondary.html')
    ),
    summarizePair(
      'production source options/index.html vs latest built options/index.html',
      productionSourceHtml,
      productionBuiltHtml
    )
  ]);

  const report = {
    truthSource: {
      trackedDigests: Object.fromEntries(
        [...ALLOWED_PREVIEW_DRIFT].map(([label, entry]) => [
          label,
          {
            originalSha256: entry.leftSha256,
            currentSha256: entry.rightSha256
          }
        ])
      ),
      externalOriginalReferenceRoot: originalReferenceRoot,
      note: originalReferenceRoot
        ? 'The optional external original reference was cross-checked against tracked frozen digests.'
        : 'The external original reference is unavailable; tracked frozen digests remain authoritative.'
    },
    generatedCurrentPreviewRoot: currentRoot,
    production: {
      sourceHtml: productionSourceHtml,
      builtHtml: productionBuiltHtml
    },
    comparisons
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  validateFreezeComparisons(comparisons);

  console.log(`✅ Preview comparison report written: ${reportPath}`);
  console.log(
    `   Truth source: tracked frozen digests${originalReferenceRoot ? ` plus ${originalReferenceRoot}` : ''}`
  );
  for (const [label, entry] of ALLOWED_PREVIEW_DRIFT) {
    const comparison = comparisons.find((item) => item.label === label);
    if (comparison && isAllowedPreviewDrift(comparison)) {
      console.log(`   Allowed drift: ${label} (${entry.reason})`);
    }
  }
}

export { validateFreezeComparisons };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
