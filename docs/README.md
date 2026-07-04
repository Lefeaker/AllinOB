# 工程文档入口

最后更新：2026-07-01

## 当前真值入口

- [`engineering-entrypoints.md`](./engineering-entrypoints.md)
- [`i18n-production-copy-governance.md`](./i18n-production-copy-governance.md)
- [`ga4-telemetry-reference.md`](./ga4-telemetry-reference.md)
- [`analytics-operations-runbook.md`](./analytics-operations-runbook.md)
- [`performance-baseline.md`](./performance-baseline.md)
- [`source-of-truth-index.md`](./source-of-truth-index.md)
- [`non-production-code-ownership.md`](./non-production-code-ownership.md)
- [`typescript-strict-roadmap.md`](./typescript-strict-roadmap.md)
- [`long-term-maintenance-backlog-2026-03-29.md`](./long-term-maintenance-backlog-2026-03-29.md)
- [`release-readiness-handoff-2026-05-20.md`](./release-readiness-handoff-2026-05-20.md)
- [`project-stabilization-plan-2026-04-13.md`](./project-stabilization-plan-2026-04-13.md)
- [`current-delivery-batches-2026-04-13.md`](./current-delivery-batches-2026-04-13.md)

## 当前正式代码入口

- `src/ui/foundation/*`
- `src/ui/primitives/*`
- `src/ui/patterns/*`
- `src/ui/hosts/*`
- `src/ui/domains/*`
- `src/options/index.ts -> src/options/app/bootstrap.ts`
- `src/content/index.ts -> src/content/runtime/*`

## 当前口径

- `quality` / `verify:preflight` / CI 对三项 typecheck 口径已经对齐
- `lint:type-any` 当前 i18n hardcoded P22/post-strict-gap integration 口径为扫描 `1231` files，实测 overall `0/1148/1973/47/3`、src `0/628/695/9/0`、tests `0/520/1278/38/3`；`lint:type-any:ratchet` 守住 checked-in 上限 overall `0/1148/1973/53/4`、src `0/628/695/9/0`、tests `0/520/1278/46/4`，`any` 保持 `0`，`ts-expect-error` 未增加，non-null 上限未放宽
- `quality` 与 CI 已包含 `lint:hardcoded`；当前 hardcoded config 守卫是 `0` errors / `8` warning-only findings
- `quality` 已包含 `audit:chrome-webstore-release:check`，守住 Chrome Web Store 自动发布 workflow 必须绑定受保护 `chrome-webstore-release` Environment、使用 GA public config、archive-level GA 审计、官方 action current majors 与显式 `--publish`
- i18n production copy 当前不变量：production user-visible copy 只能来自 i18n catalog 或 `UserVisibleMessageDescriptor` key；background/content 边界传 descriptor/code/params；`quality` 已包含 CJK/descriptor hard gate `audit:i18n-hardcoded-user-copy:check`，当前 audit truth 为 `scanned=579 findings=19 unexpected=0 staleAllowlist=0`；English uncatalogued-copy hard gate `audit:i18n-uncatalogued-user-copy:check` 已接入 `quality` 与 `verify:preflight`，覆盖 raw English `defaultMessage` fallback 与 `subtitle` / `hint` / `body` 等 production-visible fields，当前 audit truth 为 `scanned=575 findings=0 unexpected=0 staleAllowlist=0`
- i18n 当前由 `src/i18n/catalog/messages/<lang>/{runtime,static,schema}.json` 驱动生成 `src/i18n/generated/**` 与 `public/_locales/**`；root `_locales/**` 已退役，不再作为 compatibility duplicate 保留
- Chrome ZIP 与 Firefox XPI 在 package 脚本中会解包后执行 release-surface 审计，最终包不得包含 `qps-ploc` loader/chunk 或 `_locales/qps-ploc/messages.json`
- `audit:build:report` 使用 2026-05-24 M2.5 复核后的预算真值
- `audit:non-production-source:report` 是 inventory evidence，完成态必须退出 0；`audit:non-production-source:check` 是 hard gate
- GA production release public config 的本机 owner 命令由 ignored `.env.production.local` 注入；Chrome Web Store 自动发布 workflow 使用受保护 `chrome-webstore-release` Environment Variables 注入并在构建前 fail closed，Chrome Web Store credentials 放在同一 Environment Secrets 中且该 Environment 必须启用 Required reviewers。Chrome 自动发布入口和 owner 命令见 [`engineering-entrypoints.md`](./engineering-entrypoints.md)、[`source-of-truth-index.md`](./source-of-truth-index.md) 与 [`analytics-configuration-guide.md`](./analytics-configuration-guide.md)
- `M4` 已按重定义口径通过：当前分支保留已验真的 retained set，原始规模预算已下沉到 backlog
- 当前交付归属统一落到 [`current-delivery-batches-2026-04-13.md`](./current-delivery-batches-2026-04-13.md)

## 归档与参考

- 历史状态、旧迁移方案、旧验收记录都在 `archive/status-*` 或旧日期文档里
- `archive/legacy-options-assets/` 与 `reference-fixtures/legacy-options/` 仅作参考
- archive 与 legacy 默认不作为生产代码或正式入口真值
