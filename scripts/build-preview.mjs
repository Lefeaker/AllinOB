import { build } from 'esbuild';
import { existsSync } from 'fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function findWorkspaceRoot(startDir) {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, 'future/options-component-preview 2/index.html'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir, '..');
    }
    current = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(repoRoot);
const sourceRoot = path.join(repoRoot, 'tests/fixtures/options-preview');
const defaultOutputRoot = path.join(workspaceRoot, 'future/options-component-preview');
const previewEntryPoints = {
  index: path.join(sourceRoot, 'entries/index.ts'),
  onboarding: path.join(sourceRoot, 'entries/onboarding.ts')
};
const stitchSecondaryOverrideCssPath = path.join(
  sourceRoot,
  'styles/variants/stitch-secondary.css'
);
const standaloneAssetMap = {
  '../../AiiinOB/public/icons/bannerlogo-128.png': {
    absolutePath: path.join(repoRoot, 'public/icons/bannerlogo-128.png'),
    mimeType: 'image/png'
  },
  '../../AiiinOB/public/icons/ko-fi.svg': {
    absolutePath: path.join(repoRoot, 'public/icons/ko-fi.svg'),
    mimeType: 'image/svg+xml;charset=utf-8'
  },
  '../../AiiinOB/public/icons/aifadian-line-copy.svg': {
    absolutePath: path.join(repoRoot, 'public/icons/aifadian-line-copy.svg'),
    mimeType: 'image/svg+xml;charset=utf-8'
  }
};

function readOutputRoot() {
  const outdirFlagIndex = process.argv.indexOf('--outdir');
  const outdirFlag = process.argv.find((arg) => arg.startsWith('--outdir='));
  const configuredOutdir =
    outdirFlagIndex >= 0
      ? process.argv[outdirFlagIndex + 1]
      : outdirFlag?.slice('--outdir='.length);

  if (!configuredOutdir) {
    return defaultOutputRoot;
  }

  return path.isAbsolute(configuredOutdir)
    ? configuredOutdir
    : path.resolve(repoRoot, configuredOutdir);
}

const outputRoot = readOutputRoot();

async function resetOutputDirectory() {
  await mkdir(outputRoot, { recursive: true });
  const entries = await readdir(outputRoot);
  await Promise.all(
    entries.map((entry) => rm(path.join(outputRoot, entry), { recursive: true, force: true }))
  );
}

async function writeHtmlEntries() {
  const sharedHead = `    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="./styles.css" />`;

  await writeFile(
    path.join(outputRoot, 'index.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head>
${sharedHead}
    <title>Zendio - Component Preview</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="./index.js"></script>
  </body>
</html>
`
  );

  await writeFile(
    path.join(outputRoot, 'onboarding.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head>
${sharedHead}
    <title>Zendio - Onboarding Preview</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="./onboarding.js"></script>
  </body>
</html>
`
  );
}

async function copyStyles() {
  await cp(path.join(sourceRoot, 'styles/preview.css'), path.join(outputRoot, 'styles.css'));
}

async function buildEntries() {
  await build({
    entryPoints: previewEntryPoints,
    outdir: outputRoot,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    charset: 'utf8',
    target: ['es2021'],
    preserveSymlinks: true,
    sourcemap: false,
    minify: false
  });
}

function toDataUri(content, mimeType) {
  return `data:${mimeType};base64,${Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf8').toString('base64')}`;
}

function escapeInlineCss(content) {
  return content.replaceAll('</style', '<\\/style');
}

function escapeInlineScript(content) {
  return content.replaceAll('</script', '<\\/script');
}

function createStandaloneHtml({ title, styles, script }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
${escapeInlineCss(styles)}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
${escapeInlineScript(script)}
    </script>
  </body>
</html>
`;
}

async function inlineStandaloneAssets(scriptContent) {
  let result = scriptContent;

  for (const [assetPath, assetMeta] of Object.entries(standaloneAssetMap)) {
    const assetContent = await readFile(assetMeta.absolutePath);
    result = result.split(assetPath).join(toDataUri(assetContent, assetMeta.mimeType));
  }

  return result;
}

function patchStandaloneOnboardingNavigation(scriptContent) {
  const target = 'window.location.href = `./index.html#${String(args[0] ?? "overview")}`;';
  const replacement = `if (window.opener && !window.opener.closed) {
            try {
              window.opener.location.hash = String(args[0] ?? "overview");
              window.opener.focus?.();
            } catch (error) {
            }
            window.close();
            return;
          }
          ${target}`;

  return scriptContent.includes(target)
    ? scriptContent.replace(target, replacement)
    : scriptContent;
}

function patchStandaloneResourceOpen(scriptContent) {
  const target =
    'window.open(meta.href ?? `./${resourceId}.html`, "_blank", "noopener,noreferrer");';
  const replacement = `if (resourceId === "onboarding" && window.__AI2OB_PREVIEW_ONBOARDING_HTML__) {
        const popup = window.open("", "_blank");
        if (popup) {
          popup.document.open();
          popup.document.write(window.__AI2OB_PREVIEW_ONBOARDING_HTML__);
          popup.document.close();
        }
        return;
      }
      ${target}`;

  return scriptContent.includes(target)
    ? scriptContent.replace(target, replacement)
    : scriptContent;
}

function normalizePreviewBundleSourceLabels(scriptContent) {
  const replacements = {
    'src/options/stitch/ui/dom.ts': 'tests/fixtures/options-preview/ui/dom.ts',
    'src/options/stitch/ui/components.ts': 'tests/fixtures/options-preview/ui/components.ts',
    'src/options/stitch/content.ts': 'tests/fixtures/options-preview/content/previewContent.ts',
    'src/options/stitch/render/shellBuilders.ts':
      'tests/fixtures/options-preview/app/shellBuilders.ts',
    'src/options/stitch/render/renderStitchView.ts':
      'tests/fixtures/options-preview/app/renderPreviewView.ts',
    'src/options/stitch/schema/': 'tests/fixtures/options-preview/schema/'
  };

  return Object.entries(replacements).reduce(
    (result, [source, target]) => result.split(source).join(target),
    scriptContent
  );
}

async function writeStandalonePreviewEntry() {
  const styles = await readFile(path.join(outputRoot, 'styles.css'), 'utf8');
  const indexScript = normalizePreviewBundleSourceLabels(
    await inlineStandaloneAssets(await readFile(path.join(outputRoot, 'index.js'), 'utf8'))
  );
  const onboardingScript = patchStandaloneOnboardingNavigation(
    normalizePreviewBundleSourceLabels(
      await inlineStandaloneAssets(await readFile(path.join(outputRoot, 'onboarding.js'), 'utf8'))
    )
  );
  const onboardingHtml = createStandaloneHtml({
    title: 'Zendio - Onboarding Preview Standalone',
    styles,
    script: onboardingScript
  });
  const standaloneScript = [
    `window.__AI2OB_PREVIEW_ONBOARDING_HTML__ = ${JSON.stringify(onboardingHtml)};`,
    patchStandaloneResourceOpen(indexScript)
  ].join('\n\n');
  const standaloneHtml = createStandaloneHtml({
    title: 'Zendio - Options Preview Standalone',
    styles,
    script: standaloneScript
  });

  await writeFile(path.join(outputRoot, 'options-preview-standalone.html'), standaloneHtml);
}

async function writeSkinVariantEntry() {
  const [baseHtml, overrideCss] = await Promise.all([
    readFile(path.join(outputRoot, 'options-preview-standalone.html'), 'utf8'),
    readFile(stitchSecondaryOverrideCssPath, 'utf8')
  ]);

  const skinnedHtml = baseHtml
    .replace('<html lang="zh-CN">', '<html lang="zh-CN" data-preview-skin="stitch-secondary">')
    .replace(
      '<title>Zendio - Options Preview Standalone</title>',
      '<title>Zendio - Options Preview Stitch Secondary</title>'
    )
    .replace(
      '</head>',
      `    <style id="stitch-secondary-preview-skin">\n${overrideCss}\n    </style>\n  </head>`
    );

  await writeFile(path.join(outputRoot, 'options-preview-stitch-secondary.html'), skinnedHtml);
}

await resetOutputDirectory();
await mkdir(outputRoot, { recursive: true });
await writeHtmlEntries();
await copyStyles();
await buildEntries();
await writeStandalonePreviewEntry();
await writeSkinVariantEntry();

console.log('✅ Preview build complete:', outputRoot);
