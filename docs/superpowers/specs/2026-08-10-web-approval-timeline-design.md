# Web 审批状态与消息时间线设计

> 日期：2026-08-10
> 状态：用户已确认设计，待书面审阅

## 1. 目标

修复 Web 自动审批完成后卡片仍保持可操作、被后续回复推到末尾、重复点击无明确反馈的问题，并让审批记录跟随聊天历史分页恢复。

本设计只改变 Web 展示和通用审批审计结构：Telegram/QQ 继续使用平台原生消息历史与卡片更新，不读取 Hub 的 Web 时间线。

## 2. 已确认根因

- Orchestrator 会正常发出自动 `ApprovalApproved`，自动审批本身没有丢事件。
- WebSocket Transport 只转发 `ApprovalRequested`，没有转发 `ApprovalApproved` / `ApprovalRejected`。
- React 分别维护 `messages[]` 与 `approvals[]`，并固定把全部审批渲染在全部消息之后；任何新回复都会让旧审批卡移动到回复后面。
- WebUI 只有本地点击时才删除审批；自动决议不会更新卡片。
- 重复决议虽然被 Orchestrator 幂等忽略，但 WebSocket 没有返回已有终态。
- `audit_logs.command` 当前把 command、approvalId、detail 拼成多行文本，不适合稳定查询和结构化展示。

## 3. 不做的事情

- 不实现 messages 与 audit_logs 的双表统一游标。
- 不把审批引用序列化进 `messages.content`。
- 不让审批消息进入 CLI 上下文、记忆摘要或附件处理。
- 不改变 Telegram/QQ 的审批卡、回调或历史行为。
- 不在本轮实施已延期的 WebUI/Bun 代码拆分。

## 4. 数据模型

### 4.1 `audit_logs`

`0018` 迁移清空旧 `audit_logs` 后，将审批审计改为生命周期记录：

```ts
interface ApprovalAuditRequest {
  command: string
  detail: JsonValue
}

interface AuditLog {
  id: string
  conversationId: ConversationId
  approvalId: string
  request: ApprovalAuditRequest
  status: 'pending' | 'approved' | 'rejected'
  operator: string | null
  automatic: boolean
  createdAt: number
}
```

- `request` 使用 JSONB。`command` 是卡片标题中的工具名，例如 `Bash`；`detail` 若是合法 JSON 则保存解析后的对象，否则保存原始字符串，保证信息不丢失。
- `createdAt` 是审批请求创建时间，也是时间线排序时间；不增加 `requestedAt` 或 `resolvedAt`。
- `status=pending` 时 `operator=null`、`automatic=false`。
- 自动批准更新为 `approved`、`automatic=true`；手动批准或拒绝保留 `automatic=false` 并写入 operator。
- 删除现有 packed `command` 字段和旧 `action` 结构，改用明确的 status。
- 旧审计数据不迁移。`0018` 是一次明确批准的破坏性清理；迁移完成后 Repository 仍不暴露 delete，新的审计继续永久保留。
- 保留 conversation 外键和 `(conversation_id, created_at)` 查询索引，并增加 `(conversation_id, approval_id)` 唯一约束，保证同一审批只存在一个生命周期记录。

### 4.2 `messages`

为消息增加：

```ts
messageType: 'chat' | 'approval'
auditLogId: string | null
```

- 现有消息迁移后均为 `messageType=chat`、`auditLogId=null`。
- Web 审批请求创建一条 `messageType=approval` 的消息，`auditLogId` 指向对应 audit_logs.id。
- 审批消息使用 `role=assistant`、空 `content`、空附件、`contextEligible=false`，因此不会进入 CLI 上下文或记忆。
- `auditLogId` 使用 nullable 外键，并建立非空唯一索引，保证一个审计记录最多对应一条时间线消息。
- `/clear` 删除消息引用后，审批不再出现在聊天时间线，但 audit_logs 仍保留并可由 `/audit` 查看。

## 5. 持久化流程

### 5.1 请求审批

1. Orchestrator 发出 `ApprovalRequested`，payload 增加 `createdAt`。
2. ApprovalAudit 为该 approvalId 生成 audit ID，并解析 detail。
3. ApprovalAudit 查询 conversation 的 platform。
4. AuditRepository 在一个数据库事务中插入 pending audit；若 platform 为 `web`，同时插入引用该 audit 的 approval message。
5. Telegram/QQ/WebSocket 仍从 `ApprovalRequested` 实时展示卡片，不等待数据库写入，审计失败不会阻塞 Tool Approval 主链路。

ApprovalAudit 为每个 `(conversationId, approvalId)` 保留创建 Promise；决议到达时先等待创建完成，避免快速自动审批造成 update 早于 insert。

### 5.2 审批决议

1. 手动或自动流程发出 `ApprovalApproved` / `ApprovalRejected`。
2. Orchestrator 保持既有幂等处理并决议 Adapter。
3. ApprovalAudit 将对应 audit 更新为终态、operator 和 automatic。
4. WebSocket Transport 同步把原始决议转换为 `approval_resolved` 下行事件；实时 UI 不依赖审计写入成功才更新。

若决议事件没有对应 pending 记录，Audit 模块记录可诊断错误，不伪造缺少请求详情的新审计；Tool Approval 主链路仍不被阻塞。

## 6. WebSocket 与幂等反馈

WebSocket 下行新增：

```ts
{
  v: 1
  type: 'approval_resolved'
  conversationId: string
  approvalId: string
  status: 'approved' | 'rejected'
  operator: string
  automatic: boolean
}
```

- WebSocket Transport 维护当前进程观察到的 Web 审批终态。
- 收到决议事件后立即发送 `approval_resolved`，包括自动批准。
- 用户点击允许/拒绝后，前端只将按钮置为 resolving，等待服务端事件，不自行删除卡片。
- 若客户端对已终态 approvalId 再次操作，Transport 不再 emit 决议，而是重发已有 `approval_resolved`；前端显示“此次审批已处理”的轻量提示。
- 未知或非 Web 会话继续返回既有稳定错误，不放宽平台隔离。

## 7. Web 历史与分页

`GET /api/web/history` 继续只对 messages 做游标分页，默认最新 10 条、最大 50 条，游标格式和向上加载语义不变。

响应中的时间线项目使用明确的判别联合，不再让前端从空 content 猜测类型：

```ts
type WebTimelineItem =
  | {
      type: 'chat'
      id: string
      role: 'user' | 'assistant'
      content: string
      attachments: StoredMessageAttachment[]
      createdAt: number
    }
  | {
      type: 'approval'
      id: string // message id，继续作为分页稳定键
      createdAt: number
      approval: AuditLog | null
    }
```

`approval=null` 只表示引用损坏或详情不可用；正常的 pending/approved/rejected 都通过 AuditLog.status 表达。

一页 messages 查询完成后：

1. 收集 `messageType=approval` 的 auditLogId。
2. 通过 `AuditRepository.findByIds(ids)` 单次批量读取审批详情。
3. 将每条消息映射为 `chat` 或 `approval` DTO，保持 messages 的原始顺序。
4. 缺失 audit 详情的引用返回可见的“审批记录不可用”终态，不使整页历史失败，并发出结构化错误日志。

该方案没有双表合并、没有 N+1，也不会改变现有分页数量：审批卡本身占用一个时间线项目。

## 8. React 时间线

- 使用单一 timeline state，item 为 chat message 或 approval card。
- pending 审批按 `approvalId` 插入到收到事件时的位置；后续回复自然追加在其后。
- `approval_resolved` 按 approvalId 就地更新 status/operator/automatic，不改变数组位置。
- 页面先建立 WebSocket，并在首屏 history 加载期间缓冲实时 timeline 事件；history 返回后按 messageId、clientMessageId 和 approvalId 合并去重，再按服务端 createdAt 与到达顺序稳定排列。这样既不会重复，也不会漏掉 history 请求与 WebSocket 建连之间的新消息或审批。
- 历史审批由 message.createdAt 排序恢复；实时 approval 使用 `ApprovalRequested.createdAt`，历史合并后仍停留在同一时间位置。
- pending 卡显示允许/拒绝；resolving 禁用按钮；approved/rejected 显示不可操作终态。
- 自动批准明确显示“已自动批准”，手动状态显示“已批准/已拒绝 · operator”。
- 终态卡片保留命令、说明和必要详情，视觉密度低于 pending 卡，但不折叠掉关键审计信息。

## 9. `/audit` 输出

`/audit [conversationId]` 改为读取结构化字段，不再解析 packed command：

- 工具：`request.command`
- 命令/参数与说明：格式化 `request.detail`
- 状态：等待审批、已批准、已拒绝
- 方式：自动或手动
- 操作人：operator；pending 显示 `—`
- 时间：createdAt

仍展示最近 10 条，Telegram/QQ/Web 的命令回复行为不变。

## 10. 错误处理

- audit/message 原子插入失败：发 `ErrorOccurred`，不阻塞 Adapter 等待和 Transport 实时卡片。
- audit 终态更新失败：发 `ErrorOccurred`，实时 Web 卡仍按 EventBus 决议更新；刷新后可能显示 pending，日志保留可诊断原因。
- history 批量详情缺失：单卡降级，不让整页 500。
- detail 不是合法 JSON：作为字符串保存，不拒绝审批请求。
- 重复决议：Orchestrator 与 WebSocket Transport 双层幂等，不重复调用 Adapter。

## 11. 测试与验收

### 后端

- schema/migration：0018 清空旧 audit、重建结构、messages 新字段/外键/唯一索引和 journal 登记。
- ApprovalAudit：pending 创建、Web 原子时间线消息、非 Web 不创建消息、手动/自动终态、快速决议等待创建、失败不阻塞。
- AuditRepository：按 IDs 批量读取、终态更新幂等、事务回滚。
- Web history：chat/approval 同页排序、只按 messages 分页、批量详情、缺失详情降级。
- WebSocket：自动批准/手动批准/拒绝下行、重复点击返回既有终态、未知会话拒绝。
- `/audit`：结构化 request、pending、automatic、operator 格式化。

### WebUI

- 消息与审批按单一时间线渲染。
- 回复到达后审批位置不移动。
- 自动决议就地变为“已自动批准”且按钮消失。
- 点击后进入 resolving，服务端确认后终态；重复/竞态反馈“已处理”。
- 刷新、首屏 10 条和向上分页恢复审批卡。

### 完整验收

执行 `bun run format`、`bun run format:check`、`bun run typecheck`、`bun run lint`、`bun run webui:build` 和 `bun test`。生产构建允许保留已延期的 chunk 大小提示，但不得出现新警告或测试回归。
