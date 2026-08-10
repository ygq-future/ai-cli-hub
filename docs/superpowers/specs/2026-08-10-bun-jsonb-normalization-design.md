# Bun SQL JSONB 类型归一化设计

> 日期：2026-08-10
> 状态：用户已确认，进入实施

## 1. 问题与根因

当前运行时为 Bun 1.3.14，ORM 为 Drizzle 0.45.2，数据库驱动为 `drizzle-orm/bun-sql`。Drizzle 内置 PostgreSQL `jsonb()` 会先对值执行 `JSON.stringify`，再把字符串交给 Bun SQL；Bun SQL 针对 JSONB 参数继续序列化，导致 JavaScript 数组和对象以 JSON 字符串而非原生 JSONB 数组/对象存储。

临时表复现结果：原生 `[]` 写入后 `jsonb_typeof=value` 为 `array`，`JSON.stringify([])` 写入后为 `string`。迁移默认值绕过应用参数绑定，因此旧行可能是数组，而应用显式写入的新行可能是字符串，形成混合数据。

## 2. 修复范围

- `messages.attachments` 必须始终为 JSONB array。
- `audit_logs.request` 必须始终为 JSONB object。
- 不修改 Repository、HTTP/WebSocket 契约或 WebUI 数据结构。
- 不更换 Bun SQL 或 Drizzle，也不引入新依赖。

## 3. 写入修复

在 `src/storage/schema/bun-jsonb.ts` 提供项目专用 `bunJsonb<T>()` custom type：

- SQL 类型仍为 `jsonb`。
- 写入时保持原生 JavaScript 数组/对象，不调用 `JSON.stringify`，由 Bun SQL 仅序列化一次。
- 读取时兼容迁移前的 JSONB string：若驱动返回字符串则尝试解析一层；原生数组/对象直接返回。

`messages.attachments` 与 `audit_logs.request` 统一改用该类型，避免两个 JSONB 字段继续产生同类错误。

## 4. 数据迁移与约束

新增 `0019_normalize_bun_jsonb.sql`：

1. 将 `messages.attachments` 中 JSONB string 的字符串内容重新解析为 JSONB。
2. 将 `audit_logs.request` 中 JSONB string 的字符串内容重新解析为 JSONB。
3. 增加 `messages_attachments_array` CHECK，要求 `jsonb_typeof(attachments) = 'array'`。
4. 增加 `audit_logs_request_object` CHECK，要求 `jsonb_typeof(request) = 'object'`。

迁移对非预期或损坏数据选择失败而不是静默清空，避免为了通过约束丢失附件或审批信息。迁移完成后，数据库约束会阻止任何后续错误写入。

## 5. 验证

- 先用 schema 回归测试证明当前内置 `jsonb()` 会把数组/对象预序列化为字符串。
- 修复后断言 custom type 的 `mapToDriverValue` 保留原生值。
- schema/migration 测试覆盖两个 UPDATE、两个 CHECK 和 journal 登记。
- 使用临时 PostgreSQL 表做一次 Bun SQL 原生参数探针，确认数组/对象的 `jsonb_typeof` 正确。
- 执行 format、format check、typecheck、lint、WebUI build 和全量测试。

