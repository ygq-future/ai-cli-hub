import { sql } from 'drizzle-orm'
import type { Db } from './db'

export interface WebUserMigrationResult {
  changed: boolean
  userId: string
}

/**
 * 将旧版本按白名单首项创建的 Web 身份迁移到 transport.webUserId。
 *
 * Web 当前只有一个稳定身份，因此迁移所有非目标 Web 身份；Telegram/QQ 数据不会被触碰。
 * 迁移在单事务中完成，并在修改前拒绝同 CLI 的未关闭会话冲突，避免覆盖会话数据。
 */
export async function migrateWebUserIdentity(db: Db, userId: string): Promise<WebUserMigrationResult> {
  const stableUserId = userId.trim()
  if (!stableUserId) throw new Error('transport.webUserId must not be empty.')

  return db.transaction(async tx => {
    const legacyRows = await tx.execute<{ exists: boolean | string }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "conversations"
        WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
        UNION ALL
        SELECT 1 FROM "user_preferences"
        WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
        UNION ALL
        SELECT 1 FROM "user_cli_preferences"
        WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
      ) AS "exists"
    `)
    const hasLegacyRows = legacyRows[0]?.exists === true || legacyRows[0]?.exists === 't'
    if (!hasLegacyRows) return { changed: false, userId: stableUserId }

    const conflicts = await tx.execute<{ conversationId: string }>(sql`
      SELECT legacy."cli" AS "cli"
      FROM "conversations" AS legacy
      JOIN "conversations" AS stable
        ON stable."platform" = 'web'
       AND stable."user_id" = ${stableUserId}
       AND stable."cli" = legacy."cli"
       AND stable."status" <> 'closed'
      WHERE legacy."platform" = 'web'
        AND legacy."user_id" <> ${stableUserId}
        AND legacy."status" <> 'closed'
      LIMIT 1
    `)
    if (conflicts[0]) {
      throw new Error(
        `Cannot migrate Web identity to '${stableUserId}': an open Web conversation already exists for CLI '${conflicts[0].cli}'.`,
      )
    }

    await tx.execute(sql`
      UPDATE "audit_logs" AS audit
      SET "operator" = CASE
        WHEN audit."operator" = conversation."user_id" THEN ${stableUserId}
        WHEN audit."operator" = ('auto:' || conversation."user_id") THEN ('auto:' || ${stableUserId})
        ELSE audit."operator"
      END
      FROM "conversations" AS conversation
      WHERE audit."conversation_id" = conversation."id"
        AND conversation."platform" = 'web'
        AND conversation."user_id" <> ${stableUserId}
        AND (
          audit."operator" = conversation."user_id"
          OR audit."operator" = ('auto:' || conversation."user_id")
        )
    `)

    await tx.execute(sql`
      INSERT INTO "user_preferences" (
        "platform", "user_id", "language", "default_cli", "auto_approve_enabled", "auto_approve_seconds",
        "created_at", "updated_at"
      )
      SELECT "platform", ${stableUserId}, "language", "default_cli", "auto_approve_enabled", "auto_approve_seconds",
        "created_at", "updated_at"
      FROM (
        SELECT DISTINCT ON ("platform") "platform", "language", "default_cli", "auto_approve_enabled",
          "auto_approve_seconds", "created_at", "updated_at"
        FROM "user_preferences"
        WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
        ORDER BY "platform", "updated_at" DESC, "user_id" DESC
      ) AS source
      ON CONFLICT ("platform", "user_id") DO UPDATE
      SET "language" = EXCLUDED."language",
        "default_cli" = EXCLUDED."default_cli",
        "auto_approve_enabled" = EXCLUDED."auto_approve_enabled",
        "auto_approve_seconds" = EXCLUDED."auto_approve_seconds",
        "created_at" = EXCLUDED."created_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE EXCLUDED."updated_at" > "user_preferences"."updated_at"
    `)

    await tx.execute(sql`
      INSERT INTO "user_cli_preferences" (
        "platform", "user_id", "cli", "cwd", "model_id", "model_name", "updated_at"
      )
      SELECT "platform", ${stableUserId}, "cli", "cwd", "model_id", "model_name", "updated_at"
      FROM (
        SELECT DISTINCT ON ("platform", "cli") "platform", "cli", "cwd", "model_id", "model_name", "updated_at"
        FROM "user_cli_preferences"
        WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
        ORDER BY "platform", "cli", "updated_at" DESC, "user_id" DESC
      ) AS source
      ON CONFLICT ("platform", "user_id", "cli") DO UPDATE
      SET "cwd" = EXCLUDED."cwd",
        "model_id" = EXCLUDED."model_id",
        "model_name" = EXCLUDED."model_name",
        "updated_at" = EXCLUDED."updated_at"
      WHERE EXCLUDED."updated_at" > "user_cli_preferences"."updated_at"
    `)

    await tx.execute(sql`
      DELETE FROM "user_cli_preferences"
      WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
    `)
    await tx.execute(sql`
      DELETE FROM "user_preferences"
      WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
    `)
    await tx.execute(sql`
      UPDATE "conversations"
      SET "user_id" = ${stableUserId}
      WHERE "platform" = 'web' AND "user_id" <> ${stableUserId}
    `)

    return { changed: true, userId: stableUserId }
  })
}
