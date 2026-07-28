import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSettingsService } from './settings-service'

describe('SettingsService', () => {
  test('读取时脱敏，保存时保留未覆盖的敏感值', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-settings-'))
    const settingsPath = path.join(directory, 'settings.json')
    const source = JSON.parse(await readFile('settings.json.example', 'utf8')) as Record<string, unknown>
    const http = source.http as Record<string, unknown>
    http.authToken = 'secret-token'
    await writeFile(settingsPath, JSON.stringify(source), 'utf8')

    try {
      const service = createSettingsService(settingsPath)
      const safe = await service.read()
      expect(safe.http).toEqual({ host: '127.0.0.1', port: 8787, authToken: { configured: true }, secureCookie: false })

      await service.save(safe)
      const stored = JSON.parse(await readFile(settingsPath, 'utf8')) as { http: { authToken: string } }
      expect(stored.http.authToken).toBe('secret-token')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('非法配置不会覆盖原文件', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-settings-'))
    const settingsPath = path.join(directory, 'settings.json')
    const original = await readFile('settings.json.example', 'utf8')
    await writeFile(settingsPath, original, 'utf8')

    try {
      const service = createSettingsService(settingsPath)
      await expect(service.save({})).rejects.toThrow()
      expect(await readFile(settingsPath, 'utf8')).toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
