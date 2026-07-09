/**
 * memory —— 长期记忆：环境快照 + 实例级全局记忆注入 + V1.5 语义召回。
 *
 * 本模块只依赖 event/repository/config/shared；不 import core/、transport/、cli/。
 */
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { AppConfig } from '../config'
import type { EventBus } from '../event'
import type { Memory, Message, Repositories } from '../repository'
import {
  DEFAULT_MEMORY_NAMESPACE,
  type ConversationId,
  type MemoryType,
  type Unsubscribe,
  type UserLanguage,
} from '../shared'
import { createEmbeddingProvider, type EmbeddingProvider } from './embedding-provider'
import { createSummaryProvider, type SummaryProvider } from './summary-provider'

export interface MemoryModule {
  recallGlobalContext(): Promise<string>
  recallRelevantContext(query: string): Promise<string>
  refreshEnvironmentSnapshot(): Promise<void>
  destroy(): void
}

export interface MemoryModuleDeps {
  bus: EventBus
  repos: Repositories
  config: AppConfig
  namespace?: string
  embeddingProvider?: EmbeddingProvider
  summaryProvider?: SummaryProvider
}

interface EnvironmentFact {
  tag: string
  content: string
  importance?: number
}

const CONVERSATION_SUMMARY_MESSAGE_LIMIT = 12
const CONVERSATION_SUMMARY_MESSAGE_MAX_CHARS = 800
const REQUESTED_SUMMARY_MESSAGE_LIMIT = 10

export async function createMemoryModule(deps: MemoryModuleDeps): Promise<MemoryModule> {
  const namespace = deps.namespace ?? DEFAULT_MEMORY_NAMESPACE
  const embeddingProvider = deps.embeddingProvider ?? createEmbeddingProvider(deps.config)
  const summaryProvider = deps.summaryProvider ?? createSummaryProvider(deps.config)
  const unsubs: Unsubscribe[] = []
  unsubs.push(
    deps.bus.on('MemoryUpdated', payload => {
      if (payload.namespace !== namespace) return
      void embedMemoryById(deps, embeddingProvider, payload.memoryId)
    }),
  )
  unsubs.push(
    deps.bus.on('SessionClosed', payload => {
      void createConversationSummaryMemory(deps, namespace, payload.conversationId)
    }),
  )
  unsubs.push(
    deps.bus.on('MemorySummaryRequested', payload => {
      void createRequestedSummaryMemory(
        deps,
        namespace,
        summaryProvider,
        payload.conversationId,
        payload.text,
        payload.language,
      )
    }),
  )
  await upsertEnvironmentSnapshot(deps, namespace)

  return {
    async recallGlobalContext() {
      const memories = await deps.repos.memories.listGlobal(namespace)
      return formatGlobalMemoryContext(memories)
    },
    async recallRelevantContext(query: string) {
      const embedding = await embeddingProvider.embed(query)
      const memories = await deps.repos.memories.searchByVector(namespace, embedding, deps.config.MEMORY_RECALL_TOP_K)
      const relevantMemories = memories.filter(m => m.conversationId !== null)
      await Promise.all(relevantMemories.map(m => deps.repos.memories.touch(m.id)))
      return formatRelevantMemoryContext(relevantMemories)
    },
    async refreshEnvironmentSnapshot() {
      await upsertEnvironmentSnapshot(deps, namespace)
    },
    destroy() {
      for (const u of unsubs) u()
      unsubs.length = 0
    },
  }
}

async function embedMemoryById(deps: MemoryModuleDeps, embeddingProvider: EmbeddingProvider, memoryId: string) {
  try {
    const memory = await deps.repos.memories.findById(memoryId)
    if (!memory || memory.conversationId === null) return
    const embedding = await embeddingProvider.embed(memory.content)
    await deps.repos.memories.setEmbedding(memory.id, embedding)
  } catch (err) {
    deps.bus.emit('ErrorOccurred', {
      scope: 'memory:embed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function createConversationSummaryMemory(
  deps: MemoryModuleDeps,
  namespace: string,
  conversationId: string,
): Promise<void> {
  try {
    const cid = conversationId as ConversationId
    const messages = await deps.repos.messages.listByConversation(cid)
    const content = formatConversationSummaryMemory(conversationId, messages)
    if (!content) return

    const lastMessage = [...messages].reverse().find(m => m.content.trim())
    const memory = await deps.repos.memories.upsertByTag(namespace, `conversation.summary:${conversationId}`, {
      conversationId: cid,
      type: 'episodic',
      content,
      embedding: null,
      sourceMessageId: lastMessage?.id ?? null,
      importance: 0.6,
      accessCount: 0,
      lastAccessedAt: null,
    })
    deps.bus.emit('MemoryUpdated', {
      conversationId: cid,
      namespace,
      memoryType: memory.type,
      memoryId: memory.id,
    })
  } catch (err) {
    deps.bus.emit('ErrorOccurred', {
      scope: 'memory:conversationSummary',
      message: err instanceof Error ? err.message : String(err),
      conversationId: conversationId as ConversationId,
    })
  }
}

async function createRequestedSummaryMemory(
  deps: MemoryModuleDeps,
  namespace: string,
  summaryProvider: SummaryProvider,
  conversationId: ConversationId,
  userRequest: string,
  language: UserLanguage,
): Promise<void> {
  try {
    const messages = await deps.repos.messages.listByConversation(conversationId)
    const recentMessages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-REQUESTED_SUMMARY_MESSAGE_LIMIT)
    if (recentMessages.length === 0) return

    const summary = await summaryProvider.summarizeRecentMessages(recentMessages, userRequest, language)
    if (!summary.trim()) return

    const lastMessage = [...recentMessages].reverse().find(m => m.content.trim())
    const memory = await deps.repos.memories.insert({
      id: crypto.randomUUID(),
      namespace,
      conversationId,
      type: 'episodic',
      content: summary,
      embedding: null,
      sourceMessageId: lastMessage?.id ?? null,
      importance: 0.75,
      accessCount: 0,
      lastAccessedAt: null,
      tag: null,
      createdAt: Date.now(),
    })
    deps.bus.emit('MemoryUpdated', {
      conversationId,
      namespace,
      memoryType: memory.type,
      memoryId: memory.id,
    })
  } catch (err) {
    deps.bus.emit('ErrorOccurred', {
      scope: 'memory:requestedSummary',
      message: err instanceof Error ? err.message : String(err),
      conversationId,
    })
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
  const isWindows = process.platform === 'win32'
  const mediaDir = path.resolve(config.MEDIA_DOWNLOAD_DIR)
  const [node, bash, zsh, sh, bunCli, git, claude, codex, gemini, docker, dockerCompose, pm2, psql, mediaInfo] =
    await Promise.all([
      probeCommand('node', ['--version']),
      probeCommand('bash', ['--version'], firstLine),
      probeCommand('zsh', ['--version'], firstLine),
      probeCommand('sh', ['--version'], firstLine),
      probeCommand('bun', ['--version']),
      probeCommand('git', ['--version']),
      probeCliAvailability('claude'),
      probeCliAvailability('codex'),
      probeCliAvailability('gemini'),
      probeCommand('docker', ['--version']),
      probeCommand('docker', ['compose', 'version']),
      probeCommand('pm2', ['--version']),
      probeCommand('psql', ['--version']),
      inspectDirectory(mediaDir),
    ])

  const shells = [
    `bash=${bash.available ? bash.output : 'missing'}`,
    zsh.available ? `zsh=${zsh.output}` : null,
    sh.available ? `sh=${sh.output}` : null,
  ].filter(Boolean)
  const cliFacts = [
    `claude=${claude.available ? `available (${claude.output})` : 'missing'}`,
    `codex=${codex.available ? `available (${codex.output})` : 'missing'}`,
    `gemini=${gemini.available ? `available (${gemini.output})` : 'missing'}`,
  ]

  return [
    {
      tag: 'env.os',
      content: [
        '环境画像：[运行环境]',
        `OS=${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
        `hostname=${os.hostname()}`,
        `service cwd=${normalizePathForMemory(process.cwd())}`,
        `path style=${isWindows ? 'Windows drive path' : 'POSIX absolute path'}`,
      ].join('\n'),
    },
    {
      tag: 'env.runtime',
      content: [
        '环境画像：[运行时与 Shell]',
        `Bun runtime=${Bun.version}; bun cli=${bunCli.available ? bunCli.output : 'missing'}`,
        `Node runtime=${process.version}; node cli=${node.available ? node.output : 'missing'}`,
        `git=${git.available ? git.output : 'missing'}`,
        `shells=${shells.join('; ')}`,
      ].join('\n'),
    },
    {
      tag: 'env.default_cwd',
      content: ['环境画像：[工作目录]', `DEFAULT_CWD=${normalizePathForMemory(config.DEFAULT_CWD)}`].join('\n'),
    },
    {
      tag: 'env.cli',
      content: ['环境画像：[AI CLI]', '当前已接入 CLI=claude', ...cliFacts].join('\n'),
    },
    {
      tag: 'env.service_manager',
      content: [
        '环境画像：[服务管理]',
        `pm2=${pm2.available ? `available (${pm2.output})` : 'missing'}`,
        isWindows
          ? 'systemd=not applicable on Windows'
          : 'systemd=available on most Linux hosts; current project prefers PM2 if pm2 exists',
      ].join('\n'),
    },
    {
      tag: 'env.container',
      content: [
        '环境画像：[容器与数据库]',
        `docker=${docker.available ? docker.output : 'missing'}`,
        `docker compose=${dockerCompose.available ? dockerCompose.output : 'missing'}`,
        `psql=${psql.available ? psql.output : 'missing'}`,
        `DATABASE_URL host=${summarizeDatabaseUrl(config.DATABASE_URL)}`,
      ].join('\n'),
    },
    {
      tag: 'env.media',
      content: [
        '环境画像：[媒体目录]',
        `MEDIA_DOWNLOAD_DIR=${normalizePathForMemory(mediaDir)}`,
        `exists=${mediaInfo.exists}; writable=${mediaInfo.writable}; kind=${mediaInfo.kind}`,
        `limits=max_file_bytes=${config.MEDIA_MAX_FILE_BYTES}, parse_timeout_ms=${config.MEDIA_PARSE_TIMEOUT_MS}`,
        '清理提示：可按该目录 local_path 清理过久上传文件；清理前确认没有正在处理的会话引用。',
      ].join('\n'),
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

export function formatRelevantMemoryContext(memories: Memory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(m => `- ${memoryTypeLabel(m.type)}：${m.content.trim()}`)
  return ['[相关长期记忆 · 语义召回]', ...lines, '---'].join('\n')
}

export function formatConversationSummaryMemory(conversationId: string, messages: Message[]): string {
  const conversationMessages = messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
  if (conversationMessages.length < 2) return ''

  const selected = conversationMessages.slice(-CONVERSATION_SUMMARY_MESSAGE_LIMIT)
  const lines = selected.map(m => {
    const role = m.role === 'assistant' ? '助手' : '用户'
    return `- ${role}：${truncateForConversationSummary(m.content)}`
  })
  return [
    '会话派生记忆：该内容来自一次已关闭会话，用于未来按语义召回，不属于全局默认事实。',
    `conversation_id=${conversationId}`,
    '最近对话摘录：',
    ...lines,
  ].join('\n')
}

function memorySortKey(memory: Memory): string {
  return `${memory.type}:${memory.tag ?? ''}:${memory.createdAt}:${memory.id}`
}

function memoryTypeLabel(type: MemoryType): string {
  if (type === 'preference') return '偏好'
  if (type === 'episodic') return '情节'
  return '事实'
}

function truncateForConversationSummary(content: string): string {
  const normalized = content.trim()
  if (normalized.length <= CONVERSATION_SUMMARY_MESSAGE_MAX_CHARS) return normalized
  return `${normalized.slice(0, CONVERSATION_SUMMARY_MESSAGE_MAX_CHARS - 3)}...`
}

function normalizePathForMemory(value: string): string {
  return value.replace(/\\+/g, '/')
}

interface ProbeResult {
  available: boolean
  output: string
}

interface DirectoryProbe {
  exists: boolean
  writable: boolean
  kind: 'directory' | 'file' | 'missing' | 'other'
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

function summarizeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '')}`
  } catch {
    return 'invalid'
  }
}

async function inspectDirectory(dir: string): Promise<DirectoryProbe> {
  try {
    await mkdir(dir, { recursive: true })
    const info = await stat(dir)
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    let writable = false
    try {
      await access(dir, fsConstants.W_OK)
      writable = true
    } catch {
      writable = false
    }
    return { exists: true, writable, kind }
  } catch {
    return { exists: false, writable: false, kind: 'missing' }
  }
}
