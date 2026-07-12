# 05 - 实施计划（Implementation Plan）

> vibe coding 的**施工图**：定义构建顺序、里程碑、每步交付物与验收标准。
> 编码 Agent 请**严格按里程碑顺序推进**，每个里程碑通过验收后再进入下一个。
> 契约见 [03](./03-Interface-Contracts.md)，数据见 [04](./04-Data-Model.md)，规矩见 [CLAUDE.md](../CLAUDE.md)。

---

## 1. 构建顺序（依赖拓扑）

**从叶子到根，从抽象到装配。** 违反此序会导致上层无桩可依、反复返工。

```mermaid
flowchart LR
    A[shared/ 类型] --> B[config/]
    B --> C[event/ Bus]
    C --> D[storage/ + repository/]
    D --> E[core/ 状态机+路由]
    E --> F[cli/ ClaudeSdkAdapter / OpenCodeSdkAdapter<br/>直接依赖对应 SDK]
    F --> H[aggregator]
    H --> I[transport/ telegram]
    I --> J[memory/]
    J --> K[main.ts 装配]
    E -.备用.-> P[runtime/ node-pty + approval/<br/>PTY 家族·无 SDK 时]
    P -.-> F
```

> 原则：**下游未就绪不动上游**。例如 Transport（I）依赖 Core（E）与 Aggregator（H）已可用。

---

## 2. 里程碑

### M0 — 工程骨架 ✅ 交付即可编译运行空壳

- 初始化 Bun + TS（strict）+ `package.json` 脚本（见 CLAUDE.md §6）。
- 目录骨架（`src/*` 空模块 + `index.ts`）。
- ESLint + `dependency-cruiser`（落地依赖矩阵铁律）+ Pino 基础 logger。
- `settings.json.example`（见 [07 附](./07-Command-UX.md)）。
- **验收**：`bun run typecheck` / `bun run lint` 通过；`bun run dev` 启动打印一行日志退出。

### M1 — 配置与事件总线

- `config/`：`ConfigSchema` + `loadConfig()`，fail-fast。
- `event/`：`EventBus` 实现 + 完整 `EventMap`。
- `logger/`：订阅全部事件结构化输出。
- **验收**：单测——非法 env 抛错；`emit`/`on` 类型安全且送达；logger 能打出任一事件。

### M2 — 存储与仓储

- `storage/`：Drizzle 连接 + 四表 schema（[04](./04-Data-Model.md)）+ 首迁移 `0000_init`（含 `CREATE EXTENSION vector`，不含 HNSW）。
- `repository/`：四个 Repository 实现（`embedding` 相关方法先留桩/关键词版）。
- **验收**：跑迁移建库成功；集成测试对每个 Repository 增查通过；**全项目仅 `repository/` 出现 SQL**（lint 校验）。

### M3 — Core 状态机与会话生命周期

- `core/`：`SessionManager`（状态机，合法迁移见 02-架构 §5.2）、`Auth`（白名单二次校验）、`MessageRouter`。
- 会话 scope：`findActive(platform,user)` 复用 / `/new` 关闭同 scope 旧会话后新建 / `/cwd` 切目标目录 / 归档扫描；CLI/cwd 不是隔离维度。
- 进程占位：先用 **MockRuntime** 打通"收消息→路由→存库→回消息"闭环。
- **验收**：状态机单测覆盖全部合法/非法迁移；用 Mock 打通端到端（无真实 PTY）；进程回收→会话转 `idle` 而非 `closed`。

### M4 — Claude Adapter（SDK 家族，首选）

- `cli/`：`ClaudeSdkAdapter` 实现 `CLIAdapter`（§3.1），内部持 `@anthropic-ai/claude-agent-sdk` 的 `query()` 句柄；V2-R3 扩展 `OpenCodeSdkAdapter`，通过 `@opencode-ai/sdk` 拉起 `opencode serve` 并映射 SSE/permission 事件。
  - `sendUserInput` → 流式输入（`AsyncIterable<SDKUserMessage>` / `streamInput`）；`onOutput` ← `SDKMessage`（assistant/tool_use/result）。
  - **审批走 `canUseTool` 回调**：拿到工具名+参数 → `onApprovalRequest` → `bus.emit('ApprovalRequested')`；`resolveApproval(id,'approve'|'reject')` → `resolve({behavior:'allow'|'deny'})`。**无 scraping、无 `Runtime`、无 `ApprovalDetector`。**
  - 生命周期：CLI/adapter 起止/崩溃 → `onExit` → `PTYStarted/PTYExited` 或 adapter exit；`AGENT_IDLE_TIMEOUT_MS` 空闲关闭已启动 CLI/adapter（`query.interrupt()`/close），conversation 保持 `idle`。
  - 审批：`waitingApproval` 只属于 Adapter 内存态，conversation 持久状态保持 `running`。
- **验收**：真实拉起 Claude 完成一轮对话；构造一次工具审批，`canUseTool` 命中 → 收到结构化 `command`+`detail`；点 Approve 继续、Reject 拒绝；空闲超时进程被回收、会话可唤醒。

### M4b — PtyRuntime（PTY 家族，无 SDK 的 CLI 备用，可延后）

- `runtime/`：`NodePtyRuntime` 实现 `PtyRuntime`（§3.2，字节容器）。
- `approval/`：某无 SDK 的 CLI 的 `ApprovalDetector`（正则 `[Y/n]` scraping）。
- `cli/`：`XxxPtyAdapter` 实现同一 `CLIAdapter`，内部剥 ANSI 得输出、scraping 认审批、写 `y\r`/`n\r`。
- **验收**：无 SDK 的目标 CLI 也能经统一 `CLIAdapter` 完成一轮对话与一次审批。**非 V1 关键路径**——V1 只跑 Claude（SDK），本节按需推进。

### M5 — 消息聚合器

- `MessageAggregator`：Buffer + Debounce + Throttle + Markdown 合并 + 超长拆分。
- **验收**：高频 chunk 注入下，`MessageGenerated` 发射频率 ≤ `minEditIntervalMs`；超 4096 字符自动分段；静默后 flush 完整。

### M6 — Telegram Transport（首个端到端）

- `transport/telegram`：Telegraf 封装，实现 `Transport` 全方法。
- 白名单前置丢弃；流式 `editMessage`；审批 Markdown 卡片 + 回调 → `ApprovalApproved/Rejected`。
- M6b 收口命令：`/new`、`/close`、`/status`、`/sessions`、`/lang`、`/cwd`；`/new` 旧会话 closed，新会话 idle；`/cwd <path>` 关闭当前会话并切换目标 cwd，不创建 conversation。
- **验收**：真机 Telegram 端到端——发消息得流式回复；点 Approve 继续（SDK: `resolveApproval` allow）；点 Reject 中断；非白名单无响应。

### M7 — Audit 落地

- `audit/` 订阅 `ApprovalRequested` 缓存命令详情；订阅 `ApprovalApproved/Rejected` → `AuditRepository.record`（时间/操作人/命令详情/决策）。
- 新增 `/audit [conversationId]` 查看当前或指定会话最近审批记录；允许使用 `/sessions` 展示的短 ID 前缀。
- M7 审计范围仅指 **Human Approval 审计**，不扩展为完整操作日志；不改变 conversation status。
- **验收**：每次审批必产生一条不可删审计；会话归档后审计仍在；Telegram 可用 `/audit` 查看。

### M8 — 全局记忆基础（V1：实例级环境快照 + 命令式记忆）

- **M8-A 环境快照记忆（优先）**：启动时 upsert 当前运行环境事实。快照按 OS 自适应探测，Linux/VPS 侧记录 OS/hostname/cwd、Bun/Node/Git、Shell、Claude/Codex/Gemini CLI、PM2、Docker/Compose、Postgres 工具、默认工作目录、媒体目录可操作状态与资源限制；不记录容器列表、端口、磁盘占用等高频变化状态，Agent 需要时自行执行 `docker ps`/`ss`/`df` 查询。Windows 侧才记录 PowerShell。环境命令失败不阻塞启动。
- **M8-B 全局记忆注入**：Adapter start 时全量注入实例级全局记忆（环境事实 + `/remember` + 偏好）；conversation 历史 messages 不做完整回放，但 adapter 重启后的下一条 user message 携带最近 `RECENT_CONTEXT_LIMIT` 条轻量上下文。
- **M8-C `/remember <text>`**：显式写入实例级全局持久记忆（默认 `namespace='global'`、`conversation_id=NULL`）；不做隐式猜测抽取。
- **M8-D `/memory` / `/env` / `/forget <id>`**：查看长期记忆、刷新并查看环境快照、删除实例级全局记忆；命令权限仍由 Transport 白名单控制。
- **验收**：新会话首轮上下文自动带上当前系统/目录/shell 等环境事实；用户写入“所有软件都放在 softs 文件夹”后，新会话也带上该事实；服务重启后两类记忆仍存在。

### M9 — 媒体/文件入站 + Light OCR 接入

- **M9-A emoji 文本归一化**：识别 Unicode emoji，补充 short name/keywords 作为文本上下文；不走 OCR。
- **M9-B Telegram sticker/custom emoji metadata**：解析 sticker/custom emoji 的 `emoji`、`set_name`、`custom_emoji_id`、`is_animated`、`is_video`、`file_id`；第一版不做画面理解。
- **M9-C 文件/附件入站 + 按需解析能力**：Telegram 可下载附件入站（`photo/document/audio/voice/video/video_note/animation`；任意普通文件走 `document`，未知来源可归为 `other`），下载到受控目录、记录 metadata/local_path、大小/类型/超时限制。除图片外，PDF/Word/Excel/text/audio/video 等文件上传时全部采用懒加载：只让 AI 知道“这里有一个文件”和本地路径，不自动读取、解析、总结、OCR、转写、转换或移动，也不把文件正文塞入本轮上下文。用户明确要求处理文件时，再按 `local_path` 使用按需能力：文字型 PDF 用 `pdf-parse`，`.docx` 用 `mammoth`，`.xls/.xlsx` 用 `xlsx`，旧 `.doc` 仍不支持直接解析并提示转 `.docx`/PDF/text。
- **M9-C 图片 OCR**：图片/photo 可在上传时调用 `OcrProvider` 抽象；配置 `OCR_API_BASE_URL` 后通过 Light OCR HTTP API 的 `POST /ocr/file` 识别，留空时返回明确未配置状态。PDF 即使可能是扫描件，也属于非图片文件，上传时不自动 OCR。
- **M9-D Vision 暂不实现**：static sticker/thumbnail 图片理解、animated/video sticker 抽帧与 Vision 识别均移到项目 V1 完成后的优化迭代，不归入 M9。
- **验收**：普通 emoji 能被归一化进上下文；sticker 能展示 associated emoji 和 metadata；用户发图片/文件/音视频会进入受控下载；非图片文件只进入 metadata/local_path 懒加载上下文，不出现 `extracted_text`，不会自动消耗正文 token；配置 `OCR_API_BASE_URL` 后图片走 Light OCR，未配置时有明确占位状态；不会自动执行、读取、解析、转换或移动非图片附件。

### M10 — 加固与交付

- 优雅关闭（SIGTERM：停入站→flush→杀 Runtime→关 DB）；故障隔离（单 Runtime 崩溃不波及他会话）；幂等审批去重。
- PM2/systemd 部署脚本；README。
- **验收**：压测多会话不串扰；重启无脏状态；PRD §8 交付清单全绿。

### —— V1.5（记忆增强，非 V1 阻塞项）——

- 迁移追加 HNSW 索引；`memory/` 接入嵌入 API（异步批量）回填 `embedding`。
- 召回切换/融合 `searchByVector`（相似度 × importance 重排）。
- 遗忘：按 `importance × last_accessed` 定期降权/清理。
- **验收**：语义模糊 query 能召回关键词对不上的相关记忆；召回质量优于纯 FTS。

### —— V2-R2（运维自更新 / 自检测 / 自动拉起）——

- **R2-A 健康检查**：新增 `/health`，即时检查 Postgres ping、默认工作目录、媒体目录、关键 CLI 可用性与进程 uptime；不创建 conversation、不进入 CLI。
- **R2-B 部署自检**：围绕 PM2/systemd、迁移状态、依赖安装与关键 env 做只读自检，为更新前检查提供报告。
- **R2-C 受控自更新**：通过显式命令触发 `git pull --ff-only`、`bun install`、`bun run db:migrate`、`bun run format:check`/`typecheck` 等检查，成功后写入重启通知 marker 并交给 PM2/systemd 重启；新进程启动后主动通知原 chat；失败必须保留当前进程并报告原因。`/update` 与 `/restart` 仅适用于 Linux/VPS 部署，Windows 上直接拒绝执行。另提供 `/restart` 复用同一重启命令与通知 marker，仅验证重启链路，不更新代码。
- **R2-D 自动拉起与恢复验证**：依赖外部守护（PM2/systemd）自动拉起，应用启动后通过状态对账与 `/health` 验证恢复。
- **验收**：`/health` 能区分 ok/degraded/down；自更新过程可审计、可失败回退到“未重启”；异常退出后守护器拉起且会话状态无脏 running/starting。

---

## 3. 里程碑依赖与并行

```mermaid
flowchart TD
    M0 --> M1 --> M2 --> M3
    M3 --> M4 --> M5 --> M6 --> M7
    M7 --> M8 --> M9 --> M10
    M10 -.-> V15[V1.5 记忆增强]
```

- **可并行**：M5（聚合器，依赖 M4 的 chunk 但接口独立）与 M4 后段可交叠；文件/OCR 可在 M8 记忆契约稳定后并行细化解析器。
- **关键路径**：M0→M1→M2→M3→M4→M6→M7→M8→M9→M10。

---

## 4. vibe-coding 工作流约定

1. **每个里程碑一个分支/一批提交**，完成"验收"再合并。
2. **契约先行**：动实现前对齐 [03](./03-Interface-Contracts.md)；若需改签名，先改 03 再改实现，保持真相源唯一。
3. **测试随行**：难测部件（PTY/事件/审批）先写 Mock 与断言（M3 的 MockRuntime 贯穿始终）。
4. **每步自检三问**：违反依赖矩阵了吗？出现 `process.env`/SQL 越界了吗？状态迁移合法吗？
5. **发现要改 Core 才能加功能 → 停**，回看架构分层，多半是设计问题。

---

## 5. V1 完成定义（Definition of Done）

对齐 [PRD §8](./01-PRD.md) 交付清单：

- ✅ Bun+TS 架构 / Postgres+Drizzle+Repository / Event Bus / Config
- ✅ Telegram + 腾讯官方 QQ Bot C2C 接入 / Claude Adapter（`@anthropic-ai/claude-agent-sdk`，SDK 家族）/ opencode Adapter（`@opencode-ai/sdk`，SDK 家族）/ 状态机会话生命周期
- ✅ Message Aggregator / Approval Flow / 永久 Audit
- ✅ 会话边界（cwd 目标 / `/new` / `/cwd` / `/close` / 归档）
- ✅ 记忆基础：实例级环境快照记忆 + 命令式全局记忆注入（向量列预留待 V1.5）
- ✅ 全程满足依赖矩阵、无 env/SQL 越界、优雅关闭
