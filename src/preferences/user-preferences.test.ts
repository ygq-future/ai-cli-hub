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
    }
  >()
  const cwds = new Map<string, string>()
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
        async setAutoApproveEnabled(platform: 'telegram' | 'qq' | 'websocket', userId: string, enabled: boolean) {
          preferences.get(key(platform, userId))!.autoApproveEnabled = enabled
        },
        async findCwd(platform: 'telegram' | 'qq' | 'websocket', userId: string, cli: string) {
          const cwd = cwds.get(cwdKey(platform, userId, cli))
          return cwd ? { platform, userId, cli: cli as 'claude', cwd, updatedAt: 1 } : null
        },
        async upsertCwd(platform: 'telegram' | 'qq' | 'websocket', userId: string, cli: string, cwd: string) {
          cwds.set(cwdKey(platform, userId, cli), cwd)
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
    expect(await preferences.getLanguage('telegram', 'u1')).toBe('en')
    expect(await preferences.getAutoApproveEnabled('telegram', 'u1')).toBe(false)
    await preferences.setAutoApproveEnabled('telegram', 'u1', true)
    expect(await preferences.getAutoApproveEnabled('telegram', 'u1')).toBe(true)
    expect(await preferences.getAutoApproveEnabled('qq', 'u1')).toBe(false)
    expect(await preferences.getTarget('qq', 'u1')).toEqual({ cli: 'claude', cwd: defaultClaudeCwd })
  })
})
