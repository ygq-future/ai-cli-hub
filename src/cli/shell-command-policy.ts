import { parse, type Command, type Node, type Redirect, type Script, type Word, type WordPart } from 'unbash'
import {
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_ONLY_POWERSHELL_COMMANDS,
  READ_ONLY_SHELL_COMMANDS,
  VERSION_ONLY_COMMANDS,
} from './constants'

export type CommandEffect = 'read-only' | 'mutating' | 'unknown'

const READ_ONLY_DOCKER_COMMANDS = new Set([
  'diff',
  'events',
  'history',
  'images',
  'info',
  'inspect',
  'logs',
  'port',
  'ps',
  'search',
  'stats',
  'top',
  'version',
])
const MUTATING_SHELL_COMMANDS = new Set([
  'chmod',
  'chown',
  'cp',
  'del',
  'kill',
  'mkdir',
  'move',
  'mv',
  'remove-item',
  'ren',
  'rename-item',
  'rm',
  'rmdir',
  'set-content',
  'stop-process',
  'tee',
  'touch',
])

const DOCKER_EXEC_VALUE_OPTIONS = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--detach-keys'])
const SAFE_FD_REDIRECT_TARGET = /^\d+$|^-$|^\/dev\/(?:null|stdout|stderr)$/
const READ_ONLY_DOCKER_RESOURCE_COMMANDS = new Set(['ls', 'inspect'])
const UNSAFE_FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-fprint', '-fprintf', '-fls', '-ok', '-okdir'])

export function classifyShellCommand(source: string): CommandEffect {
  const trimmed = source.trim()
  if (!trimmed) return 'unknown'
  try {
    const script = parse(trimmed)
    if (script.errors?.length) return 'unknown'
    return classifyScript(script)
  } catch {
    return 'unknown'
  }
}

export function isReadOnlyShellCommand(source: string): boolean {
  return classifyShellCommand(source) === 'read-only'
}

function classifyScript(script: Script): CommandEffect {
  if (script.commands.length === 0) return 'unknown'
  return combineEffects(script.commands.map(classifyNode))
}

function classifyNode(node: Node): CommandEffect {
  switch (node.type) {
    case 'Statement':
      if (node.background) return 'unknown'
      return combineEffects([classifyRedirects(node.redirects), classifyNode(node.command)])
    case 'Command':
      return classifyCommand(node)
    case 'Pipeline':
    case 'AndOr':
      return combineEffects(node.commands.map(classifyNode))
    case 'Subshell':
    case 'BraceGroup':
      return combineEffects(node.body.commands.map(classifyNode))
    case 'CompoundList':
      return combineEffects(node.commands.map(classifyNode))
    case 'TestCommand':
      return 'read-only'
    default:
      return 'unknown'
  }
}

function classifyCommand(command: Command): CommandEffect {
  const structuralEffect = combineEffects([
    classifyRedirects(command.redirects),
    ...command.prefix.map(prefix => (prefix.value ? classifyWordExpansions(prefix.value) : 'read-only')),
    ...(command.name ? [classifyWordExpansions(command.name)] : []),
    ...command.suffix.map(classifyWordExpansions),
  ])
  if (structuralEffect !== 'read-only') return structuralEffect
  if (!command.name || isDynamicWord(command.name)) return 'unknown'

  const executable = normalizeExecutable(command.name.value)
  const args = command.suffix.map(word => word.value)
  const hasDynamicArgs = command.suffix.some(isDynamicWord)

  if (executable === 'powershell' || executable === 'pwsh') return classifyPowerShellInvocation(command.suffix)
  if (executable === 'cmd') return classifyCmdInvocation(command.suffix)
  if (executable === 'bash' || executable === 'sh') return classifyShellInvocation(command.suffix)
  if (executable === 'docker') return classifyDockerInvocation(command.suffix)
  if (executable === 'find') return classifyFindInvocation(command.suffix)
  if (executable === 'git') return hasDynamicArgs ? 'unknown' : classifyGitInvocation(args)
  if (executable === 'hostname') return hasDynamicArgs ? 'unknown' : classifyHostnameInvocation(args)
  if (executable === 'ipconfig') return hasDynamicArgs ? 'unknown' : classifyIpconfigInvocation(args)
  if (executable === 'python' || executable === 'python3') return classifyPythonInvocation(args, hasDynamicArgs)
  if (VERSION_ONLY_COMMANDS.has(executable)) return hasDynamicArgs ? 'unknown' : classifyVersionOnly(args)
  if (MUTATING_SHELL_COMMANDS.has(executable)) return 'mutating'
  if (READ_ONLY_SHELL_COMMANDS.has(executable) || READ_ONLY_POWERSHELL_COMMANDS.has(executable)) return 'read-only'
  return 'unknown'
}

function classifyRedirects(redirects: Redirect[]): CommandEffect {
  return combineEffects(
    redirects.map(redirect => {
      const expansionEffect = redirect.target ? classifyWordExpansions(redirect.target) : 'read-only'
      if (expansionEffect !== 'read-only') return expansionEffect
      if (isStderrToDevNull(redirect)) return 'read-only'
      if (['>', '>>', '<>', '>|', '&>', '&>>'].includes(redirect.operator)) return 'mutating'
      if (redirect.operator === '>&') {
        return redirect.target && SAFE_FD_REDIRECT_TARGET.test(redirect.target.value) ? 'read-only' : 'mutating'
      }
      return 'read-only'
    }),
  )
}

function classifyWordExpansions(word: Word): CommandEffect {
  return combineEffects((word.parts ?? []).map(classifyWordPart))
}

function classifyWordPart(part: WordPart): CommandEffect {
  switch (part.type) {
    case 'CommandExpansion':
    case 'ProcessSubstitution':
      return part.script ? classifyScript(part.script) : 'unknown'
    case 'DoubleQuoted':
    case 'LocaleString':
      return combineEffects(part.parts.map(classifyWordPart))
    default:
      return 'read-only'
  }
}

function isDynamicWord(word: Word): boolean {
  return (word.parts ?? []).some(part => {
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      return part.parts.some(child => child.type !== 'Literal')
    }
    return [
      'SimpleExpansion',
      'ParameterExpansion',
      'CommandExpansion',
      'ArithmeticExpansion',
      'ProcessSubstitution',
    ].includes(part.type)
  })
}

function classifyPowerShellInvocation(words: Word[]): CommandEffect {
  const commandIndex = words.findIndex(word => ['-command', '-c'].includes(word.value.toLowerCase()))
  if (commandIndex < 0 || commandIndex === words.length - 1) return 'unknown'
  const inner = words.slice(commandIndex + 1)
  if (inner.some(isDynamicWord)) return 'unknown'
  return classifyShellCommand(inner.map(word => word.value).join(' '))
}

function classifyCmdInvocation(words: Word[]): CommandEffect {
  const commandIndex = words.findIndex(word => word.value.toLowerCase() === '/c')
  if (commandIndex < 0 || commandIndex === words.length - 1) return 'unknown'
  const inner = words.slice(commandIndex + 1)
  if (inner.some(isDynamicWord)) return 'unknown'
  return classifyShellCommand(inner.map(word => word.value).join(' '))
}

function classifyShellInvocation(words: Word[]): CommandEffect {
  const commandIndex = words.findIndex(word => ['-c', '-lc'].includes(word.value.toLowerCase()))
  if (commandIndex < 0 || commandIndex === words.length - 1) return 'unknown'
  const inner = words[commandIndex + 1]!
  return isDynamicWord(inner) ? 'unknown' : classifyShellCommand(inner.value)
}

function classifyDockerInvocation(words: Word[]): CommandEffect {
  const args = words.map(word => word.value)
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) index += 1
  const subcommandWord = words[index]
  if (!subcommandWord || isDynamicWord(subcommandWord)) return 'unknown'
  const subcommand = subcommandWord.value.toLowerCase()
  if (!subcommand) return 'unknown'
  if (READ_ONLY_DOCKER_COMMANDS.has(subcommand)) return 'read-only'
  if (subcommand === 'volume') return classifyDockerResourceInvocation(words.slice(index + 1))
  if (subcommand !== 'exec') return 'unknown'

  if (words.slice(index + 1).some(isDynamicWord)) return 'unknown'

  index += 1
  while (index < args.length && args[index]!.startsWith('-')) {
    const option = args[index]!
    index += DOCKER_EXEC_VALUE_OPTIONS.has(option.split('=')[0]!) && !option.includes('=') ? 2 : 1
  }
  if (index >= args.length - 1) return 'unknown'
  const innerWords = words.slice(index + 1)
  if (innerWords.length === 1 && ['--version', '-v', 'version'].includes(innerWords[0]!.value.toLowerCase())) {
    return 'read-only'
  }
  return classifyShellCommand(innerWords.map(word => word.text).join(' '))
}

function classifyDockerResourceInvocation(words: Word[]): CommandEffect {
  const subcommand = words[0]
  if (!subcommand || isDynamicWord(subcommand)) return 'unknown'
  return READ_ONLY_DOCKER_RESOURCE_COMMANDS.has(subcommand.value.toLowerCase()) ? 'read-only' : 'unknown'
}

function classifyFindInvocation(words: Word[]): CommandEffect {
  const actions = words.map(word => word.value.toLowerCase())
  if (actions.includes('-delete')) return 'mutating'
  return actions.some(action => UNSAFE_FIND_ACTIONS.has(action)) ? 'unknown' : 'read-only'
}

function isStderrToDevNull(redirect: Redirect): boolean {
  return (
    redirect.fileDescriptor === 2 && redirect.target?.value === '/dev/null' && ['>', '>>'].includes(redirect.operator)
  )
}

function classifyPythonInvocation(args: string[], hasDynamicArgs: boolean): CommandEffect {
  if (hasDynamicArgs) return 'unknown'
  return args.length === 2 && args[0] === '-m' && args[1] === 'json.tool' ? 'read-only' : classifyVersionOnly(args)
}

function classifyVersionOnly(args: string[]): CommandEffect {
  return args.length === 1 && ['--version', '-v', 'version'].includes(args[0]!.toLowerCase()) ? 'read-only' : 'unknown'
}

function classifyGitInvocation(args: string[]): CommandEffect {
  if (args.length === 1 && args[0]?.toLowerCase() === '--version') return 'read-only'
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
    if (rawArg === '-c') return 'mutating'
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      index += 1
      continue
    }
    break
  }
  const subcommand = args[index]?.toLowerCase()
  if (!subcommand) return 'unknown'
  const rest = args.slice(index + 1)
  if (rest.some(arg => arg === '--output' || arg.startsWith('--output='))) return 'mutating'
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return 'read-only'
  if (subcommand === 'branch') return classifyGitBranch(rest)
  if (subcommand === 'reflog') return rest.length === 0 || rest[0] === 'show' ? 'read-only' : 'mutating'
  if (subcommand === 'remote') return classifyGitRemote(rest)
  if (subcommand === 'stash') return rest[0] === 'list' || rest[0] === 'show' ? 'read-only' : 'mutating'
  if (subcommand === 'worktree') return rest[0] === 'list' ? 'read-only' : 'mutating'
  if (subcommand === 'tag')
    return rest.length === 0 || rest[0] === '--list' || rest[0] === '-l' ? 'read-only' : 'mutating'
  return 'unknown'
}

function classifyHostnameInvocation(args: string[]): CommandEffect {
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
  return args.length === 0 || args.every(arg => queryFlags.has(arg.toLowerCase())) ? 'read-only' : 'mutating'
}

function classifyIpconfigInvocation(args: string[]): CommandEffect {
  const queryFlags = new Set(['/all', '/displaydns', '/allcompartments', '/?'])
  return args.length === 0 || args.every(arg => queryFlags.has(arg.toLowerCase())) ? 'read-only' : 'mutating'
}

function classifyGitBranch(args: string[]): CommandEffect {
  if (args.length === 0) return 'read-only'
  const mutationFlags = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy'])
  if (args.some(arg => mutationFlags.has(arg))) return 'mutating'
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
  return args.some(arg => queryFlags.has(arg)) ? 'read-only' : 'mutating'
}

function classifyGitRemote(args: string[]): CommandEffect {
  if (args.length === 0) return 'read-only'
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) return 'read-only'
  return args[0] === 'show' || args[0] === 'get-url' ? 'read-only' : 'mutating'
}

function normalizeExecutable(value: string): string {
  return value
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase()
}

function combineEffects(effects: CommandEffect[]): CommandEffect {
  if (effects.includes('mutating')) return 'mutating'
  if (effects.includes('unknown')) return 'unknown'
  return 'read-only'
}
