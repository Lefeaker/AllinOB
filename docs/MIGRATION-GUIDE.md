# Repository 迁移指南

> 版本: v1.0  
> 最近更新时间: 2025-11-30  
> 适用范围: Shared / Options / Content Scripts 重构阶段

## 目录

1. 概述
2. 识别待迁移代码
3. Before / After 对比
4. 迁移步骤
5. 验证策略
6. 回滚策略
7. 常见问题
8. Checklist
9. 附录 A: 工具脚本
10. 附录 B: 模板
11. 附录 C: FAQ 扩展

---

## 1. 概述

- 目标：让 UI / Service 层零 `chrome.*`、零 `getPlatformServices()`，全部通过 Repository 访问平台能力。
- 范围：Options、Content Script、Shared Service，包含 YAML、Video、Clipper、Reader 等模块。
- 成功指标：`npm run test:unit` 与 `npm run test:e2e` 全绿，`rg 'getPlatformServices()'` 仅在入口命中。

## 2. 识别待迁移代码

### 快速命令

```bash
rg -n \"chrome\\\\.\" src/options src/content | rg -v \"infrastructure\"
rg -n \"getPlatformServices()\" src/options src/content | rg -v \"Dependencies\"
```

### 常见症状

| 症状                                 | 风险                 |
| ------------------------------------ | -------------------- |
| UI 直接调用 `chrome.storage`         | 无法在测试环境运行   |
| UI 订阅 storage.onChanged            | 容易遗漏取消订阅     |
| 业务代码引入 `getPlatformServices()` | 与平台强耦合         |
| 缺少错误处理                         | 用户无法得知异常状态 |

## 3. Before / After 对比

### Before

```ts
class UsageDashboardView {
  async clearStats() {
    const { storage } = getPlatformServices();
    await storage.sync.set({ usageStats: {} });
    this.render();
  }
}
```

### After

```ts
class UsageDashboardView {
  private readonly repo = resolveRepository<IOptionsRepository>(DI_TOKENS.IOptionsRepository);

  async clearStats(): Promise<void> {
    await this.repo.set({ usageStats: {} });
  }
}
```

迁移后 UI 不再关心 storage 细节，只与 Repository 对话。

## 4. 迁移步骤

1. **定位代码**：使用 `rg` 找到所有 `chrome.*` 或 `getPlatformServices()`。
2. **定义接口**：在 `src/shared/repositories` 下新增接口 / 扩展类型。
3. **实现 Provider**：在 `src/infrastructure/repositories` 中实现 Chrome 版本。
4. **注册 DI**：更新 `src/shared/di/serviceRegistry.ts`。
5. **注入 Consumer**：修改 UI 或 Service，通过 `resolveRepository` 获取实例。
6. **添加测试**：至少覆盖 `get/set/onChange`，并为 Mock 提供对应实现。
7. **更新文档**：在 `docs/REPOSITORY-PATTERN.md` 与 `src/shared/repositories/README.md` 记录。

## 5. 验证策略

### 单元测试

- `npm run test:unit -- tests/unit/shared/yamlConfigService.test.ts`
- `npm run test:unit -- tests/unit/infrastructure/ChromeYamlRepository.test.ts`

### 集成 / E2E

- `npm run test:e2e`
- 针对 Options Shell：`npm run test:e2e -- tests/e2e/optionsTemplatesAutoSave.test.ts`

### 静态检查

- `npm run typecheck`
- `npm run lint`
- `npm run lint:warnings-guard`

## 6. 回滚策略

1. 保留旧实现文件 1-2 周，在 `archived/` 目录记录路径。
2. 如果某个 Repository 出现严重问题，可在 `serviceRegistry` 中切换回旧实现。
3. 通过 Feature Flag 控制新旧逻辑切换，避免一次性上线风险。

## 7. 常见问题

### Q: UI 仍需要访问 `chrome.runtime.sendMessage` 怎么办？

A: 封装成 `IMessagingRepository`，UI 调用 Repository 暴露的 `send()` 方法即可。

### Q: 订阅太多导致性能问题？

A: Repository 层实现去重与节流；UI 层在组件销毁时务必取消订阅。

### Q: Mock 实现是否需要模拟 storage？

A: 需要。Mock 应与 Chrome 行为一致，保证测试结果可信。

## 8. Checklist

- [ ] 新增接口已放入 `src/shared/repositories/index.ts`
- [ ] Chrome 实现放在 `src/infrastructure/repositories`
- [ ] 订阅逻辑提供取消函数
- [ ] 错误包装为 `RepositoryError`
- [ ] UI 不再使用 `getPlatformServices()`
- [ ] 测试覆盖 get/set/onChange
- [ ] 文档已更新
- [ ] `scripts/check-migration-progress.sh` 无新增报警

## 9. 附录 A: 工具脚本

- `scripts/check-migration-progress.sh`：输出所有未迁移文件。
- `scripts/verify-p2-2-completion.mjs`：校验 Repository 行为。

## 10. 附录 B: 模板

```ts
export interface IFooRepository {
  get(): Promise<Foo>;
  set(patch: Partial<Foo>): Promise<void>;
  onChange(listener: (foo: Foo) => void): () => void;
}

export class ChromeFooRepository implements IFooRepository {
  constructor(private readonly storage: PlatformStorageService) {}

  async get(): Promise<Foo> {
    const snapshot = await this.storage.sync.get('foo');
    return snapshot.foo ?? DEFAULT_FOO;
  }

  async set(patch: Partial<Foo>): Promise<void> {
    const current = await this.get();
    await this.storage.sync.set({ foo: { ...current, ...patch } });
  }

  onChange(listener: (foo: Foo) => void): () => void {
    const wrapped = (changes: StorageChanges, area: string) => {
      if (area !== 'sync' || !changes.foo) {
        return;
      }
      listener(structuredClone(changes.foo.newValue as Foo));
    };
    this.storage.onChanged.addListener(wrapped);
    void this.get().then(listener);
    return () => this.storage.onChanged.removeListener(wrapped);
  }
}
```

## 11. 附录 C: FAQ 扩展

1. **如何在多浏览器共享 Repository？**  
   提供 `ChromeFooRepository` 与 `FirefoxFooRepository`，在 DI 注册阶段根据 runtime 选择。

2. **如何迁移旧的全局变量？**  
   通过 Repository 持久化，再由 Service 读取，逐步替换全局状态。

3. **需要多语言支持怎么办？**  
   Repository 负责返回完整数据，UI 层根据 locale 渲染，不在 Repository 中写死字符串。

---

## 12. 识别模式与案例

### Pattern 1: UI 直接写 storage

- 位置：`src/options/components/usageDashboard.ts`
- 处理：抽取 `IUsageStatsRepository`，UI 改为调用 `clear()`。

### Pattern 2: Content Script 使用 messaging

- 位置：`src/content/video/session.ts`
- 处理：注入 `IVideoClipRepository` 和 `IVideoSessionRepository`，统一发送逻辑。

### Pattern 3: Shared Service 使用模块级变量

- 位置：`src/shared/services/yamlConfigService.ts`
- 处理：改为纯函数 + Repository 提供 overrides，移除 `initializeOverridesFromStorage()`。

## 13. 迁移脚手架

```bash
# 1. 创建接口与实现
pnpx hygen repo new --name Foo

# 2. 更新 serviceRegistry
pnpx hygen repo register --name Foo

# 3. 生成测试骨架
pnpx hygen repo test --name Foo
```

> 若 hygen 不可用，可复制 `MockOptionsRepository` 与 `ChromeOptionsRepository` 结构。

## 14. 迁移案例时间线

| Day | 任务                          | 产出                                                    |
| --- | ----------------------------- | ------------------------------------------------------- |
| 1   | 梳理 YAML Service chrome 依赖 | `YAML-CONFIG-SERVICE-REFACTOR-NOTES.md`                 |
| 2   | 编写 `IYamlRepository` 接口   | `src/shared/repositories/IYamlRepository.ts`            |
| 3   | Chrome 实现 + 测试            | `ChromeYamlRepository.ts` + 单测                        |
| 4   | 替换 Options Section          | production Stitch YAML owner 更新                       |
| 5   | 更新模板、文档、审计报告      | `REPOSITORY-PATTERN.md` / `REPO-MONTH3-SHARED-AUDIT.md` |

## 15. 实战 Tips

- 小步提交：分拆接口、实现、Consumer、测试，方便 review。
- 先写 Mock，再写 Chrome，实现时可对照行为。
- 遇到多个模块共享字段时，纵向优先：先迁移 Repository，再依次替换 Consumer。
- 迁移完单个模块后立刻运行相关测试，避免问题积累。
- 及时更新 `GET-PLATFORM-SERVICES-CLEANUP.md`，保持审计透明。

## 16. 扩展 Checklist

- [ ] 迁移 PR 描述包含：影响范围、风险、测试项。
- [ ] `npm run test:unit -- tests/unit/content/...` 覆盖受影响模块。
- [ ] `docs/REPO-MONTH*-EXECUTION-PLAN.md` 对应任务标记完成。
- [ ] 在 `MONTH*-WEEK*-COMPLETION-REPORT.md` 中登记代码行数。
- [ ] 如果涉及用户数据，确认隐私政策未受影响。
- [ ] 对 messaging 场景，确认 Background 端也改用 Repository。
- [ ] 审核 release note，确保对用户透明。
- [ ] 若引入新依赖，更新 `package.json` 与 `LICENSE`。

## 17. 进阶 FAQ

### Q: Repository 是否可以缓存数据以减少 storage 调用？

可以，但必须提供 `refresh()` 或 `invalidate()`。缓存一致性由 Repository 维护，UI 只依赖订阅。

### Q: 如何处理需要跨 Tab 同步的状态？

通过 Repository 订阅 storage/messaging 事件，在 onChange 中广播。UI 不应直接监听 `chrome.storage.onChanged`。

### Q: 多 Repository 依赖同一数据源怎么办？

抽象为 Service 层，例如 `YamlConfigService`，由 Service 协调多个 Repository 的输入输出。

## 18. 迁移风险矩阵

| 风险                      | 影响         | 缓解措施                                       |
| ------------------------- | ------------ | ---------------------------------------------- |
| 忘记取消订阅              | 内存泄漏     | 在当前 owner 的 cleanup/dispose 钩子中统一调用 |
| 错误吞掉                  | 用户无法得知 | RepositoryError 必须向上抛出                   |
| Mock 行为与 Chrome 不一致 | 测试失真     | 编写端到端测试和行为对比清单                   |
| 未更新文档                | 知识断层     | 在 CI 中加入文档检查                           |
| 行数膨胀                  | 维护成本增加 | 在审计报告中记录行数 + 原因                    |

## 19. 迁移完成后的自检

1. `rg 'chrome\\.' src/shared | rg -v 'infrastructure'` 输出 0。
2. `rg 'getPlatformServices()' src/options src/content | rg -v 'Dependencies'` 输出 0。
3. `npm run test:unit -- tests/unit/shared/yamlConfigService.test.ts --coverage` 覆盖率 > 90%。
4. `npm run test:e2e` 通过。
5. `docs/REPOSITORY-PATTERN.md` 与 `src/shared/repositories/README.md` 有更新记录。

## 20. 资源索引

- `docs/251126-design-system-poc/REPO-MONTH3-EXECUTION-PLAN.md`
- `docs/251126-design-system-poc/GET-PLATFORM-SERVICES-CLEANUP.md`
- `docs/251126-design-system-poc/MONTH3-WEEK1-AUDIT-REPORT.md`
- `src/shared/repositories/README.md`
- `tests/utils/repositories/` Mock 实现

## 21. 里程碑 Checklist（按周）

### Week 1

- [ ] 提交债务分析文档
- [ ] 完成接口定义
- [ ] 搭建 Mock 实现

### Week 2

- [ ] Chrome 实现完成
- [ ] Consumer 重构完成
- [ ] 单元测试覆盖核心路径

### Week 3

- [ ] 覆盖率达到 90%+
- [ ] Shared/Options/Content 审计通过
- [ ] 审核报告归档

### Week 4

- [ ] 文档（REPOSITORY-PATTERN / MIGRATION-GUIDE / README）更新
- [ ] Completion Report 输出行数与测试结果
- [ ] Feature Flag / Rollout 策略确认
