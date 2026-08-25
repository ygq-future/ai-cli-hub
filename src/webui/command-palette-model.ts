import { COMMAND_CATALOG, type CommandCatalogEntry, type UserLanguage } from '../shared'

export interface TextSelectionRange {
  start: number
  end: number
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

function withoutLeadingSlash(value: string): string {
  const normalized = normalize(value)
  return normalized.startsWith('/') ? normalized.slice(1) : normalized
}

function isOrderedSubsequence(query: string, value: string): boolean {
  const needle = query.replace(/\s+/g, '')
  const haystack = value.replace(/\s+/g, '')
  if (!needle) return true
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return false
}

function scoreField(value: string, query: string): number {
  const normalized = normalize(value)
  if (!normalized) return 0
  if (normalized === query) return 1_000

  const substringIndex = normalized.indexOf(query)
  if (substringIndex >= 0) return 850 - Math.min(substringIndex, 100)

  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && tokens.every(token => normalized.includes(token))) return 650
  const compactQuery = query.replace(/\s+/g, '')
  if (compactQuery.length >= 2 && isOrderedSubsequence(compactQuery, normalized)) {
    const compactLength = normalized.replace(/\s+/g, '').length
    return 350 - Math.min(Math.max(compactLength - compactQuery.length, 0), 200)
  }
  return 0
}

function scoreCommandField(value: string, query: string): number {
  const normalized = normalize(value)
  const compactQuery = query.replace(/\s+/g, '')
  const compactValue = normalized.replace(/\s+/g, '')
  if (compactQuery.length < 2 || compactValue[0] !== compactQuery[0]) return 0
  if (!isOrderedSubsequence(compactQuery, compactValue)) return 0
  return 350 - Math.min(Math.max(compactValue.length - compactQuery.length, 0), 200)
}

function fuzzyScore(entry: CommandCatalogEntry, query: string, language: UserLanguage): number {
  const localized = [entry.description[language], ...entry.keywords[language]]
  const alternateLanguage = language === 'zh' ? 'en' : 'zh'
  const alternate = [entry.description[alternateLanguage], ...entry.keywords[alternateLanguage]]
  const commandFields = [entry.command, entry.insertText].map(withoutLeadingSlash)
  const commandScore = Math.max(...commandFields.map(field => scoreCommandField(field, query)))
  const localizedScore = Math.max(...localized.map(field => scoreField(field, query)))
  const alternateScore = Math.max(...alternate.map(field => scoreField(field, query)))
  return Math.max(
    commandScore > 0 ? commandScore + 30 : 0,
    localizedScore > 0 ? localizedScore + 20 : 0,
    alternateScore,
  )
}

export function searchCommandCatalog(input: string, language: UserLanguage): readonly CommandCatalogEntry[] {
  const query = withoutLeadingSlash(input)
  if (!query) return COMMAND_CATALOG

  const prefixMatches = COMMAND_CATALOG.filter(entry =>
    [entry.command, entry.insertText].some(value => withoutLeadingSlash(value).startsWith(query)),
  ).sort((left, right) => left.command.length - right.command.length)
  if (prefixMatches.length) return prefixMatches

  const commandMatches = COMMAND_CATALOG.map((entry, index) => ({
    entry,
    index,
    score: Math.max(
      ...[entry.command, entry.insertText].map(value => scoreCommandField(withoutLeadingSlash(value), query)),
    ),
  }))
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(result => result.entry)
  if (commandMatches.length) return commandMatches

  return COMMAND_CATALOG.map((entry, index) => ({ entry, index, score: fuzzyScore(entry, query, language) }))
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(result => result.entry)
}

export function findFirstPlaceholderRange(template: string): TextSelectionRange | null {
  const match = /\[[^\]]+\]|<[^>]+>/.exec(template)
  return match ? { start: match.index, end: match.index + match[0].length } : null
}
