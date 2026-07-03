# 07 - 命令与交互 UX（Command & UX）

> Bot 面向用户的**行为契约**：命令、按钮、消息格式、错误文案。实现 Transport 与 Core 路由时以此为准。
> 依赖：会话边界见 [02 §5.1](./02-Architecture.md)，审批见 [PRD §5](./01-PRD.md)，事件见 [03 §1.1](./03-Interface-Contracts.md)。

---

## 1. 消息分类（Transport 入站处理）

```mermaid
flowchart TD
    IN[收到客户端消息] --> WL{白名单?}
    WL -->|否| DROP[静默丢弃, 无响应]
    WL -->|是| KIND{以 / 开头?}
    KIND -->|是| CMD[命令处理]
    KIND -->|否| BTN{是按钮回调?}
    BTN -->|是| CB[审批回调处理]
    BTN -->|否| TEXT[普通消息 → emit MessageReceived]
```

- **非白名单**：Transport 层直接丢弃，**不回任何提示**（避免暴露存在性）。
- **命令**：以 `/` 开头，由 Transport 解析后转 Core 对应动作（多数不进 CLI）。
- **普通文本**：`emit('MessageReceived')`，走会话路由 → CLI。

---

## 2. 命令清单

| 命令 | 参数 | 作用 | 触发行为 |
|---|---|---|---|
| `/start` | — | 欢迎 + 当前会话状态 | 若无活跃会话则展示引导 |
| `/help` | — | 命令帮助 | 返回本表精简版 |
| `/new` | `[cli]` `[cwd]` | 强制开新会话 | 旧活跃会话置 `idle` → 新建 conversation → `SessionCreated` |
| `/close` | — | 结束当前会话 | 状态 → `closing` → 生成 episodic 摘要 → `closed` → `SessionClosed{reason:user}` |
| `/status` | — | 当前会话详情 | 展示 platform/cli/cwd/status/进程是否在跑 |
| `/cli` | `<name>` | 切换目标 CLI | 等价新建一个该 cli 的会话（受 cwd 约束） |
| `/cwd` | `<path>` | 切换工作目录 | 切 cwd = 切会话边界，定位/新建对应会话 |
| `/stop` | — | 中断当前 CLI 运行 | `adapter.interrupt()`（Ctrl+C），会话保留 |
| `/sessions` | — | 列出该用户活跃/近期会话 | 便于在多项目间切换 |

> 参数缺省：`/new` 不带参数则复用当前 `cli`、当前 `cwd`（若无则用默认 cwd 配置）。

---

## 3. 会话边界与命令的关系

| 用户动作 | 会话结果 |
|---|---|
| 普通发消息 | 命中 `(user, cli, cwd)` 活跃会话则复用；否则新建 |
| `/new` | 强制新建，旧会话转 `idle`（不丢，可 `/sessions` 找回） |
| `/cwd` 换目录 | 切换到该目录对应会话（存在则复用，否则新建） |
| `/close` | 当前会话归档并生成摘要，下条消息将开新会话 |
| 长期无活动 | 超 `SESSION_ARCHIVE_DAYS` 自动归档（等同 `/close`，`reason:archiveTimeout`） |

---

## 4. 审批交互（Human-in-the-loop）

### 4.1 展示（`ApprovalRequested` → `sendApproval`）

Markdown 卡片 + 内联按钮：

```text
⚠️ *需要授权*

命令：
`rm -rf ./dist`

说明：Claude 请求执行上述操作。

[ ✅ Approve ]   [ ❌ Reject ]
```

- 卡片携带 `approvalId`（按钮 callback data 内），供回调定位。
- 会话状态此时为 `waitingApproval`；期间普通文本消息提示"当前有待审批操作，请先处理"。

### 4.2 回调处理

| 点击 | 事件 | 注入 | 后续 |
|---|---|---|---|
| Approve | `ApprovalApproved` | `sendInput("y\r")` | 记审计 → 状态回 `running` |
| Reject | `ApprovalRejected` | `sendInput("n\r")` 或 `interrupt()` | 记审计 → 状态回 `running` |

- **幂等**：同一 `approvalId` 重复点击只生效一次（按 `approvalId` 去重），并把卡片 `editMessage` 为最终结果（禁用按钮）。
- 每次决策**强制**写 `audit_logs`（时间/操作人/命令/决策）。

### 4.3 卡片终态回显
```text
⚠️ 需要授权 — ✅ 已批准（by @user, 14:23）
命令：`rm -rf ./dist`
```

---

## 5. 流式回复呈现

- CLI 输出经 Aggregator 聚合后 `MessageGenerated` → Transport `editMessage` 增量刷新同一条消息。
- 超单条上限（TG 4096 字符）自动拆成多条。
- `final:false` 增量编辑，`final:true` 定稿并停止刷新。

---

## 6. 错误与边界文案（用户可见）

| 场景 | 文案 |
|---|---|
| 非白名单 | （无响应） |
| CLI 启动失败 | ⚠️ 无法启动 {cli}，请稍后重试（详情见日志） |
| 待审批时发普通消息 | ⏳ 当前有操作等待授权，请先 Approve / Reject |
| `/cwd` 路径不存在 | ⚠️ 目录不存在：`{path}` |
| CLI 运行中 `/new` | ℹ️ 已保存当前会话为空闲，已为你开启新会话 |
| 进程被空闲回收后发消息 | （静默唤醒，重启进程，用户无感）|
| 内部异常 | ⚠️ 出错了，已记录。可重试或 /status 查看状态 |

> 用户可见文案友好简洁；技术细节只进 Pino 日志与 `ErrorOccurred` 事件。

---

## 附：`.env.example`

> 与 [03 §6 ConfigSchema](./03-Interface-Contracts.md) 逐项对齐。放项目根目录，实际值写入 `.env`（勿提交）。

```dotenv
# ── Telegram ──
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token

# ── 白名单（逗号分隔的 user id）──
WHITELIST_USER_IDS=11111111,22222222

# ── 数据库（Postgres）──
DATABASE_URL=postgres://hub:password@localhost:5432/ai_cli_hub

# ── 长期记忆 / 嵌入（API，不跑本地模型）──
EMBEDDING_API_KEY=sk-your-embedding-key
EMBEDDING_MODEL=text-embedding-3-small
MEMORY_RECALL_TOP_K=6

# ── 生命周期超时 ──
PTY_IDLE_TIMEOUT_MS=300000      # 进程空闲回收（5 分钟）
SESSION_ARCHIVE_DAYS=7          # 会话自动归档（天）

# ── 日志 ──
LOG_LEVEL=info                  # debug | info | warn | error
```
