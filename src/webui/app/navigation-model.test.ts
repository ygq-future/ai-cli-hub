import { describe, expect, test } from 'bun:test'
import { isWebPage, locationForPage, pageFromLocation, webPages } from './navigation-model'

describe('Web navigation model', () => {
  test('unknown hash and empty hash fall back to chat', () => {
    expect(pageFromLocation('')).toBe('chat')
    expect(pageFromLocation('#/unknown')).toBe('chat')
    expect(pageFromLocation('#/memories/detail')).toBe('memories')
  })

  test('page locations round-trip and supported pages are explicit', () => {
    expect(webPages).toEqual(['chat', 'conversations', 'preferences', 'memories', 'audits', 'settings'])
    for (const page of webPages) expect(pageFromLocation(locationForPage(page))).toBe(page)
    expect(isWebPage('settings')).toBe(true)
    expect(isWebPage('admin')).toBe(false)
  })
})
