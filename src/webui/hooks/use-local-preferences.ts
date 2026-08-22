import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export type WebPreferences = {
  locale: 'zh-CN' | 'en'
  theme: 'system' | 'light' | 'dark'
  accent: 'blue' | 'cyan' | 'amber' | 'rose' | 'violet'
  enterToSend: boolean
  notificationsEnabled: boolean
}

const STORAGE_KEY = 'ai-cli-hub.webui.preferences'
const ACCENTS: WebPreferences['accent'][] = ['blue', 'cyan', 'amber', 'rose', 'violet']

export function useLocalPreferences(): [WebPreferences, Dispatch<SetStateAction<WebPreferences>>] {
  const [preferences, setPreferences] = useState<WebPreferences>(() => readLocalPreferences())
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  }, [preferences])
  return [preferences, setPreferences]
}

export function readLocalPreferences(): WebPreferences {
  const fallback: WebPreferences = {
    locale: 'zh-CN',
    theme: 'system',
    accent: 'blue',
    enterToSend: true,
    notificationsEnabled: typeof Notification !== 'undefined' && Notification.permission === 'granted',
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<WebPreferences> & {
      accent?: string
    }
    return {
      ...fallback,
      ...stored,
      accent: ACCENTS.find(accent => accent === stored.accent) ?? 'blue',
      notificationsEnabled:
        typeof Notification !== 'undefined' &&
        Notification.permission !== 'denied' &&
        (stored.notificationsEnabled ?? Notification.permission === 'granted'),
    }
  } catch {
    return fallback
  }
}
