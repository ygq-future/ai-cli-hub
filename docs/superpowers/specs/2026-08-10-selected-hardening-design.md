# 已选生产边界加固设计

日期：2026-08-10

## 1. 目标与范围

本轮只处理已经确认适合单管理员私人项目的改进：

1. 调整 `/update` 的执行顺序，并把 WebUI 改为暂存构建后再切换。
2. `http.authToken` 为空时拒绝所有受保护 API、消息接口和 WebSocket。
3. 为 HTTP 上传和 WebSocket 增加明确的资源边界及同源校验。
4. 拆分 liveness/readiness 健康端点。
5. 正确接入 Tailwind CSS v4 的 Vite 插件。
6. 限制 WebSocket 审批只能作用于 Web transport 已知会话。

## 2. 明确不做

以下事项经过评估后不纳入本轮，也不登记为延期任务：

- 不修改私人服务器上的消息/审批日志策略。
- 不处理首条消息并发创建会话的竞争条件。
- 不把 `bun test`、Postgres 集成测试或 CI 加入生产 `/update` 流程。

只保留以下延期项：

- PDF 进程内解析依赖的已知安全漏洞。
- 后端大型源码文件的模块拆分。
- WebUI 前端包拆分和按需加载。

## 3. 自更新流程

### 3.1 方案

采用“暂存构建 + 最后切换”，不引入版本目录、符号链接发布系统或完整自动回滚平台。

执行顺序：

1. 可选的干净工作树检查。
2. `git pull --ff-only`。
3. `bun install --frozen-lockfile`。
4. `bun run format:check`。
5. `bun run typecheck`。
6. `bun run lint`。
7. 把 WebUI 构建到 `.data/update/webui-next`。
8. `bun run setting:migrate`。
9. `bun run db:migrate`。
10. 将暂存 WebUI 提升为 `public/webui`。
11. 写入重启通知并安排 PM2/systemd 重启。

生产更新不运行 `bun test`。完整测试仍是开发改动提交前的验收要求。

### 3.2 WebUI 提升

新增受控提升脚本：

- 校验暂存目录至少包含 `index.html` 与 `assets/`。
- 将现有 `public/webui` 移到同文件系统备份目录。
- 将暂存目录移动到 `public/webui`。
- 第二步失败时恢复原目录。
- 成功后删除备份目录。

构建、格式、类型或 lint 失败时，不接触正式 WebUI。配置或数据库迁移失败时，也不提升 WebUI。数据库迁移必须继续保持向后兼容，因为旧进程会运行到重启发生。

重启通知写入属于辅助能力：若 WebUI 已提升但通知写入失败，仍然安排重启，并在当前命令回复中明确警告通知可能缺失，避免让旧后端长期服务新前端。

## 4. HTTP 认证与请求体

### 4.1 空 Token

`isAuthorized()` 在 `authToken` 为空时始终返回 false。行为如下：

- `/api/platform-msg`、`/api/session-msg`：401。
- `/api/web/*`、`/api/settings`、`/api/restart`：401。
- `/ws`：401。
- `/api/auth/session`：保留当前 503，明确说明管理员尚未配置 Token。
- WebUI 静态文件和健康端点保持公开，便于显示登录页和外部探针访问。

### 4.2 请求体上限

在 `Bun.serve` 设置 `maxRequestBodySize`，值为 `media.maxFileBytes + 1 MiB multipart 开销`。消息 JSON 继续保留现有 1 MiB 业务层限制。上传处理器还会依据 `Content-Length` 提前返回 413；无该请求头时由 Bun 服务层硬限制兜底。

## 5. 上传暂存生命周期

Web 上传先写入 `MEDIA_DOWNLOAD_DIR/.staging`，不再直接混入持久会话文件目录。

默认边界：

- 单文件：沿用 `media.maxFileBytes`。
- 待发送文件数：最多 20 个。
- 待发送总大小：最多 `media.maxFileBytes × 3`。
- 暂存有效期：15 分钟。

stager 在启动时清理 `.staging` 中的旧孤儿文件，并在 stage/consume 时清除到期项。消费上传时把文件移动到正式媒体目录，再生成 `InboundAttachment`；服务关闭时停止清理计时器。重复 ID、过期 ID或超限请求返回明确错误，不部分消费一组上传。

## 6. WebSocket 边界

### 6.1 Bun 服务层

- `maxPayloadLength`：128 KiB。
- `idleTimeout`：保留 Bun 默认或当前行为，不主动缩短长会话。
- 最大已认证连接数：5；超过限制的连接关闭。
- 单 peer 发送异常或达到背压限制时隔离该 peer，不影响其余连接。

### 6.2 协议层

- 消息文本最大 64 KiB。
- 单条消息最多 10 个 upload ID。
- upload ID、clientMessageId、approvalId、conversationId 每项最大 128 字符。
- 越界输入返回稳定的 WebSocket error code，不进入 EventBus。

### 6.3 Origin 与审批隔离

WebSocket upgrade 要求浏览器 `Origin` 的 host 与请求 `Host` 或可信反代传入的 `X-Forwarded-Host` 一致。Nginx Proxy Manager 的同源 WebUI可正常连接；跨站浏览器页面即使能携带 Cookie也不能建立连接。

approve/reject 只有在 `conversationId` 位于当前 Web transport 的已知会话集合时才发出审批事件，否则返回 `conversation_unavailable`。

## 7. 健康检查

新增结构化健康结果，不从 Markdown 报告反向解析：

- `GET /health/live`：进程正在接收请求即返回 200 和 `{ "status": "ok" }`。
- `GET /health/ready`：执行数据库、媒体目录和 CLI 检查。
- `GET /health`：兼容映射到 readiness。

readiness 返回结构化 `status`、`uptimeMs` 和 `checks`。总体 `down` 返回 503；`ok` 或 `degraded` 返回 200，以免未启用的非关键 CLI 让服务被错误摘除。

health 能力由 Composition Root 注入 server；server 不直接依赖数据库、repository 或具体 CLI。

## 8. Tailwind 构建链

按照 Tailwind CSS v4 官方 Vite 方式：

- 增加 `@tailwindcss/vite` 开发依赖。
- 在 `vite.config.ts` 注册 `tailwindcss()`，与 React 插件共同运行。
- 保留 `react.css` 的 `@import "tailwindcss"`。
- 保留 `prettier-plugin-tailwindcss`。
- 删除不再使用的 `@tailwindcss/cli`。

验收要求是构建产物不再残留未处理的 `@tailwind`/`@theme` 警告，并且现有自定义 `ui-*` 样式和响应式界面不回归。

## 9. 错误处理与测试

实现前先增加失败回归：

- 空 Token 的消息 API 和 WebSocket 返回 401。
- health live/ready 状态码和结构化内容。
- 更新步骤顺序、暂存构建、失败不提升、通知失败仍重启。
- 上传数量、总容量、TTL、消费移动和孤儿清理。
- WebSocket 帧内字段限制、Origin、连接数和审批会话隔离。
- Vite 配置包含 Tailwind 第一方插件，生产构建无未知规则警告。

最终执行 `bun run format`、`bun run format:check`、`bun run typecheck`、`bun run lint`、`bun run webui:build` 和完整 `bun test`。测试仍是开发验收，不会被加入生产 `/update` 命令。

## 10. 文档与交付

同步接口契约、Web Control Plane 任务书、README 中的认证/健康/反代说明，以及 `PROGRESS.md` 的决策、延期项和验收记录。完成后提交一个范围明确的 Git commit。
