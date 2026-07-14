import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { createEventBus } from '../event'
import { createUserPreferences } from './user-preferences'

function createRepos() {
  const preferences = new Map<
    string,
    {
      language: 'zh' | 'en'
      defaultCli: 'claude' | 'opencode' | 'codex' | 'gemini'
      autoApproveEnabled: boolean
      autoApproveSeconds: number
    }
  >()
  const cwds = new Map<string, string>()
  const models = new Map<string, { modelId: string; modelName: string }>()
  const key = (platform: string, userId: string) => `${platform}:${userId}`
  const cwdKey = (platform: string, userId: string, cli: string) => `${platform}:${userId}:${cli}`

  return {
    repos: {
      userPreferences: {
        async getOrCreate(input: {
          platform: 'telegram' | 'qq' | 'websocket'
          userId: string
          language: 'zh' | 'en'
          defaultCli: 'claude' | 'opencode' | 'codex' | 'gemini'
        }) {
          const value = preferences.get(key(input.platform, input.userId)) ?? {
            language: input.language,
            defaultCli: input.defaultCli,
            autoApproveEnabled: false,
            autoApproveSeconds: 5,
          }
          preferences.set(key(input.platform, input.userId), value)
          return { platform: input.platform, userId: input.userId, ...value, createdAt: 1, updatedAt: 1 }
        },
        async setLanguage(platform: 'telegram' | 'qq' | 'websocket', userId: string, language: 'zh' | 'en') {
          const value = preferences.get(key(platform, userId))!
          value.language = language
        },
        async setDefaultCli(
          platform: 'telegram' | 'qq' | 'websocket',
          userId: string,
          cli: 'claude' | 'opencode' | 'codex' | 'gemini',
        ) {
          const value = preferences.get(key(platform, userId))!
          value.defaultCli = cli
        },
        async setAutoApprove(
          platform: 'telegram' | 'qq' | 'websocket',
          userId: string,
          enabled: boolean,
          seconds: number,
        ) {
          const preference = preferences.get(key(platform, userId))!
          preference.autoApproveEnabled = enabled
          preference.autoApproveSeconds = seconds
        },
        async findCliPreference(platform: 'telegram' | 'qq' | 'websocket', userId: string, cli: string) {
          const cwd = cwds.get(cwdKey(platform, userId, cli))
          return cwd
            ? {
                platform,
                userId,
                cli: cli as 'claude',
                cwd,
                modelId: models.get(cwdKey(platform, userId, cli))?.modelId ?? null,
                modelName: models.get(cwdKey(platform, userId, cli))?.modelName ?? null,
                updatedAt: 1,
              }
            : null
        },
        async upsertCwd(platform: 'telegram' | 'qq' | 'websocket', userId: string, cli: string, cwd: string) {
          cwds.set(cwdKey(platform, userId, cli), cwd)
        },
        async setModel(
          platform: 'telegram' | 'qq' | 'websocket',
          userId: string,
          cli: string,
          modelId: string,
          modelName: string,
        ) {
          models.set(cwdKey(platform, userId, cli), { modelId, modelName })
        },
        async reset(platform: 'telegram' | 'qq' | 'websocket', userId: string) {
          preferences.delete(key(platform, userId))
          for (const storedKey of [...cwds.keys()]) {
            if (storedKey.startsWith(`${platform}:${userId}:`)) cwds.delete(storedKey)
          }
          for (const storedKey of [...models.keys()]) {
            if (storedKey.startsWith(`${platform}:${userId}:`)) models.delete(storedKey)
          }
        },
      },
    },
  }
}

describe('user preferences', () => {
  test('首次访问初始化默认 CLI 目录，并按 platform + userId 隔离', async () => {
    const bus = createEventBus()
    const { repos } = createRepos()
    const created: string[] = []
    const preferences = createUserPreferences({
      bus,
      repos: repos as never,
      homeDir: '/home/hub',
      async ensureDirectory(cwd) {
        created.push(cwd)
      },
    })

    const defaultClaudeCwd = path.join('/home/hub', 'ai-workspace', '.claude')
    expect(await preferences.getTarget('telegram', 'u1')).toEqual({ cli: 'claude', cwd: defaultClaudeCwd })
    expect(created).toEqual([defaultClaudeCwd])
    await preferences.setTarget('telegram', 'u1', { cli: 'opencode', cwd: '/projects/open' })
    await preferences.setLanguage('telegram', 'u1', 'en')

    expect(await preferences.getTarget('telegram', 'u1')).toEqual({ cli: 'opencode', cwd: '/projects/open' })
    expect(await preferences.getModel('telegram', 'u1', 'opencode')).toBeNull()
    await preferences.setModel('telegram', 'u1', 'opencode', {
      modelId: 'deepseek/deepseek-v4',
      modelName: 'DeepSeek V4',
    })
    expect(await preferences.getModel('telegram', 'u1', 'opencode')).toEqual({
      modelId: 'deepseek/deepseek-v4',
      modelName: 'DeepSeek V4',
    })
    expect(await preferences.getLanguage('telegram', 'u1')).toBe('en')
    expect(await preferences.getAutoApprove('telegram', 'u1')).toEqual({ enabled: false, seconds: 5 })
    await preferences.setAutoApprove('telegram', 'u1', { enabled: true, seconds: 12 })
    expect(await preferences.getAutoApprove('telegram', 'u1')).toEqual({ enabled: true, seconds: 12 })
    expect(await preferences.getAutoApprove('qq', 'u1')).toEqual({ enabled: false, seconds: 5 })
    expect(await preferences.getTarget('qq', 'u1')).toEqual({ cli: 'claude', cwd: defaultClaudeCwd })
  })

  test('reset 删除持久化偏好与缓存并恢复默认值', async () => {
    const bus = createEventBus()
    const resetEvents: unknown[] = []
    bus.on('UserPreferencesReset', payload => resetEvents.push(payload))
    const { repos } = createRepos()
    const preferences = createUserPreferences({ bus, repos: repos as never, homeDir: '/home/hub' })
    await preferences.getTarget('telegram', 'u1')
    await preferences.setTarget('telegram', 'u1', { cli: 'opencode', cwd: '/projects/open' })
    await preferences.setLanguage('telegram', 'u1', 'en')
    await preferences.setAutoApprove('telegram', 'u1', { enabled: true, seconds: 12 })
    await preferences.setModel('telegram', 'u1', 'opencode', { modelId: 'm1', modelName: 'Model 1' })

    const target = await preferences.reset('telegram', 'u1')

    expect(target).toEqual({ cli: 'claude', cwd: path.join('/home/hub', 'ai-workspace', '.claude') })
    expect(await preferences.getLanguage('telegram', 'u1')).toBe('zh')
    expect(await preferences.getAutoApprove('telegram', 'u1')).toEqual({ enabled: false, seconds: 5 })
    expect(await preferences.getModel('telegram', 'u1', 'opencode')).toBeNull()
    expect(resetEvents).toEqual([{ platform: 'telegram', userId: 'u1' }])
  })
})
