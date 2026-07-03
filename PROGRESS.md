# PROGRESS — 当前进度与决策日志

> **每个编码会话先读本文件**，了解现状后再动手；**每完成一个里程碑或做出关键决策后回来更新**。
> 这是项目的**动态状态真相源**。静态规矩见 [CLAUDE.md](./CLAUDE.md)，蓝图见 [05-实施计划](./docs/05-Implementation-Plan.md)。
>
> 最后更新：2026-07-03 · 阶段：**M0 完成，进入 M1（配置与事件总线）**

---

## 1. 当前状态一览

| 维度 | 状态 |
|---|---|
| 当前里程碑 | **M1 - 配置与事件总线**（未开始） |
| 代码 | ✅ M0 骨架就绪（可编译、可 lint、可启动） |
| 文档 | ✅ 齐全（护栏三件套 + 数据/记忆/命令 + PRD/架构） |
| 阻塞项 | 无 |
| 下一步 | M1：config（Zod）+ EventBus + logger 订阅事件（见 §4） |

---

## 2. 里程碑进度（对齐 [05-实施计划](./docs/05-Implementation-Plan.md)）

| # | 里程碑 | 状态 | 备注 |
|---|---|---|---|
| M0 | 工程骨架 | ✅ 完成 | Bun+TS / src 骨架 / dependency-cruiser 依赖矩阵 / ESLint(defineConfig)禁 env 越界 / Prettier 格式化 / Pino logger / main 启动 |
| M1 | 配置与事件总线 | 🟡 下一个 | config Zod / EventBus + EventMap / logger 订阅全部事件 |
| M2 | 存储与仓储 | ⬜ | Drizzle 四表 / 迁移 0001 / 四 Repository |
| M3 | Core 状态机与会话生命周期 | ⬜ | SessionManager / 路由 / MockRuntime 闭环 |
| M4 | Runtime 与 Claude Adapter | ⬜ | node-pty / ClaudeAdapter / 审批检测 |
| M5 | 消息聚合器 | ⬜ | Buffer/Debounce/Throttle/拆分 |
| M6 | Telegram Transport | ⬜ | 首个端到端 |
| M7 | Audit 落地 | ⬜ | 永久审计 |
| M8 | 记忆基础（V1：关系+FTS） | ⬜ | 跨会话摘要回放 |
| M9 | 加固与交付 | ⬜ | 优雅关闭 / 故障隔离 / 部署 |
| V1.5 | 记忆增强（pgvector） | ⬜ | 非 V1 阻塞项 |

图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 受阻

---

## 3. 关键决策日志（已拍板，勿再翻案）

> 这些是已达成一致的决策，编码时直接遵循，不要重新讨论或改变方向。详细权衡见 [02-架构 ADR 附录](./docs/02-Architecture.md)。

| # | 决策 | 定稿于 |
|---|---|---|
| D1 | 数据库 V1 即用 **Postgres + Drizzle**（非 SQLite），一次定库避免二次迁移 | 2026-07-03 |
| D2 | 向量用 **pgvector 同库**；V1 预留 `embedding` 列留空，**V1.5** 启用 HNSW 索引 | 2026-07-03 |
| D3 | 嵌入**只走 API**（`text-embedding-3-small`），**不在 VPS 跑本地模型**；异步批量 | 2026-07-03 |
| D4 | 会话边界 = `(user_id, cli, cwd)` 复用 + `/new` 开新 + `/close`/超期归档 | 2026-07-03 |
| D5 | **进程回收 ≠ 会话关闭**：PTY 空闲超时转 `idle`，`closed` 仅由 `/close`/归档触发 | 2026-07-03 |
| D6 | 记忆分 **user-level / conversation-level 两层**；跨会话回放取 user-level + 相关 episodic 摘要 | 2026-07-03 |
| D7 | 文档集定为 CLAUDE.md + 01–07 + .env.example（不单列安全/ADR/贡献指南） | 2026-07-03 |

---

## 4. 下一步行动（Next Actions）

**M1 — 配置与事件总线**（当前）：
1. `config/`：实现 `ConfigSchema` + `loadConfig()`（Zod，fail-fast），契约见 [03 §6](./docs/03-Interface-Contracts.md)。
2. `event/`：实现 `EventBus` + 完整 `EventMap`（类型安全 emit/on），见 [03 §1](./docs/03-Interface-Contracts.md)。
3. `logger/`：新增订阅全部事件的桥接（`bus.on` 每个事件 → 结构化日志）。
4. `main.ts`：装配 `loadConfig() → createLogger(config) → createEventBus() → 挂 logger`。
5. 单测：非法 env 抛错；emit/on 类型安全且送达；logger 能打出任一事件。
6. 通过验收 → 更新本文件（M1 → ✅，M2 → 🟡）→ 进入 M2。

**M0 验收留痕**：`bun run typecheck` ✅ · `bun run lint`（eslint + depcruise 0 违规）✅ · `bun run start` 打印启动日志 ✅

---

## 5. 会话日志（Changelog）

> 每个工作会话追加一行：日期 · 做了什么 · 产出/决策。

| 日期 | 内容 |
|---|---|
| 2026-07-03 | 撰写 01-PRD、02-Architecture；确定长期记忆方案（Postgres+pgvector、API 嵌入、两层记忆）；同步 PRD/架构；产出护栏文档集（CLAUDE.md、03–07、.env.example）；建立本进度文件 |
| 2026-07-03 | **M0 完成**：搭建 src 骨架（12 模块）、logger(Pino)、shared 基础类型、dependency-cruiser 依赖矩阵校验、ESLint 禁 env 越界；typecheck/lint/start 三项验收通过 |

---

## 6. 开放问题（Open Questions）

> 尚未决策、需要时再定的事项。清空表示当前无悬而未决。

- （暂无）
