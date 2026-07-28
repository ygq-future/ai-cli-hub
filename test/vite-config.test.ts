import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('WebUI 构建资源使用 /webui/ 公共路径', async () => {
  const config = await readFile('vite.config.ts', 'utf8')
  expect(config).toContain("base: '/webui/'")
})
