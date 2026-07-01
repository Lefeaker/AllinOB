# Chrome 扩展上架全流程指南

> 目标：指导 Zendio 团队完成 Chrome Web Store 上架，全流程覆盖账号、素材、构建、审核和上线后的维护事项，可作为每次发布的检查清单。

## 阶段 0：立项与责任人

- [ ] 确认发布负责人、设计支持、法务/隐私负责人和技术负责人；建立协同渠道（建议在 Notion/Docs 建立任务看板）。
- [ ] 确定计划发布日期、缓冲期，以及是否需要灰度（仅发布为受限测试）或全量发布。
- [ ] 建立版本里程碑：Beta 内测、候选版 RC、正式版；约定回滚策略。

## 阶段 1：账号与合规准备

- [ ] 使用团队 Google 账号登录 [Chrome Web Store Dashboard](https://chrome.google.com/webstore/devconsole)，完成一次性 5 美元开发者注册；确认主体名称、联系邮箱、客服电话是否显示给用户。
- [ ] 准备隐私政策页面：解释数据采集、使用范围、 Obsidian 本地 REST API 的访问目的、数据删除方式。建议托管于公开可访问的独立页面（GitHub Pages 或官网）。可参考以下要素：
  - 明确列出收集/处理的数据类型（如剪藏内容、账号信息、诊断日志），并说明是否上传到云端。
  - 描述每类数据的使用场景与受限范围，强调仅用于核心功能、不会进行二次销售或广告定向。
  - 说明扩展访问 Obsidian 本地 REST API 的原因（写入/同步用户内容），补充连接安全措施与本地网络限制。
  - 说明可选本地 Vault 目录写入仅限 Chromium File System Access，必须由用户主动选择目录；权限缺失、拒绝、不支持或写入预检失败时会回退 REST API。
  - 提供用户删除数据的自助路径（扩展设置、手动清理缓存或撤销 API Token），以及联系支持团队请求删除的方式。
  - 记录隐私政策更新时间戳、版本号，并在仓库/官网保留 PDF 或 Markdown 备份以便审查。
- [ ] 编写用户支持/联系页面，包含常见问题、支持邮箱与问题反馈流程。建议复用《用户支持与联系指引》<../support-contact.md>，确保渠道、SLA 与 FAQ 与产品现状一致。
- [ ] 如扩展请求 "Host 权限" 或敏感 API（`<all_urls>`, `storage`, `scripting`, `notifications`, `downloads`, `offscreen`），准备文字说明对应的使用场景和限制，后续录入审核问卷。可参考《权限使用说明》<../permissions-usage-notes.md> 并在提交前核实与 manifest 实际声明一致。

## 阶段 2：版本与构建

- [ ] 确定发布版本号，只手写更新 `package.json` 的 `version` 字段；随后运行 `npm run release:metadata:sync` 同步 `package-lock.json`、`public/manifest.json`、`public/manifest.firefox.json` 与 runtime i18n catalog 的 `versionNumber`，并用 `npm run release:metadata:check` 确认无 drift。不要手动改 `public/manifest*.json` 或 i18n runtime catalog 版本号。
- [ ] 执行 fresh build 验证：`npm run release:metadata:check`、`npm run clean`、`npm run build:dev`、`npm run audit:build:report`、`npm run build`；如发布 Firefox 包，再执行 `npm run build:firefox`。
- [ ] 执行 Local Vault release-readiness 审计：Chrome build 后运行 `npm run audit:local-vault-release:report -- --browser chrome`；Firefox build 后运行 `npm run audit:local-vault-release:report -- --browser firefox`。
- [ ] 清理 `dist/`：仅保留运行期必须文件（`manifest.json`、构建后的 JS/CSS、必要资源）；剔除 `*.map`、测试文件、`node_modules/`、脚本和文档等。
- [ ] 运行最低限度的自动化测试（如 `npm run test` 或 `npm run lint`）；若测试覆盖不足，补充纸面检查说明并记录测试结果链接。
- [ ] 更新变更日志：在 `docs/zh-cn/release-notes/` 或 `README.md` 中增加本次版本亮点，便于商店描述引用。

## 阶段 3：素材与文案

- [ ] 扩展图标：准备 16×16、32×32、48×48、128×128 PNG；确认 manifest 中引用的路径均存在，例如 `assets/icons/icon128.png`。
- [ ] 宣传图：制作一张 440×280 PNG（可复用 `marketing/banner.png` 设计），并准备可选的重点功能截图（1280×800 或 640×400）。
- [ ] 视频/GIF（可选）：制作 ≤30MB 的快速演示，展示剪藏、AI 解析、写入 Obsidian 的完整流程。
- [ ] 商店名称（≤45 字符）与短描述（≤132 字符）：突出核心价值，建议中英文各一份。
- [ ] 长描述（≤2000 字符）：结构建议包含痛点、主要功能、权限说明、隐私承诺、更新亮点；可复用 `README.md` 中的 “Feature Highlights” 与 “Latest Enhancements”。
- [ ] 权限说明：将 `README.md` 里的权限表转换为自然语言段落，填入后台 “Required Permissions Justification”。
- [ ] 本地化：如需多语言展示，修改 `src/i18n/catalog/messages/<lang>/static.json` 中的 WebExtension static 文案，随后运行 `npm run i18n:catalog:generate`、`npm run i18n:catalog:check`、`npm run i18n:lint`、`npm run audit:locales:report`；`public/_locales/**` 是生成产物，不手写。

## 阶段 4：功能与质量验证

- [ ] 在 Chrome 稳定版、Chrome Beta（可选）上加载构建版进行回归；重点覆盖剪藏、注释、AI 解析、Obsidian 写入等核心流程。
- [ ] 验证权限触发：确保只有在触发剪藏和写入时才访问 `<all_urls>` 与本地 REST 接口；检查 console 中无未捕获异常或 `console.log` 噪音。
- [ ] 访问控制：测试无 Obsidian REST API 或 API Key 错误时的提示是否清晰。
- [ ] 本地 Vault 自动化：运行 `npm run test:e2e:browser:local-vault`，确认 fake File System Access / fake IndexedDB harness 中的本地目录写入、目录穿越拒绝、权限拒绝、重新授权和 REST fallback 均符合预期；不要把该 harness 描述为完整真实 Chrome extension 加载验真。
- [ ] 本地 Vault extension-loaded handoff：加载 fresh `build/dist`，确认 `local-vault-permission.html/js`、`offscreen/local-vault.html/js` 存在，Chrome manifest 包含 `offscreen`，Firefox manifest 不包含 `offscreen`，WAR 不含 `<all_urls>`，content/runtime lazy prompt chunk 可达；机器证据来自 `audit:local-vault-release:report`。
- [ ] 发布脚本：运行 publish script unit、Chrome Web Store workflow contract 与 dry-run；`release:chrome` 默认 dry-run，必须传入显式 `--zip <path>`；没有 Chrome Web Store 环境变量时，dry-run 应在发布前安全失败。自动发布 workflow 必须通过 `npm run audit:chrome-webstore-release:check`，确保 GA public config、archive-level GA 审计和显式 `--publish` 没有漂移。
- [ ] 性能与可用性：确认拖拽、键盘导航、无障碍标签等功能符合之前的改进记录（参考 `docs/structure/clipper-dialog-a11y-update.md`）。
- [ ] 记录测试结果：整理测试清单、环境和结论，归档到发布文档或 issue，供审核复盘使用。

## 阶段 5：提交审核

- [ ] 使用 `zip -r zendio-vX.Y.Z.zip dist manifest.json assets` 等命令打包，注意排除不必要文件，可在 `releases/` 下存档。
- [ ] 真实发布前由 owner 手动确认 zip 路径、版本号、权限问卷和 CWS credentials。真实发布命令为 `npm run release:chrome:publish -- --zip <release.zip>`；禁止依赖当前目录唯一 zip 的自动选择。
- [ ] 登录开发者控制台 → “新建项目” 或选择已有条目 → 上传压缩包。
- [ ] 填写商店表单：名称、描述、分类、语言、地区、联系方式、隐私政策 URL、支持页面 URL。
- [ ] 完成 “用户数据隐私” 问卷：解释数据是否上传服务器、保留时长、用户删除机制。
- [ ] 在 “权限” 面板补充敏感权限说明，尤其是 `<all_urls>`、`http(s)://127.0.0.1/*`、`offscreen` 与 `downloads`；必要时附上 Obsidian REST API 与本地目录写入说明。
- [ ] 如需受限权限（例如 `scripting`），按照 Google 最新政策提交额外证明材料。
- [ ] 提交审核后记录时间，关注控制台通知与邮件；通常 3–7 个工作日内反馈。

### GitHub Actions 自动提交审核

已有 Chrome Web Store 条目后，可以使用 `.github/workflows/release-chrome-webstore.yml` 自动构建、打包并提交新版审核。该 workflow 仅在手动触发或推送 `v*` tag 时运行，不随普通 `main` push 自动发布。

发布前先在 GitHub Settings → Environments 创建受保护 Environment：

- Environment name: `chrome-webstore-release`
- Deployment protection rules: 启用 Required reviewers，至少加入一名发布 owner
- 只在该 Environment 下配置 Chrome Web Store 发布 Secrets 和 GA public Variables；配置完成后删除同名 repository-level Variables / Secrets，避免后续 workflow 绕过 Environment 保护误用

不要依赖 workflow 首次运行自动创建 Environment；自动创建出的 Environment 不会自带 Required reviewers、Secrets 或 Variables。发布 owner 必须在第一次触发 `Release Chrome Web Store` 前手动完成上述 Environment 配置。

发布前确认 `chrome-webstore-release` Environment Secrets 已配置：

- `CWS_CLIENT_ID`
- `CWS_CLIENT_SECRET`
- `CWS_REFRESH_TOKEN`
- `CWS_EXTENSION_ID`
- `CWS_PUBLISHER_ID`

发布前确认 `chrome-webstore-release` Environment Variables 已配置：

- `ZENDIO_GA_MEASUREMENT_ID`
- `ZENDIO_GA_TRANSPORT_MODE`（生产发布使用 `proxy`）
- `ZENDIO_GA_PROXY_ENDPOINT`

这些 GA 值是扩展构建所需的 public config；它们不写入源码仓库，但构建出的扩展包会包含这些 public config。不要把 `GA4_API_SECRET`、`ZENDIO_GA_API_SECRET` 或其他 server-only secret 放入该 workflow、任何 GitHub Secrets、Environment Secrets 或扩展构建环境。GA `api_secret` 只能存在于 owner proxy / Cloudflare Worker 等服务端环境。

触发方式：

- 手动：GitHub Actions → `Release Chrome Web Store` → Run workflow
- 标签：推送形如 `v0.2.1` 的 tag

本流程的 release job 绑定 `environment: chrome-webstore-release`；当该 Environment 配置了 Required reviewers 时，tag 或手动触发后会先等待发布 owner 审批，审批后才可读取 Environment Variables / Secrets 并继续执行。流程会先校验 GA public config，执行 `npm run analytics:validate:prod` 与 `npm run quality`，再用同一组 `ZENDIO_GA_*` 变量构建 Chrome production bundle、执行 `npm run package:ci`、对最终 zip 运行 `audit:ga:client-secret` 与带 `--archive` 的 `audit:ga:release-surface`，最后调用 `node scripts/publish-chrome-webstore.mjs --publish --zip <zip>` 上传到 Chrome Web Store 并提交发布请求。首次上架的商店资料、隐私问卷、权限说明仍需先在 Chrome Web Store Developer Dashboard 中完成。

## 阶段 6：发布与上线后维护

- [ ] 审核通过后，确认是否立即公开，或设置受限测试/逐步推广；如需要推送给特定用户，可配置测试用户名单。
- [ ] 在仓库打 tag（如 `vX.Y.Z`），将变更日志、隐私政策更新同步到主分支。
- [ ] 监控 Chrome Web Store 后台的安装量、崩溃报告、用户反馈；为差评/问题设置响应 SLA。
- [ ] 建立回滚预案：保留上一版本压缩包，如发现严重问题，可快速提交回滚版本。
- [ ] 收集用户反馈，规划下一版本迭代，整理到 `tech-debt-action-plan.md` 或 Roadmap 文档。

## 附录：建议的资料清单

- 发布压缩包：`releases/zendio-vX.Y.Z.zip`
- 构建产物校验记录（截图或命令行输出）
- 测试结果文档（可放在 `docs/structure/` 或 issue 链接）
- 隐私政策链接与备份 PDF
- 商店长描述与短描述文本稿
- 截图与宣传图源文件（建议保存在 `assets/promo/` 内备份）

> 每次发布前，可复制本指南为核对单，逐项勾选，确保所有材料准备充分并符合 Google 最新政策。
