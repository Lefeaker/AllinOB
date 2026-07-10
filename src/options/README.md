# Options Module Overview

> 摘要：选项页模块的目录结构、核心组件与开发流程。请在新增功能或重构前先阅读本指南，并遵循 `docs/development-guidelines.md` 中的相关约束。

---

## 0. 快速上手

### 0.0 Stitch Secondary 正式主链

- 正式 Options UI 启动链是 `src/options/index.ts -> src/options/runtimeEntry.ts -> src/options/app/bootstrap.ts -> src/options/app/productionStitchShell.ts`。
- `src/options/stitch/*` 是 preview 与 production 共享的 Stitch Secondary schema、renderer、class slots、content 与 CSS 真值。
- 当前 production Stitch 可见文案真值通过 `SchemaContext.messages` / `SchemaContext.t` 消费 catalog-backed `Messages`；Settings panel、resource modal、runtime surface 与 shell fallback 不得再依赖中文 preview copy 作为 English fallback。
- 全项目 production copy 总规则见 `docs/i18n-production-copy-governance.md`：产品自有可见文案只能来自 catalog 或 `UserVisibleMessageDescriptor` key；Options 消费 background/content 状态时应格式化 descriptor，而不是把 legacy message 字段当成新的中文 fallback。
- Legacy Options section/form compatibility source and old layout source have been retired; remaining old modal/controller code is compatibility-only and must not be reconnected to the production startup chain.
- 旧 Options preview 源树已经迁为 `tests/fixtures/options-preview/**` 验证夹具；不要把 retired preview 源树重新接入生产启动链。
- 旧 widgets and other retained compatibility source are not current implementation guidance unless `audit:non-production-source:report` gives an exact production/import/test/script/public/verification owner; deletion must satisfy Non-Production Code 3.0 six-owner proof and pass `audit:non-production-source:check`.
- `audit:non-production-source:report` 是 inventory evidence，完成态必须退出 0；若出现 report blocker，必须逐 exact path 迁移、六证据删除或显式 retained-contract 分类。`audit:non-production-source:check` 是可接入 `quality` 的 hard gate。
- `src/options/app/changelogContent.ts` 当前仍按 Options changelog content compatibility module 保留；只有在 Options public behavior 移除 changelog content 且六项 owner proof 为空时，才能进入后续删除批次。
- Options 验收除通用 `quality` / `verify:preflight` 外，必须追加 `npm run verify:stitch-secondary`。
- 当前技术栈为 TypeScript、esbuild、Vitest、Playwright、ESLint、Prettier、Stylelint、Zod、Stitch runtime CSS 与 WebExtension APIs；formal specs/plans 归属外层 workspace `docs/codex-superpowers/*`。

### 0.1 目录与入口

- `index.ts -> runtimeEntry.ts -> app/bootstrap.ts -> app/productionStitchShell.ts`：唯一正式入口，负责 repository 注册、I18n、Controller、Stitch Shell 初始化。
- `app/optionsOverlayRuntimeState.ts`：可选、产品中立的运行时叠加状态端口；composition root 可注入只读快照，production shell 负责合并、订阅渲染与卸载清理，未注入时 Free 行为保持不变。
- `stitch/*`：Stitch Secondary 共享 UI 包，production 以 `future/options-component-preview 2/index.html` 的原始参考运行结果为视觉真值；`future/options-component-preview/options-preview-stitch-secondary.html` 仅作开发改稿对比输入。
- `components/infrastructure/` 与 `components/services/`：选项页专属 Modal/UI 控件与配置传输服务。
- `utils/`：辅助方法（导入导出、transfer 等）；正式 Options 样式由 `stitch/styles/` 承载。

### 0.2 样式规范速览

- 样式入口固定为 `src/options/stitch/styles/stitch.css` 与 `src/options/stitch/styles/variants/stitch-secondary.css` 的静态产物链路。
- `src/options/styles/*` legacy 样式链路已退出正式构建；真实 token 真值源只有 `src/styles/design-tokens.css`。
- `.aobx-*` 采用 BEM 语义，优先复用 Token/Utility，例如 `.aobx-card`、`.aobx-alert` 等。
- 禁止新增 `.aob-*` 或内联颜色；Dark/Light 模式需同步维护。
- 单色 SVG resource/support 图标必须在浅色主题保持 `filter: none`，只允许在 `html[data-preview-theme='dark']` 或 `.stitch-runtime-surface[data-preview-theme='dark']` 下主题化；QR、预览图和 popover 图片媒体不得加 filter。
- 需要实验性样式时，在 README / PR 中写明范围与回滚方式，并确保 `npm run report:options-legacy` 通过。
- Tailwind / DaisyUI 构建链路已退出主线；新增或修改样式必须落在 Stitch schema / renderer / `stitch/styles/`，不得恢复 Tailwind 配置、CLI 脚本或旧 CSS bridge。

### 0.3 必跑命令

```bash
npm run lint                 # Typescript + ESLint/Stylelint 基线
npm run lint:options-css     # 限定 Options CSS 的 Stylelint
npm run report:options-legacy # 确保无 `.aob-*` 遗留
npm run test:unit            # Stitch shell / controller 的最小回归
npm run verify:stitch-secondary # Stitch Secondary 主链回归
```

如改动 I18n 或 CLI，请追加 `npm run test:i18n`、`npm run typecheck:tests`。

> 提示：Options 主 UI 与 content runtime 的 Clipper / Reader / Video 面板都走 Stitch runtime CSS；`clipper.tailwind.css` / `video.tailwind.css` 样式桥已退役。

### 0.4 组件 / Utility 清单

#### 基础组件优先级 (当前正式口径)

| 语义        | 首选入口                                                | 说明                                                                                     |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 按钮        | `UiButton` / `createOptionsButtonElement`               | 正式入口：`src/ui/primitives/button/index.ts`                                            |
| 输入框      | `UiInput` / `createInputElement`                        | 正式入口：`src/ui/primitives/input/index.ts`                                             |
| 选择框      | `UiSelect` / `createSelectElement`                      | 正式入口：`src/ui/primitives/select/index.ts`                                            |
| 复选框      | `UiCheckbox` / `createCheckboxElement`                  | 正式入口：`src/ui/primitives/checkbox/index.ts`                                          |
| 表格/伪表格 | table primitive (`DaisyTable` compatibility class name) | 统一表头、行区与滚动容器；class name is historical compatibility, not DaisyUI guidance   |
| 对话框      | `createDialogFrame` / `ShadowDialogHost`                | 正式入口：`src/ui/primitives/dialog/index.ts`、`src/ui/hosts/shadow/ShadowDialogHost.ts` |

DOM-heavy 场景如需直接拿到按钮元素，统一使用 `src/ui/primitives/button/index.ts` 导出的 `createOptionsButtonElement()`。

#### 传统组件类 (逐步迁移中)

| 名称                                                                 | 用途                           | 备注                                                              |
| -------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `.aobx-card`                                                         | 卡片容器                       | 支持 light/dark，常用于 Section 外层                              |
| `.aobx-card--muted / --outline / --accent-border / --neutral-border` | 卡片修饰符                     | 组合背景、描边、强调边框，供隐私提示、Domain 控件等复用           |
| `.aobx-alert`                                                        | 信息、成功、警告、错误提醒     | 通过修饰符控制语义                                                |
| `.aobx-field-group`                                                  | 表单字段组                     | 统一 label/控件间距                                               |
| `.aobx-table`                                                        | 数据表格                       | YAML/REST 等共享                                                  |
| `.aobx-table__filters / __sort-btn / __advanced-*`                   | 表格筛选、排序与 Advanced 面板 | 复用 `.aobx-chip-btn` 与 `.aobx-table`                            |
| `.aobx-button-row`                                                   | 按钮行                         | 对齐间距、栅格                                                    |
| `.aobx-chip` / `.aobx-chip-btn`                                      | Tag/Chip                       | 过滤器或标签选择                                                  |
| `.aobx-domain__*`                                                    | YAML 域名覆盖编辑器            | 组合 `.aobx-card`、`.aobx-input`、`.aobx-btn`                     |
| `.aobx-highlight-button + --{theme}`                                 | 阅读高亮主题按钮               | 色板基于 `--aobx-highlight-*` Token，生产 Stitch 与预览可直接复用 |
| `.aobx-hint-row` / `.aobx-hint-card` / `__code`                      | 示例提示块                     | 在 Fragment 等 Stitch 面板展示 markdown/code 提示                 |

更多组件抽象请参阅 `docs/options-style-refinement-plan.md`。

### 0.5 常见问题速览

- 懒加载/自动保存/I18n 等运行时问题详见 §6《常见问题》。
- 暗色模式不生效：检查是否复用 Token、Utility，并参考 `docs/options-style-validation-guide.md`。
- Stitch 样式异常：先确认 `src/options/stitch/styles/stitch.css` 与 `variants/stitch-secondary.css` 是否覆盖当前 surface，再检查构建产物中的静态 CSS 路径。

### 0.6 任务前置指南

- 在执行 Options/Stitch runtime 样式任务前，优先确认 `src/options/stitch/styles/stitch.css` 与 `variants/stitch-secondary.css` 是否已经覆盖对应 runtime surface；不要恢复 Options、Clipper 或 Video 的 Tailwind bridge。
- 旧 Tailwind 迁移材料只保留在归档文档中用于追溯，不再作为新开发指南或验收依据。

---

## 1. 目录结构

```
src/options/
├── app/
│   ├── bootstrap.ts          # 入口：初始化 I18n、Controller、Stitch Shell
│   ├── optionsOverlayRuntimeState.ts # 可选的产品中立运行时叠加状态端口
│   ├── productionStitchShell.ts # 正式 Stitch Secondary production adapter
│   ├── optionsController.ts  # 控制器：持久化、自动保存、导入导出
│   └── optionsControllerContext.ts
├── stitch/                   # preview/production 共享的 Stitch Secondary 真值
├── components/
│   ├── infrastructure/       # 选项页专属兼容控件；新增生产弹层优先走 Stitch/domain UI
│   └── services/             # 配置传输等选项页专用服务
└── utils/                     # 选项页工具（如 optionsTransfer.ts）
```

---

## 2. 生命周期与责任划分

1. **启动流程（`bootstrap.ts`）**

- `teardownMountedShell()` + `disposeCleanupHandlers()`：保证二次初始化时清理旧实例。
- `applyI18n()`：创建并挂载 `PageI18nController`。
- `initializeOptionsController()`：实例化 `OptionsController`，通过 `createOptionsFormAdapter()` 读取当前生产表单状态并注册清理函数。
- `mountProductionStitchShell()`：挂载 Stitch Secondary Shell，实现导航、资源弹层、生产状态绑定与自动保存。
- 可选的 `optionsOverlayRuntimeState` 快照由 shell 作为只读叠加层合入 schema/action 上下文；shell 订阅快照变化触发重渲染，并在 teardown 时解除订阅。公共入口不创建该状态，因此 Free 构建语义不变。
- `src/options/index.ts -> src/options/runtimeEntry.ts -> src/options/app/bootstrap.ts` 是唯一正式页面启动链；旧 `src/options/bootstrap.ts` 兼容入口已删除。
- 已退役的旧 layout shell、`mountOptionsShell` 与 `ModalController` 不得重新进入正式页面启动链。
- `getPlatformServices` 只允许保留在 `src/options/index.ts` 这个 Options composition root；repository 注册归属 `src/options/runtimeEntry.ts`；`src/options/app/bootstrap.ts` 必须保持为显式依赖注入入口。

2. **Options 主状态链（Phase 3 当前口径）**

- 长期合同：`IOptionsRepository` 是唯一主读写/订阅合同。
- 主状态适配：`optionsStore` 负责基于 `IOptionsRepository` 做 normalize、缓存与订阅分发。
- 兼容层：`chromeOptionsPersistence` 仅作为 `OptionsController` 仍在消费的适配器，不再被视为独立主链。
- 平台桥接：`PlatformServices.optionsRepository` 已退役；Options UI 与 content/background 主链统一不得再依赖该桥接。
- 主链职责：`ChromeOptionsRepository` 负责 `get/set/onChange` 与默认值合并，`optionsStore` 负责 normalize、缓存、迁移提示与对 Options UI 的订阅分发。
- 已清退项：legacy infrastructure compatibility adapter 与 infrastructure barrel export 已删除；不要恢复 `ChromeSyncOptionsRepository`、`LegacyOptionsRepositoryAdapter`、`adaptOptionsRepository` 或 `createCompatibilityOptionsRepository`。
- 当前 residual consumers：`src/shared/interfaces/optionsRepository.ts` 仍保留 historical `load/save/snapshot/subscribe/reset` 类型合同，供尚未迁移的内容侧 helper 和测试夹具使用；它不是 Options UI 主状态链，也不再有 infrastructure adapter owner。
- 退役路径：后续如需继续清理，应先把内容侧 `OptionsRepository` 类型消费者迁移到 `IOptionsRepository` 或更小的读取合同，再删除 shared legacy interface。
- 清理方向：Phase 3 接受前，不启动新的 Options 结构拆分；先收口这条主链定义。

3. **旧 Options compatibility 边界**

- 旧 section/form compatibility source 已退役，不是新增生产 Options UI 的实现指南。
- 不要新增旧 section 类或恢复旧表单注册链，也不要将其重新接入 `src/options/app/bootstrap.ts`、`productionStitchShell.ts` 或正式页面启动链。
- 如需继续删除 retained compatibility source，必须先满足 Non-Production Code 3.0 的 production build graph、import graph、test/script/public/verification owner 六项 proof，并让相关 audit 通过。

4. **Helper/Controller 迁移边界**

- 旧 `DomainMappingsController`、`YamlConfigTable` 等 helper/controller 的 `render()` / `collect()` / `destroy()` 约定仅用于理解兼容残留，不作为新增生产功能模板。
- 新增或重写生产 UI 行为应落到 `src/options/stitch/*` 的 schema、renderer、runtime action、content、class slot 与 CSS，复杂领域控件落到当前 `src/ui/domains/*` owner。
- 通用控件复用 `src/ui/primitives/*` 与 `src/ui/patterns/*`；shell 级状态、自动保存、资源弹层或语言切换才进入 `src/options/app/productionStitchShell.ts` 相关模块。

---

## 3. 开发规范速查

- **新增生产 Options UI 行为**
  1. 优先修改 `src/options/stitch/content.ts`、`src/options/stitch/schema/**`、`src/options/stitch/render/**`、`src/options/stitch/runtime/**` 与 `src/options/stitch/styles/**`，保持 preview / production 共享同一 Stitch 真值。
  2. 仅在 shell 级生命周期、资源弹层、语言切换、状态订阅或自动保存需要调整时，修改 `src/options/app/productionStitchShell.ts` 及其相邻 production shell 模块。
  3. 复杂领域控件应归属当前 `src/ui/domains/*` owner；可复用能力放入 `src/ui/primitives/*` 或 `src/ui/patterns/*`，不得新增旧 section/form owner。
  4. 自动保存应沿用 production shell/action adapter 与 `OptionsController` 的当前链路；不要为新增生产功能恢复旧表单注册链。
  5. 测试应覆盖 Stitch schema/render/runtime、production shell、domain UI 或当前 controller 行为；不要新增旧 `tests/unit/options/sections/<Section>.test.ts` 作为生产实现模板。

- **旧 Options compatibility 说明**
  - 旧 section/form compatibility source 已退役；如果 audit 显示其他旧资产仍有 owner，应先迁移 owner 或补齐 retained-contract 分类。
  - 不得为了让生产功能工作而把 retired compatibility source 重新连回正式启动链。

- **多语言适配**
  - production Stitch schema/body copy 统一由当前语言资源的 `Messages` 驱动：schema/builders 优先走 `SchemaContext.t(key, fallback)`，shell/runtime helper 使用当前 `Messages`，静态模板再通过 `setMessages()` 或 `data-i18n` 绑定。
  - 连接测试、storage feedback、shared AppError 等跨 background/content 边界的状态必须优先消费 `messageDescriptor`、`errorDescriptor`、`labelDescriptor` 或 `userMessageDescriptor`，并通过 `formatUserVisibleMessage()` 或等价 current-`Messages` 路径格式化。
  - Options production language selector 当前真值固定为 12 个 release human UI locales，顺序与 `RELEASE_LANGUAGE_ORDER` 一致：`en`、`zh-CN`、`ja`、`de`、`fr`、`es-ES`、`es-419`、`it`、`ko`、`pt-BR`、`ru`、`zh-TW`；production 不得暴露 `es` 或 `qps-ploc`，唯一允许保留 native language labels 的位置是语言选择器 option 文本。
  - 参照 `docs/options-multilingual-adaptation-guide.md` 维护 English residual 规则与必跑验证命令；跨模块 descriptor/audit/allowlist 规则以 `docs/i18n-production-copy-governance.md` 为准。
  - 切勿在 Section 内直接写死字符串或手动读取 `_locales`。

- **运行时清理**
  - 若创建了额外的定时器或全局事件，需使用 `registerCleanup()` 或 Section `destroy()` 手动释放。
  - 禁止绕过 `bootstrap.ts` 直接实例化 `OptionsController` 或恢复 retired form registration。

---

## 4. 样式与命名约束（2025-11 更新）

- **唯一样式入口**：Options 页主要依赖 `src/options/stitch/styles/stitch.css` 与 `src/options/stitch/styles/variants/stitch-secondary.css` 的构建产物；`src/options/styles/*` legacy 样式链路已删除。
- **命名统一**：所有 DOM、控件、弹窗必须使用 `.aobx-*` 前缀（如 `.aobx-section__header`、`.aobx-btn`、`.aobx-input`、`.aobx-modal`）。新增功能严禁引入 `.aob-*` 类名。
- **CSS 编写准则**：
  - 正式 Options 与 content runtime 样式优先落在 Stitch schema / renderer / `stitch/styles/stitch.css`。
  - 不再新增或恢复模块级 legacy CSS；结构与视觉规则应优先落在 Stitch runtime CSS 或 token 链路。
  - 组件级样式优先靠 Token/Utility（如 `--aobx-space-*`、`.aobx-button-row`），避免复制粘贴局部颜色/间距。
  - SVG icon 主题化必须显式绑定 document 与 runtime surface 的暗色主题宿主；不要为了修暗色图标可读性而在基础选择器中写无条件 `filter: invert()`。
  - 如需实验性样式，请放在局部容器，并在 PR 描述中说明范围与回滚方式。
- **开发流程建议**：
  1. 修改 DOM → 使用统一 helper 输出 `.aobx-*` 类。
  2. 在 Stitch schema / renderer / `stitch/styles/stitch.css` 中补齐对应规则。
  3. 执行 `npm run report:options-legacy && npm run lint:options-css`，确认没有 `.aob-*` 残留且命名符合 `.aobx-*` 规范；如命令输出命中需立刻处理。
  4. 运行 `npm run test:unit` 或必要的 UI 回归（可配合 `npm run build:dev` + `chrome://extensions` 刷新）。
  5. 若需要对照 Legacy → `.aobx-*` 的映射，可参见 `docs/options-css-naming-map.md`。
- **通用 Utility/组件清单**（与 §0.4 对应）：
  - `.aobx-card`: 标准卡片容器（背景、边框、阴影、圆角）。
  - `.aobx-alert`: 提示框，支持 `--info`, `--success`, `--warning`, `--error` 变体。
  - `.aobx-field-group`: 表单字段组容器。
  - `.aobx-table`: 标准表格样式。
  - `.aobx-button-row`: 行内按钮布局工具。
  - `.aobx-chip` / `.aobx-chip-btn`: Tag/Chip 控件样式。
  - **注意**: 尽量复用以上组件，减少手写重复样式，并保持 Stitch schema、renderer 与 CSS 真值一致。
- **历史背景/参考**：此次治理的阶段性记录已归档到 `trash/options-css-*`（Batch1/2/Legacy Removal 等）。如需了解迁移缘由，可查阅历史 PR 或 `trash/options-css-consolidation-guide.md`。
- **验证命令示例**：
  ```bash
  npm run report:options-legacy   # 需返回 “No legacy .aob-* classes detected”
  npm run lint:options-css        # 限定在 Options CSS 的 Stylelint 校验
  npm run test:unit               # 基本回归
  rg -n "aob-" src/options        # 手动确认未引入旧命名
  ```

---

## 5. 测试与工具

- **JSDOM Helper**：在 E2E/单测中使用 `tests/utils/domEnvironment.ts` 的 `withDomEnvironment()` / `createDomEnvironment()`，确保全局对象被正确覆写与还原。
- **WebExtension Mock**：调用 `installChromeMock()`、`installFirefoxMock()`（位于 `tests/utils/browserMocks.ts`）管理 `chrome`/`browser` API Mock；测试结束必须执行 `restore()`。
- **必跑命令**：
  ```bash
  npm run typecheck:tests
  npm run lint
  npm run test:unit
  npm run test:e2e
  ```
- **多语言校验**：若改动文案、locale 或 descriptor-backed visible state，追加执行 `npm run test:i18n`、`npm run audit:i18n-hardcoded-user-copy:check` 与 `npx vitest run --config vitest.unit.config.ts tests/unit/i18n/hardcodedSurfaceCoverage.test.ts`；仅需检查文本预算时可单独运行 `npm run validate:i18n:budgets`。

---

## 6. 常见问题

- **导航/面板切换异常**：从 Stitch schema registry、`productionStitchShell.ts` 与 production render lifecycle 排查，不要恢复旧 layout shell。
- **自动保存未触发**：确认 Section 改动后调用了 `markPendingAutoSave(sectionId)`，且 `OptionsController` 的 `onSaveSuccess` 钩子没有被异常拦截。
- **文案未更新**：先确认 schema/builders 是否通过 `SchemaContext.t()` 或当前 `Messages` 取值，再检查 `ensureDeclarativeI18nController()`、`section.setMessages(messages)` 与静态模板 `data-i18n` 绑定是否完整。
- **暗色模式异常**：确认样式使用共享 Token（`--aobx-color-*` 等），并同时在 `.aobx-theme--dark` 下提供覆盖；禁止写入硬编码色值。
- **Stitch 样式未生效**：确认页面或 runtime surface 是否加载 `stitch.css` 与 `stitch-secondary.css`，并检查是否遗漏对应 schema slot 或 renderer class。

---

## 7. 维护流程与历史参考

- **文档更新责任**：凡是改动 Options DOM、样式、运行时或命令的 PR，作者必须同步更新本 README / 相关指南，并在 PR 模板勾选“文档已更新或无需更新”条目。
- **校验流程**：在提交 PR 前务必运行 `npm run lint`、`npm run lint:options-css`、`npm run report:options-legacy`；必要时附上 `npm run test:unit` 结果截图或日志。
- **定期复查**：Options 模块维护人（默认由当期版本负责人承担）需在每季度迭代结束后检查 README 是否覆盖最新规范，并同步核对 `docs/README.md` 与 `docs/engineering-entrypoints.md`。
- **历史资料**：有关 Batch1/Batch2/Legacy Removal 的阶段总结均已迁移至 `trash/options-css/`，若需追溯决策过程，请参阅 `docs/options-css-full-cleanup-guide.md` 与相关归档文档。
- **沟通渠道**：若发现 README 与实际实现不一致，请在 Issue/看板中 @Options 维护人，并把修复纳入后续文档刷新日志。

---

如有疑问，请先查阅 `docs/development-guidelines.md` 和 `docs/options-multilingual-adaptation-guide.md`；旧 Options 重构复盘已归档到 `docs/archive/completed-guides/options-refactor-summary-2025.md`，仅用于历史追溯。若仍需帮助，可在团队文档或 Issue 中同步讨论。谢谢配合！
