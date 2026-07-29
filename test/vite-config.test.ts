import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('WebUI 构建资源使用 /webui/ 公共路径', async () => {
  const config = await readFile('vite.config.ts', 'utf8')
  expect(config).toContain("base: '/webui/'")
})

test('应用运行时不触发 WebUI 构建', async () => {
  const main = await readFile('src/main.ts', 'utf8')
  expect(main).not.toContain('buildWebUi')
  expect(main).not.toContain("'webui:build'")
})
