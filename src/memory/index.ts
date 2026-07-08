/**
 * memory —— 长期记忆 V1：环境快照 + 实例级全局记忆注入。
 *
 * 本模块只依赖 event/repository/config/shared；不 import core/、transport/、cli/。
 */
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { AppConfig } from '../config'
import type { EventBus } from '../event'
import type { Memory, Repositories } from '../repository'
import { DEFAULT_MEMORY_NAMESPACE, type MemoryType } from '../shared'

export interface MemoryModule {
  recallGlobalContext(): Promise<string>
  refreshEnvironmentSnapshot(): Promise<void>
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
    async refreshEnvironmentSnapshot() {
      await upsertEnvironmentSnapshot(deps, namespace)
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
  const isWindows = process.platform === 'win32'
  const mediaDir = path.resolve(config.MEDIA_DOWNLOAD_DIR)
  const [
    node,
    bash,
    zsh,
    sh,
    bunCli,
    git,
    claude,
    codex,
    gemini,
    docker,
    dockerCompose,
    dockerPs,
    pm2,
    pm2Apps,
    psql,
    ss,
    dfDefault,
    dfMedia,
    mediaInfo,
  ] = await Promise.all([
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
    probeCommand('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'], summarizeLines),
    probeCommand('pm2', ['--version']),
    probeCommand('pm2', ['jlist'], summarizePm2Apps),
    probeCommand('psql', ['--version']),
    isWindows ? unavailable() : probeCommand('ss', ['-ltn'], summarizeListeningPorts),
    isWindows ? unavailable() : probeCommand('df', ['-h', normalizePathForMemory(config.DEFAULT_CWD)], summarizeDf),
    isWindows ? unavailable() : probeCommand('df', ['-h', mediaDir], summarizeDf),
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
      content: [
        '环境画像：[工作目录]',
        `DEFAULT_CWD=${normalizePathForMemory(config.DEFAULT_CWD)}`,
        `DEFAULT_CWD disk=${dfDefault.available ? dfDefault.output : 'unknown'}`,
      ].join('\n'),
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
        `pm2 apps=${pm2Apps.available ? pm2Apps.output : 'unknown'}`,
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
        `docker containers=${dockerPs.available ? dockerPs.output : 'unknown'}`,
        `psql=${psql.available ? psql.output : 'missing'}`,
        `DATABASE_URL host=${summarizeDatabaseUrl(config.DATABASE_URL)}`,
      ].join('\n'),
    },
    {
      tag: 'env.network',
      content: ['环境画像：[网络与端口]', `listening tcp=${ss.available ? ss.output : 'unknown'}`].join('\n'),
    },
    {
      tag: 'env.media',
      content: [
        '环境画像：[媒体目录]',
        `MEDIA_DOWNLOAD_DIR=${normalizePathForMemory(mediaDir)}`,
        `exists=${mediaInfo.exists}; writable=${mediaInfo.writable}; kind=${mediaInfo.kind}`,
        `disk=${dfMedia.available ? dfMedia.output : 'unknown'}`,
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

interface DirectoryProbe {
  exists: boolean
  writable: boolean
  kind: 'directory' | 'file' | 'missing' | 'other'
}

function unavailable(): Promise<ProbeResult> {
  return Promise.resolve({ available: false, output: '' })
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

function summarizeLines(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'none'
  return lines.slice(0, 8).join(' | ')
}

function summarizePm2Apps(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return 'unrecognized'
    if (parsed.length === 0) return 'none'
    return parsed
      .slice(0, 8)
      .map(item => {
        if (!isRecord(item)) return 'unknown'
        const name = readString(item, 'name') ?? 'unknown'
        const pid = readNumber(item, 'pid')
        const pm2Env = isRecord(item.pm2_env) ? item.pm2_env : {}
        const status = readString(pm2Env, 'status') ?? 'unknown'
        const cwd = readString(pm2Env, 'pm_cwd')
        return `${name}:${status}${pid !== undefined ? ` pid=${pid}` : ''}${cwd ? ` cwd=${normalizePathForMemory(cwd)}` : ''}`
      })
      .join(' | ')
  } catch {
    return firstLine(output)
  }
}

function summarizeListeningPorts(output: string): string {
  const ports = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|\*|0\.0\.0\.0):(\d+)/)
    if (match?.[1]) ports.add(match[1])
  }
  return ports.size > 0 ? Array.from(ports).slice(0, 20).join(',') : 'none'
}

function summarizeDf(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines[1] ?? lines[0] ?? ''
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}
