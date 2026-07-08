# 多仓库连接验证指南

## 验证目标

确认 Zendio 使用当前生产 REST 写入路径连接到 Obsidian Local REST API，并且不同仓库的本地配置不会互相污染。

本指南不再提供可直接运行的手写 REST 调试脚本。旧脚本包含固定端口、固定仓库名、旧 URL 语义和示例密钥，容易与当前生产实现不一致。

## 准备工作

1. 启动 Obsidian，并启用 Local REST API 插件。
2. 在插件设置中生成或复制本机 API Key。
3. 在 Zendio Options 中为每个仓库填写：
   - HTTPS URL 或 HTTP URL
   - Vault 名称
   - API Key
4. API Key 只能来自本机插件设置，不要写入仓库、文档、截图或提交信息。

## 推荐验证方式

### Options 连接测试

优先使用 Options 页面内置连接测试。该入口复用生产连接配置与错误展示路径，适合验证本机 Obsidian、端口、Vault 名称和 API Key 是否匹配。

### REST 候选与路径单元测试

修改 REST URL、Vault 路径或候选协议逻辑时，运行聚焦测试：

```bash
npx vitest run --config vitest.unit.config.ts \
  tests/unit/infrastructure/restClient.test.ts \
  tests/unit/shared/restCandidates.test.ts
```

这些测试覆盖当前生产 URL 契约，包括避免重复拼接 `/vault/<vault>` 的行为。

### 写入路径与接口测试

修改写入编排、接口契约或平台服务时，运行：

```bash
npx vitest run --config vitest.unit.config.ts \
  tests/unit/background/obsidianWriter.test.ts \
  tests/unit/shared/interfaces.test.ts \
  tests/unit/platform/preview/services.test.ts
```

### Local Vault 浏览器验证

需要真实浏览器或 Local Vault 场景时，使用仓库维护的浏览器 harness 和 e2e 命令，而不是复制 REST 请求脚本。具体入口以 `docs/engineering-entrypoints.md` 中的 Local Vault / browser checks 为准。

## 密钥处理要求

- 文档中只写占位符，例如 `<YOUR_LOCAL_REST_API_KEY>`。
- 本地测试时通过 Options UI、临时环境变量或手动输入提供 API Key。
- 不提交 64 位十六进制 API Key 示例。
- 不在终端输出、ledger、截图或最终报告中复制真实 API Key。

## 常见问题

### 连接失败

1. 确认 Obsidian 正在运行。
2. 确认 Local REST API 插件已启用。
3. 确认 Zendio Options 中的 URL、端口和 Vault 名称与插件配置一致。
4. 优先查看 Options 连接测试的错误信息。

### 认证失败

1. 重新从 Local REST API 插件复制 API Key。
2. 确认没有多余空格或换行。
3. 不要复用文档、历史脚本或他人机器上的示例值。

### 写入路径异常

1. 先运行 REST 候选与路径单元测试。
2. 确认当前路径契约由 `src/shared/paths/vaultWritePath.ts`、`src/background/utils/restCandidates.ts` 和 `src/infrastructure/restClient.ts` 覆盖。
3. 如需排查生产写入流程，优先检查 `src/background/services/obsidianWriter.ts` 相关测试。
