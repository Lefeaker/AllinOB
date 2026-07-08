# Selection Clip & Clip Pipeline 耦合梳理（F1）

## selectionExtractor.ts

- 主要职责：
  1. 组装 Turndown 工具并应用 Obsidian Markdown 规则；
  2. 根据配置决定脚注格式或直接 Markdown 输出；
  3. 处理上下文捕捉（前后 HTML、列表祖先、footnote）；
  4. 生成 frontmatter、评论、meta 信息。
- 问题点：
  - 文件 200+ 行，既负责 DOM 转换又负责 Markdown 组合、frontmatter 拼接，缺乏清晰层次。
  - 与 `clipper/utils/markdown.ts` 重复逻辑较多，可将上下文组合、frontmatter 等提炼成可复用的 builder。
  - Turndown 初始化每次重复执行，无法复用配置。

## clipPipeline.ts

- 当前结构：
  - orchestrator，调用 `contextCapture`、`selectionExtractor`、`obsidianWriter`、Vault 路由、通知服务等；REST 请求由 `restClient.ts` 和 `restCandidates.ts` 承接。
  - pipeline 包含大量分支（剪藏类型、AI 片段、thumbnail 等），函数内 if/else 较多。
- 问题点：
  - 既处理剪藏类型判断、又负责结果写入与通知，职责较重。
  - REST 写入、通知逻辑已经拆出，但 pipeline 中仍包含较多具体操作顺序，可考虑封装为更小的步骤对象或命令模式，以便测试。

## 拟拆分方向

1. **Selection Markdown Builder**
   - 抽象出 `generateFragmentMarkdown`，负责 frontmatter、正文、评论、footnote 组合；`selectionExtractor.ts` 只负责 DOM -> Markdown 数据准备。
   - Turndown 初始化迁移到 `shared/markdown.ts` 提供工厂（便于复用与测试）。
2. **Context Assembler**
   - 将上下文片段处理（before/after/ancestor 等）独立为函数，返回结构体供 Markdown builder 使用。
3. **Clip Pipeline Steps**
   - 抽出 `prepareClipPayload`（生成 meta + markdown）与 `writeClip`（写入 + 通知）两个步骤，pipeline 只 orchestrate step，便于测试与复用到其他入口。

以上作为后续 F2-F4 的改造基础。
