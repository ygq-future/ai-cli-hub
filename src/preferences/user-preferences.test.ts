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
  const conversationResets: unknown[] = []
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
        async reset(
          platform: 'telegram' | 'qq' | 'websocket',
          userId: string,
          defaults: ReadonlyArray<{ cli: 'claude' | 'opencode' | 'codex' | 'gemini'; cwd: string }>,
        ) {
          preferences.set(key(platform, userId), {
            language: 'zh',
            defaultCli: 'claude',
            autoApproveEnabled: false,
            autoApproveSeconds: 5,
          })
          for (const value of defaults) {
            cwds.set(cwdKey(platform, userId, value.cli), value.cwd)
            models.delete(cwdKey(platform, userId, value.cli))
          }
        },
      },
      conversations: {
        async resetOpenCwds(platform: string, userId: string, defaults: unknown) {
          conversationResets.push({ platform, userId, defaults })
        },
      },
    },
    preferences,
    cwds,
    models,
    conversationResets,
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

    const telegramClaudeCwd = path.join('/home/hub', 'ai-workspace', '.claude-telegram')
    const qqClaudeCwd = path.join('/home/hub', 'ai-workspace', '.claude-qq')
    expect(await preferences.getTarget('telegram', 'u1')).toEqual({ cli: 'claude', cwd: telegramClaudeCwd })
    expect(created).toEqual([telegramClaudeCwd])
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
    expect(await preferences.getTarget('qq', 'u1')).toEqual({ cli: 'claude', cwd: qqClaudeCwd })
    expect(created).toEqual([telegramClaudeCwd, qqClaudeCwd])
  })

  test('reset 以默认值覆盖持久化偏好、CLI cwd 与模型选择', async () => {
    const bus = createEventBus()
    const resetEvents: unknown[] = []
    bus.on('UserPreferencesReset', payload => resetEvents.push(payload))
    const { repos, preferences: storedPreferences, cwds, models, conversationResets } = createRepos()
    const preferences = createUserPreferences({ bus, repos: repos as never, homeDir: '/home/hub' })
    await preferences.getTarget('telegram', 'u1')
    await preferences.setTarget('telegram', 'u1', { cli: 'opencode', cwd: '/projects/open' })
    await preferences.setLanguage('telegram', 'u1', 'en')
    await preferences.setAutoApprove('telegram', 'u1', { enabled: true, seconds: 12 })
    await preferences.setModel('telegram', 'u1', 'opencode', { modelId: 'm1', modelName: 'Model 1' })

    const target = await preferences.reset('telegram', 'u1')

    expect(target).toEqual({ cli: 'claude', cwd: path.join('/home/hub', 'ai-workspace', '.claude-telegram') })
    expect(await preferences.getLanguage('telegram', 'u1')).toBe('zh')
    expect(await preferences.getAutoApprove('telegram', 'u1')).toEqual({ enabled: false, seconds: 5 })
    expect(await preferences.getModel('telegram', 'u1', 'opencode')).toBeNull()
    expect(storedPreferences.get('telegram:u1')).toEqual({
      language: 'zh',
      defaultCli: 'claude',
      autoApproveEnabled: false,
      autoApproveSeconds: 5,
    })
    expect(cwds.get('telegram:u1:opencode')).toBe(path.join('/home/hub', 'ai-workspace', '.opencode-telegram'))
    expect(models.has('telegram:u1:opencode')).toBeFalse()
    expect(conversationResets).toEqual([
      {
        platform: 'telegram',
        userId: 'u1',
        defaults: [
          { cli: 'claude', cwd: path.join('/home/hub', 'ai-workspace', '.claude-telegram') },
          { cli: 'opencode', cwd: path.join('/home/hub', 'ai-workspace', '.opencode-telegram') },
        ],
      },
    ])
    expect(resetEvents).toEqual([{ platform: 'telegram', userId: 'u1' }])
  })
})
