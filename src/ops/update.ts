/**
 * ops/update —— controlled self-update runner.
 *
 * `/update` is intentionally two-step: preview first, explicit confirmation
 * before running commands that modify the deployment.
 */
import type { AppConfig } from '../config'
import type { AgentActivityState, MessageRef } from '../shared'
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
  preview(onProgress?: (action: { state: AgentActivityState; detail?: string }) => void): Promise<string>
  run(ref?: MessageRef, onProgress?: (action: { state: AgentActivityState; detail?: string }) => void): Promise<string>
}

export interface UpdateRunnerDeps {
  config: AppConfig
  runCommand: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<CommandResult>
  writeRestartNotice?: (ref: MessageRef) => Promise<void>
  scheduleRestart: (command: string, args: string[], cwd: string, delayMs: number) => void
  platform?: NodeJS.Platform
  onProgress?: (action: { state: AgentActivityState; detail?: string }) => void
}
const FAILURE_OUTPUT_PREVIEW_CHARS = 1000
const SETTINGS_REPORT_PREFIX = 'AI_CLI_HUB_SETTINGS_REPORT='
const DB_REPORT_PREFIX = 'AI_CLI_HUB_DB_REPORT='
const MAX_COMMITS = 12
const MAX_SETTING_PATHS = 12
const MAX_MIGRATION_CHANGES = 8
const WINDOWS_UNSUPPORTED_MESSAGE =
  '自更新只适用于 Linux/VPS 部署环境；当前是 Windows。请在 VPS 上执行 /update，或在本机手动运行 git pull / bun install / 检查命令。'

export function createUpdateRunner(deps: UpdateRunnerDeps): UpdateRunner {
  const steps = createUpdateSteps()
  const platform = deps.platform ?? process.platform

  return {
    async preview(onProgress?: (action: { state: AgentActivityState; detail?: string }) => void): Promise<string> {
      if (platform === 'win32') return formatUpdateUnsupported()
      const progress = onProgress ?? deps.onProgress
      try {
        const results: UpdateStepResult[] = []

        let dirtyWarning: string | null = null
        let worktreeStatus = '未检查'
        const status = await runStep(
          deps,
          {
            label: 'check clean worktree',
            command: 'git',
            args: ['status', '--short'],
            critical: false,
          },
          progress,
        )
        results.push(status)
        if (status.result.code === 0) {
          if (status.result.stdout.trim()) {
            worktreeStatus = '存在未提交变更'
            dirtyWarning = '工作树存在未提交的变更，更新可能冲突或被阻止。'
          } else {
            worktreeStatus = '干净'
          }
        }

        const currentRev = await runStep(deps, revisionStep('read current revision'), progress)
        results.push(currentRev)
        if (currentRev.result.code !== 0) {
          return formatUpdateFailure(results, '读取当前本地版本失败。')
        }
        const beforeHash = currentRev.result.stdout.trim()

        const fetchStep = await runStep(
          deps,
          {
            label: 'fetch remote updates',
            command: 'git',
            args: ['fetch'],
            critical: true,
          },
          progress,
        )
        results.push(fetchStep)
        if (fetchStep.result.code !== 0) {
          return formatUpdateFailure(results, '拉取远程更新信息失败，请检查网络连接或远程仓库配置。')
        }

        const upstreamRev = await runStep(
          deps,
          {
            label: 'read upstream revision',
            command: 'git',
            args: ['rev-parse', '@{upstream}'],
            critical: true,
          },
          progress,
        )
        results.push(upstreamRev)
        let targetRef = '@{upstream}'
        let afterHash = upstreamRev.result.stdout.trim()
        if (upstreamRev.result.code !== 0 || !afterHash) {
          const fallbackRev = await runStep(
            deps,
            {
              label: 'read origin/main revision',
              command: 'git',
              args: ['rev-parse', 'origin/main'],
              critical: true,
            },
            progress,
          )
          results.push(fallbackRev)
          if (fallbackRev.result.code === 0 && fallbackRev.result.stdout.trim()) {
            targetRef = 'origin/main'
            afterHash = fallbackRev.result.stdout.trim()
          } else {
            return formatUpdateFailure(results, '未检测到远程追踪分支（@{upstream} 或 origin/main）。')
          }
        }

        const logStep = await runStep(
          deps,
          {
            label: 'inspect commits',
            command: 'git',
            args: ['log', '--format=%h%x09%s', '-n', String(MAX_COMMITS), `HEAD..${targetRef}`],
            critical: true,
          },
          progress,
        )
        results.push(logStep)
        const commits = parseGitCommits(logStep.result.stdout)

        if (beforeHash === afterHash || commits.length === 0) {
          return formatPreviewUpToDate({
            revision: shortHash(beforeHash),
            worktreeStatus,
            dirtyWarning,
          })
        }

        const diffStatStep = await runStep(
          deps,
          {
            label: 'inspect code changes',
            command: 'git',
            args: ['diff', '--shortstat', `HEAD..${targetRef}`],
            critical: true,
          },
          progress,
        )
        results.push(diffStatStep)
        const shortstat = diffStatStep.result.stdout.trim()

        const diffNamesStep = await runStep(
          deps,
          {
            label: 'inspect changed files',
            command: 'git',
            args: ['diff', '--name-only', `HEAD..${targetRef}`],
            critical: true,
          },
          progress,
        )
        results.push(diffNamesStep)
        const changedFiles = diffNamesStep.result.stdout
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean)

        const actions: string[] = []
        if (changedFiles.some(f => f === 'package.json' || f === 'bun.lock')) {
          actions.push('依赖同步 (`bun install --frozen-lockfile`)')
        }
        if (changedFiles.some(f => f.startsWith('src/webui/'))) {
          actions.push('WebUI 构建 (`bun run webui:build:staged` -> `promote`)')
        }
        if (changedFiles.some(f => f.startsWith('settings.json.example') || f.startsWith('scripts/setting'))) {
          actions.push('配置迁移 (`bun run setting:migrate`)')
        }
        if (changedFiles.some(f => f.startsWith('drizzle/') || f.startsWith('src/storage/schema/'))) {
          actions.push('数据库迁移 (`bun run db:migrate`)')
        }

        const restart = deps.config.UPDATE_RESTART_COMMAND.trim()
          ? `${formatCommand(deps.config.UPDATE_RESTART_COMMAND, deps.config.UPDATE_RESTART_ARGS)} after ${deps.config.UPDATE_RESTART_DELAY_MS}ms`
          : '手动重启'

        return formatPreviewWithUpdates({
          beforeRevision: shortHash(beforeHash),
          afterRevision: shortHash(afterHash),
          commits,
          shortstat,
          actions,
          restartCommand: restart,
          worktreeStatus,
          dirtyWarning,
        })
      } finally {
        progress?.({ state: 'idle' })
      }
    },

    async run(
      ref?: MessageRef,
      onProgress?: (action: { state: AgentActivityState; detail?: string }) => void,
    ): Promise<string> {
      if (platform === 'win32') return formatUpdateUnsupported()
      const progress = onProgress ?? deps.onProgress
      try {
        const results: UpdateStepResult[] = []

        if (deps.config.UPDATE_REQUIRE_CLEAN_WORKTREE) {
          const status = await runStep(
            deps,
            {
              label: 'check clean worktree',
              command: 'git',
              args: ['status', '--short'],
              critical: true,
            },
            progress,
          )
          results.push(status)
          if (status.result.code !== 0) {
            return formatUpdateFailure(results, '工作树检查失败，已停止更新。')
          }
          if (status.result.stdout.trim()) {
            return formatUpdateFailure(results, '工作树存在未提交的跟踪文件变更，已停止更新。请先处理变更后重试。')
          }
        }

        const beforeRevision = await runStep(deps, revisionStep('read current revision'), progress)
        results.push(beforeRevision)
        if (beforeRevision.result.code !== 0) {
          return formatUpdateFailure(results, '读取更新前版本失败，已停止更新。')
        }

        const pull = await runStep(deps, steps[0]!, progress)
        results.push(pull)
        if (pull.result.code !== 0) return formatUpdateFailure(results, '拉取最新代码失败，已停止更新。')

        const afterRevision = await runStep(deps, revisionStep('read updated revision'), progress)
        results.push(afterRevision)
        if (afterRevision.result.code !== 0) {
          return formatUpdateFailure(results, '读取更新后版本失败，已停止更新。')
        }

        const git = await inspectGitUpdate(
          deps,
          results,
          beforeRevision.result.stdout,
          afterRevision.result.stdout,
          progress,
        )
        if (typeof git === 'string') return formatUpdateFailure(results, git)
        if (git.before === git.after) return formatNoUpdate(git.after)

        let settings: SettingsMigrationReport | null = null
        let database: DatabaseMigrationReport | null = null
        for (const step of steps.slice(1)) {
          const result = await runStep(deps, step, progress)
          results.push(result)
          if (result.result.code !== 0) {
            return formatUpdateFailure(results, `${formatStepLabel(step.label)}失败，已停止更新。`)
          }
          if (step.label === 'settings migration') {
            settings = extractJsonMarker<SettingsMigrationReport>(result.result.stdout, SETTINGS_REPORT_PREFIX)
            if (!settings) return formatUpdateFailure(results, '配置迁移报告缺失或损坏，已停止更新。')
          }
          if (step.label === 'database migration') {
            database = extractJsonMarker<DatabaseMigrationReport>(result.result.stdout, DB_REPORT_PREFIX)
            if (!database) return formatUpdateFailure(results, '数据库迁移报告缺失或损坏，已停止更新。')
          }
        }

        const restart = formatCommand(deps.config.UPDATE_RESTART_COMMAND, deps.config.UPDATE_RESTART_ARGS)
        if (deps.config.UPDATE_RESTART_COMMAND.trim()) {
          progress?.({ state: 'executing', detail: 'schedule restart' })
          let restartNoticeWarning: string | null = null
          if (ref && deps.writeRestartNotice) {
            try {
              await deps.writeRestartNotice(ref)
            } catch (err) {
              restartNoticeWarning = `写入重启通知失败：${err instanceof Error ? err.message : String(err)}`
            }
          }
          deps.scheduleRestart(
            deps.config.UPDATE_RESTART_COMMAND,
            deps.config.UPDATE_RESTART_ARGS,
            deps.config.UPDATE_WORKDIR,
            deps.config.UPDATE_RESTART_DELAY_MS,
          )
          return formatUpdateSuccess(
            { git, settings, database, restart, delayMs: deps.config.UPDATE_RESTART_DELAY_MS },
            restartNoticeWarning,
          )
        }

        return formatUpdateSuccess({ git, settings, database, restart: null, delayMs: null })
      } finally {
        progress?.({ state: 'idle' })
      }
    },
  }
}

function revisionStep(label: string): CommandSpec {
  return { label, command: 'git', args: ['rev-parse', 'HEAD'], critical: true }
}

function createUpdateSteps(): CommandSpec[] {
  return [
    { label: 'git pull', command: 'git', args: ['pull', '--ff-only'], critical: true },
    { label: 'install dependencies', command: 'bun', args: ['install', '--frozen-lockfile'], critical: true },
    { label: 'format check', command: 'bun', args: ['run', 'format:check'], critical: true },
    { label: 'typecheck', command: 'bun', args: ['run', 'typecheck'], critical: true },
    { label: 'lint', command: 'bun', args: ['run', 'lint'], critical: true },
    { label: 'build staged webui', command: 'bun', args: ['run', 'webui:build:staged'], critical: true },
    { label: 'settings migration', command: 'bun', args: ['run', 'setting:migrate', '--report-json'], critical: true },
    { label: 'database migration', command: 'bun', args: ['run', 'db:migrate', '--report-json'], critical: true },
    { label: 'promote webui', command: 'bun', args: ['run', 'webui:promote'], critical: true },
  ]
}

interface UpdateStepResult {
  step: CommandSpec
  result: CommandResult
}

interface GitUpdateReport {
  before: string
  after: string
  diffStat: string
  commits: Array<{ hash: string; subject: string }>
}

interface SettingsMigrationReport {
  created: boolean
  changed: boolean
  added: number
  deleted: number
  addedPaths: string[]
  deletedPaths: string[]
}

interface DatabaseMigrationReport {
  applied: Array<{ tag: string; changes: string[] }>
}

interface UpdateReport {
  git: GitUpdateReport
  settings: SettingsMigrationReport | null
  database: DatabaseMigrationReport | null
  restart: string | null
  delayMs: number | null
}

async function inspectGitUpdate(
  deps: UpdateRunnerDeps,
  results: UpdateStepResult[],
  beforeOutput: string,
  afterOutput: string,
  onProgress?: (action: { state: AgentActivityState; detail?: string }) => void,
): Promise<GitUpdateReport | string> {
  const before = beforeOutput.trim()
  const after = afterOutput.trim()
  if (!before || !after) return 'Git 版本信息为空，已停止更新。'
  if (before === after) return { before, after, diffStat: '', commits: [] }

  const range = `${before}..${after}`
  const diff = await runStep(
    deps,
    {
      label: 'inspect code changes',
      command: 'git',
      args: ['diff', '--shortstat', range],
      critical: true,
    },
    onProgress,
  )
  results.push(diff)
  if (diff.result.code !== 0) return '统计代码变更失败，已停止更新。'

  const log = await runStep(
    deps,
    {
      label: 'inspect commits',
      command: 'git',
      args: ['log', '--format=%h%x09%s', range],
      critical: true,
    },
    onProgress,
  )
  results.push(log)
  if (log.result.code !== 0) return '读取更新提交失败，已停止更新。'

  return {
    before,
    after,
    diffStat: diff.result.stdout.trim(),
    commits: parseGitCommits(log.result.stdout),
  }
}

const ACTION_DETAIL_BY_LABEL: Record<string, string> = {
  'check clean worktree': 'git status',
  'fetch remote updates': 'git fetch',
  'git pull': 'git pull --ff-only',
  'install dependencies': 'bun install --frozen-lockfile',
  'format check': 'bun run format:check',
  typecheck: 'bun run typecheck',
  lint: 'bun run lint',
  'build staged webui': 'bun run webui:build:staged',
  'settings migration': 'bun run setting:migrate',
  'database migration': 'bun run db:migrate',
  'promote webui': 'bun run webui:promote',
  'inspect diff stat': 'git diff --stat',
  'inspect code changes': 'git diff --stat',
  'inspect changed files': 'git diff',
  'inspect commits': 'git log',
  'read current revision': 'git rev-parse HEAD',
  'read updated revision': 'git rev-parse HEAD',
  'read upstream revision': 'git rev-parse @{upstream}',
  'read origin/main revision': 'git rev-parse origin/main',
}

export function formatActionDetail(step: CommandSpec): string {
  return ACTION_DETAIL_BY_LABEL[step.label] ?? formatCommand(step.command, step.args)
}

async function runStep(
  deps: UpdateRunnerDeps,
  step: CommandSpec,
  onProgress?: (action: { state: AgentActivityState; detail?: string }) => void,
): Promise<UpdateStepResult> {
  const progress = onProgress ?? deps.onProgress
  progress?.({
    state: 'executing',
    detail: formatActionDetail(step),
  })
  const result = await deps
    .runCommand(step.command, step.args, deps.config.UPDATE_WORKDIR, deps.config.UPDATE_COMMAND_TIMEOUT_MS)
    .catch((err: unknown) => ({
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }))
  return { step, result }
}
function parseGitCommits(stdout: string): Array<{ hash: string; subject: string }> {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [hash = '', ...subject] = line.split('\t')
      return { hash, subject: subject.join('\t') || '(无提交说明)' }
    })
}

function formatPreviewUpToDate(input: {
  revision: string
  worktreeStatus?: string
  dirtyWarning: string | null
}): string {
  const lines = [
    '## 🔄 自更新预检',
    '',
    `当前已是最新版本（\`${input.revision}\`），暂无待更新内容。`,
    `- **工作树**: ${input.worktreeStatus ?? '干净'}`,
  ]
  if (input.dirtyWarning) {
    lines.push('', `⚠️ **注意**: ${input.dirtyWarning}`)
  }
  return lines.join('\n')
}

function formatPreviewWithUpdates(input: {
  beforeRevision: string
  afterRevision: string
  commits: Array<{ hash: string; subject: string }>
  shortstat: string
  actions: string[]
  restartCommand: string
  worktreeStatus?: string
  dirtyWarning: string | null
}): string {
  const commitLines = input.commits.length
    ? input.commits.map(c => `- \`${c.hash}\` ${c.subject}`)
    : ['- （无新提交记录）']

  const actionLines = input.actions.length
    ? input.actions.map(a => `- ${a}`)
    : ['- 代码更新（无依赖、数据库或配置迁移步骤）']

  const lines = [
    '## 🔄 自更新预检',
    '',
    `发现待更新提交（\`${input.beforeRevision}\` → \`${input.afterRevision}\`）：`,
    '',
    '### 待更新提交',
    ...commitLines,
    '',
    '### 变动概览',
    ...(input.shortstat ? [`- **统计**: ${input.shortstat}`] : []),
    `- **工作树**: ${input.worktreeStatus ?? '干净'}`,
    '- **触发操作**:',
    ...actionLines.map(line => `  ${line}`),
    `- **重启安排**: \`${input.restartCommand}\``,
  ]
  if (input.dirtyWarning) {
    lines.push('', `⚠️ **警告**: ${input.dirtyWarning}`)
  }
  lines.push('', '> 确认执行请发送 `/update confirm`。')
  return lines.join('\n')
}
function formatUpdateSuccess(report: UpdateReport, warning: string | null = null): string {
  const sections = [
    formatGitReport(report.git),
    formatSettingsReport(report.settings),
    formatDatabaseReport(report.database),
  ]
    .filter(Boolean)
    .join('\n\n')
  return [
    '## ✅ 自更新完成',
    '',
    sections,
    warning ? `\n> ⚠️ ${warning}` : '',
    '',
    '### 重启安排',
    report.restart && report.delayMs != null
      ? `- **命令**: \`${report.restart}\`\n- **延迟**: ${formatDelay(report.delayMs)}\n\n> 服务恢复后会主动通知此聊天。`
      : '> 未配置自动重启命令；请手动重启服务以加载更新。',
  ]
    .filter(value => value !== '')
    .join('\n')
}

function formatUpdateFailure(results: UpdateStepResult[], reason: string): string {
  const failed = results.find(result => result.result.code !== 0)
  const diagnosticSource =
    failed ?? [...results].reverse().find(result => result.result.stdout.trim() || result.result.stderr.trim())
  const diagnostic = diagnosticSource ? commandOutputPreview(diagnosticSource.result) : ''
  return [
    '## ❌ 自更新失败',
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

function formatNoUpdate(revision: string): string {
  return [
    '## ✅ 已是最新版本',
    '',
    `当前版本：\`${shortHash(revision)}\`。`,
    '',
    '> 未发现新提交，已跳过依赖同步、检查、构建和迁移，无需重启。',
  ].join('\n')
}

function commandOutputPreview(result: CommandResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  if (!text) return ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= FAILURE_OUTPUT_PREVIEW_CHARS) return normalized
  return `${normalized.slice(0, FAILURE_OUTPUT_PREVIEW_CHARS - 3)}...`
}

function formatStepLabel(label: string): string {
  const labels: Record<string, string> = {
    'check clean worktree': '工作树检查',
    'git pull': '拉取最新代码',
    'install dependencies': '同步依赖',
    'build staged webui': '暂存构建 WebUI',
    'promote webui': '切换 WebUI 构建产物',
    'settings migration': '同步配置模板',
    'database migration': '数据库迁移',
    'format check': '代码格式检查',
    typecheck: '类型检查',
    lint: '静态检查',
    'read current revision': '读取当前版本',
    'read updated revision': '读取更新版本',
    'inspect code changes': '统计代码变更',
    'fetch remote updates': '拉取远程更新',
    'read upstream revision': '读取远程追踪版本',
    'read origin/main revision': '读取远端主分支版本',
    'inspect changed files': '检测变更文件',
    'inspect commits': '读取更新提交',
  }
  return labels[label] ?? label
}

function formatDelay(delayMs: number): string {
  return delayMs % 1000 === 0 ? `${delayMs / 1000} 秒` : `${(delayMs / 1000).toFixed(1)} 秒`
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}

function formatGitReport(report: GitUpdateReport): string {
  const current = shortHash(report.after)
  if (report.before === report.after) {
    return ['### 代码更新', `- 已是最新版本 \`${current}\`，没有新提交。`].join('\n')
  }
  const commits = report.commits.slice(0, MAX_COMMITS)
  const hidden = report.commits.length - commits.length
  return [
    '### 代码更新',
    `- **版本**: \`${shortHash(report.before)}\` → \`${current}\``,
    `- **变更**: ${report.commits.length} 个提交${report.diffStat ? ` · ${formatGitDiffStat(report.diffStat)}` : ''}`,
    '- **提交**:',
    ...commits.map(commit => `  - \`${commit.hash}\` ${commit.subject}`),
    hidden > 0 ? `  - 另有 ${hidden} 个提交未展开` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function formatSettingsReport(report: SettingsMigrationReport | null): string {
  if (!report?.changed) return ''
  const lines = ['### 配置模板']
  if (report.created) lines.push('- 已创建 `settings.json`。')
  if (report.addedPaths.length) lines.push(`- **新增配置**: ${formatPathList(report.addedPaths, report.added)}`)
  if (report.deletedPaths.length) lines.push(`- **删除配置**: ${formatPathList(report.deletedPaths, report.deleted)}`)
  return lines.join('\n')
}

function formatDatabaseReport(report: DatabaseMigrationReport | null): string {
  if (!report?.applied.length) return ''
  return [
    '### 数据库迁移',
    `已应用 **${report.applied.length}** 个迁移：`,
    ...report.applied.map(migration => {
      const changes = migration.changes.slice(0, MAX_MIGRATION_CHANGES)
      const hidden = migration.changes.length - changes.length
      const description = [...changes, hidden > 0 ? `另有 ${hidden} 项变更` : ''].filter(Boolean).join('；')
      return `- \`${migration.tag}\`: ${description || '迁移已执行'}`
    }),
  ].join('\n')
}

function formatPathList(paths: string[], total: number): string {
  const shown = paths.slice(0, MAX_SETTING_PATHS).map(path => `\`${path}\``)
  const hidden = Math.max(total - shown.length, 0)
  return `${shown.join('、')}${hidden ? `，另有 ${hidden} 项` : ''}`
}

function formatGitDiffStat(value: string): string {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(value)
  if (!match) return value
  return `${match[1]} 个文件 · +${match[2] ?? '0'} / -${match[3] ?? '0'}`
}

function shortHash(value: string): string {
  return value.slice(0, 8)
}

function extractJsonMarker<T>(stdout: string, prefix: string): T | null {
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
  if (!line) return null
  try {
    return JSON.parse(line.slice(prefix.length)) as T
  } catch {
    return null
  }
}
