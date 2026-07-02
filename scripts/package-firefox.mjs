import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import process from 'process';
import { pathToFileURL } from 'url';
import { zipDirectory } from './utils/archive.mjs';
import { applyRestHostPermissions } from './utils/manifestHosts.mjs';
import { pathExists, prepareLicenseArtifacts, resolveMessage } from './utils/packageHelpers.mjs';
import {
  createReleaseArtifactBaseName,
  createReleaseArtifactFileName
} from './utils/releaseArtifactNames.mjs';
import {
  auditFirefoxAmoSourceArchive,
  createFirefoxAmoSourceArchive
} from './utils/firefoxAmoSourceArchive.mjs';
import { auditReleaseArchive } from '../tools/audit-release-archive.mjs';

const args = process.argv.slice(2);
const FIREFOX_SIGNING_CHANNELS = new Set(['listed', 'unlisted']);

function hasFlag(flag) {
  return args.includes(flag);
}

function getFlagValue(flag, { defaultValue } = {}) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return defaultValue;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`参数 ${flag} 缺少取值`);
  }
  return value;
}

function getOptionalNumberFlagValue(flag) {
  const rawValue = getFlagValue(flag, { defaultValue: undefined });
  if (rawValue === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/.test(rawValue)) {
    throw new Error(`参数 ${flag} 必须是非负整数毫秒值`);
  }
  return Number(rawValue);
}

export function normalizeFirefoxSigningChannel(channel) {
  const normalized = String(channel ?? '').trim();
  if (!FIREFOX_SIGNING_CHANNELS.has(normalized)) {
    throw new Error('Firefox signing channel must be either "listed" or "unlisted".');
  }
  return normalized;
}

export function requiresDownloadedSignedArtifact(channel) {
  return normalizeFirefoxSigningChannel(channel) === 'unlisted';
}

export async function createUnsignedXpi(distDir, _resolvedName, version) {
  const artifactBaseName = createReleaseArtifactBaseName(version);
  const xpiName = createReleaseArtifactFileName(version, 'xpi');
  const outputPath = resolve(xpiName);

  if (await pathExists(outputPath)) {
    await rm(outputPath, { force: true });
  }

  await zipDirectory(distDir, outputPath, { ignore: ['**/*.map', '**/.DS_Store'] });
  return { xpiName, outputPath, artifactBaseName };
}

async function loadWebExt() {
  const webExtModule = await import('web-ext');
  return webExtModule.default ?? webExtModule;
}

function getLintCount(lintResult, key) {
  const summaryCount = lintResult?.summary?.[key];
  if (typeof summaryCount === 'number') {
    return summaryCount;
  }

  const entries = lintResult?.[key];
  return Array.isArray(entries) ? entries.length : 0;
}

function formatLintErrorCodes(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'unknown';
  }

  return errors
    .map((error) => error?.code ?? error?.message ?? 'unknown')
    .slice(0, 5)
    .join(', ');
}

export async function lintFirefoxExtension(distDir, dependencies = {}) {
  const { importWebExtImpl = loadWebExt, logger = console, webExt } = dependencies;
  const resolvedWebExt = webExt ?? (await importWebExtImpl());

  if (typeof resolvedWebExt?.cmd?.lint !== 'function') {
    throw new Error('Firefox web-ext lint API is unavailable.');
  }

  logger.log('🔎 正在运行 Firefox web-ext lint...');

  let lintResult;
  try {
    lintResult = await resolvedWebExt.cmd.lint(
      {
        sourceDir: distDir,
        selfHosted: true,
        warningsAsErrors: false
      },
      { shouldExitProgram: false }
    );
  } catch (error) {
    throw new Error(`Firefox web-ext lint failed: ${error.message}`);
  }

  const errorCount = getLintCount(lintResult, 'errors');
  if (errorCount > 0) {
    throw new Error(
      `Firefox web-ext lint failed with ${errorCount} error(s): ${formatLintErrorCodes(
        lintResult?.errors
      )}`
    );
  }

  const warningCount = getLintCount(lintResult, 'warnings');
  if (warningCount > 0) {
    logger.warn(
      `⚠️  Firefox web-ext lint reported ${warningCount} warning(s); review web-ext output before AMO submission.`
    );
  }

  logger.log('✅ Firefox web-ext lint passed');
  return lintResult;
}

async function readXpiArtifactSnapshot(artifactsDir, { readdirImpl, statImpl }) {
  const snapshot = new Map();
  const files = await readdirImpl(artifactsDir);

  for (const file of files) {
    if (!file.endsWith('.xpi')) {
      continue;
    }

    const fileStats = await statImpl(join(artifactsDir, file));
    snapshot.set(file, {
      file,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size
    });
  }

  return snapshot;
}

function findUpdatedSignedArtifact(beforeSnapshot, afterSnapshot) {
  const candidates = [];

  for (const [file, afterStats] of afterSnapshot.entries()) {
    const beforeStats = beforeSnapshot.get(file);
    if (
      !beforeStats ||
      beforeStats.mtimeMs !== afterStats.mtimeMs ||
      beforeStats.size !== afterStats.size
    ) {
      candidates.push(afterStats);
    }
  }

  candidates.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return right.file.localeCompare(left.file);
  });

  return candidates[0]?.file ?? null;
}

export async function runSigning(
  {
    distDir,
    artifactsDir,
    artifactBaseName,
    apiKey,
    apiSecret,
    channel,
    extensionId,
    uploadSourceCodePath,
    timeout,
    approvalTimeout
  },
  dependencies = {}
) {
  const {
    copyFileImpl = copyFile,
    importWebExtImpl = loadWebExt,
    logger = console,
    mkdirImpl = mkdir,
    pathExistsImpl = pathExists,
    readdirImpl = readdir,
    resolvePathImpl = resolve,
    statImpl = stat,
    webExt
  } = dependencies;
  const resolvedWebExt = webExt ?? (await importWebExtImpl());
  const normalizedChannel = normalizeFirefoxSigningChannel(channel);

  if (!(await pathExistsImpl(artifactsDir))) {
    await mkdirImpl(artifactsDir, { recursive: true });
  }

  const beforeArtifacts = await readXpiArtifactSnapshot(artifactsDir, {
    readdirImpl,
    statImpl
  });

  logger.log('🔏 正在请求 Mozilla 签名服务...');

  const signOptions = {
    sourceDir: distDir,
    artifactsDir,
    apiKey,
    apiSecret,
    channel: normalizedChannel,
    id: extensionId
  };
  if (uploadSourceCodePath) {
    signOptions.uploadSourceCode = uploadSourceCodePath;
  }
  if (timeout !== undefined) {
    signOptions.timeout = timeout;
  }
  if (approvalTimeout !== undefined) {
    signOptions.approvalTimeout = approvalTimeout;
  }

  let webExtResult;
  try {
    webExtResult = await resolvedWebExt.cmd.sign(signOptions, { shouldExitProgram: false });
  } catch (error) {
    throw new Error(`web-ext 签名失败: ${error.message}`);
  }

  const afterArtifacts = await readXpiArtifactSnapshot(artifactsDir, {
    readdirImpl,
    statImpl
  });
  const latestSigned = findUpdatedSignedArtifact(beforeArtifacts, afterArtifacts);

  if (!latestSigned) {
    logger.warn('⚠️  未找到签名后的 XPI 文件，请检查 web-ext 输出日志。');
    return {
      artifactBaseName,
      channel: normalizedChannel,
      signedPath: null,
      webExtResult
    };
  }

  const signedSource = join(artifactsDir, latestSigned);
  const signedTargetName = `${artifactBaseName}-signed.xpi`;
  const signedTargetPath = resolvePathImpl(signedTargetName);

  await copyFileImpl(signedSource, signedTargetPath);

  logger.log('✅ 签名完成');
  logger.log(`   签名文件: ${signedTargetPath}`);
  logger.log(`   原始文件: ${signedSource}`);

  return {
    artifactBaseName,
    channel: normalizedChannel,
    signedPath: signedTargetPath,
    webExtResult
  };
}

export async function signAndAuditFirefoxPackage(signingOptions, dependencies = {}) {
  const { auditReleaseArchiveImpl = auditReleaseArchive, runSigningImpl = runSigning } =
    dependencies;
  const result = await runSigningImpl(signingOptions, dependencies);

  if (!result.signedPath && requiresDownloadedSignedArtifact(result.channel)) {
    throw new Error('Firefox signing did not produce a signed XPI artifact.');
  }

  if (result.signedPath) {
    await auditReleaseArchiveImpl(result.signedPath);
  }
  return result;
}

export async function resolveFirefoxAmoSourceArchiveForSigning(options, dependencies = {}) {
  const {
    artifactBaseName,
    releaseXpiName = `${artifactBaseName}.xpi`,
    version,
    uploadSourceCodePath,
    sourceArchiveOutputDir = 'build/firefox-source'
  } = options;
  const {
    auditFirefoxAmoSourceArchiveImpl = auditFirefoxAmoSourceArchive,
    createFirefoxAmoSourceArchiveImpl = createFirefoxAmoSourceArchive,
    logger = console,
    repoRoot = process.cwd(),
    resolvePathImpl = resolve
  } = dependencies;

  if (uploadSourceCodePath) {
    const resolvedPath = resolvePathImpl(uploadSourceCodePath);
    await auditFirefoxAmoSourceArchiveImpl(resolvedPath);
    logger.log(`🧾 Firefox AMO source archive: ${resolvedPath}`);
    return resolvedPath;
  }

  const sourceArchive = await createFirefoxAmoSourceArchiveImpl(
    {
      repoRoot,
      outputDir: sourceArchiveOutputDir,
      artifactBaseName,
      releaseXpiName,
      version
    },
    { logger }
  );
  return sourceArchive.archivePath;
}

export async function prepareFirefoxReleasePackage({ distDir }, dependencies = {}) {
  const {
    applyRestHostPermissionsImpl = applyRestHostPermissions,
    auditReleaseArchiveImpl = auditReleaseArchive,
    createUnsignedXpiImpl = createUnsignedXpi,
    lintFirefoxExtensionImpl = lintFirefoxExtension,
    logger = console,
    prepareLicenseArtifactsImpl = prepareLicenseArtifacts,
    readFileImpl = readFile,
    resolveMessageImpl = resolveMessage,
    writeFileImpl = writeFile
  } = dependencies;

  await prepareLicenseArtifactsImpl(distDir);

  const manifestPath = join(distDir, 'manifest.json');
  const manifest = JSON.parse(await readFileImpl(manifestPath, 'utf8'));
  const manifestWithHosts = applyRestHostPermissionsImpl(manifest);

  await writeFileImpl(manifestPath, JSON.stringify(manifestWithHosts, null, 2));

  const version = manifestWithHosts.version;
  const resolvedName = await resolveMessageImpl(manifestWithHosts.name, manifestWithHosts, distDir);

  logger.log(`📝 扩展名称: ${resolvedName}`);
  logger.log(`📝 版本号: ${version}`);

  await lintFirefoxExtensionImpl(distDir);

  const { xpiName, outputPath, artifactBaseName } = await createUnsignedXpiImpl(
    distDir,
    resolvedName,
    version
  );
  await auditReleaseArchiveImpl(outputPath);

  return {
    manifest: manifestWithHosts,
    outputPath,
    resolvedName,
    version,
    xpiName,
    artifactBaseName
  };
}

export async function packageFirefoxExtension() {
  console.log('📦 开始打包 Firefox 扩展...');
  const distDir = getFlagValue('--dist-dir', { defaultValue: 'build/dist' });

  if (!(await pathExists(distDir))) {
    console.error(`❌ ${distDir} 目录不存在，请先运行 npm run build:firefox`);
    process.exit(1);
  }

  const { artifactBaseName, manifest, outputPath, xpiName } = await prepareFirefoxReleasePackage({
    distDir
  });

  console.log('✅ 未签名 XPI 已生成');
  console.log(`   文件路径: ${outputPath}`);

  if (!hasFlag('--sign')) {
    console.log('');
    console.log('📖 手动安装说明:');
    console.log('   1. 打开 Firefox，访问 about:debugging#/runtime/this-firefox');
    console.log('   2. 点击“临时载入附加组件”');
    console.log(`   3. 选择 ${xpiName}`);
    return;
  }

  const apiKey = getFlagValue('--api-key', { defaultValue: process.env.WEB_EXT_API_KEY });
  const apiSecret = getFlagValue('--api-secret', { defaultValue: process.env.WEB_EXT_API_SECRET });
  const channel = normalizeFirefoxSigningChannel(
    getFlagValue('--channel', { defaultValue: 'listed' })
  );
  const timeout = getOptionalNumberFlagValue('--timeout');
  const explicitApprovalTimeout = getOptionalNumberFlagValue('--approval-timeout');
  const approvalTimeout = explicitApprovalTimeout ?? (channel === 'listed' ? 0 : undefined);
  const artifactsDir = getFlagValue('--artifacts-dir', { defaultValue: 'build/firefox-artifacts' });
  const uploadSourceCodePath = getFlagValue('--upload-source-code', { defaultValue: undefined });
  const sourceArchiveOutputDir = getFlagValue('--source-archive-dir', {
    defaultValue: 'build/firefox-source'
  });

  if (!apiKey || !apiSecret) {
    console.error('❌ 签名模式需要提供 WEB_EXT_API_KEY 和 WEB_EXT_API_SECRET。');
    console.error('   可以通过环境变量或 --api-key/--api-secret 参数传入。');
    process.exit(1);
  }

  const resolvedUploadSourceCodePath = await resolveFirefoxAmoSourceArchiveForSigning({
    artifactBaseName,
    releaseXpiName: xpiName,
    version: manifest.version,
    uploadSourceCodePath,
    sourceArchiveOutputDir
  });

  const signingResult = await signAndAuditFirefoxPackage({
    distDir,
    artifactsDir,
    artifactBaseName,
    apiKey,
    apiSecret,
    channel,
    extensionId: manifest?.browser_specific_settings?.gecko?.id,
    uploadSourceCodePath: resolvedUploadSourceCodePath,
    timeout,
    approvalTimeout
  });

  if (!signingResult.signedPath) {
    console.log('✅ 已提交到 Mozilla Add-ons。');
    console.log('   listed 渠道会等待 AMO 审核；审核通过后由 AMO 侧提供签名产物。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageFirefoxExtension().catch((error) => {
    console.error('❌ Firefox 打包流程失败:', error);
    process.exit(1);
  });
}
