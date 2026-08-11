import { describe, expect, test } from 'bun:test'
import { COMMAND_CATALOG, getCommandDescription, getPrimaryHelpCommands } from './command-catalog'

describe('shared command catalog', () => {
  test('uses unique ids and complete bilingual metadata', () => {
    expect(new Set(COMMAND_CATALOG.map(item => item.id)).size).toBe(COMMAND_CATALOG.length)
    expect(COMMAND_CATALOG.every(item => item.description.zh && item.description.en)).toBe(true)
    expect(COMMAND_CATALOG.every(item => item.keywords.zh.length && item.keywords.en.length)).toBe(true)
  })

  test('keeps parameter templates and fixed confirm variants distinct', () => {
    expect(COMMAND_CATALOG.find(item => item.id === 'model')?.command).toBe('/model')
    expect(COMMAND_CATALOG.find(item => item.id === 'model')?.insertText).toBe('/model [model_name|model_id]')
    expect(COMMAND_CATALOG.find(item => item.id === 'update-confirm')?.command).toBe('/update confirm')
    expect(COMMAND_CATALOG.find(item => item.id === 'restart-confirm')?.primaryHelp).toBe(false)
  })

  test('primary help includes every base slash command and localizes descriptions', () => {
    const primary = getPrimaryHelpCommands()
    expect(primary.some(item => item.id === 'start')).toBe(true)
    expect(primary.some(item => item.id === 'help')).toBe(true)
    expect(primary.some(item => item.id === 'update-confirm')).toBe(false)
    expect(
      getCommandDescription(
        primary.find(item => item.id === 'model')!,
        'zh',
      ),
    ).toContain('模型')
    expect(
      getCommandDescription(
        primary.find(item => item.id === 'model')!,
        'en',
      ),
    ).toContain('model')
  })
})
