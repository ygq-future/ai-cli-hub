import type { Dispatch, SetStateAction } from 'react'
import type { WebPreferences } from '../../hooks/use-local-preferences'
import { Button } from '../../components/ui/button'

export function SettingsPage({
  locale,
  preferences,
  setPreferences,
}: {
  locale: 'zh-CN' | 'en'
  preferences: WebPreferences
  setPreferences: Dispatch<SetStateAction<WebPreferences>>
}) {
  const zh = locale === 'zh-CN'
  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-kicker">{zh ? '控制台' : 'CONTROL PLANE'}</p>
          <h1>{zh ? '显示与交互设置' : 'Display & interaction'}</h1>
          <p>
            {zh
              ? '浏览器偏好立即保存到本地，不会改变服务器 settings.json。'
              : 'Browser preferences are saved locally and do not change server settings.json.'}
          </p>
        </div>
      </div>
      <div className="admin-panel admin-form-panel">
        <div className="admin-form-grid">
          <label>
            {zh ? '语言' : 'Language'}
            <select
              className="ui-select-trigger"
              value={preferences.locale}
              onChange={event =>
                setPreferences(current => ({ ...current, locale: event.target.value as WebPreferences['locale'] }))
              }>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            {zh ? '主题' : 'Theme'}
            <select
              className="ui-select-trigger"
              value={preferences.theme}
              onChange={event =>
                setPreferences(current => ({ ...current, theme: event.target.value as WebPreferences['theme'] }))
              }>
              <option value="system">{zh ? '跟随系统' : 'System'}</option>
              <option value="light">{zh ? '浅色' : 'Light'}</option>
              <option value="dark">{zh ? '深色' : 'Dark'}</option>
            </select>
          </label>
          <label>
            {zh ? '强调色' : 'Accent'}
            <select
              className="ui-select-trigger"
              value={preferences.accent}
              onChange={event =>
                setPreferences(current => ({ ...current, accent: event.target.value as WebPreferences['accent'] }))
              }>
              <option value="blue">Blue</option>
              <option value="cyan">Cyan</option>
              <option value="amber">Amber</option>
              <option value="rose">Rose</option>
              <option value="violet">Violet</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={preferences.enterToSend}
              onChange={event => setPreferences(current => ({ ...current, enterToSend: event.target.checked }))}
            />{' '}
            {zh ? 'Enter 发送消息' : 'Enter sends messages'}
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={preferences.notificationsEnabled}
              onChange={event =>
                setPreferences(current => ({ ...current, notificationsEnabled: event.target.checked }))
              }
            />{' '}
            {zh ? '启用浏览器通知' : 'Browser notifications'}
          </label>
        </div>
        <div className="admin-note">
          <strong>{zh ? '服务器设置' : 'Server settings'}</strong>
          <p>
            {zh
              ? 'settings.json、重启和服务级配置仍通过右上角设置面板管理。'
              : 'settings.json, restart, and service-level configuration remain available from the header settings panel.'}
          </p>
          <Button variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent('open-server-settings'))}>
            {zh ? '打开服务设置' : 'Open server settings'}
          </Button>
        </div>
      </div>
    </section>
  )
}
