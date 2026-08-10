# Web Approval Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist structured approval lifecycle records and render Web approvals in their original message-timeline position with reliable realtime terminal-state updates.

**Architecture:** `ApprovalRequested` creates one structured `audit_logs` lifecycle row and, only for Web conversations, one `messages` reference row in a repository transaction. Web history continues paging only `messages`, batch-hydrates audit references, and React renders one discriminated timeline while WebSocket terminal events update approval cards in place.

**Tech Stack:** Bun, strict TypeScript, Postgres, Drizzle ORM, typed EventBus, React 19, Tailwind/CSS, Bun test.

## Global Constraints

- Keep `src/main.ts` as the only Composition Root and preserve the existing dependency matrix.
- All SQL/Drizzle operations remain inside `repository/` and `storage/`.
- Approval persistence must never block the adapter approval path; failures emit `ErrorOccurred`.
- Telegram and QQ approval behavior must remain unchanged.
- Slash commands and their replies remain excluded from `messages`; approval reference rows are not slash-command history.
- Approval reference messages use `contextEligible=false`, empty content, and no attachments.
- Migration `0018` intentionally clears legacy `audit_logs`; runtime repositories still expose no delete API.
- Web history keeps the existing message cursor, default page size 10, and maximum 50.
- Use Bun commands only, run `bun run format` after edits, and update `PROGRESS.md` before completion.

---

### Task 1: Structured schema and destructive migration

**Files:**
- Modify: `src/shared/types/common.ts`
- Modify: `src/storage/schema/enums.ts`
- Modify: `src/storage/schema/audit-logs.ts`
- Modify: `src/storage/schema/messages.ts`
- Modify: `src/storage/schema.test.ts`
- Create: `drizzle/0018_structured_approval_timeline.sql`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `JsonValue`, `ApprovalAuditRequest`, `approvalStatusEnum`, `messageTypeEnum`, structured `AuditLog`, and Message fields `messageType`/`auditLogId`.
- Database invariant: `(conversation_id, approval_id)` is unique; every non-null `messages.audit_log_id` is unique and references `audit_logs.id`.

- [ ] **Step 1: Write failing schema and migration tests**

Assert the exact columns, enums, indexes, nullable operator, audit foreign key, message defaults, and migration SQL ordering. The migration test must verify it clears audit rows before dropping packed columns and that it drops `approval_action` only after dropping `action`.

```ts
expect(auditColumns).toEqual(
  expect.arrayContaining(['approval_id', 'request', 'status', 'operator', 'automatic', 'created_at']),
)
expect(auditColumns).not.toContain('command')
expect(messageColumns).toEqual(expect.arrayContaining(['message_type', 'audit_log_id']))
expect(migration.indexOf('DELETE FROM "audit_logs"')).toBeLessThan(migration.indexOf('DROP COLUMN "command"'))
```

- [ ] **Step 2: Run the schema test and confirm RED**

Run: `bun test src/storage/schema.test.ts`

Expected: FAIL because structured columns and `0018` do not exist.

- [ ] **Step 3: Implement types, Drizzle schema, SQL migration, and journal entry**

Use these domain shapes:

```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export interface ApprovalAuditRequest {
  command: string
  detail: JsonValue
}
```

Create `approval_status = pending|approved|rejected` and `message_type = chat|approval`. Add `message_type NOT NULL DEFAULT 'chat'` and nullable `audit_log_id`; clear audit rows, replace packed columns, add constraints/indexes, then drop `approval_action`.

- [ ] **Step 4: Run schema tests and format**

Run: `bun run format && bun test src/storage/schema.test.ts`

Expected: PASS.

---

### Task 2: Audit repository lifecycle and atomic Web reference insertion

**Files:**
- Modify: `src/repository/types.ts`
- Modify: `src/repository/audit-repository.ts`
- Modify: `test/repository.integration.test.ts`

**Interfaces:**
- Consumes: structured `AuditLog`, `NewAuditLog`, `NewMessage` from Task 1.
- Produces:

```ts
interface AuditRepository {
  createPending(audit: NewAuditLog, timelineMessage?: NewMessage): Promise<void>
  resolve(input: {
    conversationId: ConversationId
    approvalId: string
    status: 'approved' | 'rejected'
    operator: string
    automatic: boolean
  }): Promise<AuditLog | null>
  findByIds(ids: readonly string[]): Promise<AuditLog[]>
  listByConversation(id: ConversationId): Promise<AuditLog[]>
}
```

- [ ] **Step 1: Rewrite repository integration expectations**

Cover pending insertion, optional approval message insertion in the same transaction, batch lookup, terminal update, and second terminal update returning the existing terminal record without changing it.

- [ ] **Step 2: Run the integration test when configured**

Run: `bun test test/repository.integration.test.ts`

Expected: FAIL when `TEST_DATABASE_URL` exists; otherwise the suite reports skipped and typecheck later remains the enforcement path.

- [ ] **Step 3: Implement repository methods**

Use `db.transaction()` for `createPending`; insert audit first, then optional message. Use a conditional `UPDATE ... WHERE status='pending' RETURNING`, followed by a lookup when no row changed so duplicate resolution is idempotent. Return `[]` immediately for an empty `findByIds` input.

- [ ] **Step 4: Run repository/schema tests**

Run: `bun test src/storage/schema.test.ts test/repository.integration.test.ts`

Expected: schema PASS; integration PASS or configured skip.

---

### Task 3: Event timestamp and approval audit lifecycle

**Files:**
- Modify: `src/event/event-map.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/orchestrator.test.ts`
- Modify: `src/audit/approval-audit.ts`
- Modify: `src/audit/approval-audit.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- `ApprovalRequested` adds required `createdAt: number`.
- `createApprovalAudit` consumes `AuditRepository` and `ConversationRepository`.
- Request detail parsing returns parsed JSON for valid JSON and the original string otherwise.

- [ ] **Step 1: Add failing event/audit tests**

Cover required stable `createdAt`, structured pending creation, Web-only timeline message, non-Web audit without message, valid/invalid JSON detail, manual and automatic terminal status, fast decision waiting for pending creation, and error emission without rejection.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bun test src/audit/approval-audit.test.ts src/orchestrator.test.ts`

Expected: FAIL on old `record` calls and missing timestamp.

- [ ] **Step 3: Implement event production and audit subscriptions**

Capture one `const createdAt = Date.now()` for every approval request and include it whether auto approval is configured or not. In ApprovalAudit, keep `Map<string, Promise<void>>` creation tasks; decision handlers await the matching task before `resolve`, report missing rows, and always clean the map.

- [ ] **Step 4: Inject both repositories and run focused tests**

Pass `repos.conversations` at the Composition Root. Run: `bun test src/audit/approval-audit.test.ts src/orchestrator.test.ts`

Expected: PASS.

---

### Task 4: WebSocket terminal state and structured `/audit`

**Files:**
- Modify: `src/transport/websocket/websocket-transport.ts`
- Modify: `src/transport/websocket/websocket-transport.test.ts`
- Modify: `src/core/commands.ts`
- Modify: `src/core/session-manager.test.ts`

**Interfaces:**
- Produces WebSocket envelope:

```ts
type ApprovalResolvedEnvelope = {
  v: 1
  type: 'approval_resolved'
  conversationId: string
  approvalId: string
  status: 'approved' | 'rejected'
  operator: string
  automatic: boolean
  alreadyHandled?: boolean
}
```

- [ ] **Step 1: Add failing WebSocket and `/audit` tests**

Assert approved/rejected/automatic events are sent only for remembered Web conversations; duplicate client actions re-send terminal state with `alreadyHandled=true` and do not emit another EventBus decision. Assert `/audit` prints command, structured detail, pending/approved/rejected, automatic/manual, operator, and created time without parsing packed text.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bun test src/transport/websocket/websocket-transport.test.ts src/core/session-manager.test.ts`

- [ ] **Step 3: Implement terminal map, event subscriptions, and formatter**

Store terminal envelopes by `conversationId:approvalId`. Automatic is `payload.automatic === true`; rejection is always false. Keep terminal cards in history and format `request.detail` with stable JSON pretty-printing or the original string.

- [ ] **Step 4: Run focused tests**

Run the WebSocket and actual command test files. Expected: PASS.

---

### Task 5: History hydration through message references

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/server.test.ts`
- Modify: `src/main.ts`
- Add or modify Composition Root tests that cover `webHistory.get`.

**Interfaces:**
- `WebHistoryMessage` becomes a discriminated `WebTimelineItem` union with `type='chat'|'approval'`.
- The response property remains `messages` for API compatibility; each item carries the source message `id` and `createdAt`.

- [ ] **Step 1: Add failing API and mapping tests**

Cover a mixed page preserving message order, one batched `findByIds`, terminal/pending hydration, null audit fallback, unchanged cursor, and no N+1 lookup.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `bun test src/server/server.test.ts`

Expected: FAIL because the DTO only accepts chat messages.

- [ ] **Step 3: Implement discriminated DTO and Composition Root mapping**

Collect non-null audit IDs from the selected message page, create an ID map from one `findByIds` call, and map each row without reordering. Emit `ErrorOccurred` for missing audit records but return `approval: null` instead of failing the page.

- [ ] **Step 4: Run server and relevant mapping tests**

Run: `bun test src/server/server.test.ts src/storage/schema.test.ts`

Expected: PASS.

---

### Task 6: React single timeline and in-place approval cards

**Files:**
- Modify: `src/webui/main.tsx`
- Modify: `src/webui/react.css`

**Interfaces:**
- `TimelineItem = ChatTimelineItem | ApprovalTimelineItem` is the only chat-feed state.
- Approval status is `pending|resolving|approved|rejected|unavailable`.
- Reconciliation keys are chat `id`/`clientMessageId` and approval `approvalId`.

- [ ] **Step 1: Replace local types and state with a discriminated timeline**

Hydrate history approvals, use `approval:<approvalId>` for realtime temporary IDs, preserve the source message ID when history exists, and render items in one `.map()`.

- [ ] **Step 2: Connect WebSocket before first history request and buffer timeline events**

Buffer `output`, `user_message`, `approval`, and `approval_resolved` until the first history request settles. Apply history first, replay the buffer in arrival order, and deduplicate approvals by approvalId so the history/network gap cannot lose or duplicate cards.

- [ ] **Step 3: Implement decision and terminal UI behavior**

Client clicks set `resolving` and disable buttons; only `approval_resolved` makes a terminal card. `alreadyHandled` shows the existing error/toast surface with “此次审批已处理 / This approval was already handled”. Automatic approvals show explicit copy. Missing history audit renders a noninteractive unavailable card.

- [ ] **Step 4: Update card styling and scrolling dependencies**

Keep pending cards visually prominent; terminal cards use lower emphasis but retain command/detail/operator. Auto-scroll depends on the single timeline state, while prepending older history preserves scroll position.

- [ ] **Step 5: Build and typecheck WebUI**

Run: `bun run typecheck && bun run webui:build`

Expected: PASS; only the already-deferred chunk-size notice may remain.

---

### Task 7: Contracts, progress, full verification, and commit

**Files:**
- Modify: `docs/03-Interface-Contracts.md`
- Modify: `docs/04-Data-Model.md`
- Modify: `docs/08-Web-Control-Plane-Task-Book.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Documentation must match the final event payloads, repository methods, schema, history DTO, and WebSocket terminal envelope exactly.

- [ ] **Step 1: Update contracts and progress**

Record the completed lifecycle model, one-table pagination/reference hydration, realtime terminal protocol, migration data reset, tests, and commit in `PROGRESS.md`. Change the design spec status to implemented after verification.

- [ ] **Step 2: Run mandatory formatting and static verification**

Run: `bun run format && bun run format:check && bun run typecheck && bun run lint && bun run webui:build`

Expected: all exit 0.

- [ ] **Step 3: Run focused and full tests**

Run: `bun test src/storage/schema.test.ts src/audit/approval-audit.test.ts src/transport/websocket/websocket-transport.test.ts src/server/server.test.ts`

Then run: `bun test`

Expected: 0 failures; integration tests may retain their existing environment-controlled skips.

- [ ] **Step 4: Review diff and commit**

Run: `git diff --check`, inspect `git diff --stat` and relevant diff sections, then commit all scoped source/tests/docs/migration changes with:

```bash
git commit -m "feat: persist web approval timeline"
```
