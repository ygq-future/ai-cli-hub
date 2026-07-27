import { expect, test } from 'bun:test'
import { normalizeWebUiPreferences, resolveTheme } from './state'

test('WebUI 偏好默认跟随浏览器语言并拒绝未知值', () => {
  expect(normalizeWebUiPreferences({ locale: 'fr', accent: 'blue' }, 'zh-CN')).toEqual({
    locale: 'zh-CN',
    theme: 'system',
    accent: 'cyan',
  })
})

test('WebUI 偏好保留合法的语言、主题与强调色', () => {
  expect(normalizeWebUiPreferences({ locale: 'en', theme: 'dark', accent: 'rose' })).toEqual({
    locale: 'en',
    theme: 'dark',
    accent: 'rose',
  })
})

test('system 主题依照系统偏好解析', () => {
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme('light', true)).toBe('light')
})
