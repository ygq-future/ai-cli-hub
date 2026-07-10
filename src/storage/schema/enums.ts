/**
 * Postgres 枚举 —— 与 shared/types 的联合类型一一对应（docs/04-Data-Model.md §2）。
 * 枚举值改动需同步 shared/types/common.ts 与本文件，二者是同一契约的两种表达。
 */
import { pgEnum } from 'drizzle-orm/pg-core'

export const platformEnum = pgEnum('platform', ['telegram', 'qq', 'websocket'])
export const cliEnum = pgEnum('cli', ['claude', 'opencode', 'codex', 'gemini'])
export const sessionStatusEnum = pgEnum('session_status', ['idle', 'starting', 'running', 'closing', 'closed'])
export const roleEnum = pgEnum('role', ['user', 'assistant', 'system'])
export const memoryTypeEnum = pgEnum('memory_type', ['episodic', 'semantic', 'preference'])
export const approvalActionEnum = pgEnum('approval_action', ['approve', 'reject'])
