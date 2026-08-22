export type WebPage = 'chat' | 'conversations' | 'preferences' | 'memories' | 'audits' | 'settings'

const PAGES: readonly WebPage[] = ['chat', 'conversations', 'preferences', 'memories', 'audits', 'settings']

export function pageFromLocation(hash: string): WebPage {
  const value = hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  return isWebPage(value) ? value : 'chat'
}

export function locationForPage(page: WebPage): string {
  return page === 'chat' ? '#/chat' : `#/${page}`
}

export function isWebPage(value: string): value is WebPage {
  return PAGES.includes(value as WebPage)
}

export const webPages = PAGES
