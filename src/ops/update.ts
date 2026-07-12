/**
 * ops/update —— controlled self-update runner.
 *
 * `/update` is intentionally two-step: preview first, explicit confirmation
 * before running commands that modify the deployment.
 */
import type { AppConfig } from '../config'
import type { MessageRef } from '../shared'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandSpec {
  label: string
  command: string
  args: string[]
  critical?: boolean
}

export interface UpdateRunner {
  preview(): string
  run(ref?: MessageRef): Promise<string>
}

export interface UpdateRunnerDeps {
  config: AppConfig
  runCommand: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<CommandResult>
  writeRestartNotice?: (ref: MessageRef) => Promise<void>
  scheduleRestart: (command: string, args: string[], cwd: string, delayMs: number) => void
  platform?: NodeJS.Platform
}

const FAILURE_OUTPUT_PREVIEW_CHARS = 1000
const WINDOWS_UNSUPPORTED_MESSAGE =
  '自更新只适用于 Linux/VPS 部署环境；当前是 Windows。请在 VPS 上执行 /update，或在本机手动运行 git pull / bun install / 检查命令。'

export function createUpdateRunner(deps: UpdateRunnerDeps): UpdateRunner {
  const steps = createUpdateSteps()
  const platform = deps.platform ?? process.platform

  return {
    preview(): string {
      if (platform === 'win32') return formatUpdateUnsupported()
      return formatUpdatePreview({
        workdir: deps.config.UPDATE_WORKDIR,
        requireCleanWorktree: deps.config.UPDATE_REQUIRE_CLEAN_WORKTREE,
        steps,
        restartCommand: deps.config.UPDATE_RESTART_COMMAND,
        restartArgs: deps.config.UPDATE_RESTART_ARGS,
        restartDelayMs: deps.config.UPDATE_RESTART_DELAY_MS,
      })
    },

    async run(ref?: MessageRef): Promise<string> {
      if (platform === 'win32') return formatUpdateUnsupported()

      const results: UpdateStepResult[] = []

      if (deps.config.UPDATE_REQUIRE_CLEAN_WORKTREE) {
        const status = await runStep(deps, {
          label: 'check clean worktree',
          command: 'git',
          args: ['status', '--short'],
          critical: true,
        })
        results.push(status)
        if (status.result.stdout.trim()) {
          return formatUpdateFailure(results, '工作树存在未提交的跟踪文件变更，已停止更新。请先处理变更后重试。')
        }
      }

      for (const step of steps) {
        const result = await runStep(deps, step)
        results.push(result)
        if (result.result.code !== 0) {
          return formatUpdateFailure(results, `${step.label} 失败，已停止更新。`)
        }
      }

      const restart = formatCommand(deps.config.UPDATE_RESTART_COMMAND, deps.config.UPDATE_RESTART_ARGS)
      if (deps.config.UPDATE_RESTART_COMMAND.trim()) {
        if (ref && deps.writeRestartNotice) {
          try {
            await deps.writeRestartNotice(ref)
          } catch (err) {
            return formatUpdateFailure(
              results,
              `写入重启通知标记失败：${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        deps.scheduleRestart(
          deps.config.UPDATE_RESTART_COMMAND,
          deps.config.UPDATE_RESTART_ARGS,
          deps.config.UPDATE_WORKDIR,
          deps.config.UPDATE_RESTART_DELAY_MS,
        )
        return formatUpdateSuccess(results, restart, deps.config.UPDATE_RESTART_DELAY_MS)
      }

      return formatUpdateSuccess(results, null, null)
    },
  }
}

function createUpdateSteps(): CommandSpec[] {
  return [
    { label: 'git pull', command: 'git', args: ['pull', '--ff-only'], critical: true },
    { label: 'install dependencies', command: 'bun', args: ['install', '--frozen-lockfile'], critical: true },
    { label: 'settings migration', command: 'bun', args: ['run', 'setting:migrate'], critical: true },
    { label: 'database migration', command: 'bun', args: ['run', 'db:migrate'], critical: true },
    { label: 'format check', command: 'bun', args: ['run', 'format:check'], critical: true },
    { label: 'typecheck', command: 'bun', args: ['run', 'typecheck'], critical: true },
    { label: 'lint', command: 'bun', args: ['run', 'lint'], critical: true },
    { label: 'prune bundled Claude CLI', command: 'bun', args: ['run', 'deps:prune'], critical: true },
  ]
}

interface UpdateStepResult {
  step: CommandSpec
  result: CommandResult
}

async function runStep(deps: UpdateRunnerDeps, step: CommandSpec): Promise<UpdateStepResult> {
  const result = await deps
    .runCommand(step.command, step.args, deps.config.UPDATE_WORKDIR, deps.config.UPDATE_COMMAND_TIMEOUT_MS)
    .catch((err: unknown) => ({
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }))
  return { step, result }
}

function formatUpdatePreview(input: {
  workdir: string
  requireCleanWorktree: boolean
  steps: CommandSpec[]
  restartCommand: string
  restartArgs: string[]
  restartDelayMs: number
}): string {
  const commands = [
    ...(input.requireCleanWorktree ? ['git status --short'] : []),
    ...input.steps.map(step => formatCommand(step.command, step.args)),
  ]
  const restart = input.restartCommand.trim()
    ? `${formatCommand(input.restartCommand, input.restartArgs)} after ${input.restartDelayMs}ms`
    : 'manual restart required'

  return [
    '## 🔄 自更新预检',
    '',
    `- **工作目录**: \`${input.workdir}\``,
    `- **工作树要求**: ${input.requireCleanWorktree ? '必须干净' : '不检查'}`,
    '',
    '### 将执行',
    ...commands.map((command, index) => `${index + 1}. \`${command}\``),
    '',
    '### 重启安排',
    `- \`${restart}\``,
    '',
    '> 确认执行请发送 `/update confirm`。',
  ].join('\n')
}

function formatUpdateSuccess(results: UpdateStepResult[], restart: string | null, delayMs: number | null): string {
  return [
    '## ✅ 自更新完成',
    '',
    `已完成 **${results.length}** 项检查与更新。`,
    '',
    '### 执行结果',
    ...results.map(formatStepSuccess),
    '',
    '### 重启安排',
    restart && delayMs != null
      ? `- **命令**: \`${restart}\`\n- **延迟**: ${formatDelay(delayMs)}\n\n> 服务恢复后会主动通知此聊天。`
      : '> 未配置自动重启命令；请手动重启服务以加载更新。',
  ].join('\n')
}

function formatUpdateFailure(results: UpdateStepResult[], reason: string): string {
  const failed = results.find(result => result.result.code !== 0)
  const diagnostic = failed ? commandOutputPreview(failed.result) : ''
  return [
    '## ❌ 自更新失败',
    '',
    results.length ? '### 已执行' : '',
    ...results.filter(result => result.result.code === 0).map(formatStepSuccess),
    '',
    `> ${reason}`,
    diagnostic ? `\n**诊断信息**\n\`\`\`\n${diagnostic}\n\`\`\`` : '',
    '未安排重启，当前服务继续运行。',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatUpdateUnsupported(): string {
  return ['## ⚠️ 自更新不可用', '', WINDOWS_UNSUPPORTED_MESSAGE, '', '未执行任何命令，未安排重启。'].join('\n')
}

function commandOutputPreview(result: CommandResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  if (!text) return ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= FAILURE_OUTPUT_PREVIEW_CHARS) return normalized
  return `${normalized.slice(0, FAILURE_OUTPUT_PREVIEW_CHARS - 3)}...`
}

function formatStepSuccess({ step }: UpdateStepResult): string {
  return `- ✅ **${formatStepLabel(step.label)}**`
}

function formatStepLabel(label: string): string {
  const labels: Record<string, string> = {
    'check clean worktree': '工作树检查',
    'git pull': '拉取最新代码',
    'install dependencies': '同步依赖',
    'settings migration': '同步配置模板',
    'database migration': '数据库迁移',
    'format check': '代码格式检查',
    typecheck: '类型检查',
    lint: '静态检查',
    'prune bundled Claude CLI': '裁剪 SDK 内置 Claude CLI',
  }
  return labels[label] ?? label
}

function formatDelay(delayMs: number): string {
  return delayMs % 1000 === 0 ? `${delayMs / 1000} 秒` : `${(delayMs / 1000).toFixed(1)} 秒`
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}
