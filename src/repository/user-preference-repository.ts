import { and, eq } from 'drizzle-orm'
import type { Db } from '../storage'
import { userCliCwds, userPreferences } from '../storage/schema'
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

    async setAutoApproveEnabled(platform, userId, enabled) {
      await db
        .update(userPreferences)
        .set({ autoApproveEnabled: enabled, updatedAt: Date.now() })
        .where(and(eq(userPreferences.platform, platform), eq(userPreferences.userId, userId)))
    },

    async findCwd(platform, userId, cli) {
      const [row] = await db
        .select()
        .from(userCliCwds)
        .where(and(eq(userCliCwds.platform, platform), eq(userCliCwds.userId, userId), eq(userCliCwds.cli, cli)))
        .limit(1)
      return row ?? null
    },

    async upsertCwd(platform, userId, cli, cwd) {
      await db
        .insert(userCliCwds)
        .values({ platform, userId, cli, cwd, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [userCliCwds.platform, userCliCwds.userId, userCliCwds.cli],
          set: { cwd, updatedAt: Date.now() },
        })
    },
  }
}
