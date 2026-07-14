import path from 'node:path'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import {
  DEFAULT_AUTO_APPROVE_SECONDS,
  type AutoApprovePreference,
  type CliModelPreference,
  type CliType,
  type Platform,
  type Unsubscribe,
  type UserLanguage,
} from '../shared'

export interface UserTarget {
  cli: CliType
  cwd: string
}

export interface UserPreferences {
  getLanguage(platform: Platform, userId: string): Promise<UserLanguage>
  setLanguage(platform: Platform, userId: string, language: UserLanguage): Promise<void>
  getAutoApprove(platform: Platform, userId: string): Promise<AutoApprovePreference>
  setAutoApprove(platform: Platform, userId: string, preference: AutoApprovePreference): Promise<void>
  getTarget(platform: Platform, userId: string): Promise<UserTarget>
  getCwd(platform: Platform, userId: string, cli: CliType): Promise<string>
  getModel(platform: Platform, userId: string, cli: CliType): Promise<CliModelPreference | null>
  setTarget(platform: Platform, userId: string, target: UserTarget): Promise<void>
  setModel(platform: Platform, userId: string, cli: CliType, model: CliModelPreference): Promise<void>
  reset(platform: Platform, userId: string): Promise<UserTarget>
  destroy(): void
}

export interface UserPreferencesDeps {
  bus: EventBus
  repos: Repositories
  homeDir: string
  ensureDirectory?: (cwd: string) => Promise<void>
}

const DEFAULT_LANGUAGE: UserLanguage = 'zh'
const DEFAULT_CLI: CliType = 'claude'

export function createUserPreferences(deps: UserPreferencesDeps): UserPreferences {
  const { bus, repos } = deps
  const ensureDirectory = deps.ensureDirectory ?? (() => Promise.resolve())
  const languageCache = new Map<string, UserLanguage>()
  const targetCache = new Map<string, UserTarget>()
  const autoApproveCache = new Map<string, AutoApprovePreference>()
  const unsubs: Unsubscribe[] = []

  const cacheKey = (platform: Platform, userId: string) => `${platform}:${userId}`

  async function ensurePreference(platform: Platform, userId: string) {
    return repos.userPreferences.getOrCreate({ platform, userId, language: DEFAULT_LANGUAGE, defaultCli: DEFAULT_CLI })
  }

  async function getCwd(platform: Platform, userId: string, cli: CliType): Promise<string> {
    const row = await repos.userPreferences.findCliPreference(platform, userId, cli)
    if (row) return row.cwd
    const cwd = defaultCwd(deps.homeDir, cli, platform)
    await ensureDirectory(cwd)
    await repos.userPreferences.upsertCwd(platform, userId, cli, cwd)
    return cwd
  }

  async function getModel(platform: Platform, userId: string, cli: CliType): Promise<CliModelPreference | null> {
    const preference = await repos.userPreferences.findCliPreference(platform, userId, cli)
    return preference?.modelId
      ? { modelId: preference.modelId, modelName: preference.modelName ?? preference.modelId }
      : null
  }

  async function setModel(platform: Platform, userId: string, cli: CliType, model: CliModelPreference): Promise<void> {
    await getCwd(platform, userId, cli)
    await repos.userPreferences.setModel(platform, userId, cli, model.modelId, model.modelName)
  }

  async function getTarget(platform: Platform, userId: string): Promise<UserTarget> {
    const key = cacheKey(platform, userId)
    const cached = targetCache.get(key)
    if (cached) return cached
    const preference = await ensurePreference(platform, userId)
    const target = {
      cli: preference.defaultCli as CliType,
      cwd: await getCwd(platform, userId, preference.defaultCli as CliType),
    }
    targetCache.set(key, target)
    languageCache.set(key, preference.language as UserLanguage)
    return target
  }

  async function setLanguage(platform: Platform, userId: string, language: UserLanguage): Promise<void> {
    await ensurePreference(platform, userId)
    await repos.userPreferences.setLanguage(platform, userId, language)
    languageCache.set(cacheKey(platform, userId), language)
  }

  async function setTarget(platform: Platform, userId: string, target: UserTarget): Promise<void> {
    await ensurePreference(platform, userId)
    await repos.userPreferences.setDefaultCli(platform, userId, target.cli)
    await repos.userPreferences.upsertCwd(platform, userId, target.cli, target.cwd)
    targetCache.set(cacheKey(platform, userId), target)
    bus.emit('UserTargetChanged', { platform, userId, cli: target.cli, cwd: target.cwd })
  }

  async function getAutoApprove(platform: Platform, userId: string): Promise<AutoApprovePreference> {
    const key = cacheKey(platform, userId)
    const cached = autoApproveCache.get(key)
    if (cached) return cached
    const preference = await ensurePreference(platform, userId)
    const value = {
      enabled: preference.autoApproveEnabled,
      seconds: preference.autoApproveSeconds ?? DEFAULT_AUTO_APPROVE_SECONDS,
    }
    autoApproveCache.set(key, value)
    return value
  }

  async function setAutoApprove(platform: Platform, userId: string, preference: AutoApprovePreference): Promise<void> {
    await ensurePreference(platform, userId)
    await repos.userPreferences.setAutoApprove(platform, userId, preference.enabled, preference.seconds)
    autoApproveCache.set(cacheKey(platform, userId), preference)
  }

  async function reset(platform: Platform, userId: string): Promise<UserTarget> {
    await repos.userPreferences.reset(platform, userId)
    const key = cacheKey(platform, userId)
    languageCache.delete(key)
    targetCache.delete(key)
    autoApproveCache.delete(key)
    const target = { cli: DEFAULT_CLI, cwd: defaultCwd(deps.homeDir, DEFAULT_CLI, platform) }
    await ensureDirectory(target.cwd)
    bus.emit('UserTargetChanged', { platform, userId, ...target })
    bus.emit('UserPreferencesReset', { platform, userId })
    return target
  }

  unsubs.push(
    bus.on('UserLanguageChanged', payload => {
      void setLanguage(payload.platform, payload.userId, payload.language).catch(err =>
        bus.emit('ErrorOccurred', {
          scope: 'preferences:UserLanguageChanged',
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }),
  )

  return {
    async getLanguage(platform, userId) {
      const key = cacheKey(platform, userId)
      const cached = languageCache.get(key)
      if (cached) return cached
      const preference = await ensurePreference(platform, userId)
      const language = preference.language as UserLanguage
      languageCache.set(key, language)
      return language
    },
    setLanguage,
    getAutoApprove,
    setAutoApprove,
    getTarget,
    getCwd,
    getModel,
    setTarget,
    setModel,
    reset,
    destroy() {
      for (const unsubscribe of unsubs) unsubscribe()
      unsubs.length = 0
    },
  }
}

export function defaultCwd(homeDir: string, cli: CliType, platform: Platform): string {
  return path.join(homeDir, 'ai-workspace', `.${cli}-${platform}`)
}
