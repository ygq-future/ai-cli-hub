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

test('聊天附件使用触摸屏可触发的单击交互', async () => {
  const source = await readFile('src/webui/main.tsx', 'utf8')
  expect(source).not.toContain('onDoubleClick')
  expect(source).toContain('onClick={() => downloadAttachment(file)}')
})

test('标签页图标使用版本化 favicon 与兼容声明', async () => {
  const html = await readFile('src/webui/index.html', 'utf8')
  expect(html).toContain('rel="icon"')
  expect(html).toContain('rel="shortcut icon"')
  expect(html).toContain('icon.svg?v=')
})

test('设置面板先展示 Web 系统偏好，再展示 settings.json', async () => {
  const source = await readFile('src/webui/main.tsx', 'utf8')
  const systemPreferencesAt = source.indexOf('className="system-preferences"')
  const settingsJsonAt = source.indexOf('Object.entries(data)')
  expect(systemPreferencesAt).toBeGreaterThanOrEqual(0)
  expect(settingsJsonAt).toBeGreaterThan(systemPreferencesAt)
})

test('WebUI 使用稳定的清晰系统字体栈', async () => {
  const styles = await readFile('src/webui/react.css', 'utf8')
  expect(styles).toContain("'Segoe UI Variable'")
  expect(styles).toContain("'Microsoft YaHei UI'")
  expect(styles).toContain("'Cascadia Mono'")
  expect(styles).not.toContain('font-family: Inter,')
})
