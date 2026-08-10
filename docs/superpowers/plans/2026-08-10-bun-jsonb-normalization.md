# Bun SQL JSONB Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `messages.attachments` and `audit_logs.request` are stored as native JSONB array/object values and normalize existing double-serialized rows.

**Architecture:** Add one storage-schema custom type that passes native values to Bun SQL and keeps backward-compatible reads. Apply it to both JSONB columns, then use migration 0019 to normalize existing rows and add database shape constraints.

**Tech Stack:** Bun 1.3.14, TypeScript strict, Drizzle ORM 0.45.2, PostgreSQL JSONB, Bun test.

## Global Constraints

- SQL remains confined to `storage/` migrations and repository-backed runtime paths.
- No new dependency and no driver replacement.
- Existing Repository and Web/API contracts remain unchanged.
- Run `bun run format` before final validation.
- Update `PROGRESS.md` when the fix is complete.

---

### Task 1: Reproduce the serializer contract

**Files:**
- Modify: `src/storage/schema.test.ts`

**Interfaces:**
- Consumes: `messages.attachments.mapToDriverValue` and `auditLogs.request.mapToDriverValue`.
- Produces: regression assertions requiring native array/object driver values.

- [ ] Add assertions that `mapToDriverValue([])` remains an array and an approval request remains an object.
- [ ] Run `bun test src/storage/schema.test.ts` and confirm both assertions fail because the current built-in `jsonb()` returns strings.

### Task 2: Add Bun-compatible JSONB columns

**Files:**
- Create: `src/storage/schema/bun-jsonb.ts`
- Modify: `src/storage/schema/messages.ts`
- Modify: `src/storage/schema/audit-logs.ts`

**Interfaces:**
- Produces: `bunJsonb<T>(name: string)`, whose driver value is native and whose reader accepts legacy serialized strings.
- Consumes: `StoredMessageAttachment[]` and `ApprovalAuditRequest` as concrete column data types.

- [ ] Implement `bunJsonb<T>()` with SQL type `jsonb`, identity writes, and one-layer legacy string parsing.
- [ ] Replace the two built-in `jsonb()` column builders with `bunJsonb<T>()`.
- [ ] Re-run `bun test src/storage/schema.test.ts` and confirm the serializer assertions pass.

### Task 3: Normalize persisted data and enforce shapes

**Files:**
- Create: `drizzle/0019_normalize_bun_jsonb.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/storage/schema/messages.ts`
- Modify: `src/storage/schema/audit-logs.ts`
- Modify: `src/storage/schema.test.ts`

**Interfaces:**
- Produces: database constraints `messages_attachments_array` and `audit_logs_request_object`.

- [ ] Add schema CHECK declarations for array/object JSONB shapes.
- [ ] Add migration UPDATE statements that parse one string layer before adding constraints.
- [ ] Register migration index 19 in the Drizzle journal.
- [ ] Extend migration tests to assert normalization order, constraints, and journal coverage.
- [ ] Run the storage schema tests.

### Task 4: Documentation, validation, and commit

**Files:**
- Modify: `docs/04-Data-Model.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Produces: deployment-visible migration warning and completed progress record.

- [ ] Document native JSONB shapes and Bun-compatible serialization.
- [ ] Record the root cause, migration, constraints, and verification in `PROGRESS.md`.
- [ ] Run `bun run format`, `bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run webui:build`, `git diff --check`, and `bun test`.
- [ ] Commit all scoped changes as `fix: normalize Bun JSONB storage`.

