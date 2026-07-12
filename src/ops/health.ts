/**
 * ops/health —— V2-R2 live self-check reporter.
 *
 * This module owns operational checks and formatting. Core only receives an
 * injected function that returns text for `/health`.
 */
import type { AppConfig } from '../config'

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthCheckResult {
  name: string
  status: HealthStatus
  detail: string
  critical?: boolean
}

export interface HealthReporter {
  getReport(): Promise<string>
}

export interface HealthReporterDeps {
  config: AppConfig
  startedAt: number
  checkDatabase: () => Promise<HealthCheckResult>
  checkDirectory: (path: string) => Promise<HealthCheckResult>
  checkCommand: (name: string) => Promise<HealthCheckResult>
  now?: () => number
}

export function createHealthReporter(deps: HealthReporterDeps): HealthReporter {
  const now = deps.now ?? Date.now

  return {
    async getReport(): Promise<string> {
      const checks = await Promise.all([
        deps.checkDatabase(),
        deps.checkDirectory(deps.config.MEDIA_DOWNLOAD_DIR).then(check => ({ ...check, name: 'media_dir' })),
        deps.checkCommand('claude').then(check => ({ ...check, name: 'cli.claude', critical: true })),
        deps.checkCommand('opencode').then(check => ({ ...check, name: 'cli.opencode' })),
      ])

      return formatHealthReport({
        status: overallStatus(checks),
        uptimeMs: now() - deps.startedAt,
        checks,
      })
    },
  }
}

export function formatHealthReport(input: {
  status: HealthStatus
  uptimeMs: number
  checks: HealthCheckResult[]
}): string {
  return [
    '## 🩺 服务健康检查',
    '',
    `- **总体状态**: ${statusIcon(input.status)} ${statusLabel(input.status)}`,
    `- **运行时长**: ${formatDuration(input.uptimeMs)}`,
    '',
    '### 检查项',
    ...input.checks.map(check => `- ${statusIcon(check.status)} **${check.name}** — ${check.detail}`),
  ].join('\n')
}

function overallStatus(checks: HealthCheckResult[]): HealthStatus {
  if (checks.some(check => check.critical && check.status === 'down')) return 'down'
  if (checks.some(check => check.status !== 'ok')) return 'degraded'
  return 'ok'
}

function statusIcon(status: HealthStatus): string {
  if (status === 'ok') return '✅'
  if (status === 'degraded') return '⚠️'
  return '❌'
}

function statusLabel(status: HealthStatus): string {
  if (status === 'ok') return '正常'
  if (status === 'degraded') return '部分降级'
  return '不可用'
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
