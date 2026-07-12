import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../config'
import { createRestartRunner } from './restart'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    UPDATE_WORKDIR: '/app/ai-cli-hub',
    UPDATE_RESTART_COMMAND: 'pm2',
    UPDATE_RESTART_ARGS: ['restart', 'ai-cli-hub'],
    UPDATE_RESTART_DELAY_MS: 1500,
    ...overrides,
  } as AppConfig
}

describe('restart runner', () => {
  test('preview lists restart command and explicit confirmation', () => {
    const runner = createRestartRunner({
      config: config(),
      platform: 'linux',
      scheduleRestart() {},
    })

    const preview = runner.preview()

    expect(preview).toContain('## 🔄 重启预检')
    expect(preview).toContain('**工作目录**: `/app/ai-cli-hub`')
    expect(preview).toContain('**重启命令**: `pm2 restart ai-cli-hub after 1500ms`')
    expect(preview).toContain('/restart confirm')
  })

  test('successful restart writes notice and schedules restart', async () => {
    const notices: string[] = []
    const restarts: string[] = []
    const runner = createRestartRunner({
      config: config(),
      platform: 'linux',
      async writeRestartNotice(ref) {
        notices.push(`${ref.chatId}/${ref.nativeId}`)
      },
      scheduleRestart(command, args, cwd, delayMs) {
        restarts.push(`${[command, ...args].join(' ')} | ${cwd} | ${delayMs}`)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(notices).toEqual(['chat-1/msg-1'])
    expect(restarts).toEqual(['pm2 restart ai-cli-hub | /app/ai-cli-hub | 1500'])
    expect(report).toContain('重启已安排')
    expect(report).toContain('**延迟**: 1.5 秒')
    expect(report).toContain('恢复后会主动通知此聊天')
  })

  test('restart notice failure stops before scheduling restart', async () => {
    const restarts: string[] = []
    const runner = createRestartRunner({
      config: config(),
      platform: 'linux',
      async writeRestartNotice() {
        throw new Error('disk full')
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(restarts).toEqual([])
    expect(report).toContain('重启失败')
    expect(report).toContain('写入重启通知标记失败：disk full')
  })

  test('empty restart command reports manual restart without scheduling', async () => {
    const restarts: string[] = []
    const runner = createRestartRunner({
      config: config({ UPDATE_RESTART_COMMAND: '' }),
      platform: 'linux',
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(restarts).toEqual([])
    expect(report).toContain('重启未安排')
    expect(report).toContain('`UPDATE_RESTART_COMMAND` 为空')
  })

  test('windows platform reports unsupported and does not write notice or schedule restart', async () => {
    const notices: string[] = []
    const restarts: string[] = []
    const runner = createRestartRunner({
      config: config(),
      platform: 'win32',
      async writeRestartNotice(ref) {
        notices.push(`${ref.chatId}/${ref.nativeId}`)
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const preview = runner.preview()
    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(preview).toContain('重启不可用')
    expect(preview).toContain('当前是 Windows')
    expect(report).toContain('重启不可用')
    expect(report).toContain('未执行任何命令')
    expect(notices).toEqual([])
    expect(restarts).toEqual([])
  })
})
