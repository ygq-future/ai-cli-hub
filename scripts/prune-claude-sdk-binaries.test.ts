import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pruneClaudeSdkBinaries } from './prune-claude-sdk-binaries'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pruneClaudeSdkBinaries', () => {
  test('验证系统 CLI 后只删除 Claude SDK 平台二进制包', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-cli-hub-prune-'))
    tempDirs.push(root)
    const scope = path.join(root, 'node_modules', '@anthropic-ai')
    const systemClaude = path.join(root, 'system-bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    mkdirSync(path.dirname(systemClaude), { recursive: true })
    writeFileSync(systemClaude, 'system cli')

    const removable = ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl']
    for (const name of removable) {
      const dir = path.join(scope, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'claude'), 'bundled binary')
    }
    const wrapper = path.join(scope, 'claude-agent-sdk')
    const unrelated = path.join(scope, 'sdk')
    mkdirSync(wrapper, { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(path.join(wrapper, 'sdk.mjs'), 'wrapper')
    writeFileSync(path.join(unrelated, 'index.js'), 'unrelated')

    const result = pruneClaudeSdkBinaries({ root, claudeExecutablePath: systemClaude })

    expect(result.removedPackages.sort()).toEqual(removable.sort())
    expect(result.reclaimedBytes).toBeGreaterThan(0)
    expect(existsSync(wrapper)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    for (const name of removable) expect(existsSync(path.join(scope, name))).toBe(false)
  })

  test('系统 CLI 位于待删除平台包内时拒绝裁剪', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-cli-hub-prune-'))
    tempDirs.push(root)
    const bundled = path.join(
      root,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-linux-x64',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    )
    mkdirSync(path.dirname(bundled), { recursive: true })
    writeFileSync(bundled, 'bundled binary')

    expect(() => pruneClaudeSdkBinaries({ root, claudeExecutablePath: bundled })).toThrow(/待裁剪/)
    expect(existsSync(bundled)).toBe(true)
  })
})
