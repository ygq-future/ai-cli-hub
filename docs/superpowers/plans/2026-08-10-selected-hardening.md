# Selected Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加固单管理员 Web 控制面的生产更新、认证、上传、WebSocket、健康检查和 Tailwind 构建链，同时保持用户明确接受的风险取舍。

**Architecture:** Server 继续只依赖 Composition Root 注入的抽象能力；Bun 服务层负责连接与请求硬限制，WebSocket transport 负责信封语义限制，media stager 负责暂存文件生命周期。更新器先完成无副作用检查和暂存构建，最后执行迁移、提升构建产物并重启。

**Tech Stack:** Bun、TypeScript strict、React 19、Vite 8、Tailwind CSS 4、Pino、Postgres/Drizzle、Bun test。

## Global Constraints

- 生产 `/update` 不运行 `bun test`；完整测试只在开发验收执行。
- `http.authToken` 为空时，所有受保护 API、消息接口和 `/ws` 拒绝访问；静态 WebUI 与 health 公开。
- WebSocket：128 KiB payload、64 KiB text、最多 10 个 upload ID、每个标识最多 128 字符、最多 5 个连接。
- 上传：单文件沿用 `media.maxFileBytes`，最多 20 个待发送文件，总量最多 `maxFileBytes × 3`，TTL 15 分钟。
- `/health/live` 为 liveness；`/health/ready` 与 `/health` 为 readiness；只有总体 `down` 返回 503。
- 延期只记录 PDF 漏洞、后端代码模块拆分、WebUI 包拆分。
- 每次代码改动后执行 `bun run format`，任务完成后提交 Git。

---

## File Map

- `vite.config.ts`：注册 Tailwind 插件，并允许更新脚本覆盖构建输出目录。
- `package.json` / `bun.lock`：替换 Tailwind CLI 为 Vite 插件，增加 staged build/promote scripts。
- `scripts/promote-webui.ts`：校验、备份、提升和失败恢复 WebUI 构建产物。
- `src/ops/update.ts`：更新步骤分组和执行顺序。
- `src/ops/update.test.ts`：更新顺序、失败边界和通知降级测试。
- `src/ops/health.ts`：新增结构化 health snapshot。
- `src/server/server.ts`：HTTP body、Origin、连接数、health 与空 Token 边界。
- `src/server/server.test.ts`：Server 请求和 health/Origin 回归。
- `src/media/web-upload-stager.ts`：暂存目录、TTL、配额、原子消费和清理。
- `src/media/web-upload-stager.test.ts`：stager 生命周期测试。
- `src/transport/websocket/websocket-transport.ts`：WebSocket 信封字段限制与审批隔离。
- `src/transport/websocket/websocket-transport.test.ts`：协议边界回归。
- `src/main.ts`：注入 health、server 限额和 stager 生命周期。
- `docs/03-Interface-Contracts.md`、`docs/08-Web-Control-Plane-Task-Book.md`、`README.md`、`PROGRESS.md`：同步契约、部署说明和完成记录。

---

### Task 1: Tailwind Vite 构建链和暂存构建入口

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `vite.config.ts`
- Modify: `test/vite-config.test.ts`

**Interfaces:**

- Produces: `webui:build:staged` 将产物写到仓库根 `.data/update/webui-next`。
- Produces: Vite plugins 同时包含 `tailwindcss()` 与 `react()`。

- [x] **Step 1: 写失败测试**

在 `test/vite-config.test.ts` 断言：

```ts
expect(config).toContain("import tailwindcss from '@tailwindcss/vite'")
expect(config).toContain('plugins: [tailwindcss(), react()]')
expect(pkg.scripts['webui:build:staged']).toBe(
  'vite build --outDir ../../.data/update/webui-next --emptyOutDir',
)
expect(pkg.devDependencies['@tailwindcss/vite']).toBeDefined()
expect(pkg.devDependencies['@tailwindcss/cli']).toBeUndefined()
```

- [x] **Step 2: 验证测试失败**

Run: `bun test test/vite-config.test.ts`

Expected: 缺少 `@tailwindcss/vite` 和 staged build 断言失败。

- [x] **Step 3: 实现 Tailwind Vite 集成**

执行：

```bash
bun remove --dev @tailwindcss/cli
bun add --dev @tailwindcss/vite@^4.3.3
```

`vite.config.ts`：

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/webui/',
  root: 'src/webui',
  publicDir: 'public',
  plugins: [tailwindcss(), react()],
  build: {
    outDir: '../../public/webui',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'assets/app.js', assetFileNames: 'assets/app.[ext]' } },
  },
})
```

向 scripts 增加：

```json
"webui:build:staged": "vite build --outDir ../../.data/update/webui-next --emptyOutDir"
```

- [x] **Step 4: 验证测试和构建**

Run: `bun test test/vite-config.test.ts && bun run webui:build`

Expected: 测试通过；构建日志不再出现 unknown `@theme`/`@tailwind`。

- [x] **Step 5: 格式化并提交**

```bash
bun run format
git add package.json bun.lock vite.config.ts test/vite-config.test.ts
git commit -m "build: wire Tailwind into Vite"
```

### Task 2: WebUI 构建产物安全提升与更新顺序

**Files:**

- Create: `scripts/promote-webui.ts`
- Create: `scripts/promote-webui.test.ts`
- Modify: `package.json`
- Modify: `src/ops/update.ts`
- Modify: `src/ops/update.test.ts`

**Interfaces:**

- Produces: `promoteWebUi({ stagedDir, targetDir, backupDir }): Promise<void>`。
- Produces: `webui:promote` package script。
- Consumes: Task 1 的 `webui:build:staged`。

- [x] **Step 1: 写提升脚本失败测试**

使用临时目录覆盖三种行为：

```ts
test('promotes a validated staged build and removes backup', async () => {
  await writeFixture(targetDir, 'old')
  await writeFixture(stagedDir, 'new')
  await promoteWebUi({ stagedDir, targetDir, backupDir })
  expect(await Bun.file(join(targetDir, 'index.html')).text()).toContain('new')
  expect(await exists(backupDir)).toBe(false)
})

test('rejects a staged build without index and preserves target', async () => {
  await expect(promoteWebUi({ stagedDir, targetDir, backupDir })).rejects.toThrow('index.html')
  expect(await Bun.file(join(targetDir, 'index.html')).text()).toContain('old')
})
```

- [x] **Step 2: 验证提升测试失败**

Run: `bun test scripts/promote-webui.test.ts`

Expected: 模块不存在。

- [x] **Step 3: 实现提升脚本**

使用 `node:fs/promises` 的 `access`、`rename`、`rm`：

```ts
export async function promoteWebUi(input: PromoteWebUiInput): Promise<void> {
  await assertBuild(input.stagedDir)
  await rm(input.backupDir, { recursive: true, force: true })
  const hadTarget = await pathExists(input.targetDir)
  if (hadTarget) await rename(input.targetDir, input.backupDir)
  try {
    await rename(input.stagedDir, input.targetDir)
  } catch (error) {
    if (hadTarget) await rename(input.backupDir, input.targetDir)
    throw error
  }
  await rm(input.backupDir, { recursive: true, force: true })
}
```

直接执行脚本时，以仓库根解析 `.data/update/webui-next`、`public/webui` 和 `.data/update/webui-backup`。package scripts 增加：

```json
"webui:promote": "bun scripts/promote-webui.ts"
```

- [x] **Step 4: 写更新顺序失败测试**

将 `src/ops/update.test.ts` 成功调用顺序更新为：

```ts
expect(calls).toEqual([
  'git status --short',
  'git pull --ff-only',
  'bun install --frozen-lockfile',
  'bun run format:check',
  'bun run typecheck',
  'bun run lint',
  'bun run webui:build:staged',
  'bun run setting:migrate',
  'bun run db:migrate',
  'bun run webui:promote',
])
```

增加通知写入失败仍安排重启并返回警告的测试。

- [x] **Step 5: 验证更新测试失败**

Run: `bun test src/ops/update.test.ts`

Expected: 顺序和通知降级断言失败。

- [x] **Step 6: 实现更新顺序与通知降级**

`createUpdateSteps()` 按上述顺序返回命令。步骤完成后：

```ts
let restartNoticeWarning: string | null = null
if (ref && deps.writeRestartNotice) {
  try {
    await deps.writeRestartNotice(ref)
  } catch (error) {
    restartNoticeWarning = `写入重启通知失败：${errorMessage(error)}`
  }
}
deps.scheduleRestart(...)
return formatUpdateSuccess(results, restart, delayMs, restartNoticeWarning)
```

- [x] **Step 7: 定向验证、格式化并提交**

```bash
bun test scripts/promote-webui.test.ts src/ops/update.test.ts
bun run format
git add package.json scripts/promote-webui.ts scripts/promote-webui.test.ts src/ops/update.ts src/ops/update.test.ts
git commit -m "fix: stage WebUI during self-update"
```

### Task 3: 结构化 health 与空 Token HTTP 边界

**Files:**

- Modify: `src/ops/health.ts`
- Modify: `src/ops/health.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/server.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Produces: `HealthSnapshot { status, uptimeMs, checks }`。
- Produces: `HealthReporter.check(): Promise<HealthSnapshot>`。
- Produces: `AppServerDeps.health?: { ready(): Promise<HealthSnapshot> }`。
- Produces: `AppServerDeps.maxRequestBodyBytes?: number`。

- [x] **Step 1: 写 health snapshot 失败测试**

```ts
const snapshot = await reporter.check()
expect(snapshot).toEqual({
  status: 'degraded',
  uptimeMs: 1000,
  checks: expect.arrayContaining([expect.objectContaining({ name: 'database' })]),
})
expect(await reporter.getReport()).toContain('部分降级')
```

- [x] **Step 2: 实现结构化 snapshot**

`HealthReporter` 增加 `check()`；`getReport()` 调用同一个内部 `runChecks()`，避免重复规则。导出：

```ts
export interface HealthSnapshot {
  status: HealthStatus
  uptimeMs: number
  checks: HealthCheckResult[]
}
```

- [x] **Step 3: 写 server 失败测试**

增加以下断言：

```ts
expect((await emptyToken.handler(messageRequest('/api/platform-msg', body))).status).toBe(401)
expect((await handler(request('/health/live'))).status).toBe(200)
expect((await handler(request('/health/ready'))).status).toBe(503)
expect((await handler(request('/health'))).status).toBe(503)
```

ready mock 返回 `down`；另测 `degraded` 返回 200。

- [x] **Step 4: 实现认证和 health 路由**

将授权入口改为：

```ts
function isAuthorized(request: Request, authToken: string, now: number): boolean {
  if (!authToken) return false
  if (hasBearerToken(request, authToken)) return true
  const session = readCookie(request.headers.get('cookie'), 'ai_cli_hub_session')
  return session ? verifySession(session, authToken, now) : false
}
```

health 路由：

```ts
if (request.method === 'GET' && url.pathname === '/health/live') return json({ status: 'ok' })
if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/health/ready')) {
  if (!deps.health) return json({ status: 'down', error: 'Health readiness is not configured' }, 503)
  const snapshot = await deps.health.ready()
  return json(snapshot, snapshot.status === 'down' ? 503 : 200)
}
```

在 `Bun.serve` 注入 `maxRequestBodySize: deps.maxRequestBodyBytes`。上传 handler 在 `formData()` 前检查 Content-Length 并返回 413。

- [x] **Step 5: Composition Root 注入**

```ts
maxRequestBodyBytes: config.MEDIA_MAX_FILE_BYTES + 1024 * 1024,
health: { ready: health.check },
```

- [x] **Step 6: 定向验证、格式化并提交**

```bash
bun test src/ops/health.test.ts src/server/server.test.ts
bun run format
git add src/ops/health.ts src/ops/health.test.ts src/server/server.ts src/server/server.test.ts src/main.ts
git commit -m "fix: enforce HTTP auth and readiness checks"
```

### Task 4: Web 上传暂存生命周期和配额

**Files:**

- Modify: `src/media/web-upload-stager.ts`
- Create: `src/media/web-upload-stager.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Produces: `WebUploadStager.initialize(): Promise<void>`。
- Produces: `WebUploadStager.dispose(): Promise<void>`。
- Consumes: `{ directory, maxBytes, maxFiles?: 20, maxTotalBytes?: maxBytes * 3, ttlMs?: 900_000, now?: () => number }`。

- [ ] **Step 1: 写 stager 失败测试**

使用临时目录和可控 `now` 覆盖：

```ts
await stager.initialize()
const staged = await stager.stage(new File(['abc'], '../photo.png', { type: 'image/png' }))
expect(staged.name).toBe('photo.png')
expect(stagedPath).toContain(`${sep}.staging${sep}`)

now += 900_001
await expect(stager.consume([staged.id])).rejects.toThrow('unavailable')

await expect(stageBeyondCount()).rejects.toThrow('Too many staged uploads')
await expect(stageBeyondBytes()).rejects.toThrow('staged upload size limit')
```

另测 consume 成功后文件从 `.staging` 移到正式目录，并且数组中任一 ID 缺失时不移动任何文件。

- [ ] **Step 2: 验证测试失败**

Run: `bun test src/media/web-upload-stager.test.ts`

Expected: 生命周期接口和配额行为不存在。

- [ ] **Step 3: 实现 stager**

Map value 增加 `expiresAt` 与 `stagedPath`。`initialize()` 创建目录并清空 `.staging`。`cleanupExpired()` 删除到期文件并更新 total bytes。`consume()` 先完整验证全部 ID，再逐个 rename 到正式目录，最后从 Map 删除并返回更新后的 attachment。

`dispose()` 清理计时器；不删除已消费的正式文件。后台计时器每 `min(ttlMs, 60_000)` 清理，并调用 `unref()` 防止阻止进程退出。

- [ ] **Step 4: Composition Root 生命周期接入**

创建后执行 `await webUploads.initialize()`；graceful shutdown 中调用 `await webUploads.dispose()`。

- [ ] **Step 5: 定向验证、格式化并提交**

```bash
bun test src/media/web-upload-stager.test.ts src/server/server.test.ts
bun run format
git add src/media/web-upload-stager.ts src/media/web-upload-stager.test.ts src/main.ts
git commit -m "fix: bound staged web uploads"
```

### Task 5: WebSocket 服务层和协议层限制

**Files:**

- Modify: `src/server/server.ts`
- Modify: `src/server/server.test.ts`
- Modify: `src/transport/websocket/websocket-transport.ts`
- Modify: `src/transport/websocket/websocket-transport.test.ts`
- Modify: `src/main.ts`

**Interfaces:**

- Produces: `createWebSocketGateway({ maxPeers?: number })`，默认 5。
- Produces: WebSocket gateway `add(peer): boolean`，满员返回 false 并关闭 peer。
- Produces: `isAllowedWebSocketOrigin(request): boolean` server 内部校验。

- [ ] **Step 1: 写 Origin、连接数和 payload 配置失败测试**

Server handler 测试：

```ts
expect((await handler(wsRequest({ origin: 'https://evil.example', host: 'hub.example' }))).status).toBe(403)
expect(upgradedSameOrigin).toBe(true)
expect(upgradedForwardedHost).toBe(true)
```

Gateway 测试创建 6 个 peer，断言第 6 个被 close 且只前 5 个收到广播。

- [ ] **Step 2: 实现服务层限制**

`Bun.serve.websocket` 增加：

```ts
maxPayloadLength: 128 * 1024,
backpressureLimit: 256 * 1024,
closeOnBackpressureLimit: true,
```

`/ws` 在授权后检查 Origin。解析 `Origin`、`Host` 和逗号分隔的 `X-Forwarded-Host`，比较小写 host（含显式端口）；缺失或非法 Origin 返回 403。

Gateway broadcast 对每个 peer 单独 try/catch，失败 peer 从集合移除并关闭。

- [ ] **Step 3: 写 transport 字段限制和审批隔离失败测试**

```ts
gateway.receive(peer, JSON.stringify({ v: 1, type: 'message', text: 'x'.repeat(64 * 1024 + 1) }))
expect(lastEnvelope()).toMatchObject({ type: 'error', code: 'message_too_large' })

gateway.receive(peer, JSON.stringify({ v: 1, type: 'message', text: 'x', uploadIds: ids(11) }))
expect(lastEnvelope()).toMatchObject({ type: 'error', code: 'too_many_uploads' })

gateway.receive(peer, JSON.stringify({ v: 1, type: 'approve', conversationId: 'unknown', approvalId: 'a1' }))
expect(approved).toEqual([])
expect(lastEnvelope()).toMatchObject({ code: 'conversation_unavailable' })
```

- [ ] **Step 4: 实现协议验证**

在解析 JSON 后、调用 upload resolver/EventBus 前集中验证：

```ts
const MAX_TEXT_CHARS = 64 * 1024
const MAX_UPLOAD_IDS = 10
const MAX_IDENTIFIER_CHARS = 128
```

非字符串 uploadIds 不再静默降级为空数组，而是 `invalid_upload_ids`。所有越界分支通过统一 `sendError(peer, code)` 返回并结束。审批分支先验证 `conversations.has(conversationId)`。

- [ ] **Step 5: 定向验证、格式化并提交**

```bash
bun test src/server/server.test.ts src/transport/websocket/websocket-transport.test.ts
bun run format
git add src/server/server.ts src/server/server.test.ts src/transport/websocket/websocket-transport.ts src/transport/websocket/websocket-transport.test.ts src/main.ts
git commit -m "fix: bound and isolate WebSocket clients"
```

### Task 6: 文档、完整验收和最终进度

**Files:**

- Modify: `README.md`
- Modify: `docs/03-Interface-Contracts.md`
- Modify: `docs/08-Web-Control-Plane-Task-Book.md`
- Modify: `PROGRESS.md`

**Interfaces:**

- Documents: 空 Token 401、live/readiness、WS/上传边界、staged update 和延期项。

- [ ] **Step 1: 更新接口与部署文档**

明确：

- `http.authToken` 是启用受保护 HTTP/WebSocket 能力的必需配置。
- Nginx Proxy Manager 必须转发 `Host`、`X-Forwarded-Host` 和 WebSocket Upgrade。
- health 三个路径的状态码语义。
- `/update` 使用暂存 WebUI且不运行生产测试。
- 上传和 WS 的固定边界。

- [ ] **Step 2: 运行完整格式化和静态检查**

```bash
bun run format
bun run format:check
bun run typecheck
bun run lint
```

Expected: 全部退出 0。

- [ ] **Step 3: 运行生产构建和完整测试**

```bash
bun run webui:build
bun test
```

Expected: 构建无 unknown Tailwind rules；已有测试与新增测试全部通过，Postgres 集成测试在无 `TEST_DATABASE_URL` 时保持已知 skip。

- [ ] **Step 4: 检查差异和延期范围**

```bash
git diff --check
git status --short
rg -n "PDF|代码模块拆分|前端包拆分" PROGRESS.md
```

确认没有把日志、并发会话或 CI 写成延期任务。

- [ ] **Step 5: 同步 PROGRESS 并提交**

在 PROGRESS Changelog 记录实现内容、测试计数与构建结果，然后：

```bash
git add README.md docs/03-Interface-Contracts.md docs/08-Web-Control-Plane-Task-Book.md PROGRESS.md
git commit -m "docs: document hardened web control plane"
```

- [ ] **Step 6: 最终仓库验收**

```bash
git status --short
git log -6 --oneline
```

Expected: 工作区干净，提交按 Task 1–6 清晰分组。
