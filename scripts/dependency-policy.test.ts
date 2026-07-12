import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

interface PackageManifest {
  name?: string
  version?: string
  optionalDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

function readJson(filePath: string): PackageManifest {
  return JSON.parse(readFileSync(filePath, 'utf8')) as PackageManifest
}

describe('Claude Agent SDK dependency policy', () => {
  test('所有 SDK 平台 CLI 包都在安装前被同名本地 stub 覆盖', () => {
    const root = readJson('package.json')
    const sdk = readJson('node_modules/@anthropic-ai/claude-agent-sdk/package.json')
    const nativePackages = Object.keys(sdk.optionalDependencies ?? {}).filter(name =>
      name.startsWith('@anthropic-ai/claude-agent-sdk-'),
    )

    expect(nativePackages.length).toBeGreaterThan(0)
    for (const packageName of nativePackages) {
      const stubDir = packageName.replace('@anthropic-ai/claude-agent-sdk-', '')
      const override = `file:vendor/claude-agent-sdk-native-stubs/${stubDir}`
      expect(root.overrides?.[packageName]).toBe(override)

      const stub = readJson(path.join('vendor', 'claude-agent-sdk-native-stubs', stubDir, 'package.json'))
      expect(stub.name).toBe(packageName)
      expect(stub.version).toBe(sdk.optionalDependencies?.[packageName])
    }
  })
})
