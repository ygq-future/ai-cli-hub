/**
 * Remove Agent SDK bundled Claude CLI packages after verifying that a separate
 * system Claude executable is available. Bun cannot omit only this optional
 * dependency family, so global `--omit optional` would also break PDF canvas.
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveSystemClaudeExecutable } from '../src/cli/claude/system-claude'
import { loadConfig } from '../src/config'

const NATIVE_PACKAGE = /^claude-agent-sdk-(?:darwin|linux|win32)-(?:arm64|x64)(?:-musl)?$/

export interface PruneClaudeSdkOptions {
  root?: string
  claudeExecutablePath?: string
}

export interface PruneClaudeSdkResult {
  claudeExecutablePath: string
  removedPackages: string[]
  reclaimedBytes: number
}

function directorySize(target: string): number {
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name)
    if (entry.isDirectory()) total += directorySize(entryPath)
    else if (entry.isFile()) total += statSync(entryPath).size
  }
  return total
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function pruneClaudeSdkBinaries(options: PruneClaudeSdkOptions = {}): PruneClaudeSdkResult {
  const root = path.resolve(options.root ?? process.cwd())
  const configuredPath = options.claudeExecutablePath ?? loadConfig().CLAUDE_EXECUTABLE_PATH
  const claudeExecutablePath = realpathSync(resolveSystemClaudeExecutable(configuredPath))
  const scope = path.join(root, 'node_modules', '@anthropic-ai')
  if (!existsSync(scope)) return { claudeExecutablePath, removedPackages: [], reclaimedBytes: 0 }

  const packages = readdirSync(scope, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && NATIVE_PACKAGE.test(entry.name))
    .map(entry => ({ name: entry.name, path: path.join(scope, entry.name) }))

  for (const pkg of packages) {
    const packagePath = realpathSync(pkg.path)
    if (isWithin(packagePath, claudeExecutablePath)) {
      throw new Error(`系统 Claude CLI 位于待裁剪包内，拒绝删除：${claudeExecutablePath}`)
    }
  }

  let reclaimedBytes = 0
  for (const pkg of packages) {
    reclaimedBytes += directorySize(pkg.path)
    rmSync(pkg.path, { recursive: true, force: true })
  }

  return { claudeExecutablePath, removedPackages: packages.map(pkg => pkg.name), reclaimedBytes }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

if (import.meta.main) {
  const result = pruneClaudeSdkBinaries()
  const packageSummary = result.removedPackages.length ? result.removedPackages.join(', ') : 'none'
  process.stdout.write(
    `System Claude: ${result.claudeExecutablePath}\nRemoved packages: ${packageSummary}\nReclaimed: ${formatBytes(result.reclaimedBytes)}\n`,
  )
}
