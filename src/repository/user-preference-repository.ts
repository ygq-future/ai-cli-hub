import { and, asc, desc, eq, lt, or } from 'drizzle-orm'
import type { Db } from '../storage'
import { userCliPreferences, userPreferences } from '../storage/schema'
import type { UserPreferenceRepository } from './types'

export function createUserPreferenceRepository(db: Db): UserPreferenceRepository {
  return {
    async getOrCreate(input) {
      const now = Date.now()
      await db
        .insert(userPreferences)
        .values({ ...input, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(and(eq(userPreferences.platform, input.platform), eq(userPreferences.userId, input.userId)))
        .limit(1)
      if (!row) throw new Error('UserPreferenceRepository.getOrCreate: insert did not return a row')
      return row
    },

    async setLanguage(platform, userId, language) {
      await db
        .update(userPreferences)
        .set({ language, updatedAt: Date.now() })
        .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
    },

    async setDefaultCli(platform, userId, cli) {
      await db
        .update(userPreferences)
        .set({ defaultCli: cli, updatedAt: Date.now() })
        .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
    },

    async setAutoApprove(platform, userId, enabled, seconds) {
      await db
        .update(userPreferences)
        .set({ autoApproveEnabled: enabled, autoApproveSeconds: seconds, updatedAt: Date.now() })
        .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
    },

    async findCliPreference(platform, userId, cli) {
      const [row] = await db
        .select()
        .from(userCliPreferences)
        .where(
          and(
            eq(userCliPreferences.platform, platform),
            eq(userCliPreferences.userId, userId),
            eq(userCliPreferences.cli, cli),
          ),
        )
        .limit(1)
      return row ?? null
    },

    async listCliPreferences(platform, userId) {
      return db
        .select()
        .from(userCliPreferences)
        .where(and(eq(userCliPreferences.platform, platform), eq(userCliPreferences.userId, userId)))
        .orderBy(asc(userCliPreferences.cli))
    },

    async listScopes(query) {
      const conditions = []
      if (query.before) {
        conditions.push(
          or(
            lt(userPreferences.updatedAt, query.before.timestamp),
            and(eq(userPreferences.updatedAt, query.before.timestamp), lt(userPreferences.userId, query.before.id)),
          ),
        )
      }
      const rows = await db
        .select()
        .from(userPreferences)
        .where(and(...conditions))
        .orderBy(desc(userPreferences.updatedAt), desc(userPreferences.userId), desc(userPreferences.platform))
        .limit(query.limit + 1)
      const hasMore = rows.length > query.limit
      const items = hasMore ? rows.slice(0, query.limit) : rows
      const last = items.at(-1)
      return {
        items,
        nextCursor: hasMore && last ? { timestamp: last.updatedAt, id: last.userId } : null,
      }
    },

    async find(platform, userId) {
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
        .limit(1)
      return row ?? null
    },

    async upsertCwd(platform, userId, cli, cwd) {
      await db
        .insert(userCliPreferences)
        .values({ platform, userId, cli, cwd, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [userCliPreferences.platform, userCliPreferences.userId, userCliPreferences.cli],
          set: { cwd, updatedAt: Date.now() },
        })
    },

    async setModel(platform, userId, cli, modelId, modelName) {
      await db
        .update(userCliPreferences)
        .set({ modelId, modelName, updatedAt: Date.now() })
        .where(
          and(
            eq(userCliPreferences.platform, platform),
            eq(userCliPreferences.userId, userId),
            eq(userCliPreferences.cli, cli),
          ),
        )
    },

    async reset(platform, userId, defaults) {
      await db.transaction(async tx => {
        const now = Date.now()
        await tx
          .insert(userPreferences)
          .values({
            platform,
            userId,
            language: 'zh',
            defaultCli: 'claude',
            autoApproveEnabled: false,
            autoApproveSeconds: 5,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [userPreferences.platform, userPreferences.userId],
            set: {
              language: 'zh',
              defaultCli: 'claude',
              autoApproveEnabled: false,
              autoApproveSeconds: 5,
              updatedAt: now,
            },
          })
        for (const value of defaults) {
          await tx
            .insert(userCliPreferences)
            .values({
              platform,
              userId,
              cli: value.cli,
              cwd: value.cwd,
              modelId: null,
              modelName: null,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [userCliPreferences.platform, userCliPreferences.userId, userCliPreferences.cli],
              set: { cwd: value.cwd, modelId: null, modelName: null, updatedAt: now },
            })
        }
      })
    },
  }
}
