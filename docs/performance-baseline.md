# 性能优化与热点基线

日期：2026-06-29

## 1. 构建真值

验证命令：

```bash
npm run clean
npm run build:fast
npm run audit:build:report
npm run build:dev
npm run audit:build:report
```

2026-06-23 post-0.2.0 P07 governance 复核在 branch `codex/aiiinob-post-020-p07-performance-observability-2026-06-22` / source baseline commit `7495ab47` 上重新采集 `build:fast`、`build:dev`、`audit:build:report`、`audit:release-surface:report`、`audit:performance:report`、`audit:deps:report`、`audit:platform-boundary:report`、`audit:non-production-source:report`、`lint:type-any` 与 `lint:warnings-guard`。P07 后续只同步 docs、tool budget ratchets 与对应 tool test expectation，没有做 runtime-code line-count edits。本节下方“当前”区块以本次 P07 采集为准；更早段落中的“当前”只表示该历史条目采集当时的 current truth。

2026-05-24 M2.5 budget ratchet 复核在 Node `v20.20.2` / npm `10.8.2` 下完成，输入为 M2.1-M2.4 全部合入后的 integration baseline。

2026-05-25 M4.3 dev build surface budget 复核在同一 Node/npm 版本下完成。Production fast build 继续排除 dev/test harness 与 `qps-ploc` pseudo-locale，并由 `audit:release-surface:report` 证明 forbidden harness members 与 forbidden dev/test pseudo-locale members 均为 `none`。当时 dev build 保留本地浏览器 harness 与 `qps-ploc`，但仍必须通过当时更严格的 `audit:build:report` 预算；该预算已经严于本轮 plan 的 `content/runtime.js <= 57,600 bytes`、`chunk count <= 132` 和 locale chunk `<= 60 KB` 约束。

2026-05-25 M5.1 source-of-truth sync 复核重新采集 `quality`、`verify:preflight`、`audit:performance:report` 与 `audit:build:report`。以下 dev build 与热点数值以该次采集为当前真值。

2026-05-25 M5.3 budget ratchet 将 `audit:performance:report` 的 line-budget 覆盖扩展为当前全部 `src` >250 LOC 文件；每个路径的预算等于本次实测行数。下方“当前热点”仍保留高信号业务/运行时热点摘要，完整预算集以 `tools/report-performance-hotspots.mjs` 为准。

2026-05-26 M10 doc/gate sync 复核重新采集 `quality`、`verify:preflight`、`audit:performance:report`、`build:dev` 与 `audit:build:report`。本页数值仍以当前 dev build 与 hotspot audit 为真值；M10 仅收紧已通过的 warning/type gate，不改变生产构建路径。

2026-05-29 Plan 11 G3 source-of-truth sync 复核重新采集 `build:fast`、`build:dev`、`audit:build:report` 与 `audit:performance:report`。本页数值以该次采集为当前构建和热点真值。

2026-06-06 session-draft current-main reintegration 复核重新采集 `quality`、`verify:preflight`、`build:fast`、`build:dev`、`audit:build:report`、`audit:performance:report`、Chrome `build` / release audit 与 Firefox `build:firefox` / release audit。当前 build/hotspot/line-budget 数值以该次采集为当前真值；reader/video session draft integration 新增的 hotspot owner 已补齐 exact current-line budgets，既有 runtime/message hotspots 也已同步到当前行数。

2026-06-06 video screenshot attachment verification 复核重新采集 `audit:performance:report`。本轮仅补齐 feature-owned hotspot line budgets：`src/shared/attachments/videoScreenshotAttachmentTemplates.ts <= 523` 与 `src/background/application/videoScreenshotAttachmentPlanner.ts <= 269`；同步后当前 audit 输出为 trackedSourceFiles=`706`、hotspotsOver250=`104`、registeredLineBudgets=`107`。

2026-06-07 video legacy recovery 复核重新采集 `verify:preflight`、Chrome `build`、Firefox `build:firefox`、`build:dev`、`audit:build:report` 与 `audit:performance:report`。视频/阅读 draft 自动恢复入口改为 lazy `sessionDraftAutoRestore-*` chunk，避免恢复实现本体进入 content 主入口；当前 dev build `content/runtime.js` raw stop gate 同步为 `57,344` bytes，chunk count 继续守住 `<= 112`，当前 performance coverage 为 trackedSourceFiles=`717`、hotspotsOver250=`105`、registeredLineBudgets=`108`。

2026-06-08 Options i18n PR/main merge 复核重新采集 `quality`、`verify:preflight`、`build:fast` 与 `audit:build:report`。P14 12-language Options i18n final branch 与当前 main 的 video note stability / session draft lazy recovery 合并后，dev build 只在 entry raw bytes 与 chunk count 上形成叠加漂移：`content/runtime.js` raw stop gate 同步为 `57,348` bytes，`onboarding/index.js` raw stop gate 同步为 `16,395` bytes，chunk count 同步为 `<= 114`。本次未放宽任一 single chunk、shared chunk、locale chunk 或 YAML chunk budget。

2026-06-09 video screenshot/session stability final integration 复核重新采集 `quality`、`verify:preflight`、视频专项 Vitest `8` 文件 / `155` tests 与 `videoListenerScope.browser.test.ts` Chromium `11` tests。截图准备队列从 session runtime 静态路径拆为 lazy `videoScreenshotPreparationQueue-*` chunk；dev build chunk count 同步为 `<= 116`。本次只为该 lazy split 与小型 shared screenshot-intent bridge 同步 chunk count gate，`content/runtime.js`、entry、single chunk、shared chunk、locale chunk 与 YAML chunk size budget 均未放宽。

2026-06-12 video control-bar UI debt final verification 复核重新采集 `verify:preflight`、`verify:stitch-secondary`、视频专项 Vitest / fixture / Chromium reader E2E 与 `test:e2e:browser`。本次仅同步 control-bar UI 结构化迁移直接触发的 exact hotspot line budgets：`src/options/stitch/types.ts <= 759`、`src/content/video/videoPromptLifecycle.ts <= 490`、`src/content/stitch/runtimeSurfaceContent.ts <= 407`；dev build chunk count 仍为 `<= 116`，entry/shared/locale/YAML chunk size budgets 未放宽。

2026-06-12 P01 audit truth gate verification 复核重新采集 `build:dev`、`audit:build:report`、`audit:locales:report` 与 `audit:performance:report`。`report-build-splitting` 现已识别 `.generated-*` release locale chunks；generated locale modules 仅承载 non-schema runtime messages 与 WebExtension static messages，schema/options copy 改由 `schemaMessages.generated.ts` + `@i18n/messages` consumer path 提供，不再回灌到 content/runtime locale chunk。当时 dev build release locale chunks 全部低于 `60 KB`：`de 34.7 KB`、`es-419 34.6 KB`、`es-ES 34.7 KB`、`fr 35.5 KB`、`it 33.5 KB`、`ja 37.9 KB`、`ko 35.3 KB`、`pt-BR 34.1 KB`、`ru 48.4 KB`、`zh-CN 29.7 KB`、`zh-TW 29.2 KB`。

2026-06-13 final combined integration 复核重新采集 `build:dev`、`audit:build:report`、`lint:type-any:ratchet`、`typecheck:app`、`typecheck:tests` 与视频 focused tests。当时 integration dev-build exact stop gates 为 `content/runtime.js` raw `57,386` bytes、`onboarding/index.js` raw `16,459` bytes、`chunk count <= 118`；本次只同步结构债分支与 visible-tab screenshot/export 分支合并后的 dev chunk count，不放宽 locale、single chunk、shared chunk 或 YAML chunk size budgets。P06 历史修复仍只在 `tests/unit/content/video/VideoSession.test.ts` 内收口 inherited full-file restored screenshot async wait 与 same-page owner-context harness race。

2026-06-13 final integration dependency-cycle closeout 复核重新采集 `typecheck:app`、`typecheck:tests`、`audit:deps:report`、`audit:performance:report`、`build:dev`、`audit:build:report` 与 i18n/video focused tests。截图准备请求状态从 coordinator 拆入 `videoScreenshotPreparationRequestStore.ts` 后，dependency-cruiser 循环违规为 `0`；当前 performance coverage 为 sourceFiles=`755`、hotspotsOver250=`93`、registeredLineBudgets=`117`。该收口同步 `videoScreenshotPreparationRequestStore.ts <= 306`、`videoScreenshotPreparationQueue.ts <= 404`、`VideoDialogPanel.ts <= 425`、`runtimeMessages.ts <= 351` 与 `videoScreenshotPreparationCoordinator.ts <= 147` exact line budgets，没有放宽 entry/shared/locale/YAML chunk size budgets。

2026-06-13 GA P01 schema core 复核重新采集 `typecheck:app`、`typecheck:tests`、`lint -- --quiet`、focused analytics Vitest、`audit:deps:report` 与 `audit:performance:report`。GA 事件契约已从手写 `eventCatalog.ts` / `analyticsSanitizers.ts` 双表迁到 schema-owned `src/shared/analytics/schema/**`；当前 performance coverage 为 sourceFiles=`758`、hotspotsOver250=`92`、registeredLineBudgets=`118`。本次只新增 `src/shared/analytics/schema/analyticsSchema.ts <= 478` exact line budget；`eventCatalog.ts` 与 `analyticsSanitizers.ts` 已分别收敛到 `78` / `95` 行，因此不再是 >250 LOC hotspot。

2026-06-14 P06 performance budget guard 复核重新采集 `build:dev`、`audit:build:report` 与 `audit:performance:report`。`report-build-splitting` 现在对 tight dev-build gates 同时输出 observed、warning target 与 hard stop：`content/runtime.js` observed/warning `57,209` raw bytes、hard stop `57,386`；`onboarding/index.js` observed/warning `16,459` raw bytes、hard stop `16,715`；chunk count observed/warning `118`、hard stop `120`。本次没有放宽 locale、single/shared chunk 或 YAML chunk size budgets。`audit:performance:report` 当前为 sourceFiles=`764`、hotspotsOver250=`96`、registeredLineBudgets=`120`，并补齐 `videoCaptureMutationTransaction.ts <= 283` 与 `runtimeMessages.ts <= 356` exact owner budgets。

2026-06-16 i18n hardcoded P15 preflight build-budget sync 在 integration `ca8be48e` 上复现了与 import-boundary gap branch 相同的 dev-build budget drift。follow-up 前风险状态为 `content/runtime.js` raw `58,564` bytes（hard stop `58,752`）、`onboarding/index.js` raw `17,377` bytes（hard stop `17,633`）、chunk count `120`（warning `118` / hard stop `120`）、Russian release locale chunk raw `64,525` bytes（locale chunk hard stop `64 KB`），shared `chunk-*` top three 为 raw `217,959`、`138,187`、`135,188` bytes。本次只同步 accepted P16-P22/P13/P14 i18n hardcoded integration risk state；不改变生产代码、single chunk、YAML 或 chunk count hard stop。当前 follow-up 后 chunk count gate 见下一条。

2026-06-15 0.2.0 release-debt P09 final gap fix historical evidence：当时重新采集 `build:fast`、`build:dev`、`audit:build:report`、`audit:performance:report` 与 `audit:release-surface:report`。当时 production build report 为 `content/runtime.js = 49,284` bytes、`onboarding/index.js = 9,570` bytes、`chunks = 93`；`audit:release-surface:report` 当时为 `Files = 160`、forbidden harness members `none`、forbidden dev/test pseudo-locale members `none`。当时 dev build report 为 `content/runtime.js = 57,133` bytes（warning/hard `57,209 / 57,386`）、`onboarding/index.js = 16,447` bytes（warning/hard `16,459 / 16,715`）、`chunk count = 108`（warning/hard `118 / 120`），未触发 dev build budget warning。本轮通过 AI parser lazy wrapper 按 `openaiFamily-*` / `chineseFamily-*` / `assistantFamily-*` 分组、删除 onboarding 入口冗余 route guard、收窄 content 入口 platform service reachability 释放余量；未放宽 locale、single/shared chunk、YAML chunk size budget 或 warning/hard gates。同时 `audit:performance:report` 当时为 `sourceFiles=786`、`hotspotsOver250=95`、`registeredLineBudgets=120`。`videoSessionDraftController.ts` 继续低于其当时预算。

2026-06-17 P08 performance/docs sync 复核重新采集 `verify:runtime`、`build:dev`、`audit:build:report`、`audit:performance:report`、`audit:deps:report`、`audit:imports:check`、`build:fast` 与 `audit:release-surface:report`。当前 production build report 为 `content/runtime.js = 49,325` bytes、`onboarding/index.js = 9,606` bytes、`chunks = 95`；`audit:release-surface:report` 当前为 `Files = 162`、forbidden harness members `none`、forbidden dev/test pseudo-locale members `none`。当前 dev build report 为 `content/runtime.js = 57,179` bytes（warning/hard `57,209 / 57,386`）、`onboarding/index.js = 16,485` bytes（warning/hard `16,459 / 16,715`）、`chunk count = 111`（warning/hard `118 / 120`）；当前只触发 dev onboarding warning target，没有触发 hard stop，也没有放宽任何 build/performance gate。`audit:performance:report` 当前为 `sourceFiles=790`、`hotspotsOver250=95`、`registeredLineBudgets=120`。混合缓存新增支撑文件 `videoScreenshotCacheStore.ts`、`videoScreenshotEncoding.ts`、`videoSessionDraftScreenshotCache.ts`、background `videoScreenshotCacheIndexedDbStore.ts` 与 E2E util `videoScreenshotCacheIndexedDb.ts` 均未超过需要新增 hard budget 的阈值，因此本轮未修改 `tools/report-build-splitting.mjs` 或 `tools/report-performance-hotspots.mjs`。

2026-06-17 P09 final integration quality-gate gap fix 复核重新采集 `typecheck:app`、`typecheck:tests`、`typecheck:strict`、`lint:type-any`、`lint:type-any:ratchet`、`lint:warnings-guard`、focused video screenshot Vitest、`build:fast` 与 `audit:performance:report`。P09 为避免 `unknown` / assertion ratchet 回退，把 background-owned IndexedDB store 的 DOM IDB boundary 收紧为内部 facade；该文件进入 >250 LOC hotspot 后新增精确预算 `src/background/services/videoScreenshotCacheIndexedDbStore.ts <= 335`。本次没有放宽既有 `runtimeMessages.ts <= 356` 预算；该文件收敛到 `324` 行。当前 performance coverage 为 sourceFiles=`790`、hotspotsOver250=`96`、registeredLineBudgets=`121`。

2026-06-17 video screenshot cache / English copy governance main integration 以 current `main` 的 English uncatalogued-copy hard gate 与 hybrid screenshot cache 分支的 IndexedDB Blob cache architecture 为合并基线，并重新采集 `build:fast`、`audit:build:report`、`build:dev`、`audit:build:report`、`audit:release-surface:report` 与 `audit:performance:report`。Fresh production build report 为 `content/runtime.js = 49,997` bytes、`onboarding/index.js = 10,023` bytes、`chunks = 104`；fresh dev build report 为 `content/runtime.js = 58,459` bytes（warning/hard `58,564 / 58,752`）、`onboarding/index.js = 17,566` bytes（warning/hard `17,377 / 17,633`）、`chunk count = 118`（warning/hard `108 / 118`）。当前 dev build 仅触发 onboarding 与 chunk count warning，没有超过 hard stop；本轮没有放宽 entry、single/shared chunk、locale chunk、YAML chunk size budget 或 existing line-budget hard gate。`audit:release-surface:report` 输出 `Files = 172`、forbidden harness members `none`、forbidden dev/test pseudo-locale members `none`；`audit:performance:report` 输出 sourceFiles=`811`、hotspotsOver250=`102`、registeredLineBudgets=`130`。新增 `src/content/video/videoSessionDraftScreenshotCache.ts <= 251` exact line budget 只覆盖本轮新发现的 >250 LOC helper hotspot。

2026-06-18 GA telemetry production integration acceptance gap fix 复核重新采集 focused activation Vitest、`typecheck:strict`、`build:fast`、`audit:build:report`、`build:dev`、`audit:build:report`、`audit:release-surface:report` 与 `audit:performance:report`。本轮修复只收口 `exactOptionalPropertyTypes` 下 activation persisted optional fields 的 normalize 写回，并同步 GA integration 分支当前 >250 LOC hotspot exact budgets；没有提高 build hard stop、single/shared chunk、locale chunk、YAML chunk size budget 或 GA secret/release-surface gate。Fresh production build report 为 `content/runtime.js = 50,027` bytes、`onboarding/index.js = 10,023` bytes、`chunks = 104`；fresh dev build report 为 `content/runtime.js = 58,508` bytes（warning/hard `58,564 / 58,752`）、`onboarding/index.js = 17,566` bytes（warning/hard `17,377 / 17,633`）、`chunk count = 118`（warning/hard `108 / 118`）。当前 dev build 仅触发 onboarding 与 chunk count warning，没有超过 hard stop。`audit:release-surface:report` 输出 `Files = 173`、forbidden harness members `none`、forbidden dev/test pseudo-locale members `none`；`audit:performance:report` 输出 sourceFiles=`814`、hotspotsOver250=`108`、registeredLineBudgets=`136`。

2026-06-20 Options/onboarding closeout 复核重新采集 `build:dev`、`audit:build:report` 与 `audit:performance:report`。首启页入口改为 lazy bootstrap，支持/建议/联系/更新日志/协议/隐私弹窗改为 onboarding 专属轻量 renderer，不再从 onboarding 动态导入完整 Options/Stitch schema registry 与 renderStitchView。当前 dev build report 为 `content/runtime.js = 58,546` bytes（warning/hard `58,564 / 58,752`）、`onboarding/index.js = 1,827` bytes（warning/hard `17,377 / 17,633`）、`chunk count = 122`（warning/hard `118 / 122`）；Russian schema locale chunk 当前为 `66.8 KB`，locale chunk hard stop 同步为 `68 KB`。本次没有放宽 single chunk、shared chunk 或 YAML chunk size budget。`audit:performance:report` 当前输出 sourceFiles=`823`、hotspotsOver250=`112`、registeredLineBudgets=`140`，新增 `src/onboarding/resourceModal.ts <= 625` 与 `src/options/stitch/schema/resources/setup-guide.ts <= 255` exact budgets，并同步首启协议/隐私与 Options schema copy 引起的 generated/schema、overview、analytics config 与 shell action runtime exact line budgets。

2026-06-25 AI chat parser productionization P09 repair 复核重新采集 `audit:performance:report`。Perplexity parser 选择器恢复为可读数组结构后成为当前 >250 LOC hotspot，本轮新增 `src/third_party/ai-chat-exporter/platforms/perplexity.ts <= 281` exact line budget；该预算只显式承认当前结构化 parser 热点，没有放宽 build hard stop、single/shared chunk、locale chunk、YAML chunk size budget 或动态 parser lazy boundary。当前 performance coverage 为 sourceFiles=`843`、hotspotsOver250=`113`、registeredLineBudgets=`142`。

2026-06-29 post-0.2 governance / AI chat abstraction merge 复核重新采集 `i18n:catalog:check`、`audit:imports:check`、`audit:performance:report`、production `build:fast` + `audit:build:report` + `audit:release-surface:report`、dev `build:dev` + `audit:build:report`、`test:i18n`、`package:firefox:isolated`、`package:chrome:isolated` 与 `test:e2e:browser:smoke`。本轮保留 P07 Options/Stitch decomposition、post-0.2 release warning cleanup 与 AI chat platform metadata/parser productionization；fresh `audit:performance:report` 输出 sourceFiles=`887`、hotspotsOver250=`109`、registeredLineBudgets=`150`。Fresh production build report 为 `content/runtime.js = 50,170` bytes、`onboarding/index.js = 1,130` bytes、`chunks = 87`；fresh dev build report 为 `content/runtime.js = 58,501` bytes、`onboarding/index.js = 1,751` bytes、`chunks = 101`，没有触发 warning target 或 hard stop。Production release surface 为 `Files = 181`、forbidden harness / pseudo-locale `none`；Chrome ZIP 与 Firefox XPI isolated package archive audits 均为 `Files = 188`、forbidden harness / pseudo-locale `none`，Firefox `web-ext` 仍为既有 `innerHTML` warnings `3`。v0.2.1 Options/Stitch changelog sync 只新增 release-note catalog keys，并将 generated catalog exact line budgets 同步为 `src/i18n/generated/messages.generated.ts <= 1137` 与 `src/i18n/generated/schemaCore.generated.ts <= 444`；同时保留 `src/third_party/ai-chat-exporter/platforms/perplexity.ts <= 281`。本轮没有通过 runtime-code line-count edits 改善指标，也没有提高 build hard stop、single/shared chunk、locale chunk、YAML chunk size budget 或 runtime parser lazy boundary。

2026-06-16 i18n hardcoded follow-up build-budget risk reduction 将 AI chat runtime parser platform loaders 从 10 个 per-platform dynamic-import wrapper chunks 合并为一个 lazy `runtimePlatformParsers-*` boundary，并在 P3 follow-up 中切断 `aiChatExtractor.ts -> parse.ts -> registry.ts -> platform parsers` 静态路径。`build:dev` 后 `audit:build:report` 当前 dev chunk count 从 `120` 降至 `101`，chunk count gate 收紧为 warning target `108` / hard stop `118`；`aiChatExtractor-*` 静态 import 图不再包含 platform parser implementation markers，platform parsers 只通过 `runtimeRegistry-*` 动态加载唯一 `runtimePlatformParsers-*`。本次不改变 `content/runtime.js`、`onboarding/index.js`、single chunk、shared chunk、locale chunk 或 YAML size hard stops；`ru.generated-*` 与 shared Top 3 仍按 P15 current truth 继续观察。

2026-06-17 English uncatalogued-copy P07 build-budget stabilization 将 generated schema catalog 从单一 `schemaMessages.generated.ts` 聚合模块拆为 `schemaCore.generated.ts` + `src/i18n/generated/schema/<locale>.generated.ts` per-locale chunks，并让 `@i18n/messages` 按语言动态加载 schema catalog。`build:dev` + `audit:build:report` 当前通过 hard gate：`content/runtime.js` raw `58,488` bytes、`onboarding/index.js` raw `17,377` bytes、chunk count `113`（warning `108` / hard stop `118`），最大 shared top three 为 `134.9 KB` / `132.0 KB` / `118.5 KB`；旧 `schemaMessages.generated.ts` `219.5 KB` shared chunk 不再出现。本次不提高 build hard stop；仅同步前序 Options/i18n 迁移后的 exact hotspot line budgets 与新增 `schemaCore.generated.ts <= 370` generated hotspot budget。

2026-06-17 English uncatalogued-copy P05 runtime/public boundary pass 将 public HTML title、runtime progress/status/session fallback 与 onboarding/support copy 迁入 runtime catalog fallback table。`build:dev` + `audit:build:report` 当前通过 hard gate：`content/runtime.js` raw `58,488` bytes、`onboarding/index.js` raw `17,540` bytes（warning `17,377` / hard stop `17,633`）、chunk count `114`（warning `108` / hard stop `118`）。本次不提高 build hard stop；仅同步 `videoSessionDraftController.ts <= 311` exact line budget 来反映 catalog fallback constant 接入。

2026-06-17 English uncatalogued-copy P07d/P08 final gate 复核重新采集 `build:fast`、`audit:build:report` 与 `audit:performance:report`。P07d 将 Options production Stitch surface localization 从 `productionStitchLocalization.ts` 拆入 `productionStitchSurfaceLocalization.ts`；前者当前为 `370` 行，后者为 `236` 行且低于 >250 LOC hotspot 阈值。当前 production fast build 为 `content/runtime.js` raw `49,991` bytes、`onboarding/index.js` raw `9,974` bytes、chunk count `100`；当前 performance coverage 为 sourceFiles=`802`、hotspotsOver250=`100`、registeredLineBudgets=`128`。本次只同步 accepted integration current truth，没有放宽 entry、single/shared chunk、locale chunk、YAML 或 line-budget hard gate。

2026-06-17 English uncatalogued-copy coverage follow-up 复核重新采集 `build:fast`、`audit:build:report`、`build:dev`、`audit:build:report` 与 `audit:performance:report`。本轮将 Options/Stitch preview navigation seed 拆入 `src/options/stitch/previewNavigation.ts`，使 `src/options/stitch/content.ts` 从 `941` 行降为 `841` 行，并把该 hotspot line budget 收紧为 `<= 841`；新增 `previewNavigation.ts` 为 `122` 行，低于 >250 LOC hotspot 阈值。当前 performance coverage 为 sourceFiles=`803`、hotspotsOver250=`100`、registeredLineBudgets=`128`。本次没有放宽 entry、single/shared chunk、locale chunk、YAML 或 line-budget hard gate。

当前 production fast build 真值：

- `build/dist/content/index.js`: `370 B`
- `build/dist/content/runtime.js`: `49.0 KB`（raw `50,170` bytes；warning target `58,564` raw bytes；hard stop `58,752` raw bytes）
- `build/dist/options/index.js`: `1.0 KB`
- `build/dist/onboarding/index.js`: `1.1 KB`（raw `1,130` bytes；warning target `17,377` raw bytes；hard stop `17,633` raw bytes）
- 总 chunk 数：`87`（warning target `118`；hard stop `122`）
- `chunks/runtimeEntry-*.js`: `136.7 KB`
- `chunks/runtimePlatformParsers-*.js`: `37.0 KB`
- `chunks/productionStitchAssets-*.js`: `62.5 KB`
- `chunks/readerLazyRuntime-*.js`: `62.8 KB`
- `chunks/videoLazyRuntime-*.js`: `77.0 KB`
- `chunks/videoSessionControllers-*.js`: `57.7 KB`
- `chunks/videoScreenshotPreparationQueue-*.js`: `14.8 KB`

当前 dev build 真值：

- `build/dist/content/index.js`: `370 B`
- `build/dist/content/runtime.js`: `57.1 KB`（raw `58,501` bytes；warning target `58,564` raw bytes；hard stop `58,752` raw bytes）
- `build/dist/options/index.js`: `1.4 KB`
- `build/dist/onboarding/index.js`: `1.7 KB`（raw `1,751` bytes；warning target `17,377` raw bytes；hard stop `17,633` raw bytes）
- 总 chunk 数：`101`（warning target `118`；hard stop `122`）
- `chunks/runtimeEntry-*.js`: `276.1 KB`
- `chunks/runtimePlatformParsers-*.js`: `77.9 KB`
- `chunks/productionStitchAssets-*.js`: `119.1 KB`
- `chunks/videoSessionControllers-*.js`: `108.3 KB`
- `chunks/videoLazyRuntime-*.js`: `57.5 KB`
- `chunks/videoScreenshotPreparationQueue-*.js`: `29.3 KB`

当前 dev build 未触发 `content/runtime.js` warning target：`58,501 B < 58,564 B`，距离 hard stop `58,752 B` 还有 `251 B`。本轮没有放宽 warning target 或 hard stop；该余量仍作为后续 runtime-size 风险信号。

当前 shared chunk Top 3（`chunk-*`，按 `tools/report-build-splitting.mjs` 口径，以 dev build 为更高值）：

- 最大 shared chunk：`134.9 KB`（hard stop `213 KB`）
- 第二大 shared chunk：`108.3 KB`（hard stop `136 KB`）
- 第三大 shared chunk：`104.6 KB`（hard stop `133 KB`）

当前重点功能 chunk：

- No retired Options section chunk is emitted in the current report.
- No `yaml-config-*` chunk is emitted in the current report.
- `chunks/registry-*.js`: dev `3.7 KB` / production fast `1.9 KB`
- `chunks/clipFlowAnalytics-*.js`: dev `6.0 KB` / production fast `3.3 KB`
- `chunks/onboardingAnalytics-*.js`: `1.9 KB`
- `chunks/sessionDraftAutoRestore-*.js`: dev `4.8 KB` / production fast `2.1 KB`
- `chunks/videoScreenshotPreparationQueue-*.js`: dev `29.3 KB` / production fast `14.8 KB`

当前 `audit:build:report` 预算口径：

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
- `audit:release-surface:report`: current production build has `Files = 181`, forbidden harness members `none`, forbidden dev/test pseudo-locale members `none`; isolated Chrome ZIP and Firefox XPI archive audits have `Files = 188` with the same forbidden-member result
- `audit:deps:report`: `modules=993`、`dependencies=3032`、`violations=0`
- `audit:platform-boundary:report`: total `141`（composition-root `11`、offscreen-local-vault-permission-root `4`、platform-adapter `94`、shared-runtime-helper `16`、type-only `16`）
- `audit:non-production-source:report`: decision counts 为 `retain-production: 718`、`migrate-import-owner: 164`、`retain-production-facade: 17`

## 2. 热点真值

验证命令：

```bash
npm run audit:performance:report
```

当前热点摘要（完整 `src` >250 LOC 路径列表以 `tools/report-performance-hotspots.mjs` 为准）：

- `src/i18n/generated/messages.generated.ts`: `1137` 行
- `src/background/pipelines/connectionTest.ts`: `697` 行
- `src/content/reader/sessionOperations.ts`: `643` 行
- `src/options/stitch/ui/components.ts`: `592` 行
- `src/onboarding/resourceModal.ts`: `585` 行
- `src/third_party/ai-chat-exporter/platforms/gemini.ts`: `576` 行
- `src/content/reader/session.ts`: `575` 行
- `src/onboarding/bootstrap.ts`: `556` 行
- `src/content/video/videoSessionRuntime.ts`: `531` 行
- `src/shared/analytics/schema/analyticsSchema.ts`: `527` 行
- `src/shared/attachments/videoScreenshotAttachmentTemplates.ts`: `523` 行
- `src/content/clipper/components/clipperDialogController.ts`: `511` 行
- `src/shared/di/serviceRegistry.ts`: `496` 行
- `src/content/video/videoPromptLifecycle.ts`: `491` 行
- `src/background/application/clipProcessor.ts`: `470` 行
- `src/ui/domains/video/VideoDialog.ts`: `468` 行
- `src/background/services/notifications.ts`: `451` 行
- `src/i18n/generated/schemaCore.generated.ts`: `444` 行
- `src/content/video/sessionOperations.ts`: `433` 行
- `src/options/stitch/schema/settings/overview.ts`: `429` 行
- `src/background/services/obsidianWriter.ts`: `423` 行
- `src/content/video/videoScreenshotCacheRepository.ts`: `423` 行
- `src/background/vault-router.ts`: `422` 行
- `src/dev/localVaultWriteHarness.ts`: `411` 行
- `src/content/stitch/runtimeSurfaceContent.ts`: `409` 行
- `src/options/stitch/render/contentRenderers.ts`: `406` 行
- `src/shared/config/optionsMerger.ts`: `406` 行
- `src/content/reader/ui/ReaderDialogPanel.ts`: `405` 行
- `src/content/video/videoScreenshotPreparationQueue.ts`: `401` 行
- `src/content/video/videoSessionDraftController.ts`: `401` 行
- `src/content/sessionDrafts/sessionDraftRepository.ts`: `398` 行
- `src/content/video/ui/VideoDialogPanel.ts`: `392` 行
- `src/shared/errors/analytics/analyticsConfig.ts`: `383` 行
- `src/options/app/productionStitchPersistence.ts`: `379` 行
- `src/options/components/infrastructure/listBuilder.ts`: `378` 行
- `src/components/trial-notice.ts`: `376` 行
- `src/background/listeners/runtimeMessages.ts`: `374` 行
- `src/ui/domains/reading/ReaderDialog.ts`: `371` 行
- `src/shared/exportDestination.ts`: `369` 行
- `src/options/services/connectionTester.ts`: `368` 行
- `src/options/stitch/types/schemaTypes.ts`: `366` 行
- `src/shared/errors/analytics/analyticsConfig.template.ts`: `364` 行
- `src/background/services/analyticsEvents.ts`: `363` 行
- `src/utils/trial-manager.ts`: `363` 行
- `src/dev/contentOrchestratorHarness.ts`: `359` 行
- `src/options/app/productionStitchShellActionRuntime.ts`: `358` 行
- `src/options/app/productionStitchLocalization.ts`: `350` 行
- `src/content/runtime/localVaultPermissionFrame.ts`: `345` 行
- `src/content/ui/supportPrompt.ts`: `345` 行
- `src/shared/state/globalStateManager.ts`: `345` 行
- `src/options/services/connectionTestRunner.ts`: `338` 行
- `src/background/services/videoScreenshotCacheIndexedDbStore.ts`: `331` 行

当前 hotspot line budget 口径：

- 全部当前 `src` >250 LOC 文件均有 guarded line budget；2026-06-29 governance / AI chat merge fresh `audit:performance:report` 输出 sourceFiles=`887`、hotspotsOver250=`109`、registeredLineBudgets=`150`，预算以 `tools/report-performance-hotspots.mjs` 为准。
- 2026-07-10 P11 public gate repair 将 live screenshot policy 判别、policy key 与 repository lifecycle 从 `videoScreenshotCacheService.ts` 拆入 `videoScreenshotCachePolicyRuntime.ts`；service 收敛到动态发现阈值以下，并保留 `<= 250` 的前瞻 guard。Options owner action-handler 合并拆入 `productionStitchActionHandlers.ts`，`productionStitchShellActionRuntime.ts` 回到既有 `<= 358` 上限；content lazy policy 透传拆入 `contentLazySessionPolicy.ts`，`contentLazyRuntime.ts` 回到既有 `<= 258` 上限。两个剩余 composition-root seam 采用 standalone proof 后的窄幅精确口径：`runtimeMessages.ts <= 376`（由 `380` 行通过共享 policy input type 收敛）与 `options/app/bootstrap.ts <= 258`（仅承载已测试的 additional handler 透传）。同一修复把 screenshot cache 常量/结构抽到纯 `videoScreenshotCacheContract.ts`，由 normalizer 单向依赖并保留 `videoScreenshotCacheTypes.ts` barrel API，dependency-cruiser 回到 `violations=0`。P09 base 的现存 dev artifact 为 `content/runtime.js=59,764 B`，P11 首次候选为 `59,615 B`；合并五处 lazy promise lifecycle、收紧 video host predicate 与 promise forwarding 后为 `58,681 B`，低于既有 `58,752 B` hard stop 但仍高于 `58,564 B` warning target，保留 `71 B` hard-stop headroom 风险。本轮没有提高 build、entry、single/shared chunk、locale 或 YAML hard stop。
- 2026-06-25 AI chat parser productionization P09 repair 在当时分支上补齐 `src/third_party/ai-chat-exporter/platforms/perplexity.ts <= 281` exact line budget；该预算随本次合并保留。
- 2026-06-06 video screenshot attachment verification 已补齐 `src/shared/attachments/videoScreenshotAttachmentTemplates.ts <= 523` 与 `src/background/application/videoScreenshotAttachmentPlanner.ts <= 269`；2026-06-09 当前 performance coverage 见上一条。
- P07 将 36 个已低于 checked-in line budget 的 current hotspots 收紧到 fresh line count；standalone `npm run audit:performance:report` 已在 ratchet 后通过。本次不通过 runtime-code line-count edits 改善指标。
- 当前高信号热点实测：`messages.generated.ts = 1137`、`connectionTest.ts = 697`、`reader/sessionOperations.ts = 643`、`stitch/ui/components.ts = 592`、`onboarding/resourceModal.ts = 585`、`gemini.ts = 576`、`reader/session.ts = 575`、`onboarding/bootstrap.ts = 556`、`videoSessionRuntime.ts = 531`、`analyticsSchema.ts = 527`、`videoSessionDraftController.ts = 401`、`videoScreenshotPreparationQueue.ts = 401`、`videoScreenshotPreparationRequestStore.ts = 294`、`videoScreenshotCacheRepository.ts = 423`、`videoScreenshotCacheIndexedDbStore.ts = 331`、`videoSessionDraftScreenshotCache.ts = 251`、`aiChatExtractor.ts = 277`、`tongyi.ts = 254`。`tools/report-performance-hotspots.mjs` 中的 line budgets 是当前 upper-bound hard gate；进一步收紧必须 standalone 通过后再同步。
- M12/P01 current truth：`src/i18n/messages.ts` 已演进为 runtime/schema message split entrypoint；generated i18n 当前实测包括 `messages.generated.ts = 1137` 与 `schemaCore.generated.ts = 444`。Schema/options copy 仍通过 schema split 与 dynamic locale loading 避免重新压回 content/runtime locale chunks。
- 当前业务/运行时/GA 重点实测：`videoSessionRuntime.ts = 531`、`videoSessionDraftController.ts = 401`、`videoScreenshotPreparationQueue.ts = 401`、`videoScreenshotPreparationRequestStore.ts = 294`、`videoScreenshotCacheRepository.ts = 423`、`videoScreenshotCacheIndexedDbStore.ts = 331`、`videoSessionDraftScreenshotCache.ts = 251`、`videoCaptureMutationTransaction.ts = 257`、`VideoDialogPanel.ts = 392`、`videoControlBarButton.ts = 299`、`sessionDraftRepository.ts = 398`、`runtimeMessages.ts = 375`、`bilibiliRichText.ts = 302`、`bilibiliPlatformObserver.ts = 286`、`markdownBuilder.ts = 288`、`PrivacySettingsView.ts = 254`、`yaml-config-editor/rowModel.ts = 269`、`analyticsSchema.ts = 527`、`analyticsEvents.ts = 363`、`analyticsActivation.ts = 265`、`analyticsTransport.ts = 265`、`eventCatalog.ts = 78`、`analyticsSanitizers.ts = 95`、`analyticsConfig.ts = 383`、`analyticsConfig.template.ts = 364`、`googleAnalyticsReporter.ts = 260`。
- P09 hybrid-cache support files 当前实测：`src/content/video/videoScreenshotCacheStore.ts = 97`、`src/content/video/videoScreenshotEncoding.ts = 152`、`src/content/video/videoSessionDraftScreenshotCache.ts = 251`、`src/background/services/videoScreenshotCacheIndexedDbStore.ts = 331`、`tests/e2e/utils/videoScreenshotCacheIndexedDb.ts = 220`。`videoScreenshotCacheIndexedDbStore.ts` 与 `videoSessionDraftScreenshotCache.ts` 已进入 guarded hotspot，并分别由 `tools/report-performance-hotspots.mjs` 的 `<= 335` / `<= 251` 预算约束；其余路径仍低于新增 hard budget 阈值。
- 2026-06-01 YAML i18n repair only raised release-locale line budgets by the exact newly added YAML field error/save-blocked message keys; runtime owner budgets are tracked by `tools/report-performance-hotspots.mjs` and must not be loosened without fresh evidence.

本轮有效收口结果：

- `productionStitchShellMount.ts` 已从 `427` 行拆到 `254` 行，并在 M5.3 将预算收紧到 `<= 254`。
- `usageChartRenderers.ts` 已从 `407` 行拆到 `23` 行；当前已低于 >250 LOC line-budget 覆盖阈值，不再作为 M5.3 line-budget 路径。
- Markdown/parser decomposition 将 `markdown.ts` 从 `441` 行拆到 `138` 行，将 `markdownRules.ts` 从 `335` 行拆到 `120` 行；二者目前由 parser characterization tests 保护，不在 hotspot budget 表中单独设 gate。
- `videoSessionRuntime` 当前为 `530` 行，`videoScreenshotPreparationQueue` 当前为 `401` 行，`videoScreenshotPreparationRequestStore` 当前为 `294` 行；P10 final integration 通过 `videoScreenshotPreparationCoordinator.ts` 将截图准备队列改为 lazy split，最终集成又把请求状态从 coordinator 拆出以消除 dependency-cruiser 循环。session-draft P08 final integration 已把 `video/sessionOperations`、`reader/session`、`reader/sessionOperations`、`ReaderDialogPanel`、`sessionDraftRepository`、`reader/sessionDrafts`、`runtimeMessages` 与 `sessionPlatformController` 纳入 line-budget 观察项；本轮 hybrid-cache integration 另外补齐 `videoSessionDraftScreenshotCache.ts <= 251`。
- `runtimeEntry` 在 M2.1-M2.4 后仍是最大 lazy/runtime chunk；本轮只收紧通用 max chunk/shared chunk 预算，不为 `runtimeEntry` 单独设置更紧命名 gate。

## 3. 浏览器验真

2026-06-23 P07 repeatable scenario checks:

- Content runtime idle after page load: `npm run test:e2e:browser:smoke` validates the migration harness load path after `build:dev`; pair with `npm run audit:build:report` when the goal is bundle-size regression evidence.
- Reader large document panel open/edit/export: `npm run test:e2e:browser:reader-panel` runs `tests/e2e/readerPanelFlow.test.ts` through `playwright.reader.config.ts`, which owns the reader browser web server and rebuild path.
- Video page prompt lifecycle and screenshot preparation: `node scripts/run-playwright.mjs test tests/e2e/videoPanelFlow.test.ts tests/e2e/videoListenerScope.browser.test.ts --project=chromium-desktop` covers the video panel lifecycle and listener/screenshot-preparation scope used for performance-sensitive runtime changes.
- Options open and panel switch: `npm run test:e2e:shard:options` covers Options E2E shards; `npm run verify:stitch-secondary` covers preview-to-production Options/Stitch parity, runtime alignment, task-success layout, and the preview freeze contract.
- Firefox runtime/adopted stylesheet fallback: `npm run test:e2e:browser:firefox` is the dedicated Firefox browser runner; do not approximate it with Chromium visual shards when validating Firefox runtime fallback behavior.
- Parallel browser/visual profiling must use `npm run test:e2e:browser:parallel` or `npm run visual:test:parallel`, because both prebuild once and then run shards read-only against the same dist.

已通过：

- `npm run test:e2e:browser:smoke`
- `npm run test:e2e:browser:reader-panel`
- `npm run test:e2e:browser:local-vault`
- `npm run verify:stitch-secondary`
- `npm run visual:test`

覆盖到的真实路径：

- migration harness smoke
- Local Vault write harness
- Stitch Secondary preview-to-production parity
- Reader / Video / task-success runtime alignment
- video floating prompt Stitch-only runtime aliases

## 4. 债务备注

- `tools/baselines/lint-warnings.json` 基线记录当前 warning 债务；2026-06-07 video legacy recovery 集成树已同步 checked-in baseline 为 `147` 条。`lint:warnings-report` 仍会重写该 baseline，只能在有意同步 warning truth 时运行。
- Firefox build path 已在 2026-05-18 stabilization 中通过 `npm run build:firefox`；Firefox browser smoke 仍不是本轮强制浏览器收口范围。
- 2026-05-24 M2.5 budget ratchet 使用 Node.js `v20.20.2` / npm `10.8.2`，并先以 standalone `audit:build:report` / `audit:performance:report` 验证新预算，再接入 `quality` / `verify:preflight`。
- 2026-05-22 review gap patch 已确认 M6.2 retained low-reuse retirement 是安全 no-op：没有新增 delete-approved path，低复用 retained/source compatibility 仍是后续债务，不应表述为已完成退役。
