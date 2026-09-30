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

export function classifyShellCommand(source: string, customPatterns?: string[]): CommandEffect {
  const trimmed = source.trim()
  if (!trimmed) return 'unknown'
  if (customPatterns && customPatterns.length > 0) {
    for (const pattern of customPatterns) {
      try {
        if (new RegExp(pattern).test(trimmed)) {
          return 'read-only'
        }
      } catch {
        // ignore invalid user regex
      }
    }
  }
  try {
    const script = parse(trimmed)
    if (script.errors?.length) return 'unknown'
    return classifyScript(script)
  } catch {
    return 'unknown'
  }
}

export function isReadOnlyShellCommand(source: string, customPatterns?: string[]): boolean {
  return classifyShellCommand(source, customPatterns) === 'read-only'
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

  if (executable === 'sudo' || executable === 'doas') return classifySudoInvocation(command.suffix)
  if (executable === 'crontab') return hasDynamicArgs ? 'unknown' : classifyCrontabInvocation(args)
  if (executable === 'systemctl') return hasDynamicArgs ? 'unknown' : classifySystemctlInvocation(args)
  if (executable === 'journalctl') return hasDynamicArgs ? 'unknown' : classifyJournalctlInvocation(args)
  if (executable === 'timedatectl') return hasDynamicArgs ? 'unknown' : classifyTimedatectlInvocation(args)
  if (executable === 'hostnamectl') return hasDynamicArgs ? 'unknown' : classifyHostnamectlInvocation(args)
  if (executable === 'localectl') return hasDynamicArgs ? 'unknown' : classifyLocalectlInvocation(args)
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
const SUDO_FLAG_WITH_VALUE = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-p',
  '--prompt',
  '-D',
  '--chdir',
  '-C',
  '--close-from',
  '-R',
  '--chroot',
  '-T',
  '--command-timeout',
  '-t',
  '--type',
  '-c',
  '--class',
])
const SUDO_UNSAFE_FLAGS = new Set(['-s', '--shell', '-i', '--login', '-e', '--edit'])

function classifySudoInvocation(words: Word[]): CommandEffect {
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (isDynamicWord(word)) return 'unknown'
    const value = word.value
    if (value === '--') {
      index++
      break
    }
    if (!value.startsWith('-')) {
      break
    }
    if (SUDO_UNSAFE_FLAGS.has(value)) {
      return 'unknown'
    }
    if (SUDO_FLAG_WITH_VALUE.has(value)) {
      index += 2
      continue
    }
    if (value.startsWith('-u') || value.startsWith('-g') || value.startsWith('-D') || value.startsWith('-p')) {
      index++
      continue
    }
    if (/^-[bEHnPSvkK]+$/.test(value)) {
      index++
      continue
    }
    return 'unknown'
  }

  if (index >= words.length) return 'unknown'
  const commandName = words[index]!
  const suffix = words.slice(index + 1)
  const innerCommand: Command = {
    type: 'Command',
    prefix: [],
    name: commandName,
    suffix,
    redirects: [],
    pos: commandName.pos,
    end: suffix.length > 0 ? suffix[suffix.length - 1]!.end : commandName.end,
  }
  return classifyCommand(innerCommand)
}

function classifyCrontabInvocation(args: string[]): CommandEffect {
  let hasList = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-l') {
      hasList = true
    } else if (arg === '-u') {
      i++
      if (i >= args.length) return 'unknown'
    } else if (arg.startsWith('-u')) {
      continue
    } else if (arg === '-r' || arg === '-e' || arg === '-i') {
      return arg === '-e' ? 'unknown' : 'mutating'
    } else if (arg.startsWith('-')) {
      return 'unknown'
    } else {
      return 'mutating'
    }
  }
  return hasList ? 'read-only' : 'unknown'
}

const READ_ONLY_SYSTEMCTL_SUBCOMMANDS = new Set([
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'status',
  'is-active',
  'is-failed',
  'is-enabled',
  'show',
  'cat',
  'help',
  'list-dependencies',
  'list-machines',
  'list-jobs',
])

const MUTATING_SYSTEMCTL_SUBCOMMANDS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'try-restart',
  'reload-or-restart',
  'isolate',
  'kill',
  'clean',
  'enable',
  'disable',
  'reenable',
  'preset',
  'preset-all',
  'mask',
  'unmask',
  'link',
  'revert',
  'set-environment',
  'unset-environment',
  'import-environment',
  'edit',
  'set-default',
  'set-property',
  'reset-failed',
  'daemon-reload',
  'daemon-reexec',
])

const SYSTEMCTL_OPTION_WITH_VALUE = new Set([
  '-t',
  '--type',
  '--state',
  '-p',
  '--property',
  '-s',
  '--signal',
  '-n',
  '--lines',
  '-o',
  '--output',
  '--root',
])

function classifySystemctlInvocation(args: string[]): CommandEffect {
  let subcommand: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      subcommand = args[i + 1]
      break
    }
    if (SYSTEMCTL_OPTION_WITH_VALUE.has(arg)) {
      i++
      continue
    }
    if (
      arg.startsWith('--type=') ||
      arg.startsWith('--state=') ||
      arg.startsWith('--property=') ||
      arg.startsWith('--output=') ||
      arg.startsWith('--lines=')
    ) {
      continue
    }
    if (arg.startsWith('-')) {
      continue
    }
    subcommand = arg
    break
  }
  if (!subcommand) return 'read-only'
  const lower = subcommand.toLowerCase()
  if (READ_ONLY_SYSTEMCTL_SUBCOMMANDS.has(lower)) return 'read-only'
  if (MUTATING_SYSTEMCTL_SUBCOMMANDS.has(lower)) return 'mutating'
  return 'unknown'
}

function classifyJournalctlInvocation(args: string[]): CommandEffect {
  for (const arg of args) {
    if (arg.startsWith('--vacuum-') || arg === '--rotate' || arg === '--flush' || arg === '--sync') {
      return 'mutating'
    }
    if (arg === '--setup-keys') {
      return 'mutating'
    }
  }
  return 'read-only'
}

function classifyTimedatectlInvocation(args: string[]): CommandEffect {
  const sub = args.find(a => !a.startsWith('-'))
  if (!sub || ['status', 'show', 'timesync-status', 'list-timezones'].includes(sub.toLowerCase())) {
    return 'read-only'
  }
  if (sub.toLowerCase().startsWith('set-')) return 'mutating'
  return 'unknown'
}

function classifyHostnamectlInvocation(args: string[]): CommandEffect {
  const sub = args.find(a => !a.startsWith('-'))
  if (!sub || ['status', 'hostname'].includes(sub.toLowerCase())) {
    return 'read-only'
  }
  if (sub.toLowerCase().startsWith('set-')) return 'mutating'
  return 'unknown'
}

function classifyLocalectlInvocation(args: string[]): CommandEffect {
  const sub = args.find(a => !a.startsWith('-'))
  if (
    !sub ||
    [
      'status',
      'list-locales',
      'list-keymaps',
      'list-x11-keymap-models',
      'list-x11-keymap-layouts',
      'list-x11-keymap-variants',
      'list-x11-keymap-options',
    ].includes(sub.toLowerCase())
  ) {
    return 'read-only'
  }
  if (sub.toLowerCase().startsWith('set-')) return 'mutating'
  return 'unknown'
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
