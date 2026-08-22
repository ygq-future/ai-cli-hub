import type { Dispatch, SetStateAction } from 'react'
import type { WebPreferences } from '../../hooks/use-local-preferences'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Switch } from '../../components/ui/switch'

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
            <Select
              aria-label={zh ? '语言' : 'Language'}
              value={preferences.locale}
              onValueChange={value =>
                setPreferences(current => ({ ...current, locale: value as WebPreferences['locale'] }))
              }
              options={[
                { value: 'zh-CN', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
            />
          </label>
          <label>
            {zh ? '主题' : 'Theme'}
            <Select
              aria-label={zh ? '主题' : 'Theme'}
              value={preferences.theme}
              onValueChange={value =>
                setPreferences(current => ({ ...current, theme: value as WebPreferences['theme'] }))
              }
              options={[
                { value: 'system', label: zh ? '跟随系统' : 'System' },
                { value: 'light', label: zh ? '浅色' : 'Light' },
                { value: 'dark', label: zh ? '深色' : 'Dark' },
              ]}
            />
          </label>
          <label>
            {zh ? '强调色' : 'Accent'}
            <Select
              aria-label={zh ? '强调色' : 'Accent'}
              value={preferences.accent}
              onValueChange={value =>
                setPreferences(current => ({ ...current, accent: value as WebPreferences['accent'] }))
              }
              options={[
                { value: 'blue', label: 'Blue' },
                { value: 'cyan', label: 'Cyan' },
                { value: 'amber', label: 'Amber' },
                { value: 'rose', label: 'Rose' },
                { value: 'violet', label: 'Violet' },
              ]}
            />
          </label>
          <label className="field switch-field">
            <span>
              <b>{zh ? 'Enter 发送消息' : 'Enter sends messages'}</b>
            </span>
            <Switch
              aria-label={zh ? 'Enter 发送消息' : 'Enter sends messages'}
              checked={preferences.enterToSend}
              onCheckedChange={checked => setPreferences(current => ({ ...current, enterToSend: checked }))}
            />
          </label>
          <label className="field switch-field">
            <span>
              <b>{zh ? '启用浏览器通知' : 'Browser notifications'}</b>
            </span>
            <Switch
              aria-label={zh ? '启用浏览器通知' : 'Browser notifications'}
              checked={preferences.notificationsEnabled}
              onCheckedChange={checked => setPreferences(current => ({ ...current, notificationsEnabled: checked }))}
            />
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
