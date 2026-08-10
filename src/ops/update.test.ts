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

function unchangedRevisionResult() {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const call = [command, ...args].join(' ')
    if (call === 'git rev-parse HEAD') return ok('aaaaaaaaaaaaaaaa')
    if (call === 'bun run setting:migrate --report-json')
      return ok(
        'AI_CLI_HUB_SETTINGS_REPORT={"created":false,"changed":false,"added":0,"deleted":0,"addedPaths":[],"deletedPaths":[]}',
      )
    if (call === 'bun run db:migrate --report-json') return ok('AI_CLI_HUB_DB_REPORT={"applied":[]}')
    return ok()
  }
}

function changedRevisionResult() {
  let revisionReads = 0
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const call = [command, ...args].join(' ')
    if (call === 'git rev-parse HEAD') return ok(++revisionReads === 1 ? '1111111111111111' : '2222222222222222')
    if (call.startsWith('git diff --shortstat')) return ok('1 file changed, 1 insertion(+)')
    if (call.startsWith('git log --format=')) return ok('2222222\tfix: update')
    if (call === 'bun run setting:migrate --report-json')
      return ok(
        'AI_CLI_HUB_SETTINGS_REPORT={"created":false,"changed":false,"added":0,"deleted":0,"addedPaths":[],"deletedPaths":[]}',
      )
    if (call === 'bun run db:migrate --report-json') return ok('AI_CLI_HUB_DB_REPORT={"applied":[]}')
    return ok()
  }
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
    expect(preview).toContain('git diff --shortstat <before>..<after>')
    expect(preview).toContain('bun install --frozen-lockfile')
    expect(preview).toContain('bun run webui:build:staged')
    expect(preview).toContain('bun run setting:migrate')
    expect(preview).toContain('bun run db:migrate')
    expect(preview).toContain('bun run webui:promote')
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
    expect(report).toContain('M src/main.ts')
    expect(report).toContain('未安排重启')
  })

  test('worktree inspection failure stops before pull', async () => {
    const calls: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand(command, args) {
        calls.push([command, ...args].join(' '))
        return { code: 128, stdout: '', stderr: 'not a git repository' }
      },
      scheduleRestart() {
        throw new Error('should not restart')
      },
    })

    const report = await runner.run()

    expect(calls).toEqual(['git status --short'])
    expect(report).toContain('工作树检查失败')
    expect(report).toContain('not a git repository')
  })

  test('unchanged update exits after pull without checks or restart', async () => {
    const calls: string[] = []
    const restarts: string[] = []
    const notices: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand(command, args) {
        calls.push([command, ...args].join(' '))
        return unchangedRevisionResult()(command, args)
      },
      async writeRestartNotice(ref) {
        notices.push(`${ref.chatId}/${ref.nativeId}`)
      },
      scheduleRestart(command, args, cwd, delayMs) {
        restarts.push(`${[command, ...args].join(' ')} | ${cwd} | ${delayMs}`)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(calls).toEqual(['git status --short', 'git rev-parse HEAD', 'git pull --ff-only', 'git rev-parse HEAD'])
    expect(notices).toEqual([])
    expect(restarts).toEqual([])
    expect(report).toContain('当前版本：`aaaaaaaa`')
    expect(report).toContain('无需重启')
  })

  test('successful update reports commits, settings keys, and database operations', async () => {
    let revisionReads = 0
    const restarts: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      async runCommand(command, args) {
        const call = [command, ...args].join(' ')
        if (call === 'git rev-parse HEAD') return ok(++revisionReads === 1 ? '1111111111111111' : '2222222222222222')
        if (call.startsWith('git diff --shortstat')) return ok(' 4 files changed, 25 insertions(+), 3 deletions(-)')
        if (call.startsWith('git log --format='))
          return ok('2222222\tfeat: add update report\n2111111\tfix: notification toggle')
        if (call === 'bun run setting:migrate --report-json')
          return ok(
            'AI_CLI_HUB_SETTINGS_REPORT={"created":false,"changed":true,"added":1,"deleted":1,"addedPaths":["http.health"],"deletedPaths":["http.legacy"]}',
          )
        if (call === 'bun run db:migrate --report-json')
          return ok('AI_CLI_HUB_DB_REPORT={"applied":[{"tag":"0020_health","changes":["services：新增字段 health"]}]}')
        return ok()
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run()

    expect(report).toContain('2 个提交 · 4 个文件 · +25 / -3')
    expect(report).toContain('`2222222` feat: add update report')
    expect(report).toContain('**新增配置**: `http.health`')
    expect(report).toContain('**删除配置**: `http.legacy`')
    expect(report).toContain('`0020_health`: services：新增字段 health')
    expect(report).not.toContain('暂存构建 WebUI')
    expect(restarts).toEqual(['pm2'])
  })

  test('restart notice failure warns but still schedules restart', async () => {
    const restarts: string[] = []
    const runner = createUpdateRunner({
      config: config(),
      platform: 'linux',
      runCommand: changedRevisionResult(),
      async writeRestartNotice() {
        throw new Error('disk full')
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run({ platform: 'telegram', chatId: 'chat-1', nativeId: 'msg-1' })

    expect(restarts).toEqual(['pm2'])
    expect(report).toContain('自更新完成')
    expect(report).toContain('写入重启通知失败：disk full')
  })

  test('failed step stops and does not schedule restart', async () => {
    const restarts: string[] = []
    const runChangedCommand = changedRevisionResult()
    const runner = createUpdateRunner({
      config: config({ UPDATE_REQUIRE_CLEAN_WORKTREE: false }),
      platform: 'linux',
      async runCommand(command, args) {
        if (command === 'bun' && args.join(' ') === 'run typecheck') {
          return { code: 2, stdout: '', stderr: 'type error' }
        }
        return runChangedCommand(command, args)
      },
      scheduleRestart(command) {
        restarts.push(command)
      },
    })

    const report = await runner.run()

    expect(restarts).toEqual([])
    expect(report).toContain('自更新失败')
    expect(report).toContain('类型检查失败')
    expect(report).toContain('type error')
  })
})
