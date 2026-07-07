/**
 * memory —— 长期记忆 V1：环境快照 + 实例级全局记忆注入。
 *
 * 本模块只依赖 event/repository/config/shared；不 import core/、transport/、cli/。
 */
import os from 'node:os'
import type { AppConfig } from '../config'
import type { EventBus } from '../event'
import type { Memory, Repositories } from '../repository'
import { DEFAULT_MEMORY_NAMESPACE, type MemoryType } from '../shared'

export interface MemoryModule {
  recallGlobalContext(): Promise<string>
  destroy(): void
}

export interface MemoryModuleDeps {
  bus: EventBus
  repos: Repositories
  config: AppConfig
  namespace?: string
}

interface EnvironmentFact {
  tag: string
  content: string
  importance?: number
}

export async function createMemoryModule(deps: MemoryModuleDeps): Promise<MemoryModule> {
  const namespace = deps.namespace ?? DEFAULT_MEMORY_NAMESPACE
  await upsertEnvironmentSnapshot(deps, namespace)

  return {
    async recallGlobalContext() {
      const memories = await deps.repos.memories.listGlobal(namespace)
      return formatGlobalMemoryContext(memories)
    },
    destroy() {
      // V1 无后台队列；保留接口给后续摘要/嵌入任务。
    },
  }
}

export async function upsertEnvironmentSnapshot(deps: MemoryModuleDeps, namespace = DEFAULT_MEMORY_NAMESPACE) {
  const facts = await collectEnvironmentFacts(deps.config)
  for (const fact of facts) {
    const memory = await deps.repos.memories.upsertByTag(namespace, fact.tag, {
      conversationId: null,
      type: 'semantic',
      content: fact.content,
      embedding: null,
      sourceMessageId: null,
      importance: fact.importance ?? 0.8,
      accessCount: 0,
      lastAccessedAt: null,
    })
    deps.bus.emit('MemoryUpdated', {
      conversationId: null,
      namespace,
      memoryType: memory.type,
      memoryId: memory.id,
    })
  }
}

export async function collectEnvironmentFacts(config: AppConfig): Promise<EnvironmentFact[]> {
  const [node, pwsh, windowsPowerShell, bash, claude] = await Promise.all([
    probeCommand('node', ['--version']),
    probeCommand('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
    probeCommand('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
    probeCommand('bash', ['--version'], firstLine),
    probeCliAvailability('claude'),
  ])

  const shellFact =
    process.platform === 'win32'
      ? '当前平台通常使用 PowerShell；服务进程的实际交互 shell 不从环境变量读取。'
      : '当前平台通常使用 POSIX shell；服务进程的实际交互 shell 不从环境变量读取。'

  return [
    {
      tag: 'env.os',
      content: `环境：OS=${os.type()} ${os.release()} (${process.platform}/${process.arch})。`,
    },
    {
      tag: 'env.hostname',
      content: `环境：hostname=${os.hostname()}。`,
    },
    {
      tag: 'env.shell',
      content: `环境：${shellFact}`,
    },
    {
      tag: 'env.cwd',
      content: `环境：服务启动 cwd=${normalizePathForMemory(process.cwd())}。`,
    },
    {
      tag: 'env.default_cwd',
      content: `环境：默认会话目录 DEFAULT_CWD=${normalizePathForMemory(config.DEFAULT_CWD)}。`,
    },
    {
      tag: 'env.bun',
      content: `环境：Bun 版本=${Bun.version}。`,
    },
    {
      tag: 'env.node',
      content: `环境：当前运行时兼容 Node ${process.version}；系统 node=${node.available ? node.output : '不可用'}。`,
    },
    {
      tag: 'env.powershell',
      content: `环境：PowerShell Core(pwsh)=${pwsh.available ? pwsh.output : '不可用'}；Windows PowerShell=${windowsPowerShell.available ? windowsPowerShell.output : '不可用'}。`,
    },
    {
      tag: 'env.bash',
      content: `环境：Bash=${bash.available ? bash.output : '不可用'}。`,
    },
    {
      tag: 'env.cli',
      content: `环境：当前已接入 CLI=claude；系统 claude=${claude.available ? '可用' : '不可用'}${claude.output ? ` (${claude.output})` : ''}。`,
    },
    {
      tag: 'env.path_style',
      content:
        process.platform === 'win32'
          ? '环境：平台路径风格为 Windows drive path；对用户展示路径时优先使用 D:/dir 这种正斜杠形式。'
          : '环境：平台路径风格为 POSIX absolute path；路径通常形如 /home/user/project。',
    },
  ]
}

export function formatGlobalMemoryContext(memories: Memory[]): string {
  const globalMemories = memories
    .filter(m => m.conversationId === null)
    .sort((a, b) => memorySortKey(a).localeCompare(memorySortKey(b)))

  if (globalMemories.length === 0) return ''

  const lines = globalMemories.map(m => `- ${memoryTypeLabel(m.type)}：${m.content.trim()}`)
  return ['[长期记忆 · 供参考]', ...lines, '---'].join('\n')
}

function memorySortKey(memory: Memory): string {
  return `${memory.type}:${memory.tag ?? ''}:${memory.createdAt}:${memory.id}`
}

function memoryTypeLabel(type: MemoryType): string {
  if (type === 'preference') return '偏好'
  if (type === 'episodic') return '情节'
  return '事实'
}

function normalizePathForMemory(value: string): string {
  return value.replace(/\\+/g, '/')
}

interface ProbeResult {
  available: boolean
  output: string
}

async function probeCliAvailability(name: string): Promise<ProbeResult> {
  if (process.platform === 'win32') return probeCommand('where.exe', [name], firstLine)
  return probeCommand('which', [name], firstLine)
}

async function probeCommand(
  command: string,
  args: string[],
  transform: (output: string) => string = output => output.trim(),
): Promise<ProbeResult> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null
  const timeout = new Promise<number>(resolve => {
    setTimeout(() => {
      proc?.kill()
      resolve(-1)
    }, 1500)
  })

  try {
    proc = Bun.spawn([command, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      Promise.race([proc.exited, timeout]),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const output = transform(`${stdout}\n${stderr}`.trim())
    return { available: exitCode === 0, output }
  } catch {
    return { available: false, output: '' }
  }
}

function firstLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ?? ''
  )
}
