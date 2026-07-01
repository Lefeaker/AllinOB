# Zendio Firefox 兼容性指南

## 📋 概述

本文档详细说明了 Zendio 项目对 Firefox 浏览器的兼容性支持，包括实现方案、使用方法和注意事项。

## 🔧 技术实现

### 1. 平台适配架构

Zendio 采用平台适配层模式，为不同浏览器提供统一的 API 接口：

```
src/platform/
├── chrome/          # Chrome 平台实现
├── firefox/         # Firefox 平台实现
├── interfaces/      # 统一接口定义
├── services.ts      # 平台服务配置
└── types.ts         # 类型定义
```

### 2. 主要差异处理

#### Manifest 文件差异

| 特性       | Chrome           | Firefox                                   |
| ---------- | ---------------- | ----------------------------------------- |
| Background | `service_worker` | `scripts` fallback for AMO MV3 validation |
| Action API | `action`         | `browserAction` (旧版)                    |
| 扩展 ID    | 自动生成         | 需要在 `browser_specific_settings` 中指定 |

#### API 差异

| API           | Chrome             | Firefox                             |
| ------------- | ------------------ | ----------------------------------- |
| 全局对象      | `chrome.*`         | `browser.*`                         |
| Promise 支持  | 需要 polyfill      | 原生支持                            |
| Scripting API | `chrome.scripting` | `browser.tabs.executeScript` (回退) |

> ℹ️ 0.2.0 的 Firefox release manifest 使用 `background.scripts`，避免 AMO / `web-ext`
> 对 MV3 `background.service_worker` fallback 的阻断错误。Firefox manifest 同步声明
> `browser_specific_settings.gecko.data_collection_permissions`，并将桌面与 Android
> `strict_min_version` 设为 `142.0`，这是当前 `web-ext 10.4.0` lint 可证明无
> `storage.session` 与 data-collection min-version 兼容警告的最低统一版本。

### 3. 浏览器检测

```typescript
import { detectBrowser, isFirefox } from '../shared/utils/browserDetection';

const browser = detectBrowser(); // 'firefox' | 'chrome' | 'edge' | ...
const isFF = isFirefox(); // boolean
```

## 🚀 构建和开发

### 开发环境

```bash
# Firefox 开发模式
npm run dev:firefox

# Firefox 构建
npm run build:firefox

# Firefox 快速构建（跳过检查）
npm run build:firefox:fast
```

### 安装测试

1. **Firefox 开发版安装**：

   ```bash
   # 构建 Firefox 版本
   npm run build:firefox

   # 打开 Firefox
   # 访问 about:debugging#/runtime/this-firefox
   # 点击 "临时载入附加组件"
   # 选择 build/dist/manifest.json
   ```

2. **Firefox 正式版安装**：
   - 需要签名的 .xpi 文件
   - 或使用 Firefox Developer Edition / Nightly

## 📦 打包与签名

### 本地打包

```bash
# 构建 Firefox 版本并生成未签名 XPI
npm run package:firefox
```

- 输出：`<扩展名>-v<版本号>.xpi`，位于仓库根目录，可用于开发者模式临时加载。
- 脚本会自动复制许可证文件，并复用 `manifest.firefox.json`。

### Mozilla 签名发布

```bash
# 使用 AMO API 进行签名（需要先配置凭据）
WEB_EXT_API_KEY=xxx WEB_EXT_API_SECRET=yyy npm run package:firefox:sign

# 使用本机 GA public config 构建 Firefox production 包，再提交 AMO
WEB_EXT_API_KEY=xxx WEB_EXT_API_SECRET=yyy npm run package:firefox:prod:ga -- --sign --channel listed
```

- 需要在 [Mozilla Add-on Developer Hub](https://addons.mozilla.org/) 生成 API Key 与 Secret。
- 签名产物默认输出到 `build/firefox-artifacts/`，同时复制一份形如 `<扩展名>-v<版本号>-signed.xpi` 到仓库根目录。
- 支持可选参数：
  - `--channel listed|unlisted`：默认 `listed`，用于选择发布渠道。
    - `listed`：提交到 AMO 公开列表审核；脚本默认传递 `approvalTimeout=0`，避免 CI 长时间等待审核完成。审核通过后由 AMO 侧提供签名产物。
    - `unlisted`：用于自分发签名；脚本要求 Mozilla 返回 signed XPI，并对最终 signed XPI 重新执行 release archive audit。
  - `--artifacts-dir <path>`：自定义签名产物目录。
  - `--timeout <ms>`：覆盖 web-ext 等待验证的毫秒值。
  - `--approval-timeout <ms>`：覆盖 web-ext 等待审核的毫秒值；`listed` 自动发布默认使用 `0`。
  - `--api-key` / `--api-secret`：覆盖环境变量传入凭据。
- 通过 `npm run package:firefox:sign -- --channel unlisted` 可传递附加参数。
- GitHub 自动发布入口为 `.github/workflows/release-firefox-amo.yml`。该 workflow 支持 tag `v*` 触发与手动触发，默认 `listed`，手动触发可选择 `unlisted`；它会强制校验 canonical `ZENDIO_GA_MEASUREMENT_ID`、`ZENDIO_GA_TRANSPORT_MODE=proxy`、`ZENDIO_GA_PROXY_ENDPOINT`、`WEB_EXT_API_KEY`、`WEB_EXT_API_SECRET`，运行 Firefox GA production build，提交 AMO，并对生成的 XPI 执行 GA release-surface archive audit。

## 🎨 样式适配

### Firefox 特定样式

```css
/* Firefox 特定样式 */
.is-firefox {
  -moz-osx-font-smoothing: grayscale;
  scrollbar-width: thin;
}

.is-firefox-mobile {
  font-size: 18px;
}
```

### 样式加载

Firefox 特定样式会自动加载：

```typescript
// 自动添加浏览器类到 HTML
addBrowserClassToHtml(); // 添加 .is-firefox 类
```

## 🧪 测试

### 单元测试

```bash
# 运行 Firefox 特定测试
npm test tests/firefox/

# 运行所有测试
npm test
```

### E2E 测试

```bash
# Firefox E2E 测试（需要安装 Firefox）
npm run test:e2e -- --browser=firefox
```

## 📝 开发注意事项

### 1. API 使用

**✅ 推荐做法**：

```typescript
// 使用平台服务
import { getPlatformServices } from '../platform/services';

const services = getPlatformServices();
await services.storage.sync.set({ key: 'value' });
```

**❌ 避免直接使用**：

```typescript
// 不要直接使用浏览器 API
chrome.storage.sync.set({ key: 'value' }); // 在 Firefox 中不可用
```

### 2. 错误处理

```typescript
import { isFirefox } from '../shared/utils/browserDetection';

try {
  if (isFirefox()) {
    // Firefox 特定逻辑
  } else {
    // Chrome 特定逻辑
  }
} catch (error) {
  console.error('Browser-specific error:', error);
}
```

### 3. 功能检测

```typescript
import { getBrowserCapabilities } from '../shared/utils/browserDetection';

const capabilities = getBrowserCapabilities();
if (capabilities.serviceWorker) {
  // 使用 Service Worker 功能
}
```

## 🐛 常见问题

### 1. 扩展无法加载

**问题**：Firefox 提示 "无法加载扩展"

**解决方案**：

- 检查 `manifest.firefox.json` 语法
- 确保 `browser_specific_settings.gecko.id` 已设置
- 检查最低版本要求 `strict_min_version`
- 本地发布前运行 `npm run package:firefox`，该命令会在生成 XPI 前对最终
  `build/dist` 执行 `web-ext lint --self-hosted`

### 2. API 不可用

**问题**：某些 Chrome API 在 Firefox 中不存在

**解决方案**：

- 使用平台适配层
- 添加功能检测
- 提供回退方案

### 3. 样式显示异常

**问题**：Firefox 中样式与 Chrome 不一致

**解决方案**：

- 检查 CSS 前缀（`-moz-` vs `-webkit-`）
- 使用 Firefox 特定样式文件
- 测试不同 Firefox 版本

## 📊 兼容性矩阵

| 功能       | Chrome | Firefox | 状态 |
| ---------- | ------ | ------- | ---- |
| 基础剪藏   | ✅     | ✅      | 完成 |
| 右键菜单   | ✅     | ✅      | 完成 |
| 快捷键     | ✅     | ✅      | 完成 |
| 通知       | ✅     | ✅      | 完成 |
| 选项页面   | ✅     | ✅      | 完成 |
| 多语言     | ✅     | ✅      | 完成 |
| 视频模式   | ✅     | ✅      | 完成 |
| 阅读器模式 | ✅     | ✅      | 完成 |

## 🔄 更新和维护

### 版本同步

Firefox 版本与 Chrome 版本保持同步：

- 版本号相同
- 功能特性一致
- 同时发布更新

### 测试流程

1. Chrome 版本开发完成
2. 运行 Firefox 兼容性测试
3. 修复 Firefox 特定问题
4. 同时发布两个版本

## 📚 参考资源

- [Firefox WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [WebExtensions Polyfill](https://github.com/mozilla/webextension-polyfill)
- [Browser Compatibility](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_compatibility_for_manifest.json)

---

**维护者**：前端团队  
**最后更新**：2025-01-19  
**适用版本**：Zendio v0.2.0+
