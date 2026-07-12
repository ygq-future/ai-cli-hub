/**
 * ops/restart —— controlled restart runner.
 *
 * This is intentionally separate from `/update`: it exercises the same restart
 * and startup notification path without pulling code or running migrations.
 */
import type { AppConfig } from '../config'
import type { MessageRef } from '../shared'

export interface RestartRunner {
  preview(): string
  run(ref: MessageRef): Promise<string>
}

export interface RestartRunnerDeps {
  config: AppConfig
  writeRestartNotice?: (ref: MessageRef) => Promise<void>
  scheduleRestart: (command: string, args: string[], cwd: string, delayMs: number) => void
  platform?: NodeJS.Platform
}

const WINDOWS_UNSUPPORTED_MESSAGE =
  '重启命令只适用于 Linux/VPS 部署环境；当前是 Windows。请在 VPS 上执行 /restart，或在本机手动重启服务进程。'

export function createRestartRunner(deps: RestartRunnerDeps): RestartRunner {
  const platform = deps.platform ?? process.platform

  return {
    preview(): string {
      if (platform === 'win32') return formatRestartUnsupported()
      return formatRestartPreview({
        workdir: deps.config.UPDATE_WORKDIR,
        restartCommand: deps.config.UPDATE_RESTART_COMMAND,
        restartArgs: deps.config.UPDATE_RESTART_ARGS,
        restartDelayMs: deps.config.UPDATE_RESTART_DELAY_MS,
      })
    },

    async run(ref: MessageRef): Promise<string> {
      if (platform === 'win32') return formatRestartUnsupported()

      const restart = formatCommand(deps.config.UPDATE_RESTART_COMMAND, deps.config.UPDATE_RESTART_ARGS)
      if (!deps.config.UPDATE_RESTART_COMMAND.trim()) {
        return ['## ⚠️ 重启未安排', '', '`UPDATE_RESTART_COMMAND` 为空；请手动重启服务。'].join('\n')
      }

      if (deps.writeRestartNotice) {
        try {
          await deps.writeRestartNotice(ref)
        } catch (err) {
          return [
            '## ❌ 重启失败',
            '',
            `写入重启通知标记失败：${err instanceof Error ? err.message : String(err)}`,
            '未安排重启。',
          ].join('\n')
        }
      }

      deps.scheduleRestart(
        deps.config.UPDATE_RESTART_COMMAND,
        deps.config.UPDATE_RESTART_ARGS,
        deps.config.UPDATE_WORKDIR,
        deps.config.UPDATE_RESTART_DELAY_MS,
      )

      return [
        '## 🔄 重启已安排',
        '',
        `- **命令**: \`${restart}\``,
        `- **延迟**: ${formatDelay(deps.config.UPDATE_RESTART_DELAY_MS)}`,
        '',
        '> 服务将交给守护器重启；恢复后会主动通知此聊天。',
      ].join('\n')
    },
  }
}

function formatRestartPreview(input: {
  workdir: string
  restartCommand: string
  restartArgs: string[]
  restartDelayMs: number
}): string {
  const restart = input.restartCommand.trim()
    ? `${formatCommand(input.restartCommand, input.restartArgs)} after ${input.restartDelayMs}ms`
    : 'manual restart required'

  return [
    '## 🔄 重启预检',
    '',
    `- **工作目录**: \`${input.workdir}\``,
    `- **重启命令**: \`${restart}\``,
    '',
    '> 确认执行请发送 `/restart confirm`。',
  ].join('\n')
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

function formatDelay(delayMs: number): string {
  return delayMs % 1000 === 0 ? `${delayMs / 1000} 秒` : `${(delayMs / 1000).toFixed(1)} 秒`
}

function formatRestartUnsupported(): string {
  return ['## ⚠️ 重启不可用', '', WINDOWS_UNSUPPORTED_MESSAGE, '', '未执行任何命令，未安排重启。'].join('\n')
}
