import { existsSync } from 'node:fs'
import path from 'node:path'

const envLinePattern = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/

interface EnvEntry {
  rawText: string
  parsed: ParsedEnvLine | null
}

interface ParsedEnvLine {
  prefix: string
  key: string
  separator: string
  value: string
}

export interface EnvMigrationStats {
  preserved: number
  added: number
  extra: number
}

export interface EnvMigrationResult {
  text: string
  stats: EnvMigrationStats
}

export function parseEnvValues(text: string): Map<string, string> {
  const values = new Map<string, string>()

  for (const entry of parseEnvEntries(text)) {
    if (entry.parsed !== null) {
      values.set(entry.parsed.key, entry.parsed.value)
    }
  }

  return values
}

export function migrateEnvText(exampleText: string, existingText = ''): EnvMigrationResult {
  const existingValues = parseEnvValues(existingText)
  const seenTemplateKeys = new Set<string>()
  const outputLines: string[] = []
  let preserved = 0
  let added = 0

  for (const entry of parseEnvEntries(exampleText)) {
    const parsed = entry.parsed

    if (parsed === null) {
      outputLines.push(entry.rawText)
      continue
    }

    seenTemplateKeys.add(parsed.key)

    if (existingValues.has(parsed.key)) {
      outputLines.push(`${parsed.prefix}${parsed.key}${parsed.separator}${existingValues.get(parsed.key) ?? ''}`)
      preserved += 1
      continue
    }

    outputLines.push(entry.rawText)
    added += 1
  }

  const extraValues = [...existingValues.entries()].filter(([key]) => !seenTemplateKeys.has(key))

  if (extraValues.length > 0) {
    if (outputLines.length > 0 && outputLines[outputLines.length - 1] !== '') {
      outputLines.push('')
    }

    outputLines.push('# ── 本地额外配置（未出现在 .env.example）──')

    for (const [key, value] of extraValues) {
      outputLines.push(`${key}=${value}`)
    }
  }

  return {
    text: `${outputLines.join('\n')}\n`,
    stats: {
      preserved,
      added,
      extra: extraValues.length,
    },
  }
}

async function main(): Promise<void> {
  const examplePath = path.resolve('.env.example')
  const envPath = path.resolve('.env')

  if (!existsSync(examplePath)) {
    throw new Error(`缺少模板文件：${examplePath}`)
  }

  const exampleText = await Bun.file(examplePath).text()
  const existingText = existsSync(envPath) ? await Bun.file(envPath).text() : ''
  const result = migrateEnvText(exampleText, existingText)

  await Bun.write(envPath, result.text)

  const action = existingText === '' ? 'created' : 'updated'
  console.log(
    `.env ${action}: preserved=${result.stats.preserved}, added=${result.stats.added}, extra=${result.stats.extra}`,
  )
  console.log(envPath)
}

function parseEnvEntries(text: string): EnvEntry[] {
  const lines = splitLines(text)
  const entries: EnvEntry[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const parsed = parseEnvLine(line)

    if (parsed === null) {
      entries.push({ rawText: line, parsed: null })
      continue
    }

    const multilineQuote = getOpenMultilineQuote(parsed.value)

    if (multilineQuote === null) {
      entries.push({ rawText: line, parsed })
      continue
    }

    const valueLines = [parsed.value]
    const rawLines = [line]

    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? ''
      index += 1
      valueLines.push(nextLine)
      rawLines.push(nextLine)

      if (lineClosesQuote(nextLine, multilineQuote)) {
        break
      }
    }

    entries.push({
      rawText: rawLines.join('\n'),
      parsed: {
        ...parsed,
        value: valueLines.join('\n'),
      },
    })
  }

  return entries
}

function parseEnvLine(line: string): ParsedEnvLine | null {
  const match = line.match(envLinePattern)

  if (match === null) {
    return null
  }

  const [, prefix, key, separator, value] = match

  if (prefix === undefined || key === undefined || separator === undefined || value === undefined) {
    return null
  }

  return { prefix, key, separator, value }
}

function getOpenMultilineQuote(value: string): '"' | "'" | null {
  const trimmedStart = value.trimStart()
  const quote = trimmedStart[0]

  if (quote !== '"' && quote !== "'") {
    return null
  }

  const quoteIndex = value.indexOf(quote)
  const rest = value.slice(quoteIndex + 1)

  return containsClosingQuote(rest, quote) ? null : quote
}

function lineClosesQuote(line: string, quote: '"' | "'"): boolean {
  return containsClosingQuote(line, quote)
}

function containsClosingQuote(text: string, quote: '"' | "'"): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== quote) {
      continue
    }

    if (quote === '"' && isEscaped(text, index)) {
      continue
    }

    return true
  }

  return false
}

function isEscaped(text: string, quoteIndex: number): boolean {
  let slashCount = 0

  for (let index = quoteIndex - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    slashCount += 1
  }

  return slashCount % 2 === 1
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
}

if (import.meta.main) {
  await main()
}
