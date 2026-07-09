import { describe, expect, test } from 'bun:test'
import type { AppConfig } from '../config'
import { createHealthReporter, formatHealthReport, type HealthCheckResult } from './health'

const config = {
  DEFAULT_CWD: '/app',
  MEDIA_DOWNLOAD_DIR: '/app/.data/media',
} as AppConfig

function ok(name: string): HealthCheckResult {
  return { name, status: 'ok', detail: `${name} ok` }
}

describe('health reporter', () => {
  test('formats ok report with uptime and checks', async () => {
    const reporter = createHealthReporter({
      config,
      startedAt: 1_000,
      now: () => 62_000,
      checkDatabase: async () => ({ ...ok('database'), critical: true }),
      checkDirectory: async path => ok(path),
      checkCommand: async name => ok(name),
    })

    const report = await reporter.getReport()

    expect(report).toContain('Status: ok')
    expect(report).toContain('Uptime: 1m 1s')
    expect(report).toContain('OK database: database ok')
    expect(report).toContain('OK default_cwd: /app ok')
    expect(report).toContain('OK media_dir: /app/.data/media ok')
    expect(report).toContain('OK cli.claude: claude ok')
  })

  test('critical down check makes overall status down', () => {
    const report = formatHealthReport({
      status: 'down',
      uptimeMs: 0,
      checks: [
        { name: 'database', status: 'down', detail: 'connection refused', critical: true },
        { name: 'media_dir', status: 'ok', detail: 'writable' },
      ],
    })

    expect(report).toContain('Status: down')
    expect(report).toContain('DOWN database: connection refused')
  })
})
