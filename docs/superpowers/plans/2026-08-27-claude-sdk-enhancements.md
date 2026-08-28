# Claude SDK 增量流式、推理控制与用量观测实施计划

> **执行指南：** 本文档是 2026-08-27 针对 `@anthropic-ai/claude-agent-sdk` 与 `@opencode-ai/sdk` 调研后确定的 P2/P3 功能增强实施计划。
> 各阶段任务使用 Checkbox (`- [ ]`) 跟踪状态。

**目标：**
1. **P2（体验增强）**：为 `ClaudeSdkAdapter` 启用 `includePartialMessages: true`，监听 `stream_event` 增量，向 Hub 发布 `kind: 'text', final: false` 的实时增量输出，打通 Web / QQ / Telegram 的流式打字机体验。
2. **P3（能力扩展）**：在 `SpawnOptions` 和 `ClaudeSdkAdapter` 启动参数中支持 `thinking`（Adaptive / Enabled / Disabled）与 `effort`（Reasoning Effort）配置，平滑替换已弃用的 `maxThinkingTokens`。
3. **P3（观测性增强）**：在 `CLIAdapter` 语义接缝暴露可选的 `getContextUsage?()` 契约，并在 `ClaudeSdkAdapter` 中接入 `Query.getContextUsage()`，为会话状态与 Web 控制面提供 Token 分布指标。
4. **P4（长期跟踪）**：在文档与决策日志中记录 `@opencode-ai/sdk` 的 V2 命名空间演进，本期保持 V1 稳定对接。

---

## 模块设计与架构约束

- **依赖矩阵不变**：所有改动严格限制在 `src/cli/`、`src/shared/` 与对应单测中，禁止向 `core/` 或 `transport/` 泄漏 SDK 具体实现。
- **输出语义对齐 (D12)**：`OutputDelta` 维持 `final: false` 为增量 delta，`final: true` 为本轮定稿。`MessageAggregator` 负责统一的累积、防抖与分段。
- **清洗与过滤**：增量流式文本通过 `sanitizeVisibleText` 清洗；`result.result` 继续作为定稿保底（若本轮无增量且最终为空，输出预设兜底文本）。

---

## 文件结构变更

- `src/cli/base.ts`: 扩展 `SpawnOptions`（支持 `thinking`、`effort`）与 `CLIAdapter`（新增可选 `getContextUsage?()` 与 `ContextUsageInfo` 类型）。
- `src/cli/claude/claude-sdk-adapter.ts`:
  - 启动参数加入 `includePartialMessages: true`、`thinking`、`effort`。
  - `handleMessage` 增加对 `msg.type === 'stream_event'`（`content_block_delta` -> `text_delta`）的处理并触发 `onOutput(kind: 'text', final: false)`。
  - 实现 `getContextUsage()`。
- `src/cli/claude/claude-sdk-adapter.test.ts`: 补充流式增量接收、thinking/effort 传递、getContextUsage 调用的单元测试。
- `PROGRESS.md`: 记录决策 D99 与本次迭代任务。

---

## 阶段任务拆解

### Task 1: 契约扩展 (SpawnOptions & CLIAdapter)

**文件：**
- 修改 `src/cli/base.ts`

- [x] **Step 1: 扩展 `src/cli/base.ts` 契约定义**
  - 新增 `ContextUsageInfo` 接口（`totalTokens: number; maxTokens?: number; percentage?: number; categories?: Record<string, number>`）。
  - 在 `SpawnOptions` 中新增可选 `thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }` 与 `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`。
  - 在 `CLIAdapter` 中新增可选 `getContextUsage?(): Promise<ContextUsageInfo>`。

---

### Task 2: Claude SDK 适配器增强 (流式输出 + 推理配置 + 上下文用量)

**文件：**
- 修改 `src/cli/claude/claude-sdk-adapter.ts`
- 修改 `src/cli/claude/claude-sdk-adapter.test.ts`

- [x] **Step 1: 编写测试用例**
  - 测试 `stream_event`（`content_block_delta` -> `text_delta`）正确触发 `onOutput(kind: 'text', text: delta, final: false)`。
  - 测试 `thinking` 与 `effort` 参数正确传递至 SDK `query()` options。
  - 测试 `getContextUsage()` 正确调用底层 query 并返回结构化 Token 用量。
- [x] **Step 2: 实现 `ClaudeSdkAdapter` 增强**
  - 在 `queryFn` 调用参数中注入 `includePartialMessages: true`、`thinking: opts.thinking`、`effort: opts.effort`。
  - 在 `handleMessage` 中处理 `stream_event`，解析 `text_delta` 并通过 `sanitizeVisibleText` 清洗后发射。
  - 维护 `turnHasVisibleText` 标记，配合 `result` 消息完成一轮收尾。
  - 实现 `getContextUsage()`。
- [x] **Step 3: 运行并验证测试**
  - 运行 `bun test src/cli/claude/claude-sdk-adapter.test.ts`，确保全部测试通过。

---

### Task 3: 验收与门禁全量检查

- [x] **Step 1: 运行格式化与全套检查**
  - `bun run format`
  - `bun run format:check`
  - `bun run typecheck`
  - `bun run lint`
  - `bun test`
- [x] **Step 2: 对齐文档与进度**
  - 更新 `PROGRESS.md`（决策 D99、更新时间、Changelog、测试计数）。
