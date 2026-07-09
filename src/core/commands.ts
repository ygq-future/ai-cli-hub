/**
 * CommandRouter —— 系统命令路由。
 *
 * 只处理以 "/" 开头、不会进入 CLI 的命令；普通文本返回 false 交还 MessageRouter。
 * 回复经 CommandReply 事件发回原始 MessageRef，避免为 /status 等只读命令创建会话。
 */
import type { EventBus, EventMap } from '../event'
import {
  DEFAULT_MEMORY_NAMESPACE,
  type CliType,
  type ConversationId,
  type MemoryType,
  type UserLanguage,
} from '../shared'
import type { Repositories, Conversation, AuditLog, Memory } from '../repository'
import type { SessionManager } from './session-manager'

export interface CommandRouter {
  tryHandle(payload: EventMap['MessageReceived']): Promise<boolean>
}

export interface CommandRouterDeps {
  bus: EventBus
  repos: Repositories
  sessionManager: SessionManager
  getUserLanguage?: (userId: string) => UserLanguage
  resolveCwd?: (cwd: string) => Promise<CwdResolveResult> | CwdResolveResult
  refreshEnvironmentSnapshot?: () => Promise<void>
  getHealthReport?: () => Promise<string>
  getUpdatePreview?: () => string
  performUpdate?: (ref: EventMap['MessageReceived']['ref']) => Promise<string>
  getRestartPreview?: () => string
  performRestart?: (ref: EventMap['MessageReceived']['ref']) => Promise<string>
}

type CwdResolveResult = { ok: true; cwd: string } | { ok: false; message: string }
type SessionTargetResolveResult = { ok: true; cli: CliType; cwd: string } | { ok: false; message: string }

const KNOWN_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude', 'codex', 'gemini'])
const SUPPORTED_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude'])
const RECENT_SESSIONS_LIMIT = 10
const ID_PREFIX_SEARCH_LIMIT = 50
const SHORT_ID_CHARS = 8
const MEMORY_PREVIEW_CHARS = 160
const AUDIT_COMMAND_PREVIEW_CHARS = 300

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const { bus, repos, sessionManager } = deps
  const getUserLanguage = deps.getUserLanguage ?? (() => 'zh' as const)
  const resolveCwd = deps.resolveCwd ?? ((cwd: string) => ({ ok: true as const, cwd }))

  function reply(payload: EventMap['MessageReceived'], content: string) {
    bus.emit('CommandReply', { ref: payload.ref, content })
  }

  async function currentConversation(payload: EventMap['MessageReceived']): Promise<Conversation | null> {
    const currentId = await sessionManager.findCurrent({
      userId: payload.userId,
      platform: payload.platform,
      cli: payload.cli,
      cwd: payload.cwd,
    })
    return currentId ? repos.conversations.findById(currentId) : null
  }

  return {
    async tryHandle(payload) {
      const parsed = parseCommand(payload.text)
      if (!parsed) return false

      switch (parsed.name) {
        case 'new': {
          const target = await parseSessionTarget(parsed.args, payload.cli, payload.cwd, resolveCwd)
          if (!target.ok) {
            reply(payload, target.message)
            return true
          }
          const { cli, cwd } = target
          const current = await currentConversation(payload)
          if (current) await sessionManager.close(current.id as ConversationId, 'user')
          const cid = await sessionManager.forceNew({
            userId: payload.userId,
            platform: payload.platform,
            cli,
            cwd,
            text: payload.text,
          })
          reply(payload, `已开启新会话\nID: ${cid}\nCLI: ${cli}\nCWD: ${cwd}`)
          return true
        }

        case 'close': {
          const conv = await currentConversation(payload)
          if (!conv) {
            reply(payload, '当前没有可关闭的活跃会话。')
            return true
          }
          await sessionManager.close(conv.id as ConversationId, 'user')
          reply(payload, `已关闭当前会话\nID: ${conv.id}`)
          return true
        }

        case 'cwd': {
          if (parsed.args.length === 0) {
            reply(payload, `当前工作目录\nCLI: ${payload.cli}\nCWD: ${payload.cwd}`)
            return true
          }
          const rawCwd = parsed.args.join(' ')
          const resolved = await resolveCwd(rawCwd)
          if (!resolved.ok) {
            reply(payload, resolved.message)
            return true
          }
          const conv = await currentConversation(payload)
          if (conv) await sessionManager.close(conv.id as ConversationId, 'user')
          bus.emit('UserTargetChanged', { userId: payload.userId, cwd: resolved.cwd })
          reply(payload, `已切换工作目录\nCWD: ${resolved.cwd}\n当前会话已关闭，下一条消息会在新目录启动。`)
          return true
        }

        case 'status': {
          const conv = await currentConversation(payload)
          if (!conv) {
            reply(
              payload,
              [
                '当前没有活跃会话。直接发送消息会自动创建新会话。',
                `Target CLI: ${payload.cli}`,
                `Target CWD: ${payload.cwd}`,
                `Language: ${getUserLanguage(payload.userId)}`,
              ].join('\n'),
            )
            return true
          }
          reply(payload, formatStatus(conv, getUserLanguage(payload.userId), payload.cli, payload.cwd))
          return true
        }

        case 'sessions': {
          const sessions = await repos.conversations.listRecentByUser(payload.userId, RECENT_SESSIONS_LIMIT)
          reply(payload, formatSessions(sessions))
          return true
        }

        case 'audit': {
          const resolved = await resolveAuditConversation(parsed.args, payload, repos, currentConversation)
          if (!resolved.ok) {
            reply(payload, resolved.message)
            return true
          }
          const records = await repos.audit.listByConversation(resolved.conversation.id as ConversationId)
          reply(payload, formatAudit(resolved.conversation, records.slice(-10)))
          return true
        }

        case 'remember': {
          const raw = parsed.args.join(' ').trim()
          if (!raw) {
            reply(payload, '用法：/remember <要长期记住的事实或偏好>')
            return true
          }
          const classified = classifyManualMemory(raw)
          if (!classified.content) {
            reply(payload, '记忆内容不能为空。')
            return true
          }
          const memory = await repos.memories.insert({
            id: crypto.randomUUID(),
            namespace: DEFAULT_MEMORY_NAMESPACE,
            conversationId: null,
            type: classified.type,
            content: classified.content,
            embedding: null,
            sourceMessageId: null,
            importance: classified.type === 'preference' ? 0.85 : 0.75,
            accessCount: 0,
            lastAccessedAt: null,
            tag: null,
            createdAt: Date.now(),
          })
          bus.emit('MemoryUpdated', {
            conversationId: null,
            namespace: DEFAULT_MEMORY_NAMESPACE,
            memoryType: memory.type,
            memoryId: memory.id,
            operatorUserId: payload.userId,
          })
          reply(
            payload,
            [`已记住，下一条消息会加载最新记忆。`, `ID: ${memory.id}`, `Type: ${memory.type}`, memory.content].join(
              '\n',
            ),
          )
          return true
        }

        case 'memory': {
          const memories = await repos.memories.listGlobal(DEFAULT_MEMORY_NAMESPACE)
          reply(payload, formatMemories(memories))
          return true
        }

        case 'env': {
          await deps.refreshEnvironmentSnapshot?.()
          const memories = await repos.memories.listGlobal(DEFAULT_MEMORY_NAMESPACE)
          reply(payload, formatEnvironmentMemories(memories))
          return true
        }

        case 'health': {
          if (!deps.getHealthReport) {
            reply(payload, '健康检查暂未配置。')
            return true
          }
          reply(payload, await deps.getHealthReport())
          return true
        }

        case 'update': {
          if (!deps.getUpdatePreview || !deps.performUpdate) {
            reply(payload, '自更新暂未配置。')
            return true
          }
          if (parsed.args.length === 0) {
            reply(payload, deps.getUpdatePreview())
            return true
          }
          if (parsed.args.length === 1 && parsed.args[0] === 'confirm') {
            reply(payload, await deps.performUpdate(payload.ref))
            return true
          }
          reply(payload, '用法：/update 查看计划；/update confirm 执行自更新。')
          return true
        }

        case 'restart': {
          if (!deps.getRestartPreview || !deps.performRestart) {
            reply(payload, '重启暂未配置。')
            return true
          }
          if (parsed.args.length === 0) {
            reply(payload, deps.getRestartPreview())
            return true
          }
          if (parsed.args.length === 1 && parsed.args[0] === 'confirm') {
            reply(payload, await deps.performRestart(payload.ref))
            return true
          }
          reply(payload, '用法：/restart 查看计划；/restart confirm 执行重启。')
          return true
        }

        case 'forget': {
          const target = parsed.args[0]?.trim()
          if (!target) {
            reply(payload, '用法：/forget <memoryId>')
            return true
          }
          const resolved = await resolveMemory(target, repos)
          if (!resolved.ok) {
            reply(payload, resolved.message)
            return true
          }
          await repos.memories.delete(resolved.memory.id)
          bus.emit('MemoryUpdated', {
            conversationId: null,
            namespace: DEFAULT_MEMORY_NAMESPACE,
            memoryType: resolved.memory.type,
            memoryId: resolved.memory.id,
            operatorUserId: payload.userId,
          })
          reply(payload, `已删除记忆，下一条消息会加载最新记忆。\nID: ${resolved.memory.id}`)
          return true
        }

        default:
          reply(payload, `未知命令：/${parsed.name}\n发送 /help 查看可用命令。`)
          return true
      }
    },
  }
}

function parseCommand(text: string): { name: string; args: string[] } | null {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  const head = parts[0]
  if (!head?.startsWith('/')) return null
  const name = head.slice(1).split('@')[0]?.toLowerCase()
  if (!name) return null
  return { name, args: parts.slice(1) }
}

async function parseSessionTarget(
  args: string[],
  fallbackCli: CliType,
  fallbackCwd: string,
  resolveCwd: (cwd: string) => Promise<CwdResolveResult> | CwdResolveResult,
): Promise<SessionTargetResolveResult> {
  const [first, ...rest] = args
  if (!first) return { ok: true, cli: fallbackCli, cwd: fallbackCwd }

  if (KNOWN_CLI_TYPES.has(first as CliType)) {
    const cli = first as CliType
    if (!SUPPORTED_CLI_TYPES.has(cli)) return { ok: false, message: `暂不支持 CLI：${cli}` }
    if (rest.length === 0) return { ok: true, cli, cwd: fallbackCwd }
    const resolved = await resolveCwd(rest.join(' '))
    return resolved.ok ? { ...resolved, cli } : resolved
  }

  if (looksLikeAbsolutePath(first)) {
    const resolved = await resolveCwd(args.join(' '))
    return resolved.ok ? { ...resolved, cli: fallbackCli } : resolved
  }

  return { ok: false, message: `不支持的 CLI：${first}` }
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value)
}

function formatStatus(conv: Conversation, language: UserLanguage, targetCli: CliType, targetCwd: string): string {
  return [
    '当前会话',
    `ID: ${conv.id}`,
    `Status: ${conv.status}`,
    `Platform: ${conv.platform}`,
    `CLI: ${conv.cli}`,
    `Language: ${language}`,
    `CWD: ${conv.cwd}`,
    `Target CLI: ${targetCli}`,
    `Target CWD: ${targetCwd}`,
    `Alive: ${formatDuration(Date.now() - conv.createdAt)}`,
  ].join('\n')
}

function formatSessions(sessions: Conversation[]): string {
  if (sessions.length === 0) return '暂无历史会话。'

  return [
    '最近会话',
    ...sessions.map(
      s => `${shortId(s.id as ConversationId)} | ${s.status} | ${s.cli} | ${formatDate(s.updatedAt)} | ${s.cwd}`,
    ),
  ].join('\n')
}

async function resolveAuditConversation(
  args: string[],
  payload: EventMap['MessageReceived'],
  repos: Repositories,
  currentConversation: (payload: EventMap['MessageReceived']) => Promise<Conversation | null>,
): Promise<{ ok: true; conversation: Conversation } | { ok: false; message: string }> {
  const target = args[0]?.trim()
  if (!target) {
    const conv = await currentConversation(payload)
    if (!conv) {
      return {
        ok: false,
        message: '当前没有活跃会话。可用 /sessions 查看会话后执行 /audit <conversationId>。',
      }
    }
    return { ok: true, conversation: conv }
  }

  const exact = await repos.conversations.findById(target as ConversationId)
  if (exact) return exact.userId === payload.userId ? { ok: true, conversation: exact } : auditNotFound(target)

  const recent = await repos.conversations.listRecentByUser(payload.userId, ID_PREFIX_SEARCH_LIMIT)
  const matches = recent.filter(conv => conv.id.startsWith(target))
  if (matches.length === 1) return { ok: true, conversation: matches[0]! }
  if (matches.length > 1) return { ok: false, message: `会话 ID 前缀不唯一：${target}\n请多输入几位。` }
  return auditNotFound(target)
}

function auditNotFound(target: string): { ok: false; message: string } {
  return { ok: false, message: `找不到可查看的会话：${target}` }
}

function formatAudit(conv: Conversation, records: AuditLog[]): string {
  if (records.length === 0) {
    return ['审批审计', `Conversation: ${conv.id}`, '暂无审批记录。'].join('\n')
  }

  return [
    '审批审计',
    `Conversation: ${conv.id}`,
    ...records.map(record =>
      [
        `${formatDate(record.createdAt)} | ${formatAuditAction(record.action)} | ${record.operator}`,
        truncateForAudit(record.command),
      ].join('\n'),
    ),
  ].join('\n\n')
}

function formatAuditAction(action: AuditLog['action']): string {
  return action === 'approve' ? 'approved' : 'rejected'
}

function formatMemories(memories: Memory[]): string {
  const globalMemories = memories
    .filter(m => m.namespace === DEFAULT_MEMORY_NAMESPACE && m.conversationId === null)
    .sort((a, b) => b.createdAt - a.createdAt)
  if (globalMemories.length === 0) return '暂无长期记忆。'

  return [
    '**长期记忆**',
    ...globalMemories.map(m =>
      [
        `- **ID**: \`${shortMemoryId(m.id)}\``,
        `  **Namespace**: \`${m.namespace}\``,
        `  **Content**: ${truncateMemory(m.content)}`,
      ].join('\n'),
    ),
  ].join('\n\n')
}

function formatEnvironmentMemories(memories: Memory[]): string {
  const envMemories = memories
    .filter(m => m.namespace === DEFAULT_MEMORY_NAMESPACE && m.conversationId === null && m.tag?.startsWith('env.'))
    .sort((a, b) => (a.tag ?? '').localeCompare(b.tag ?? ''))
  if (envMemories.length === 0) return '暂无环境快照。'

  return ['**环境快照**', ...envMemories.map(m => `- **${m.tag}**\n${m.content.trim()}`)].join('\n\n')
}

function classifyManualMemory(rawText: string): { type: MemoryType; content: string } {
  const text = rawText.trim()
  const preferencePrefixes = ['preference:', 'preference：', '偏好:', '偏好：']
  const matched = preferencePrefixes.find(prefix => text.toLowerCase().startsWith(prefix.toLowerCase()))
  if (!matched) return { type: 'semantic', content: text }
  return { type: 'preference', content: text.slice(matched.length).trim() }
}

async function resolveMemory(
  target: string,
  repos: Repositories,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  const exact = await repos.memories.findById(target)
  if (exact) {
    return exact.namespace === DEFAULT_MEMORY_NAMESPACE && exact.conversationId === null
      ? { ok: true, memory: exact }
      : memoryNotFound(target)
  }

  const memories = await repos.memories.listGlobal(DEFAULT_MEMORY_NAMESPACE)
  const matches = memories.filter(m => m.id.startsWith(target))
  if (matches.length === 1) return { ok: true, memory: matches[0]! }
  if (matches.length > 1) return { ok: false, message: `记忆 ID 前缀不唯一：${target}\n请多输入几位。` }
  return memoryNotFound(target)
}

function memoryNotFound(target: string): { ok: false; message: string } {
  return { ok: false, message: `找不到可删除的全局记忆：${target}` }
}

function shortMemoryId(id: string): string {
  return id.slice(0, SHORT_ID_CHARS)
}

function truncateMemory(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= MEMORY_PREVIEW_CHARS) return normalized
  return `${normalized.slice(0, MEMORY_PREVIEW_CHARS - 3)}...`
}

function truncateForAudit(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= AUDIT_COMMAND_PREVIEW_CHARS) return normalized
  return `${normalized.slice(0, AUDIT_COMMAND_PREVIEW_CHARS - 3)}...`
}

function shortId(id: ConversationId): string {
  return id.slice(0, SHORT_ID_CHARS)
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
