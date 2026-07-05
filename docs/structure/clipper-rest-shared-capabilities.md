# 剪藏 UI / REST Sink 共享能力清单（C1）

## 目标

整理剪藏链路中跨模块复用的能力，明确可抽取的工具函数，以支持后续解耦工作（C2-C4）。

## 涉及文件

- `src/content/clipper/services/contextCapture.ts`
- `src/content/clipper/components/dialog.ts`
- `src/background/services/obsidianWriter.ts`
- `src/infrastructure/restClient.ts`
- `src/background/utils/restCandidates.ts`
- `src/background/sinks/obsidianRest.ts`（保留兼容 facade，不是当前生产 owner）
- 相关辅助模块：`src/content/clipper/utils/markdown.ts`、`src/content/clipper/utils/datetime.ts` 等

## 共享能力

| 能力                   | 主要位置                              | 复用点 / 问题                                                             | 拟抽取方向                                                                                   |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 上下文截取与序列化     | `contextCapture.ts`                   | DOM 选择、列表路径、片段序列化逻辑杂糅，其他流程可能也需复用高亮/格式整理 | 抽象为 `contextDomUtils`（选择范围、列表路径）+ `contextSerialization`（HTML/Markdown 处理） |
| Markdown 高亮/脚注处理 | `clipper/utils/markdown.ts`           | 已部分解耦，但 `contextCapture` 内仍有大量重复逻辑                        | 继续集中在 utils，提供易组合的函数                                                           |
| UI 对话框拖拽/样式注入 | `components/dialog.ts`                | 拖拽状态管理、全局 style 插入与业务逻辑混在一起                           | 抽出 `dragController`（指针事件处理）与 `styleManager`（临时样式注入）                       |
| 时间/命名辅助          | `clipper/utils/datetime.ts`           | 格式化时间戳、生成默认文件名等散落多个文件                                | 统一工具函数目录，确保所有格式一致                                                           |
| REST 写入重试策略      | `restClient.ts` / `obsidianWriter.ts` | 当前请求执行和写入编排已拆到生产 owner；兼容 facade 只保留旧边界          | 后续改动应直接落在生产 owner，并用聚焦单元测试覆盖                                           |
| 敏感日志过滤           | `restCandidates.ts` / `restClient.ts` | REST 候选与请求日志必须继续避免输出 API Key                               | 复用 `maskApiKey` 与现有错误归一化，不在手写调试工具中复制密钥                               |
| 配置回退策略           | `restCandidates.ts`                   | HTTPS/HTTP、Vault URL 与直接路径候选由当前候选模块集中处理                | 新增回退策略前先补充候选 URL 单元测试                                                        |
| 事件/状态总线          | `dialog.ts` + `contextCapture.ts`     | 目前通过 Promise resolve/async 传递，调试困难                             | 引入更清晰的事件接口或独立状态管理对象（视需求）                                             |

## 下一步建议

1. 在 `src/content/clipper/shared/` 下建立共享模块目录：`dom.ts`、`interaction.ts`、`serialization.ts` 等。
2. 后续 REST 行为改动应落在 `obsidianWriter.ts`、`restClient.ts`、`restCandidates.ts` 或路径契约 owner；`obsidianRest.ts` 只作为保留兼容 facade，删除前必须完成 import ownership 迁移与六项证明。
3. 准备针对拖拽、重试、上下文序列化的最小单元测试，确保抽取后功能稳定。

> 本清单为后续 C2-C4 的拆分参考，后续落地时应同步更新。
