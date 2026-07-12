import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../config'
import { createUpdateRunner, type CommandResult } from './update'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    UPDATE_WORKDIR: '/app/ai-cli-hub',
    UPDATE_COMMAND_TIMEOUT_MS: 120_000,
    UPDATE_REQUIRE_CLEAN_WORKTREE: true,
    UPDATE_RESTART_COMMAND: 'pm2',
    UPDATE_RESTART_ARGS: ['restart', 'ai-cli-hub'],
    UPDATE_RESTART_DELAY_MS: 1500,
    ...overrides,
  } as AppConfig
}

function ok(stdout = ''): CommandResult {
  return { code: 0, stdout, stderr: '' }
}

describe('update runner', () => {
  test('preview lists commands and explicit confirmation', () => {
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      runCommand: async () => ok(),
      scheduleRestart() {},
    })

    const preview = runner.preview()

    expect(preview).toContain('## 🔄 自更新预检')
    expect(preview).toContain('**工作目录**: `/app/ai-cli-hub`')
    expect(preview).toContain('git status --short')
    expect(preview).toContain('git pull --ff-only')
    expect(preview).toContain('bun install --frozen-lockfile')
    expect(preview).toContain('bun run setting:migrate')
    expect(preview).toContain('bun run db:migrate')
    expect(preview).toContain('bun run deps:prune')
    expect(preview).toContain('`pm2 restart ai-cli-hub after 1500ms`')
    expect(preview).toContain('/update confirm')
  })

  test('windows platform reports unsupported and does not run commands', async () => {
    const calls: string[] = []
    const restarts: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'win32',
      async runCommand(command, args) {
        calls.push([command, ...args].join(' '))
        return ok()
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const preview = runner.preview()
    const report = await runner.run()

    expect(preview).toContain('自更新不可用')
    expect(preview).toContain('当前是 Windows')
    expect(report).toContain('自更新不可用')
    expect(report).toContain('未执行任何命令')
    expect(calls).toEqual([])
    expect(restarts).toEqual([])
  })

  test('dirty worktree stops before mutating update steps', async () => {
    const calls: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand(command, args) {
        calls.push([command, ...args].join(' '))
        return ok(' M src/main.ts')
      },
      scheduleRestart() {
        throw new Error('should not restart')
      },
    })

    const report = await runner.run()

    expect(calls).toEqual(['git status --short'])
    expect(report).toContain('自更新失败')
    expect(report).toContain('工作树存在未提交')
    expect(report).toContain('未安排重启')
  })

  test('successful update runs checks and schedules restart', async () => {
    const calls: string[] = []
    const restarts: string[] = []
    const notices: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand(command, args) {
        calls.push([command, ...args].join(' '))
        return ok()
      },
      async writeRestartNotice(ref) {
        notices.push(`${ref.chatId}/${ref.nativeId}`)
      },
      scheduleRestart(command, args, cwd, delayMs) {
        restarts.push(`${[command, ...args].join(' ')} | ${cwd} | ${delayMs}`)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(calls).toEqual([
      'git status --short',
      'git pull --ff-only',
      'bun install --frozen-lockfile',
      'bun run setting:migrate',
      'bun run db:migrate',
      'bun run format:check',
      'bun run typecheck',
      'bun run lint',
      'bun run deps:prune',
    ])
    expect(notices).toEqual(['chat-1/msg-1'])
    expect(restarts).toEqual(['pm2 restart ai-cli-hub | /app/ai-cli-hub | 1500'])
    expect(report).toContain('自更新完成')
    expect(report).toContain('已完成 **9** 项检查与更新')
    expect(report).toContain('**命令**: `pm2 restart ai-cli-hub`')
  })

  test('restart notice failure stops before scheduling restart', async () => {
    const restarts: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand() {
        return ok()
      },
      async writeRestartNotice() {
        throw new Error('disk full')
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(restarts).toEqual([])
    expect(report).toContain('自更新失败')
    expect(report).toContain('写入重启通知标记失败：disk full')
  })

  test('failed step stops and does not schedule restart', async () => {
    const restarts: string[] = []
    const runner = createUpdateRunner({
      config: config({ UPDATE_REQUIRE_CLEAN_WORKTREE: false }),
      platform: 'linux',
      async runCommand(command, args) {
        if (command === 'bun' && args.join(' ') === 'run typecheck') {
          return { code: 2, stdout: '', stderr: 'type error' }
        }
        return ok()
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run()

    expect(restarts).toEqual([])
    expect(report).toContain('自更新失败')
    expect(report).toContain('typecheck 失败')
    expect(report).toContain('type error')
  })
})
