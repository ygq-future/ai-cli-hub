import { existsSync } from 'node:fs'
import path from 'node:path'

export interface SystemClaudeResolverDeps {
  which?: (command: string) => string | null
  exists?: (value: string) => boolean
}

/**
 * Resolve the separately installed Claude CLI. The Agent SDK otherwise falls
 * back to its bundled 230+ MB platform package.
 */
export function resolveSystemClaudeExecutable(configuredPath = '', deps: SystemClaudeResolverDeps = {}): string {
  const which = deps.which ?? Bun.which
  const exists = deps.exists ?? existsSync
  const configured = configuredPath.trim()
  const candidate = configured || which('claude')

  if (!candidate) {
    throw new Error(
      '未找到系统 Claude CLI。请先安装 Claude Code 并确保 claude 在 PATH 中，或在 settings.json 的 session.claudeExecutablePath 配置绝对路径。',
    )
  }

  const resolved = path.resolve(candidate)
  if (!exists(resolved)) {
    throw new Error(`系统 Claude CLI 不存在：${resolved}`)
  }
  return resolved
}
