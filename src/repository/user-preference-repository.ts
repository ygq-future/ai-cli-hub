import { and, eq } from 'drizzle-orm'
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

    async reset(platform, userId) {
      await db.transaction(async tx => {
        await tx
          .delete(userCliPreferences)
          .where(and(eq(userCliPreferences.platform, platform), eq(userCliPreferences.userId, userId)))
        await tx
          .delete(userPreferences)
          .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
      })
    },
  }
}
