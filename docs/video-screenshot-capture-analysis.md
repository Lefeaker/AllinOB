# 视频模式截图功能可行性分析报告

最后更新：2026-06-17

## 1. 背景与目标

- 需求：在视频模式下，用户打点（创建时间戳或文字片段）时自动截取当前视频画面，保存并随导出的 Markdown 一起写入仓库。
- 现状：`VideoSession` 仅记录时间戳、评论及文本片段（`VideoTimestampCapture` / `VideoFragmentCapture`），导出链路只处理 Markdown 文本，不包含二进制资源。
- 目标：记录当前已落地的混合截图缓存架构、剩余风险与为什么没有继续沿用 `storage.local` 持久化截图 bytes。

## 2. 现有架构概览

| 模块           | 作用                                                                                                                    | 关键文件                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视频内容脚本   | `VideoSession` 协调面板 UI、选区捕获、截图请求、draft 同步与导出，时间戳录入在 `handleAddCapture` 内完成                | `src/content/video/session.ts`, `src/content/video/videoSessionRuntime.ts`                                                                                                       |
| draft 持久化   | session draft 只持久化 `screenshotRequested` 与 metadata-only `screenshotRef`，不持久化截图 bytes                       | `src/content/video/sessionDrafts.ts`, `src/content/video/videoSessionDraftController.ts`, `src/content/video/captureStorage.ts`                                                  |
| 截图缓存       | background-owned extension IndexedDB Blob cache 保存截图 bytes；legacy `storage.local` base64 cache 仅做兼容读取与清理  | `src/background/services/videoScreenshotCacheIndexedDbStore.ts`, `src/background/services/videoScreenshotCacheService.ts`, `src/content/video/videoScreenshotCacheRepository.ts` |
| 导出构建       | `VideoSessionExporter` 将捕获数据转成 Markdown + front matter，并规划截图附件输出路径                                   | `src/content/video/videoSessionExporter.ts`, `src/shared/attachments/videoScreenshotAttachmentTemplates.ts`                                                                      |
| 导出链路       | `VideoSession` -> `VideoSessionExporter` -> background `clipPipeline` -> `processClipPayload` -> `writeMarkdownToVault` | `src/background/pipelines/clipPipeline.ts`, `src/background/application/clipProcessor.ts`, `src/background/services/obsidianWriter.ts`                                           |
| JSON-safe 边界 | runtime/background/exporter 之间继续通过 JSON-safe serialized binary content 传递截图内容                               | `src/content/video/videoScreenshotCacheClientRepository.ts`, `src/background/services/videoScreenshotCacheService.ts`                                                            |

- manifest 当前权限：`activeTab`、`scripting`、`storage`、`offscreen` 等；当前没有 `unlimitedStorage`、`message_serialization` 或 `tabCapture`。

> 2026-06-16 P07 权限策略当前真值：
>
> - Chrome 源 manifest 继续只在现有权限基础上追加 `offscreen`；不新增 `unlimitedStorage`，也不引入 `message_serialization`。
> - Chrome 官方扩展文档当前将 `storage.local` 默认额度记为 `10 MB`，不是历史文档中的 `~5MB`。
> - 当前混合缓存方案继续保持 JSON-safe 传输：draft 仅持久化 `screenshotRequested` 与 metadata-only `screenshotRef`，截图字节写入 background-owned extension IndexedDB Blob cache；legacy `storage.local` base64 cache 只保留兼容读取、best-effort migrate 与 cleanup。

## 3. 功能需求拆解

1. **截图能力**：在用户触发打点时获取当前视频画面，支持至少 720p，失败时需降级不阻塞打点。
2. **数据结构扩展**：时间戳 capture 在 runtime 中可持有截图对象，但 durable draft 只保留 `screenshotRequested` 与 `screenshotRef`。
3. **导出链路升级**：图片需随 Markdown 一并写入仓库，可选为内联 `data:` URI 或单独文件。
4. **UI/交互**：面板展示截图预览、导出结果在 Markdown 中正确引用；提供开关或告警。
5. **配置与权限**：当前继续使用 `activeTab` + `offscreen` + `storage` 方案，不追加 `unlimitedStorage`、`message_serialization` 或 `tabCapture`。
6. **测试与文档**：补充单元/端到端测试、更新 i18n 文案与用户指南。

## 4. 技术方案评估

### 4.1 截图获取方式

| 方案                                      | 描述                                                                        | 优点                       | 风险 / 限制                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `<video>` + Canvas                     | 在内容脚本中使用 `canvas.drawImage(video)`                                  | 实现简单；无需背景交互     | 绝大多数平台（Bilibili、YouTube）视频源跨域，Canvas 会被标记为 tainted，无法读取像素                                                                 |
| B. `chrome.tabs.captureVisibleTab` + 裁剪 | 在后台 Service Worker 调用 API 获取整页截图，再按视频元素 bounding box 裁剪 | 不受跨域限制；官方支持     | 仅能截取可见区域；需要在内容脚本与后台之间交换矩形信息；Service Worker 无 DOM，需要 `OffscreenCanvas`/`ImageBitmap` 处理；多显示器/高 DPI 需计算缩放 |
| C. `chrome.tabCapture.capture` (流)       | 捕获页面媒体流，绘制到 OffscreenCanvas                                      | 可持续获取帧，适合后续扩展 | 需声明 `tabCapture` 权限；实现复杂；Firefox 兼容性差；额外性能开销                                                                                   |

推荐先走方案 B：一次性截图满足当前“打点瞬间”需求，复杂度可控。Canvas 方案只能在同源视频站适用，价值有限；流式捕获工程成本远高于收益。

### 4.2 截图裁剪 / 缩放

- 内容脚本在触发打点时同步发送：目标 `tabId`、`videoBoundingRect`、页面 `devicePixelRatio`。
- 后台 Service Worker 调用 `captureVisibleTab` 获取 base64 PNG，再通过 `OffscreenCanvas` 按坐标处理，返回裁剪后的 data URL。
- 需要处理页面滚动导致的可视区域偏移；若视频不在 viewport（用户切到其他标签页），API 可能返回上一帧或空白，需要回退。
- 可在内容脚本层添加等待（最多 150ms）确保 UI 稳定，必要时提示用户需保持标签页激活。

### 4.3 数据存储与同步

- **当前 runtime 结构**：`VideoTimestampCapture` 在内存态仍可持有 `screenshot`，但 draft envelope 与 legacy capture storage 不持久化图片 bytes；durable state 只保留 `screenshotRequested` 与 normalized `screenshotRef`。
- **当前 durable owner**：截图 bytes 进入 background-owned extension IndexedDB Blob cache，按 page/capture/screenshot key 建索引，并受 TTL、全局条目数、单页面条目数与单截图字节上限约束。当前相关 owner 为 `videoScreenshotCacheIndexedDbStore.ts` + `videoScreenshotCacheRepository.ts`。
- **当前 session draft 恢复限额**：0.2.0 开源默认策略只保留最近 `48` 小时、最新 `5` 个 reader/video 页面身份以及每页最新 `20` 条可恢复 highlight / capture；`SESSION_DRAFT_MAX_ENTRIES = 100` 与 `SESSION_DRAFT_MAX_ENVELOPE_BYTES = 512 KiB` 仍是技术保护。默认截图 Blob cache 通过同一个 `SessionDraftStoragePolicy.videoScreenshotCache` 取得 TTL、全局条目数、单页面条目数与单截图字节上限，默认仍为 retention window / `100` / `50` / `1 MiB`。未来私有构建或外部集成如需不同保留策略，应注入完整 neutral storage policy，不在开源默认路径加入额外产品判断。
- **legacy 兼容路径**：`storage.local` base64 cache 仍可被读取，但只作为 compatibility path。成功命中 legacy cache 时会 best-effort migrate 到 IndexedDB 并删除旧 key；失败或损坏时不会阻塞恢复。
- **配额策略**：Chrome 官方扩展文档当前将 `storage.local` 默认总额度记为 `10 MB`。当前实现没有请求 `unlimitedStorage`；`storage.local` 主要承载 draft metadata、legacy base64 cache 兼容读取与 cleanup，而不是新的截图 bytes 主存储。
- **恢复与清理**：restored draft 会先尝试 hydrate `screenshotRef`；invalid ref 会被清除，stale/missing/expired/corrupt ref 会回落到 low-concurrency screenshot preparation，并在需要时触发 draft save 清掉失效 ref。单条 capture 删除在删除 mutation 成功 commit 后 best-effort 删除不再被当前 draft 引用的缓存 key；terminal cleanup 与 cache prune 也会同步删除对应缓存 key。缓存清理失败只记录 warning，不回滚 capture 删除。

### 4.4 导出与仓库写入

| 方案                                                                  | 描述                     | 优点                                                             | 缺点 |
| --------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ---- |
| 1. Markdown 直接内联 `data:image/png;base64`                          | 无需改 REST 客户端       | 文档体积暴涨；Obsidian 预览性能差；Markdown diff 变大            |
| 2. 将截图写为独立文件（`assets/video-shots/<id>.png`），Markdown 引用 | 体积可控，用户可复用资源 | 需要扩展后端链路支持二进制写入、多文件；需处理命名冲突与引用同步 |
| 3. Markdown 内使用 `![[attachment]]`，通过 REST 写入 Attachment       | 贴合 Obsidian 用法       | 同方案 2 的实现复杂度                                            |

**建议路径**：优先落地方案 2。需要对以下模块扩展：

1. `VideoSessionExporter`：在 `ExportPayload.meta` 中新增附件数组（包含文件名、MIME、base64）。
2. `ClipResultMessage` / `processClipPayload`：支持携带附件信息。
3. `writeMarkdownToVault` / `FetchRestClient`：增加 `writeBinaryFile`，使用 `PUT` 并设置合适的 `Content-Type`。
4. 若 REST 服务端不支持，该方案需先验证（可通过临时脚本对接当前 REST API）。

若短期无法改动后端，折中方案是提供配置选择：允许用户开启“内联图片”，并提示文件体积风险。

当前实现补充：

- export/write/download 边界继续使用 JSON-safe serialized binary content，再通过 `serializedAttachmentContentToBlob()` 恢复 `Blob`。
- `video.screenshotAttachment.{locationTemplate,fileNameTemplate,markdownUrlFormat}` 只负责 export-time 输出路径与 Markdown URL 规划，不负责 durable cache。
- 当前没有 idle zip/archive packing；截图缓存不会在后台被重新打包成 zip 或 archive。

### 4.5 UI/交互调整

- 面板侧：
  - 在 `VideoPanelPresenter` 渲染时间戳项时显示缩略图（可懒加载）。
  - 编辑、删除时同步更新截图。
  - 失败时展示提示（例如“截图失败，已保存时间戳”）。
- 打点流程：
  - `handleAddCapture` 需改为异步，等待截图结果后再 push capture；失败则以无图模式继续。
  - 可加入 loading 态或淡化按钮避免用户连续点击。
- 导出提示：
  - `VideoSession` 的完成提示应说明截图一并导出。
  - Options 页面提供开关、分辨率/格式选择、是否内联等设置 (`src/options/state/optionsStore.ts`、`options/index.html` 等需同步 i18n 文案)。

### 4.6 权限 / 隐私

- 当前已采用的权限调整：
  - 追加 `offscreen`，用于后台截图处理与编码辅助路径。
  - 继续依赖 `activeTab` + `captureVisibleTab`；当前没有采用 `tabCapture`。
  - 当前没有声明 `unlimitedStorage` 或 `message_serialization`。
- 隐私文档与许可说明 (`docs/privacy-policy.md`) 需更新，说明扩展会截取用户当前页面的图像，只用于导出。
- 需要提供配置项允许用户关闭截图能力，默认可考虑关闭以降低敏感度。

## 5. 已落地工程范围

1. **内容脚本 (`VideoSession`)**
   - 打点流程异步化、增加截图请求逻辑、错误处理、UI 状态。
   - `captures` 数据结构变更，序列化/反序列化适配。
   - 在清理流程中释放临时资源。
2. **平台适配器**
   - 若部分平台需要特殊构图（例如 Bilibili 弹幕遮盖），需在 `platforms/*` 中添加额外遮罩逻辑。
3. **后台 Service Worker**
   - 新增消息处理器，执行 `captureVisibleTab`、`OffscreenCanvas` 裁剪、编码。
   - 可抽象成 `videoScreenshotService`，便于复用与测试。
4. **导出链路**
   - `VideoSessionExporter` 构造 Markdown + 附件元信息。
   - `clipPipeline` / `processClipPayload` 扩展 payload 结构。
   - `restClient` 支持批量写入：先写图片，再写 Markdown（或反之）。
5. **配置与本地化**
   - Options UI、新增 schema 字段、`src/i18n/catalog/messages/<lang>/schema.json` / `static.json` 文案，并重新生成 catalog artifacts。
   - 更新 `docs/zh-cn/设置页面使用指南.md` 等指南。
6. **测试**
   - 单元测试：截图请求协议（mock background）、序列化迁移、导出 Markdown 链接正确性。
   - e2e：在 `tests/e2e/deepseekAiChatFlow.test.ts` 等基础上新增视频模式场景或独立脚本，验证截图文件写入。
7. **文档与发布**
   - 更新 README / 发行说明，说明新权限与功能。
   - 当前没有引入 `unlimitedStorage` 等额外敏感权限；Chrome Web Store 文案只需反映 `offscreen` + 视频截图能力即可。

## 6. 风险与缓解

| 风险                      | 描述                                                                        | 缓解措施                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 截图失败率高              | 标签页未激活、视频被遮挡、跨屏缩放导致裁剪错位                              | 捕获前检测 `document.visibilityState`；获取失败时退化为无图；记录错误用于后续统计                                                             |
| 存储超限                  | 多次截屏导致 IndexedDB Blob cache 增长，legacy `storage.local` 残留占用空间 | IndexedDB cache 受 TTL、全局/页面条目数与单截图字节上限约束；legacy cache 在命中后 best-effort migrate/cleanup；当前不请求 `unlimitedStorage` |
| REST API 不支持二进制写入 | 现有 Obsidian REST 仅测试过 Markdown                                        | 预研 REST 端行为，必要时提交补丁；若短期无法支持，使用内联方案作为过渡                                                                        |
| 性能回归                  | 截图/编码耗时导致前端卡顿                                                   | 在 Service Worker 侧异步处理，前端仅等待 Promise；可在 UI 层显示 loading；对截图进行压缩                                                      |
| 权限审查风险              | 新增截图相关权限可能触发商店审核                                            | 当前只增加 `offscreen`，不新增 `unlimitedStorage`、`message_serialization` 或 `tabCapture`；在文档与上架描述中充分披露用途并保留开关          |

## 7. 工作量粗估（以 2 人周衡量）

| 任务                                | 估计   | 说明                                       |
| ----------------------------------- | ------ | ------------------------------------------ |
| 截图服务实现（内容脚本 + 背景通信） | 3-4 天 | 含裁剪、错误处理、单元测试                 |
| 数据结构 & 存储迁移                 | 1-2 天 | 兼容旧数据、添加清理逻辑                   |
| 导出链路扩展（附件写入）            | 3-4 天 | 取决于 REST API 支持程度，可能拆分为两阶段 |
| UI 与配置调整                       | 2 天   | 面板预览、Options、i18n                    |
| 测试 & 文档                         | 2 天   | e2e + 文档更新                             |
| 审稿及回归                          | 1 天   | 包括手动验证 Bilibili / YouTube            |

- 总体 11-15 天，存在 REST 端未改造或权限受限的额外风险缓冲。

## 8. 推荐推进节奏

1. **当前阶段**：`captureVisibleTab` + 裁剪、JSON-safe 消息边界、background IndexedDB Blob cache、legacy cache migrate/cleanup 与 focused browser regression 都已落地。
2. **后续阶段**：若真实用户数据表明 current TTL / byte / entry 限制仍不足，再单独评估是否需要新的 cache policy，而不是默认申请 `unlimitedStorage`。
3. **发布前准备**：继续保持权限说明、回归测试与文档同步；不要把当前实现误写成 `storage.local` durable screenshot cache 或 idle archive packing。

## 9. 待明确问题

- Obsidian 端 REST 接口是否允许 `Content-Type: image/png` 的写入？是否需要新增 API？
- 截图文件在仓库中的归档策略（统一目录/按视频 ID 分类）及命名规范。
- 是否需要对截图做敏感信息遮挡（如用户名、弹幕）或提醒用户可能涉及隐私。
- 用户是否需要手动触发截图（例如二次确认）或支持自动关闭。

---

当前文档用途是约束“已实现真值”：draft 只持久化 `screenshotRequested` + metadata-only `screenshotRef`，截图 bytes 由 background-owned extension IndexedDB Blob cache 持有，legacy `storage.local` base64 cache 只做兼容读取与清理，消息边界保持 JSON-safe，且当前没有 idle zip/archive packing。
