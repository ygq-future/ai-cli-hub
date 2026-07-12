import type { Unsubscribe } from '../shared'
import {
  OPERATION_RESULT_GUARDRAIL,
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_ONLY_POWERSHELL_COMMANDS,
  READ_ONLY_SHELL_COMMANDS,
  READ_ONLY_TOOL_NAMES,
  VERSION_ONLY_COMMANDS,
} from './constants'

export function buildSystemPromptAppend(systemLanguageHint?: string): string {
  return [systemLanguageHint, OPERATION_RESULT_GUARDRAIL].filter(Boolean).join('\n\n')
}

export function emitHandlers<T>(handlers: Array<(value: T) => void>, value: T): void {
  for (const handler of handlers) handler(value)
}

export function unsubscribeHandler<T>(handlers: T[], handler: T): Unsubscribe {
  return () => {
    const index = handlers.indexOf(handler)
    if (index >= 0) handlers.splice(index, 1)
  }
}

/**
 * 跨 CLI 的保守 shell 查询判定。
 * 只接受单条命令；重定向、管道、串联、命令替换一律进入审批。
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[\r\n;&|<>`]/.test(trimmed) || /\$\s*\(/.test(trimmed)) return false

  const tokens = tokenizeCommand(trimmed)
  if (tokens.length === 0) return false
  const executable = normalizeExecutable(tokens[0]!)

  if (executable === 'powershell' || executable === 'pwsh') return isReadOnlyPowerShellInvocation(tokens)
  if (executable === 'cmd') return isReadOnlyCmdInvocation(tokens)
  if (executable === 'git') return isReadOnlyGitInvocation(tokens.slice(1))
  if (executable === 'hostname') return isReadOnlyHostnameInvocation(tokens.slice(1))
  if (executable === 'ipconfig') return isReadOnlyIpconfigInvocation(tokens.slice(1))
  if (VERSION_ONLY_COMMANDS.has(executable)) return isVersionOnly(tokens.slice(1))
  return READ_ONLY_SHELL_COMMANDS.has(executable) || READ_ONLY_POWERSHELL_COMMANDS.has(executable)
}

export function isReadOnlyToolName(toolName: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName.toLowerCase())
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g)?.map(unquote) ?? []
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function normalizeExecutable(value: string): string {
  return value
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
}

function isVersionOnly(args: string[]): boolean {
  return args.length === 1 && ['--version', '-v', 'version'].includes(args[0]!.toLowerCase())
}

function isReadOnlyPowerShellInvocation(tokens: string[]): boolean {
  const commandIndex = tokens.findIndex((token, index) => index > 0 && ['-command', '-c'].includes(token.toLowerCase()))
  if (commandIndex < 0 || commandIndex === tokens.length - 1) return false
  return isReadOnlyShellCommand(tokens.slice(commandIndex + 1).join(' '))
}

function isReadOnlyCmdInvocation(tokens: string[]): boolean {
  const commandIndex = tokens.findIndex((token, index) => index > 0 && token.toLowerCase() === '/c')
  if (commandIndex < 0 || commandIndex === tokens.length - 1) return false
  return isReadOnlyShellCommand(tokens.slice(commandIndex + 1).join(' '))
}

function isReadOnlyGitInvocation(args: string[]): boolean {
  if (args.length === 1 && args[0]?.toLowerCase() === '--version') return true
  let index = 0
  while (index < args.length) {
    const rawArg = args[index]!
    const arg = rawArg.toLowerCase()
    if (arg === '--no-pager' || arg === '--literal-pathspecs' || arg === '--no-optional-locks') {
      index += 1
      continue
    }
    if (rawArg === '-C') {
      index += 2
      continue
    }
    if (rawArg === '-c') return false
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      index += 1
      continue
    }
    break
  }
  const subcommand = args[index]?.toLowerCase()
  if (!subcommand) return false
  const rest = args.slice(index + 1)
  if (rest.some(arg => arg === '--output' || arg.startsWith('--output='))) return false
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true
  if (subcommand === 'branch') return isReadOnlyGitBranch(rest)
  if (subcommand === 'reflog') return rest.length === 0 || rest[0] === 'show'
  if (subcommand === 'remote') return isReadOnlyGitRemote(rest)
  if (subcommand === 'stash') return rest[0] === 'list' || rest[0] === 'show'
  if (subcommand === 'worktree') return rest[0] === 'list'
  if (subcommand === 'tag') return rest.length === 0 || rest[0] === '--list' || rest[0] === '-l'
  return false
}

function isReadOnlyHostnameInvocation(args: string[]): boolean {
  const queryFlags = new Set([
    '-a',
    '--alias',
    '-d',
    '--domain',
    '-f',
    '--fqdn',
    '-i',
    '--ip-address',
    '-s',
    '--short',
    '-y',
    '--yp',
  ])
  return args.length === 0 || args.every(arg => queryFlags.has(arg.toLowerCase()))
}

function isReadOnlyIpconfigInvocation(args: string[]): boolean {
  const queryFlags = new Set(['/all', '/displaydns', '/allcompartments', '/?'])
  return args.length === 0 || args.every(arg => queryFlags.has(arg.toLowerCase()))
}

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.length === 0) return true
  const mutationFlags = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy'])
  if (args.some(arg => mutationFlags.has(arg))) return false
  const queryFlags = new Set([
    '--list',
    '-a',
    '--all',
    '-r',
    '--remotes',
    '-v',
    '-vv',
    '--show-current',
    '--contains',
    '--no-contains',
    '--merged',
    '--no-merged',
  ])
  return args.some(arg => queryFlags.has(arg))
}

function isReadOnlyGitRemote(args: string[]): boolean {
  if (args.length === 0) return true
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) return true
  return args[0] === 'show' || args[0] === 'get-url'
}
