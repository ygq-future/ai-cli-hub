import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('WebUI 构建资源使用 /webui/ 公共路径', async () => {
  const config = await readFile('vite.config.ts', 'utf8')
  expect(config).toContain("base: '/webui/'")
})

test('WebUI 通过 Tailwind Vite 插件构建并提供暂存构建入口', async () => {
  const [config, eslintConfig, packageJson] = await Promise.all([
    readFile('vite.config.ts', 'utf8'),
    readFile('eslint.config.js', 'utf8'),
    readFile('package.json', 'utf8').then(value => JSON.parse(value) as Record<string, Record<string, string>>),
  ])

  expect(config).toContain("import tailwindcss from '@tailwindcss/vite'")
  expect(config).toContain('plugins: [tailwindcss(), react()]')
  expect(packageJson.scripts?.['webui:build:staged']).toBe(
    'vite build --outDir ../../.data/update/webui-next --emptyOutDir',
  )
  expect(packageJson.devDependencies?.['@tailwindcss/vite']).toBeDefined()
  expect(packageJson.devDependencies?.['@tailwindcss/cli']).toBeUndefined()
  expect(eslintConfig).toContain("'.data/**'")
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

test('WebUI 使用中性黑白 Glass 基底与冷蓝默认强调色', async () => {
  const [styles, source, icon] = await Promise.all([
    readFile('src/webui/react.css', 'utf8'),
    readFile('src/webui/main.tsx', 'utf8'),
    readFile('src/webui/public/assets/icon.svg', 'utf8'),
  ])
  expect(styles).toContain('--bg: #08090d')
  expect(styles).toContain('--glass:')
  expect(styles).toContain("data-accent='blue'")
  expect(styles).not.toContain('--bg: #07110e')
  expect(source).toContain("accent: 'blue'")
  expect(source).not.toContain("accent: 'emerald'")
  expect(icon).not.toContain('#42e0a3')
})

test('WebSocket 断开后区分服务重启与认证过期', async () => {
  const source = await readFile('src/webui/main.tsx', 'utf8')
  expect(source).toContain("fetch('/api/auth/session')")
  expect(source).toContain('response.status === 401')
  expect(source).toContain("setConnection('reconnecting')")
  expect(source).toContain('setReady(false)')
})

test('浏览器通知权限与可持久关闭的应用开关分离', async () => {
  const source = await readFile('src/webui/main.tsx', 'utf8')
  expect(source).toContain('notificationsEnabled: boolean')
  expect(source).toContain('!preferences.notificationsEnabled')
  expect(source).toContain('notificationsEnabled: false')
  expect(source).toContain("t('浏览器通知', 'Browser notifications')")
})

test('Web 输入框提供命令面板、聚焦快捷键和通知高亮', async () => {
  const [source, palette, styles] = await Promise.all([
    readFile('src/webui/main.tsx', 'utf8'),
    readFile('src/webui/command-palette.tsx', 'utf8'),
    readFile('src/webui/react.css', 'utf8'),
  ])

  expect(source).toContain('<CommandPalette')
  expect(source).toContain("event.key.toLowerCase() !== 'i'")
  expect(source).toContain('composer.current?.focus()')
  expect(source).toContain('setSelectionRange(range.start, range.end)')
  expect(source).toContain("'notification-trigger active'")
  expect(source).toContain("'notification-field active'")
  expect(palette).toContain('role="listbox"')
  expect(palette).toContain('role="option"')
  expect(palette).toContain('aria-selected')
  expect(palette).toContain('scrollIntoView')
  expect(styles).toContain('.command-palette')
  expect(styles).toContain('.notification-trigger.active')
})
