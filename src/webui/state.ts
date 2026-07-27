export const WEBUI_LOCALES = ['zh-CN', 'en'] as const
export const WEBUI_THEMES = ['system', 'light', 'dark'] as const
export const WEBUI_ACCENTS = ['cyan', 'emerald', 'amber', 'rose', 'violet'] as const

export type WebUiLocale = (typeof WEBUI_LOCALES)[number]
export type WebUiTheme = (typeof WEBUI_THEMES)[number]
export type WebUiAccent = (typeof WEBUI_ACCENTS)[number]

export interface WebUiPreferences {
  locale: WebUiLocale
  theme: WebUiTheme
  accent: WebUiAccent
}

export const DEFAULT_WEBUI_PREFERENCES: WebUiPreferences = {
  locale: 'zh-CN',
  theme: 'system',
  accent: 'cyan',
}

export function normalizeWebUiPreferences(value: unknown, browserLanguage = ''): WebUiPreferences {
  const source = isRecord(value) ? value : {}
  const locale =
    source.locale === 'zh-CN' || source.locale === 'en'
      ? source.locale
      : browserLanguage.startsWith('zh')
        ? 'zh-CN'
        : 'en'
  const theme =
    source.theme === 'system' || source.theme === 'light' || source.theme === 'dark' ? source.theme : 'system'
  const accent = WEBUI_ACCENTS.includes(source.accent as WebUiAccent) ? (source.accent as WebUiAccent) : 'cyan'
  return { locale, theme, accent }
}

export function resolveTheme(theme: WebUiTheme, systemPrefersDark: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
