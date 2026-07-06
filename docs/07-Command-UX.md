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
    BTN -->|否| MEDIA{含媒体/文件?}
    MEDIA -->|是| MP[媒体预处理 → emit MessageReceived]
    MEDIA -->|否| TEXT[普通文本 → emit MessageReceived]
```

- **非白名单**：Transport 层直接丢弃，**不回任何提示**（避免暴露存在性）。
- **命令**：以 `/` 开头，由 Transport 解析后转 Core 对应动作（多数不进 CLI）。
- **普通文本**：`emit('MessageReceived')`，走会话路由 → CLI。
- **emoji / sticker / 文件**：先做媒体预处理。Unicode emoji 做文本归一化；sticker/custom emoji 第一版只解析 metadata；图片/PDF/Office 走文件解析和 OCR pipeline。

---

## 2. 命令清单

| 命令 | 参数 | 作用 | 触发行为 |
|---|---|---|---|
| `/start` | — | 欢迎 + 当前会话状态 | 若无活跃会话则展示引导 |
| `/help` | — | 命令帮助 | 返回本表精简版 |
| `/new` | `[cli]` `[cwd]` | 强制开新会话 | 关闭当前/目标旧会话 → 新建 `idle` conversation → `SessionCreated` |
| `/close` | — | 结束当前会话 | 状态 → `closing` → 生成 episodic 摘要 → `closed` → `SessionClosed{reason:user}` |
| `/status` | — | 当前会话详情 | 展示完整 conversationId、status、cli/cwd、目标 cli/cwd、语言 |
| `/cwd` | `[path]` | 查看或切换工作目录 | 无参数查看；带路径则关闭当前会话、切换目标 cwd，下一条消息懒启动 |
| `/sessions` | — | 列出该用户近期会话 | 历史查看，不表示 resume |

> 参数缺省：`/new` 不带参数则使用当前目标 `cli`、当前目标 `cwd`（若无则用 `DEFAULT_CWD`）。V1 当前只接入 `claude`，`codex/gemini` 等未实现 Adapter 前必须返回“不支持”，不得静默当作 cwd。

---

## 3. 会话边界与命令的关系

| 用户动作 | 会话结果 |
|---|---|
| 普通发消息 | 命中 `(user, cli, cwd)` 活跃会话则复用；否则新建 |
| `/new` | 强制新建，旧会话关闭；新建会话初始为 `idle`，第一条普通消息懒启动 CLI |
| `/cwd` | 无参数仅查看当前目标 cwd |
| `/cwd <path>` | 关闭当前会话并切换当前用户目标 cwd；不创建 conversation，下一条普通消息在新 cwd 新建 |
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
- 审批是运行时状态：conversation 持久状态保持 `running`，pending approval 只存在于 adapter/orchestrator 内存和后续 audit 记录中。

### 4.2 回调处理

| 点击 | 事件 | 应答 | 后续 |
|---|---|---|---|
| Approve | `ApprovalApproved` | `resolveApproval(id,'approve')` | 记审计 → adapter 继续 |
| Reject | `ApprovalRejected` | `interrupt()` + `resolveApproval(id,'reject')` | 记审计 → 当前轮停止 |

> **应答语义按家族分派**（对上层透明）：SDK 家族 → `resolve({behavior:'allow'|'deny'})`；PTY 家族 → 注入 `y\r` / `n\r` 或 `interrupt()`（Ctrl+C）。

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

## 5.5 媒体与 emoji 入站

| 类型 | 第一版处理 | 是否 OCR |
|---|---|---|
| Unicode emoji | 从文本中识别 emoji，补充 short name/keywords 到上下文 | 否 |
| Telegram sticker/custom emoji | 解析 `emoji`、`set_name`、`custom_emoji_id`、`is_animated`、`is_video`、`file_id` 等 metadata | 否 |
| 图片/photo | 下载到受控目录，记录 metadata；图片文字走 OCR | 是 |
| PDF/扫描 PDF | 优先文本提取；扫描页走 OCR | 视内容 |
| Word/Excel/文本文件 | 结构化文本提取，作为本轮上下文 | 否 |
| 动态/video sticker | 第一版只记录 metadata；后续可抽帧走 Vision | 否，属于 Vision |

> OCR 只负责识别图片/PDF/截图中的文字。动态 sticker 的画面含义属于 Vision/抽帧增强，不用 OCR 兜底。

---

## 6. 错误与边界文案（用户可见）

| 场景 | 文案 |
|---|---|
| 非白名单 | （无响应） |
| CLI 启动失败 | ⚠️ 无法启动 {cli}，请稍后重试（详情见日志） |
| 待审批时发普通消息 | ⏳ 当前有操作等待授权，请先 Approve / Reject |
| `/cwd` 路径不存在 | ⚠️ 目录不存在：`{path}` |
| `/cwd` 路径不是绝对路径 | ⚠️ 工作目录必须是绝对路径：`{path}` |
| CLI 运行中 `/new` | ℹ️ 已关闭当前会话，已为你开启新会话 |
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
# 已启动的 CLI/adapter 空闲超过该时间后自动关闭；conversation 保持 idle，可再次唤醒
AGENT_IDLE_TIMEOUT_MS=300000

# 会话自动归档（天）
SESSION_ARCHIVE_DAYS=7

# ── 日志 ──
# debug | info | warn | error
LOG_LEVEL=info
```
