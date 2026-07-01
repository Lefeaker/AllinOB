import { runTaskGraph } from './utils/taskGraphRunner.mjs';

export function createQualityTaskGraph() {
  return {
    tasks: [
      task('verify-runtime', 'Runtime engine 守卫', ['npm', 'run', 'verify:runtime']),
      task('release-metadata-check', 'Release metadata source-of-truth 守卫', [
        'npm',
        'run',
        'release:metadata:check'
      ]),
      task('audit-ui-architecture-report', 'UI 架构迁移守卫', [
        'npm',
        'run',
        'audit:ui-architecture:report'
      ]),
      task('audit-components-report', '组件入口统一守卫', [
        'npm',
        'run',
        'audit:components:report'
      ]),
      task('audit-compatibility-duplicates-check', '兼容壳重复审计', [
        'npm',
        'run',
        'audit:compatibility-duplicates:check'
      ]),
      task('audit-design-system-doc-report', '设计系统文档真值守卫', [
        'npm',
        'run',
        'audit:design-system-doc:report'
      ]),
      task('audit-interaction-contract-report', '交互约定守卫', [
        'npm',
        'run',
        'audit:interaction-contract:report'
      ]),
      task('audit-options-mainline-report', 'Options 主链守卫', [
        'npm',
        'run',
        'audit:options-mainline:report'
      ]),
      task('report-options-legacy', 'Options 旧前缀扫描', ['npm', 'run', 'report:options-legacy']),
      task('lint-options-css', 'Options CSS 命名校验', ['npm', 'run', 'lint:options-css']),
      task('lint-hardcoded', 'Hardcoded config 守卫', ['npm', 'run', 'lint:hardcoded']),
      task('typecheck-app', 'TypeScript 类型检查（应用代码）', ['npm', 'run', 'typecheck:app']),
      task('typecheck-tests', 'TypeScript 类型检查（测试代码）', ['npm', 'run', 'typecheck:tests']),
      task('typecheck-strict', 'TypeScript 类型检查（strict 基线）', [
        'npm',
        'run',
        'typecheck:strict'
      ]),
      task('lint-type-any-ratchet', 'TypeScript 类型债务预算守卫', [
        'npm',
        'run',
        'lint:type-any:ratchet'
      ]),
      task('audit-ga-proxy-contract', 'GA proxy contract 守卫', [
        'npm',
        'run',
        'audit:ga:proxy-contract'
      ]),
      task(
        'audit-ga-docs',
        'GA docs contract 守卫',
        ['npm', 'run', 'audit:ga:docs'],
        ['audit-ga-proxy-contract']
      ),
      task('audit-ga-legacy-api', 'GA legacy API 守卫', ['npm', 'run', 'audit:ga:legacy-api']),
      task('audit-platform-services-report', '平台调用 allowlist 审计', [
        'npm',
        'run',
        'audit:platform-services:report'
      ]),
      task('audit-imports-report', '深层导入边界审计', ['npm', 'run', 'audit:imports:report']),
      task('audit-retired-code-report', 'Retired code 回归守卫', [
        'npm',
        'run',
        'audit:retired-code:report'
      ]),
      task('audit-production-shape-report', 'Production shape 守卫', [
        'npm',
        'run',
        'audit:production-shape:report'
      ]),
      task('audit-ci-workflow-check', 'CI workflow 拓扑守卫', [
        'npm',
        'run',
        'audit:ci-workflow:check'
      ]),
      task('audit-chrome-webstore-release-check', 'Chrome Web Store GA 发布流程守卫', [
        'npm',
        'run',
        'audit:chrome-webstore-release:check'
      ]),
      task('audit-build-graph-report', 'Production build graph 守卫', [
        'npm',
        'run',
        'audit:build-graph:report'
      ]),
      task(
        'audit-hardcoded-user-copy-check',
        'i18n hardcoded user-copy 守卫',
        ['node', 'scripts/audit-i18n-hardcoded-user-copy.mjs', '--check'],
        ['audit-build-graph-report']
      ),
      task(
        'uncatalogued-user-copy-check',
        'i18n uncatalogued English user-copy 守卫',
        ['node', 'scripts/audit-i18n-uncatalogued-user-copy.mjs', '--check'],
        ['audit-hardcoded-user-copy-check']
      ),
      task(
        'audit-non-production-source-check',
        'Non-production source 安全守卫',
        ['npm', 'run', 'audit:non-production-source:check'],
        ['audit-build-graph-report']
      ),
      task('build-fast', 'Release surface 生产构建', ['npm', 'run', 'build:fast']),
      task(
        'audit-release-surface-report',
        'Release surface 守卫',
        ['npm', 'run', 'audit:release-surface:report'],
        ['build-fast']
      ),
      task(
        'audit-ga-client-secret',
        'GA client secret 守卫',
        ['npm', 'run', 'audit:ga:client-secret'],
        ['build-fast']
      ),
      task(
        'audit-ga-release-surface',
        'GA release surface 守卫',
        ['npm', 'run', 'audit:ga:release-surface'],
        ['build-fast']
      ),
      task('audit-deps-report', 'Dependency graph 覆盖守卫', ['npm', 'run', 'audit:deps:report']),
      task('lint-warnings-guard', 'Lint Warning 基线守卫', ['npm', 'run', 'lint:warnings-guard']),
      task('i18n-catalog-check', 'i18n catalog 生成一致性守卫', [
        'npm',
        'run',
        'i18n:catalog:check'
      ]),
      task('i18n-lint', 'i18n 消息一致性校验', ['npm', 'run', 'i18n:lint']),
      task('validate-i18n-budgets', '字符预算校验', ['npm', 'run', 'validate:i18n:budgets']),
      task('audit-locales-report', 'Locale source alignment 守卫', [
        'npm',
        'run',
        'audit:locales:report'
      ])
    ]
  };
}

function task(id, name, cmd, dependsOn = []) {
  return {
    id,
    name,
    cmd,
    dependsOn: id === 'verify-runtime' ? [] : dependsOn.length > 0 ? dependsOn : ['verify-runtime']
  };
}

export async function runQualityChecks() {
  const graph = createQualityTaskGraph();
  const result = await runTaskGraph(graph.tasks);

  if (!result.ok) {
    const failures = result.failed.map((failure) => failure.name).join(', ');
    console.error(`❌ 质量检查失败: ${failures}`);
    process.exit(result.failed[0]?.code ?? 1);
  }

  console.log('🎉 质量检查全部通过');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runQualityChecks();
}
