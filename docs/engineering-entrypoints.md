# 工程命令与入口

最后更新：2026-07-01

## 推荐运行环境

- Node.js：`.nvmrc` pins `20.20.2`；package engines allow `>=20.19 <21`
- npm：validated `10.8.2`；package engines allow `>=10 <11`
- Playwright：`npx playwright install --with-deps chromium`

## 本轮统一门禁真值

- `npm run quality`
  - 由 `scripts/quality-check.mjs` 的 dependency-aware task graph 执行；`QUALITY_CONCURRENCY` 可控制本地并发，默认按 CPU 上限保守并行
  - 显式包含 `verify:runtime`，运行 `scripts/verify-runtime.mjs` 校验当前 Node.js 满足 `package.json` 的 `engines.node`
  - 显式包含 `release:metadata:check`；版本号单一来源为 `package.json` 的 `version` 字段，该 gate 校验 `package-lock.json` root version、`public/manifest.json`、`public/manifest.firefox.json` 与 `src/i18n/catalog/messages/*/runtime.json` 的 `versionNumber` 均已由 `npm run release:metadata:sync` 同步
  - 显式包含 `typecheck:app`
  - 显式包含 `typecheck:tests`
  - 显式包含 `typecheck:strict`
  - 显式包含 `audit:ga:proxy-contract`、`audit:ga:docs` 与 `audit:ga:legacy-api`
  - `audit:ga:proxy-contract` check mode 以 source-derived contract 为当前真值，并刷新 ignored `build/reports/ga-proxy-contract.json` 供 `audit:ga:docs` 复用；stale / missing / invalid report 不得阻塞当前 source contract
  - 显式执行 production `build:fast` 后运行 `audit:release-surface:report`
  - 显式在 production `build:fast` 后运行 `audit:ga:client-secret` 与 `audit:ga:release-surface`
  - 显式只生成一次 `build/reports/production-build-graph.json`，随后复用该 graph 运行 i18n hardcoded user-copy、English uncatalogued-copy 与 non-production source hard gates；English uncatalogued-copy 仍依赖 CJK/descriptor hardcoded gate 先通过
  - 显式包含 `audit:locales:report`，在 i18n lint 与字符预算通过后校验 config、locale loaders、catalog runtime/static/schema source、generated locale modules 与 public `_locales` 一致
  - i18n 产品范围决策为 `release-13-languages`：release-supported human UI locales 为 `en`、`zh-CN`、`ja`、`de`、`fr`、`es-ES`、`es-419`、`it`、`ko`、`pt-BR`、`ru`、`zh-TW`
  - `qps-ploc` 分类为 `dev-test-only`；production build/package output 与 release-surface audit 不允许出现 `qps-ploc` loader/chunk 或 `_locales/qps-ploc/messages.json`
  - Chrome ZIP 与 Firefox XPI package 脚本会解包最终产物并通过 `tools/audit-release-archive.mjs` 复用 release-surface 审计
  - Firefox XPI package 脚本会在生成未签名 XPI 前对最终 `build/dist` 执行 `web-ext lint --self-hosted`；Firefox source manifest 当前使用 `background.scripts`，声明 `browser_specific_settings.gecko.data_collection_permissions.required=["none"]` / `optional=["technicalAndInteraction"]`，并将 desktop / Android `strict_min_version` 统一为 `142.0`，避免 `BACKGROUND_SERVICE_WORKER_NOFALLBACK`、`storage.session` min-version 与 AMO data-collection min-version 漂移静默进入 release artifact
  - `npm run test:i18n` 包含 `layout:report`；clean worktree 中需先运行 `npm run build:dev` 或 `npm run build` 生成 `build/dist`
  - `lint:options-css` 的当前有效规则覆盖 `src/options/**/*.css`；`src/options/stitch/styles/**` 的 `--print-config` 必须包含非空 `selector-class-pattern`
  - 显式包含 `lint:hardcoded`；当前 standalone 输出为 `0` hardcoded findings
  - 显式包含 `audit:i18n-hardcoded-user-copy:check`；生产用户可见文案只能来自 i18n catalog 或 `UserVisibleMessageDescriptor` key，background/content 边界只传 descriptor/code/params。当前 CJK/descriptor hard gate 输出为 `scanned=582 findings=19 unexpected=0 staleAllowlist=0`，治理细节见 [`i18n-production-copy-governance.md`](./i18n-production-copy-governance.md)
  - 显式包含 `audit:i18n-uncatalogued-user-copy:check`；英文 uncatalogued-copy audit 已作为 hard gate 接入 `quality`，覆盖 `normalizeToAppError` 的 raw English `defaultMessage` fallback、`subtitle` / `hint` / `body` 等 production-visible fields，并且不会把带编号的多词英文 UI title 误判为 technical token list；当前输出 `scanned=578 findings=0 unexpected=0 staleAllowlist=0`，allowlist rules 为 `0`
  - 显式包含 `i18n:catalog:check`；catalog/generated artifact drift 会在 `quality`、`verify:preflight` 与 CI 中阻塞
  - `audit:design-system-doc:report` 只检查 tracked / non-ignored 的 active style guidance；被 `.gitignore` 标记的本地过程 archive 不进入当前样式真值口径
  - `i18n:catalog:generate` 当前从 `src/i18n/catalog/messages/<lang>/{runtime,static,schema}.json` 生成 `src/i18n/generated/*`、`src/i18n/generated/locales/*.generated.ts` 与 `public/_locales/**`；`npm run i18n:generate` 保持原命令名，但现在只是兼容包装层，实际委托给 catalog generator
  - `public/_locales/**` 是当前 catalog-owned WebExtension static source；root `_locales/**` 已退役并删除，不参与 production build/package ownership
- `npm run verify:preflight`
  - 显式包含 `verify:runtime`
  - 显式包含 `typecheck:app`
  - 显式包含 `typecheck:tests`
  - 显式包含 `typecheck:strict`
  - 显式包含 `release:metadata:check`，并且在 `i18n:catalog:check` 前失败，防止版本元数据或 release catalog 版本号 drift 进入后续发布门禁
  - 显式包含 `i18n:catalog:check`
  - 显式包含 `audit:i18n-uncatalogued-user-copy:check`
  - 显式包含 `audit:ga:proxy-contract`、`audit:ga:docs` 与 `audit:ga:legacy-api`
  - 串行继续执行 `lint -- --quiet`、`build:dev`、`audit:ga:client-secret`、`audit:ga:release-surface` 与其他 `audit:*` 报告
- `npm run test*` 与 `npm run visual*`
  - 每个 npm script entrypoint 显式前置 `verify:runtime`
  - 本地 PATH 指向不受支持 Node 版本时，先在 runtime guard 失败，不启动 Vitest / Playwright
  - `test:unit:shards` 与 `test:e2e:shards` 是本地加速入口：它们按进程级 shard 并行运行，单个 Vitest 进程仍使用现有 config，不改变 canonical `test:unit`、`test:e2e` 或 `test:coverage` 口径
  - `test:e2e:browser:parallel` 与 `visual:test:parallel` 会先运行一次 `build:dev`，再通过 `PLAYWRIGHT_SKIP_WEB_SERVER_BUILD=1` 让各 Playwright shard 只读同一 dist；runner 会为每个 shard 注入独立 `PLAYWRIGHT_OUTPUT_DIR` 与 `PLAYWRIGHT_HTML_REPORT_DIR`，避免 failure artifacts / HTML report 互相覆盖；直接并行多个旧 browser 命令仍不推荐
  - `test:e2e:browser:parallel` 当前覆盖 YAML interaction、reader-panel 与 migration smoke 三组 shard；local-vault 与 Firefox browser checks 仍保留为独立专项命令
- `npm run build*` 与 `npm run package*`
  - `build` 与 `build:firefox` 显式先运行一次 `quality`，随后调用 `scripts/build.mjs --skip-checks`，不得恢复为重复触发完整 `quality` 的形式
  - `scripts/build.mjs` 从 `package.json` 读取版本号，并注入 `__ZENDIO_EXTENSION_VERSION__` / `__AIIINOB_EXTENSION_VERSION__` 作为 Options 等无 platform manifest 场景的版本 fallback；不要在 UI 代码中硬编码 release version
  - `scripts/build.mjs` 支持 `--outdir` / `BUILD_DIST_DIR`；`scripts/package.mjs` 与 `scripts/package-firefox.mjs` 支持 `--dist-dir`
  - `build:chrome:isolated` / `build:firefox:isolated` 与 `package:chrome:isolated` / `package:firefox:isolated` 使用独立 dist 目录，作为 Chrome / Firefox package 并行化的安全入口
  - Firefox AMO 自动发布入口为 `.github/workflows/release-firefox-amo.yml`；该 workflow 在 tag `v*` 与手动触发时使用 repository secrets 注入 GA public config 与 AMO API credentials，运行 `analytics:validate:prod:required`、`build:firefox:prod:ga:ci`、生成并审计 AMO source archive、`web-ext` signing submission、GA secret / release-surface archive audits，并上传生成的 XPI 与 `build/firefox-source/**/*-source.zip` artifact
- `.github/workflows/ci.yml`
  - 采用拆分后的并行 job 拓扑：`static-preflight`、`static-release-surface`、`static-generated-artifacts`、`static-style-and-locale`、`static-reporting-audits`、`coverage`、`visual` matrix、`e2e-vitest`、`browser-yaml`、`browser-reader-panel`、`browser-smoke` 并行执行
  - 使用 workflow-level `concurrency`，同一 PR / ref 的新 run 会取消旧 run
  - `.github/actions/setup-node-deps` 统一 Node / npm cache / `npm ci`；`.github/actions/setup-playwright` 在此基础上缓存 `~/.cache/ms-playwright` 并安装 Chromium browser dependencies
  - 官方 JavaScript actions 使用 Node 24-compatible major：`actions/checkout@v6`、`actions/setup-node@v6`、`actions/upload-artifact@v7`、`actions/github-script@v8`
  - `static-preflight` 显式运行 `npm run audit:ci-workflow:check`、`npm run i18n:catalog:check` 与 `npm run verify:preflight`；三项 typecheck 仍由 `verify:preflight` 显式覆盖
  - `static-release-surface` 显式运行 `build:fast` 与 `audit:release-surface:report`
  - `static-style-and-locale` 保留 locale source alignment、Options CSS naming、hardcoded config guard 与 lint warning guard 的 hard gate 语义；`static-reporting-audits` 仅保留 report-only audit 的 per-step `continue-on-error`
  - `visual` 按 `chromium-desktop` / `chromium-tablet` / `chromium-mobile` matrix 拆分；Vitest E2E 与三组 browser E2E 拆成独立 job，失败报告 artifact 按 suite 命名
  - `package` job 通过 `needs: [static-preflight]` 提前启动，并继续使用 `npm run build:fast`，避免在 CI 后段通过 `npm run build` 重复触发完整 `quality`；测试、visual、release-surface 与静态拆分 job 仍应作为独立 required checks 参与合并判断
- `.github/workflows/release-firefox-amo.yml`
  - Firefox AMO 自动发布支持 tag `v*` 触发与 `workflow_dispatch` 手动触发；手动触发可选择 `listed` 或 `unlisted`，tag 触发默认 `listed`
  - Workflow 只读取 `contents: read` 权限，不写 GitHub release；发布凭据只来自 `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` repository secrets，GA public config 只来自 `ZENDIO_GA_MEASUREMENT_ID` / `ZENDIO_GA_PROXY_ENDPOINT` secrets 与固定 `ZENDIO_GA_TRANSPORT_MODE=proxy`
  - `listed` 渠道使用 `--approval-timeout 0` 提交 AMO 审核，不要求 CI 立即下载 signed XPI；`unlisted` 渠道必须产出根目录 signed XPI，并与 unsigned XPI 一起进入 GA release-surface archive audit
  - 签名流程默认生成 `<扩展名>-v<版本号>-source.zip` 并通过 `web-ext.cmd.sign({ uploadSourceCode })` 上传；源码包包含 `AMO_SOURCE_REVIEW.md` 与复现构建所需白名单输入，并拒绝 `.env*`、`node_modules/`、`build/`、`.worktrees/`、XPI/ZIP 与私钥类文件
  - `.github/workflows/release-firefox-amo.yml` 的核心契约由 `npm run audit:ci-workflow:check` 与 `tests/unit/tools/ciWorkflow.test.ts` 守住；不要把该 workflow 改回依赖本机 `.env.production.local` 的命令
- 2026-06-23 post-0.2.0 P07 performance observability truth：在 branch `codex/aiiinob-post-020-p07-performance-observability-2026-06-22` / source baseline commit `7495ab47` 重新采集 production `build:fast`、dev `build:dev`、`audit:build:report`、`audit:release-surface:report`、`audit:performance:report`、`audit:deps:report`、`audit:platform-boundary:report`、`audit:non-production-source:report`、`lint:type-any` 与 `lint:warnings-guard`；P07 后续只同步 docs、tool budget ratchets 与对应 tool test expectation。Fresh production build report 为 `content/runtime.js` raw `50,167` bytes、`onboarding/index.js` raw `1,130` bytes、chunks `86`；fresh dev report 为 `content/runtime.js` raw `58,694` bytes、`onboarding/index.js` raw `1,751` bytes、chunks `100`。Dev `content/runtime.js` remains above warning target `58,564` but below hard stop `58,752`; P07 intentionally did not loosen this build budget. `audit:release-surface:report` 为 `Files=180`、forbidden harness/pseudo-locale `none`；`audit:performance:report` 为 `sourceFiles=875`、`hotspotsOver250=111`、`registeredLineBudgets=149`，并将 36 个 stale line budgets 收紧到 fresh line count；`audit:deps:report` 为 `modules=993`、`dependencies=3032`、`violations=0`；`audit:platform-boundary:report` 为 total `141`；`audit:non-production-source:report` decision counts 为 `retain-production: 718`、`migrate-import-owner: 164`、`retain-production-facade: 17`；`lint:type-any` 为 overall `0/1187/1987/49/3`、src `0/666/715/8/0`、tests `0/521/1272/41/3`；`lint:warnings-guard` 当前 warning count 为 `157`（baseline `160`）。
- 2026-05-22 final exit gate 真值：在 Node `v20.20.2` / npm `10.8.2` 下，`quality`、`verify:preflight`、`test:unit`、`clean`、`build:dev`、`audit:build:report`、`audit:performance:report`、`verify:stitch-secondary`、`visual:test`、browser smoke、reader-panel、local-vault 均已通过；`build/dist/content/runtime.js` raw `54,554` bytes，低于当时 `57,600` stop gate
- 2026-05-24 M2.5 budget ratchet 真值：M2.1-M2.4 合入后，`audit:build:report` 的 `content/runtime.js` raw stop gate 收紧为 `56,320` bytes；chunk count 收紧为 `<= 112`；hotspot line budgets 以 `docs/performance-baseline.md` 为准
- 2026-06-07 video legacy recovery 真值：视频/阅读 draft 自动恢复入口改为 lazy `sessionDraftAutoRestore-*` chunk 后，`audit:build:report` 的 `content/runtime.js` raw stop gate 同步为 `57,344` bytes；chunk count 继续守住 `<= 112`；完整 build/hotspot 真值以 `docs/performance-baseline.md` 为准
- 2026-06-08 options i18n PR/main merge build-budget 真值：P14 12-language Options i18n final branch 与当前 main 的 video note stability / session draft lazy recovery 合并后，dev build `content/runtime.js` raw stop gate 同步为 `57,348` bytes，`onboarding/index.js` raw stop gate 同步为 `16,395` bytes，chunk count 同步为 `<= 114`；single/shared/locale/YAML chunk budgets 未放宽
- 2026-06-09 video screenshot/session stability final truth：`codex/aiiinob-video-asset-stability-2026-06-08-integration` 在 `fbc24294` 通过 `quality`、`verify:preflight`、P01 attachment + 视频专项 Vitest `11` 文件 / `201` tests、`videoListenerScope.browser.test.ts` Chromium `11` tests。截图准备队列已从 session runtime 静态路径拆为 lazy chunk，`audit:build:report` 当前 dev build chunk count 为 `116`；只同步 chunk count gate，不放宽 entry、single chunk、shared chunk、locale chunk 或 YAML chunk size budget。
- 2026-06-13 final combined integration 历史真值：当时 integration dev build exact stop gate 为 `content/runtime.js` raw `57,386` bytes、`onboarding/index.js` raw `16,459` bytes、`chunk count <= 118`；本次只同步结构债分支与 visible-tab screenshot/export 分支合并后的 dev chunk count，没有放宽 locale/single/shared/YAML budgets。P06 历史修复仍只在 `tests/unit/content/video/VideoSession.test.ts` 内收口 inherited full-file restored screenshot async wait 与 same-page owner-context harness race。
- 2026-06-13 final integration dependency-cycle truth：`audit:deps:report` 发现并阻塞了截图准备 queue/coordinator 循环与 i18n pseudo/runtime type 循环。最终修复将截图请求状态迁入 `videoScreenshotPreparationRequestStore.ts`，让 coordinator 只持有 queue interface；i18n `RuntimeMessages` 类型改由 `localeDefinition.ts` 从 generated messages 导出，pseudo locale/runtime service 不再从 `messages.ts` 回拉入口。复核后 `audit:deps:report` 为 `violations=0`，`audit:performance:report` 覆盖 `sourceFiles=755`、`hotspotsOver250=93`、`registeredLineBudgets=117`。
- 2026-06-17 video screenshot cache / English copy governance integration 真值：本轮以 current `main` 的 English uncatalogued-copy hard gate 为治理基线，并合入 hybrid video screenshot cache 分支的 background-owned IndexedDB Blob cache、metadata-only session drafts、Free restore `48h / 5 pages / 20 items`、single-capture deletion best-effort cache cleanup 与 persistent browser relaunch regression。`unlimitedStorage`、`message_serialization`、`tabCapture` 继续不得加入 manifest；当前开源路径不加入额外产品判断或恢复文案。
- 2026-06-18 GA telemetry production integration acceptance 真值：Fresh production `audit:build:report` 为 `content/runtime.js` raw `50,027` bytes、`onboarding/index.js` raw `10,023` bytes、chunks `104`；fresh dev report 为 `content/runtime.js` raw `58,508` bytes、`onboarding/index.js` raw `17,566` bytes、chunks `118`（onboarding 与 chunk count warning，未超过 hard stop）。`audit:release-surface:report` 为 `Files=173`、forbidden harness/pseudo-locale `none`；`audit:performance:report` 为 `sourceFiles=814`、`hotspotsOver250=108`、`registeredLineBudgets=136`。本轮只修复 activation persisted optional field normalization 与同步 exact current hotspot budgets；没有提高 build hard stop、single/shared chunk、locale chunk、YAML chunk size budget 或 GA secret/release-surface gate。
- 2026-06-20 Options/onboarding closeout 真值：首启页入口改为 lazy bootstrap，支持/建议/联系/更新日志/协议/隐私弹窗由 onboarding 专属轻量 renderer 承载，不再从 onboarding 导入完整 Options/Stitch schema registry 与 renderStitchView。Fresh dev `audit:build:report` 为 `content/runtime.js` raw `58,546` bytes、`onboarding/index.js` raw `1,827` bytes、chunks `122`（warning/hard `118 / 122`），Russian schema locale chunk 当前为 `66.8 KB`，locale chunk hard stop 同步为 `68 KB`；single/shared/YAML chunk size budgets 未放宽。`audit:performance:report` 为 `sourceFiles=823`、`hotspotsOver250=112`、`registeredLineBudgets=140`。
- 2026-06-25 AI chat parser productionization P09 repair 真值：Perplexity parser 选择器恢复为可读数组结构后显式纳入 `tools/report-performance-hotspots.mjs`，exact line budget 为 `src/third_party/ai-chat-exporter/platforms/perplexity.ts <= 281`；fresh `audit:performance:report` 为 `sourceFiles=843`、`hotspotsOver250=113`、`registeredLineBudgets=142`。本轮只同步 line-budget current truth，没有提高 build hard stop、single/shared chunk、locale chunk、YAML chunk size budget 或 runtime parser lazy boundary。
- 2026-05-26 M10 source-of-truth sync 真值：maintainability-debt M0-M10 合入后的 integration branch 上，`quality`、`verify:preflight`、`lint:type-any`、`audit:performance:report`、`audit:build:report`、`audit:compatibility-duplicates:check` 与 `audit:non-production-source:report` 均已重新采集；当前 type/warning/non-production source 数值见下文
- 2026-05-26 M10 budget ratchet 真值：`quality` 显式包含 `lint:type-any:ratchet`；`verify:preflight` 继续包含 `audit:performance:report`，且 performance report 覆盖当前全部 `src` >250 LOC 文件
- 2026-06-01 Plan 09 compatibility duplicate 真值：`quality` 显式包含 `audit:compatibility-duplicates:check`；当前 usage/rest compatibility candidate files 为 `0`，exact duplicate groups 为 `0`，allowlist entries 为 `0`，因此没有生产 allowlist。工具中的旧 `src/options/components/sections/usage*.ts` / `src/options/widgets/shared/usage/**` scope 是 retired compatibility reintroduction guard，只用于防止已退役 usage compatibility shells 被重新引入并复制，不代表当前生产 owner。
- 2026-06-13 test runtime guard 真值：`package.json` 中 `test` / `test:*` / `visual:*` npm scripts 均显式前置 `verify:runtime`；本地 PATH 指向 Node 23 等不支持版本时，测试入口会先失败在 runtime guard，不会启动 Vitest / Playwright。
- 2026-05-25 post-gap runtime guard 真值：本轮验证使用 Node `v20.20.2` / npm `10.8.2`；`package.json` 与 `package-lock.json` root engines 要求 Node `>=20.19 <21`，`verify:runtime` 会读取 `package.json` 的 `engines.node` 并已接入 `quality` 与 `verify:preflight`
- 2026-06-19 Vitest 4 / Vite 8 / release-tooling dependency-audit 真值：Node `v20.20.2` / npm `10.8.2` 下，root devDependencies 精确锁定为 `vitest 4.1.9` 与 `@vitest/coverage-v8 4.1.9`，解析出的 dev test toolchain 为 `vite 8.0.16`、`esbuild 0.28.1`。Firefox signing toolchain 仍通过 `web-ext 10.4.0 -> addons-linter 10.7.0 -> cheerio 1.2.0` 解析；`undici@>=7.0.0 <7.28.0` 已由 root override 锁定到 `7.28.0`，关闭 2026-06-19 发现的 `undici@7.27.2` dev/release-tooling audit 漂移。`npm audit --omit=dev --json` 与 `npm audit --audit-level=low --json` 当前均退出 `0`，total `0` vulnerabilities；此前 `vitest` / `vite` / `esbuild` dev/build/test-only high 链 release exception 已关闭。全量 dev audit 仍不是 `quality` / `verify:preflight` / CI hard gate，除非后续 owner 单独做 gate 决策。迁移兼容修复仅限测试侧：Vitest 4 stricter `Mock` typing、Chrome/Firefox downloads 测试中的 constructible `URL` stub、以及 `@mozilla/readability` constructible mock。coverage hard gate 保持启用并同步为 Vitest 4 口径 floor：statements `76.5`、lines `77`、functions `77.5`、branches `66.5`。
- 2026-06-16 i18n hardcoded P22/post-strict-gap type-ratchet 真值：P16-P22 与 post-P22 strict gap 合入 integration 后，`lint:type-any` 扫描 `1231` files，fresh overall `0/1148/1973/47/3`、src `0/628/695/9/0`、tests `0/520/1278/38/3`；`lint:type-any:ratchet` checked-in 上限同步为 overall `0/1148/1973/53/4`、src `0/628/695/9/0`、tests `0/520/1278/46/4`。本次只同步 accepted integration current truth，`any` 继续保持 `0`，`ts-expect-error` 未增加，non-null 上限未放宽。
- 2026-06-18 GA telemetry post-main type-ratchet 真值：GA integration 合入 current `origin/main` 后，`lint:type-any` 扫描 `1285` files，fresh overall `0/1190/1996/50/3`、src `0/668/715/9/0`、tests `0/522/1281/41/3`；`lint:type-any:ratchet` checked-in 上限同步为 exact current counts。`any` 继续保持 `0`，overall / tests 的 non-null 与 `ts-expect-error` 上限较旧值收紧；tests 下降不得抵消 src 增长。
- 2026-06-18 GA telemetry post-main quality 真值：`quality` fresh run 在 Node `v20.20.2` 下通过；`lint:warnings-guard` checked-in baseline 为 `160`，fresh warning count 为 `159`；`audit:non-production-source:check` decision counts 为 `retain-production: 685`、`migrate-import-owner: 137`、`retain-production-facade: 16`；`audit:deps:report` 输出 `modules=927`、`dependencies=2840`、`violations=0`。本次没有同步 warning baseline，也没有把 dependency / non-production source 报告改成新的 hard threshold。
- 2026-06-16 i18n hardcoded production-copy 真值：`audit:i18n-hardcoded-user-copy` 为报告命令；`audit:i18n-hardcoded-user-copy:check` 会先生成 `build/reports/production-build-graph.json`，再以 `--check` 运行 hardcoded user-copy audit，并已接入 `quality`。当前保留 allowlist 仅限 P21 site-native AI parser tokens；P13 regression matrix `tests/unit/i18n/hardcodedSurfaceCoverage.test.ts` 绑定 P03-P22 migrated surfaces 到 executable evidence，integration full `npm run test` 已通过 `391` files / `2477` tests。
- 2026-06-17 English uncatalogued-copy hard gate 真值：`audit:i18n-uncatalogued-user-copy:check` 会先刷新 production build graph，再扫描 production-reachable `src/**` 与 relevant `public/**` 中疑似英文 UI copy、translation fallback、descriptor-boundary payload、HTML/DOM text。P01-P07 迁移、P07d surface-localization owner split、P08 wiring、coverage follow-up 与 numbered-title follow-up 后，audit 覆盖 `normalizeToAppError(..., { defaultMessage })` raw English fallback，把 `subtitle`、`hint`、`body` 纳入 production-visible field taxonomy，并且不会因为独立编号 token 把多词英文 UI title 归为 technical token list；当前输出 `scanned=578 findings=0 unexpected=0 staleAllowlist=0`，allowlist rules 为 `0`；不得用 broad allowlist 掩盖产品 UI copy。
- 2026-06-17 English uncatalogued-copy build/performance 真值：coverage follow-up 将 Options/Stitch preview navigation seed 拆入 `src/options/stitch/previewNavigation.ts`，`src/options/stitch/content.ts` 当前为 `841` 行且 line budget 收紧为 `<= 841`。Production fast `audit:build:report` 当前输出 `content/runtime.js` raw `49,989` bytes、`onboarding/index.js` raw `9,974` bytes、chunk count `100`；dev `audit:build:report` 当前输出 `content/runtime.js` raw `58,489` bytes、`onboarding/index.js` raw `17,540` bytes、chunk count `114`；`audit:performance:report` 当前输出 `sourceFiles=803`、`hotspotsOver250=100`、`registeredLineBudgets=128`。完整当前热点与 line-budget 口径以 [`performance-baseline.md`](./performance-baseline.md)、`tools/report-build-splitting.mjs` 和 `tools/report-performance-hotspots.mjs` 为准，本次没有放宽 entry、single/shared chunk、locale chunk、YAML 或 line-budget hard gate。
- 2026-06-16 i18n hardcoded P15 preflight build-budget follow-up 前风险状态：`audit:build:report` 在 integration `ca8be48e` 上复现 post-P14 dev-build drift 后，同步 gates 为 `content/runtime.js` warning `58,564` raw bytes / hard stop `58,752`、`onboarding/index.js` warning `17,377` / hard stop `17,633`、release locale chunk hard stop `64 KB`、shared `chunk-*` top-three hard stops `213 KB` / `136 KB` / `133 KB`；当时 chunk count hard stop 为 `120`，single chunk `320 KB`、YAML `70 KB` 未变。该条保留风险来源，不再代表 follow-up 后当前 chunk count gate。
- 2026-06-16 i18n hardcoded follow-up build-budget 真值：AI chat runtime parser loaders 合并为一个 lazy `runtimePlatformParsers-*` boundary，并在 P3 follow-up 切断 `aiChatExtractor.ts -> parse.ts -> registry.ts -> platform parsers` 静态路径后，dev `audit:build:report` chunk count 从 `120` 降为 `101`；chunk count gate 收紧为 warning target `108` / hard stop `118`。`aiChatExtractor-*` 静态 import 图不再包含 platform parser implementation markers，platform parsers 只通过 `runtimeRegistry-*` 动态加载唯一 `runtimePlatformParsers-*`。本次没有提高任何 hard stop，也没有改变 entry/shared/locale/YAML size hard stops。
- 2026-05-29 Plan 11 G2/G3 governance 真值：`lint:hardcoded` 已接入 `quality` 与 CI；`audit:platform-boundary:report` 仍是 report-only standalone evidence，当前报告 `148` findings（composition-root `11`、offscreen-local-vault-permission-root `1`、platform-adapter `93`、shared-runtime-helper `23`、type-only `20`），不得当作 hard gate；全量 `npm audit --audit-level=low` 不是 `quality` hard gate，当前 dependency-audit 状态见上一条。
- 2026-05-29 Plan 11 G4 preflight 真值：`audit:imports:check` 已恢复为 green，当前输出 `No deep relative imports found.`；`verify:preflight` 不再因 `src/content/shared/panels/sessionPanelResizeAdapter.ts` 的深层相对导入失败
- 2026-06-01 Plan 09 final verification 真值：Node `v20.20.2` / npm `10.8.2` 下，YAML editor / Stitch host 的 `exactOptionalPropertyTypes` gap 已用窄范围类型安全修复收口；`typecheck:strict`、`quality`、`verify:preflight`、`build`、`verify:stitch-secondary` 均已重新通过。该修复未放宽门禁，preview freeze JS allowlist 仅刷新为精确 hash。
- 2026-06-03 video-mode structural repair 真值：P01-P06 合入后，`lint:type-any:ratchet` 已按当前实测同步为 overall `0/971/1616/41/4`、src `0/537/565/5/0`、tests `0/434/1051/36/4`；本次同步只反映新增视频/哔哩哔哩测试夹具的 current truth，同时收紧 overall assertions/non-null 与 src unknown/assertion 上限。
- 2026-06-04 i18n-v2 M11 type-ratchet 真值：M02-M10 accepted i18n generated source/test expansion 后，`lint:type-any:ratchet` 已按当前实测同步为 overall `0/991/1658/41/4`、src `0/549/579/5/0`、tests `0/442/1079/36/4`；M11 自身新增 gate test 不增加 type-debt 计数，`any` 与 `ts-expect-error` 上限未放宽。
- 2026-06-05 GA / i18n PR merge type-ratchet 真值：两个 PR 合并后的当前 `lint:type-any` 实测为扫描 `1071` files，overall `0/1084/1776/41/4`、src `0/588/606/5/0`、tests `0/496/1170/36/4`；`lint:type-any:ratchet` 的 checked-in 上限同步为 overall `0/1084/1776/41/4`、src `0/588/606/5/0`、tests `0/496/1170/36/4`，`any` 继续保持 `0`，`non-null` 与 `ts-expect-error` 上限保持原值。
- 2026-06-06 session-draft current-main reintegration type-ratchet 真值：session draft integration 重新基于当前 `origin/main` 合入并补齐 active video draft restore 回退后，`lint:type-any` 实测扫描 `1091` files，overall `0/1132/1845/53/4`、src `0/612/626/7/0`、tests `0/520/1219/46/4`；`lint:type-any:ratchet` 的 checked-in 上限同步为这些 current truth，`any` 继续保持 `0`，`ts-expect-error` 继续保持 `4`，不得用 tests 下降抵消 src 增长。
- 2026-06-07 video legacy recovery type-ratchet 真值：当前集成树 `lint:type-any` 实测扫描 `1111` files，overall `0/1125/1838/53/4`、src `0/612/622/7/0`、tests `0/513/1216/46/4`；`lint:type-any:ratchet` 的 checked-in 上限同步为这些 current truth，`any` 继续保持 `0`，`ts-expect-error` 继续保持 `4`。
- 2026-06-08 options i18n PR/main merge type-ratchet 真值：当前合并树 `lint:type-any` 实测扫描 `1133` files，fresh overall `0/1113/1819/38/4`、src `0/613/628/7/0`、tests `0/500/1191/31/4`；`lint:type-any:ratchet` 的 checked-in 上限守住 overall `0/1125/1838/53/4`、src `0/613/628/7/0`、tests `0/513/1216/46/4`，本次只同步 src merge truth，`any` 继续保持 `0`，`ts-expect-error` 继续保持 `4`。
- 2026-06-07 video note stability 修复真值：`codex/aiiinob-video-note-stability-2026-06-07-integration` 解决了视频时间戳备注在第 6 个及后续 capture 上因 live draft flush、未 scoped editor stop、runtime mutation 绕过 draft sync 而不稳定的问题；最终行为要求新增时间戳、切换其他时间戳截图状态、勾选评论区文字、删除其他 capture、pagehide/visibility persistence 与 export preparation 均不得丢失任一 timestamp note，且截图状态切换不得 seek/pause/play 可见视频。该集成树已通过 `quality`、`verify:preflight`、`test:unit`、`tests/e2e/videoPanelFlow.test.ts` Chromium desktop、reader-panel browser E2E 与独立 closeout audit；P05/P06 的窄 helper extraction / test hardening 已在 workspace plan 中补充记录。
- 2026-06-12 P01 audit truth gate verification：`report-build-splitting` 现已识别 `.generated-*` release locale chunks；generated locale modules 仅承载 non-schema runtime messages 与 WebExtension static messages，schema/options copy 改由 `schemaMessages.generated.ts` + `@i18n/messages` consumer path 提供，不再回灌到 content/runtime locale chunks。当时 dev build release locale chunks 全部低于 `60 KB`：`de 34.7 KB`、`es-419 34.6 KB`、`es-ES 34.7 KB`、`fr 35.5 KB`、`it 33.5 KB`、`ja 37.9 KB`、`ko 35.3 KB`、`pt-BR 34.1 KB`、`ru 48.4 KB`、`zh-CN 29.7 KB`、`zh-TW 29.2 KB`；`audit:build:report`、`audit:locales:report` 与 `audit:performance:report` 均通过。

## 当前推荐执行顺序

本地前置守门：

```bash
npm run release:metadata:check
npm run quality
npm run verify:preflight
npm run typecheck:strict
```

i18n production copy 守门：

```bash
npm run build:dev
npm run test:i18n
npm run audit:i18n-hardcoded-user-copy
npm run audit:i18n-hardcoded-user-copy:check
npm run audit:i18n-uncatalogued-user-copy
npm run audit:i18n-uncatalogued-user-copy:check
npx vitest run --config vitest.unit.config.ts tests/unit/i18n/hardcodedSurfaceCoverage.test.ts
```

`audit:i18n-hardcoded-user-copy` 只打印当前报告；`audit:i18n-hardcoded-user-copy:check` 是 standalone hard gate。`quality` 会先生成 `build/reports/production-build-graph.json` 再直接调用底层 check 脚本以复用同一个 graph；手动直接运行 `node scripts/audit-i18n-hardcoded-user-copy.mjs --check` 前必须先刷新 graph，普通本地使用仍优先 npm script。

`audit:i18n-uncatalogued-user-copy` 打印英文 uncatalogued-copy 报告；`audit:i18n-uncatalogued-user-copy:check` 是 hard gate，并已由 `quality` 与 `verify:preflight` 调用。新增英文产品 UI copy 必须先进入 catalog 或 typed descriptor；`defaultMessage`、`subtitle`、`hint`、`body` 等真实可见字段不能作为 raw English escape hatch。

浏览器与交互验真：

```bash
npm run test:e2e:browser:local-vault
npm run test:e2e:browser:smoke
npm run test:e2e:browser
npm run test:e2e:browser:reader-panel
npm run test:e2e:browser:parallel
npm run verify:stitch-secondary
npm run visual:test
npm run visual:test:parallel
```

Reader/video browser E2E command truth:

- `node scripts/run-playwright.mjs test tests/e2e/<file> --project=chromium-desktop` automatically uses `playwright.reader.config.ts` when no explicit `--config` is supplied.
- `playwright.reader.config.ts` starts the local Playwright web server and runs `build:dev`, so reader/video browser E2E tests do not depend on a pre-existing `build/dist`.
- Visual browser tests remain owned by `playwright.config.ts` and `tests/visual/**`.

Local Vault / release handoff checks:

```bash
npm run release:metadata:check
npm run clean
npm run build
npm run audit:release-surface:report
npm run audit:local-vault-release:report -- --browser chrome
npm run build:firefox
npm run audit:local-vault-release:report -- --browser firefox
npm run release:chrome -- --zip <release.zip>
```

`build/dist` is a single-browser-target output. Run the Chrome Local Vault release
audit immediately after the Chrome production build, then rebuild for Firefox
before running the Firefox audit; do not reuse a Firefox build for Chrome audit or
a Chrome build for Firefox audit. `build:fast` / `build:firefox:fast` are only
acceptable when a surrounding standalone quality gate has already passed.

`release:chrome` is a dry-run alias. A real Chrome Web Store publish must use
`npm run release:chrome:publish -- --zip <release.zip>` with owner-provided
credentials and manual confirmation.

GA production release public config is loaded from ignored
`.env.production.local`. The reusable owner commands are:

```bash
npm run analytics:validate:prod
npm run analytics:validate:prod:required
npm run analytics:smoke:delivery
npm run build:prod:ga
npm run package:prod:ga
npm run package:firefox:prod:ga
npm run build:firefox:prod:ga:ci
npm run package:firefox:prod:ga:ci
npm run release:prod:ga
node scripts/run-ga-owner-smoke.mjs --mode proxy --event runtime_harness_open
node scripts/run-ga-owner-smoke.mjs --mode directDebug --event runtime_harness_open
```

The file must only contain public build config (`measurementId`,
`transportMode`, `proxyEndpoint`). GA `api_secret` remains server-only in the
Cloudflare Worker secret `GA4_API_SECRET`.
`directDebug` is also proxy-backed: it requires an owner debug proxy endpoint and
must not call Google debug endpoints directly from the extension.
Runtime `enabled` is live OR semantics (`analytics || errorReporting`), but actual
sendability stays event-scoped: usage/product events require `analytics` consent,
and `extension_error` requires `errorReporting` consent.
`analytics:validate:prod` is a static/public-config + owner env sanity check; it
now validates the tracked transport/consent contract, proxy-only negative guards,
and public env shape, but it still does not prove real GA property delivery,
DebugView visibility, or server-side `api_secret` injection. If
`.env.production.local` is absent, the validator still runs and reports missing
public values as warnings.
`analytics:validate:prod:required` runs the same contract but is the strict CI /
release automation entry: it does not load `.env.production.local`, requires
canonical `ZENDIO_GA_MEASUREMENT_ID` / `ZENDIO_GA_TRANSPORT_MODE` /
`ZENDIO_GA_PROXY_ENDPOINT`, and requires `ZENDIO_GA_TRANSPORT_MODE=proxy`. The
`*:ci` Firefox GA package scripts likewise do not load `.env.production.local`;
they expect CI environment variables or repository secrets to be injected by the
caller.
`audit:ga:proxy-contract` / `audit:ga:docs` / `audit:ga:legacy-api` are
deterministic static gates and are wired into `quality` and `verify:preflight`.
`audit:ga:client-secret` scans client runtime `src/**` plus the current
`build/dist` for secret-like GA tokens and direct Google Measurement Protocol
endpoints. `audit:ga:release-surface` scans the same `build/dist` surface and
can additionally check Chrome ZIP / Firefox XPI archives via repeated
`--archive <path>` arguments for secret/direct-endpoint leaks and debug success
log payload exposure. Neither gate requires live proxy success or owner-only
credentials.
`analytics:smoke:delivery` is an opt-in owner-run proxy acceptance smoke. It is
not wired into `quality`, `verify:preflight`, build, package, release, or CI.
By default it skips cleanly when the public env is incomplete; `--require-env`
turns incomplete env into failure; `--dry-run` prints only a redacted summary;
`--event-name` is limited to allowlisted synthetic events. It never accepts
`api_secret`, never prints event params, and refuses direct Google Measurement
Protocol hosts.
Successful production proxy sends are intentionally silent in the console. Only
`directDebug` emits `[analytics-events] Event sent (debug):` with a summary
(`eventName`, `transportMode`, `responseStatus`, validation message count) and
never logs event params.
`analytics_client_id` and `analytics_session_id` are local-only storage keys
until the relevant event-class consent and public config make a send possible;
`clearAllData()` / analytics data clear removes both ids.
Public-safe analytics operations are documented in
[`analytics-operations-runbook.md`](./analytics-operations-runbook.md). Real GA4
property links, Cloudflare account evidence, dashboard URLs, screenshots,
deployment records, rollback records, and owner platform incident notes belong
in private ops assets, not this product repository.

## GA / Video Targeted Checks

```bash
npm run analytics:validate:prod
npm run analytics:smoke:delivery -- --dry-run
npm run audit:ga:proxy-contract
npm run audit:ga:docs
npm run audit:ga:legacy-api
npm run audit:ga:client-secret
npm run audit:ga:release-surface
node scripts/run-ga-owner-smoke.mjs --mode proxy --event runtime_harness_open
node scripts/run-ga-owner-smoke.mjs --mode directDebug --event runtime_harness_open
node scripts/run-ga-owner-smoke.mjs --help
npx vitest run --config vitest.unit.config.ts tests/unit/scripts/runGaOwnerSmoke.test.ts tests/unit/scripts/analyticsDeliverySmoke.test.ts
npx vitest run tests/unit/background/analyticsEvents.test.ts tests/unit/shared/errors/analytics/index.test.ts tests/unit/shared/errors/analyticsConfig.test.ts
npx vitest run tests/unit/content/video/videoScreenshotCacheRepository.test.ts tests/unit/content/video/videoScreenshotCacheBackgroundClient.test.ts tests/unit/content/video/VideoSession.test.ts tests/unit/content/video/videoFrameScreenshot.test.ts tests/unit/background/visibleTabScreenshot.test.ts tests/unit/background/runtimeMessages.test.ts
node scripts/run-playwright.mjs test tests/e2e/videoPanelFlow.test.ts tests/e2e/videoListenerScope.browser.test.ts --project=chromium-desktop
```

Use these commands to validate the settled GA consent/transport contract and the
video screenshot intent-to-attachment path. `report-ga-docs-contract` binds
`ga4-telemetry-reference.md`, `google-analytics-dashboard-setup.md`, and
`analytics-operations-runbook.md` to the current schema / proxy contract and
public-safe secret guidance; it does not prove real GA property delivery,
DebugView visibility, owner retention settings, or server-side `api_secret`
injection.
`analytics:validate:prod` remains the static/public-config contract check, and
`analytics:smoke:delivery` only proves that an owner proxy accepted a synthetic
event under the current public env. For package/release surfaces, run
`npm run package:prod:ga` or `npm run package:firefox:prod:ga` first, then pass
the produced archive path(s) to
`npm run audit:ga:release-surface -- --archive <zip-or-xpi>`. Chrome ZIP and
Firefox XPI must be scanned against their own artifacts; do not reuse the wrong
browser target output. `run-ga-owner-smoke.mjs` is an owner CLI harness: it
rejects client-side secret env vars, sends only to the configured proxy endpoint,
and prints a redacted summary. Its local output proves request shape and local
proxy behavior only; it does not prove real GA property delivery, DebugView
visibility, or server-side `api_secret` injection unless the owner adds external
evidence. Screenshot attachment templates still plan only export-time output
paths / Markdown URLs; durable draft state persists `screenshotRequested` plus
metadata-only `screenshotRef`, while screenshot bytes now live in the
background-owned extension IndexedDB Blob cache. Legacy `storage.local` base64
cache rows are compatibility-only and are best-effort migrated/cleaned on valid
loads. Runtime message boundaries remain JSON-safe via serialized binary
content; cache hits restore without immediate visible-video seek; legacy
ref-less drafts plus missing/expired/corrupt refs fall back to low-concurrency
screenshot preparation. No idle zip/archive packing is implemented.

## 当前 Lint / Type 债务真值

2026-05-29 post-remediation governance truth:

- `npm run lint -- --quiet`：通过，当前没有 ESLint error。
- `npm run lint:warnings-guard`：2026-06-18 GA telemetry post-main quality fresh run 通过；checked-in baseline 为 `160`，当前 warning 总数为 `159`，gate 输出为 `Warning 总量下降 1 条（现在 159 条）`。当前规则族为 `@typescript-eslint/require-await: 111`、`@typescript-eslint/no-unsafe-assignment: 23`、`@typescript-eslint/no-unsafe-return: 6`、`@typescript-eslint/no-floating-promises: 1`、`@typescript-eslint/no-unsafe-member-access: 12`、`@typescript-eslint/no-unsafe-argument: 4`、`@typescript-eslint/no-unsafe-call: 1`、`@typescript-eslint/no-misused-promises: 1`。
- `npm run lint:warnings-report`：会重写 `tools/baselines/lint-warnings.json`，不得在普通里程碑中随手运行后遗留 diff；只在有意同步 warning truth 时运行。
- 当前 fresh warning 主要规则族：`require-await`（`111`）与 unsafe type warnings（`no-unsafe-assignment: 23`、`no-unsafe-return: 6`、`no-unsafe-argument: 4`、`no-unsafe-member-access: 12`、`no-unsafe-call: 1`）。
- `npm run lint:hardcoded`：通过；当前为 `0` hardcoded findings，且已接入 `quality` 与 CI。
- `npm run lint:type-any`：2026-06-18 GA telemetry post-main integration fresh run 扫描 `1285` files；fresh overall 为 `any: 0`、`unknown: 1190`、assertions `1996`、non-null assertions `50`、`ts-expect-error: 3`；src 为 `0/668/715/9/0`；tests 为 `0/522/1281/41/3`。
- `scripts/audit-types.mjs` 支持 overall 阈值参数 `--max-any`、`--max-unknown`、`--max-assertions`、`--max-non-null`、`--max-ts-expect-error`，并支持 scoped 阈值参数 `--max-src-*` / `--max-tests-*`。
- `npm run lint:type-any:ratchet`：checked-in 上限为 overall `0/1190/1996/50/3`、src `0/668/715/9/0`、tests `0/522/1281/41/3`，并已接入 `quality` 作为 type-debt hard gate；2026-06-18 GA telemetry post-main integration fresh run 通过。此次同步只反映 GA integration 合入 current `origin/main` 后的 exact current truth，`any` 继续为 `0`，overall / tests 的 non-null 与 `ts-expect-error` 上限较旧值收紧，且 tests 下降不得抵消 src 增长。
- `npm run audit:platform-boundary:report`：通过，当前为 `148` findings（composition-root `11`、offscreen-local-vault-permission-root `1`、platform-adapter `93`、shared-runtime-helper `23`、type-only `20`）；仍是 report-only，不得表述为 hard gate。
- `npm run audit:non-production-source:report`：在先运行 `npm run audit:production-build-graph:report` 后通过。P01 修复了 `resolveSourceImport()` 对 `?inline` / `#hash` specifier 的 owner 解析，`src/content/video/video-control-bar.css` 不再误报为 `migrate-test-owner`。当前 decision counts 为 `retain-production: 685`、`migrate-import-owner: 137`、`retain-production-facade: 16`。

## 当前构建预算真值

`npm run audit:build:report` 当前执行以下预算。2026-06-16 i18n hardcoded
follow-up 将 AI chat runtime parser per-platform wrapper chunks 合并到一个
lazy `runtimePlatformParsers-*` boundary，并在 P3 follow-up 切断
`aiChatExtractor.ts -> parse.ts -> registry.ts -> platform parsers` 静态路径
后，chunk count gate 已从 P15 的 warning `118` / hard stop `120` 收紧为
warning `108` / hard stop `118`；2026-06-20 Options/onboarding closeout 将
首启页 bootstrap 与轻量资源弹窗作为保留 lazy surface，同步为 warning `118`
/ hard stop `122`。entry/shared/YAML size gates 未放宽。

- `content/index.js <= 1 KB`
- `content/runtime.js`: warning target `58,564` raw bytes；hard stop `58,752` raw bytes
- `options/index.js <= 12 KB`
- `onboarding/index.js`: warning target `17,377` raw bytes；hard stop `17,633` raw bytes
- 任一 chunk `<= 320 KB`
- 最大 shared chunk `<= 213 KB`
- 第二大 shared chunk `<= 136 KB`
- 第三大 shared chunk `<= 133 KB`
- locale chunk `<= 68 KB`
- `yaml-config <= 70 KB`
- `chunk count`: warning target `118`；hard stop `122`
- 当前 `M4` 口径以“保住已验真的 retained set”为准，不再强制证明旧版单批文件数预算

2026-05-29 Plan 11 G3 dev build truth:

- `npm run verify:preflight` 后的 `npm run audit:build:report` 通过
- `build/dist/content/runtime.js`: `53.1 KB`（raw `54,375` bytes；raw stop gate `56,320`）
- `build/dist/options/index.js`: `997 B`
- `build/dist/onboarding/index.js`: `12.3 KB`
- chunks: `103`
- 2026-05-22 review gap patch 在 Node `v20.20.2` / npm `10.8.2` 下补跑并通过 Chrome `npm run build` -> `npm run audit:local-vault-release:report -- --browser chrome`、Firefox `npm run build:firefox` -> `npm run audit:local-vault-release:report -- --browser firefox`
- `src/shared/errors/analytics/analyticsConfig.ts` is tracked as a non-sensitive disabled default; clean checkout no longer needs a copied ignored local analytics file for typecheck/build.

2026-06-05 GA production telemetry P13 final build truth:

- `quality` 与 `verify:preflight` 在 Node `v20.20.2` 下通过
- `build/dist/content/runtime.js`: `54.9 KB`（raw `56,170` bytes；raw stop gate `56,320`）
- `build/dist/options/index.js`: `997 B`
- `build/dist/onboarding/index.js`: `15.8 KB`（raw `16,200` bytes）
- chunks: `109`
- GA content/onboarding telemetry now lives behind lazy `clipFlowAnalytics-*` / `onboardingAnalytics-*` chunks so entry bundles remain within the existing release gates.

2026-06-06 session-draft current-main reintegration build truth:

- `quality`、`verify:preflight`、Chrome `build`、Firefox `build:firefox`、release surface audits 与 Chrome/Firefox Local Vault release audits 在 Node `v20.20.2` 下通过
- dev `build/dist/content/runtime.js`: `54.9 KB`（raw `56,170` bytes；raw stop gate `56,320`）
- dev chunks: `110`
- Chrome production fast `build/dist/content/runtime.js`: `47.6 KB`
- Chrome production fast chunks: `91`
- 详细 build/hotspot 数值以 [`performance-baseline.md`](./performance-baseline.md) 为准

2026-06-08 options i18n PR/main merge build truth:

- `quality`、`verify:preflight`、Chrome `build:fast`、`build:dev` 与 `audit:build:report` 在 Node `v20.20.2` 下通过
- dev `build/dist/content/runtime.js`: `56.0 KB`（raw `57,348` bytes；raw stop gate `57,348`）
- dev chunks: `114`
- performance coverage: trackedSourceFiles=`726`、hotspotsOver250=`95`、registeredLineBudgets=`113`
- `sessionDraftAutoRestore-*` 作为 lazy chunk 承载页面进入后的 reader/video draft 自动恢复，不再把恢复实现本体压入 content 主入口

2026-06-09 video screenshot/session stability final build truth:

- `quality`、`verify:preflight`、P01 attachment + 视频专项 Vitest `11` 文件 / `201` tests 与 `videoListenerScope.browser.test.ts` Chromium `11` tests 在 Node `v20.20.2` 下通过
- dev `build/dist/content/runtime.js`: `56.0 KB`（raw `57,348` bytes；raw stop gate `57,348`）
- dev chunks: `116`
- shared Top 3: `134.9 KB` / `128.1 KB` / `82.8 KB`
- `chunks/runtimeEntry-*.js`: `240.5 KB`
- `chunks/videoSessionControllers-*.js`: `85.6 KB`
- `chunks/videoLazyRuntime-*.js`: `44.8 KB`
- `chunks/videoScreenshotPreparationQueue-*.js`: `18.0 KB`
- performance coverage: sourceFiles=`733`、hotspotsOver250=`94`、registeredLineBudgets=`113`
- `videoScreenshotPreparationQueue-*` 是截图准备实现的显式 lazy split；chunk count gate 只为该 split 与小型 shared screenshot-intent bridge 同步，entry/shared/locale/YAML size gates 未放宽

2026-06-17 video screenshot cache main integration build/type/regression truth:

- 本轮集成保留 `node scripts/run-playwright.mjs test tests/e2e/videoPanelFlow.test.ts --project=chromium-desktop` 作为视频截图混合缓存 browser truth；该文件覆盖 reload、关闭页面后同 context 重开、关闭 persistent browser context 后用同一 `userDataDir` relaunch，以及删除 capture 后 IndexedDB cache entry 清理。
- P06 inherited restored-screenshot focused proof 与 P07 reader browser proof 继续作为历史补充证据；本轮不改变 production 截图 bytes owner，不把 Blob/data URL 写回 durable session draft。
- 本轮 focused Vitest `5` 文件 / `79` tests、`VideoSessionDraftController.test.ts` `21` tests、`VideoSession.test.ts` `96` tests 与 Chromium `videoPanelFlow.test.ts` `3` tests 通过。`lint:type-any:ratchet` fresh overall `0/1141/1954/50/3`、src `0/627/692/9/0`、tests `0/514/1262/41/3`；`lint:warnings-guard` baseline `160`；English uncatalogued-copy audit 输出 `scanned=583 findings=0 unexpected=0 staleAllowlist=0`。
- Fresh build/performance truth 已由 2026-06-18 GA telemetry acceptance gap fix 重新同步到 [`performance-baseline.md`](./performance-baseline.md)：production `content/runtime.js` raw `50,027` bytes、`onboarding/index.js` raw `10,023` bytes、chunks `104`；dev `content/runtime.js` raw `58,508` bytes、`onboarding/index.js` raw `17,566` bytes、chunks `118`；release-surface `Files=173`；performance `sourceFiles=814`、`hotspotsOver250=108`、`registeredLineBudgets=136`。

## 核心命令

- `npm run build:dev`
- `npm run build`
- `npm run typecheck:app`
- `npm run typecheck:tests`
- `npm run typecheck:strict`
- `npm run test:unit`
- `npm run test:e2e`
- `npm run test:e2e:browser`
- `npm run test:e2e:browser:smoke`
- `npm run test:e2e:browser:reader-panel`
- `npm run test:coverage`
- `npm run test:i18n`
- `npm run lint:hardcoded`
- `npm run audit:locales:report`
- `npm run visual:test`
- `npm run verify:runtime`
- `npm run report:release-summary`
- `npm run audit:local-vault-release:report`
- `npm run audit:release-surface:report`

## 正式代码入口

- foundation：`src/ui/foundation/*`
- primitives：`src/ui/primitives/*`
- patterns：`src/ui/patterns/*`
- hosts：`src/ui/hosts/*`
- domains：`src/ui/domains/*`
- Options 主链：`src/options/index.ts -> src/options/app/bootstrap.ts`
- content 主链：`src/content/index.ts -> src/content/runtime/*`

## 已降级为兼容壳的入口

- `src/content/video/session.ts`
- `src/content/video/platforms/bilibiliPlatform.ts`
- `src/ui/domains/privacy/PrivacySettings.ts`

## MCP / 本地浏览器调试入口

生产构建与发布包默认不包含 harness 入口；`build:dev` / dev server 保留以下 harness 页面用于本地浏览器调试：

- `http://localhost:4173/options/index.html`
- `http://localhost:4173/onboarding/index.html`
- `http://localhost:4173/content-orchestrator-harness.html`
- `http://localhost:4173/runtime-observability-harness.html`
- `http://localhost:4173/interaction-contract-harness.html`
