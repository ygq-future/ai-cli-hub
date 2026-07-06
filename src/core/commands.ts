/**
 * CommandRouter —— 系统命令路由。
 *
 * 只处理以 "/" 开头、不会进入 CLI 的命令；普通文本返回 false 交还 MessageRouter。
 * 回复经 CommandReply 事件发回原始 MessageRef，避免为 /status 等只读命令创建会话。
 */
import type { EventBus, EventMap } from '../event'
import type { CliType, ConversationId, UserLanguage } from '../shared'
import type { Repositories, Conversation, AuditLog } from '../repository'
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
}

type CwdResolveResult = { ok: true; cwd: string } | { ok: false; message: string }
type SessionTargetResolveResult = { ok: true; cli: CliType; cwd: string } | { ok: false; message: string }

const KNOWN_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude', 'codex', 'gemini'])
const SUPPORTED_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude'])

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const { bus, repos, sessionManager } = deps
  const getUserLanguage = deps.getUserLanguage ?? (() => 'zh' as const)
  const resolveCwd = deps.resolveCwd ?? ((cwd: string) => ({ ok: true as const, cwd }))

  function reply(payload: EventMap['MessageReceived'], content: string) {
    bus.emit('CommandReply', { ref: payload.ref, content })
  }

  async function currentConversation(payload: EventMap['MessageReceived']): Promise<Conversation | null> {
    return repos.conversations.findActive(payload.userId, payload.cli, payload.cwd)
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
          const sessions = await repos.conversations.listRecentByUser(payload.userId, 10)
          reply(payload, formatSessions(sessions))
          return true
        }

        case 'audit': {
          const resolved = await resolveAuditConversation(parsed.args, payload, repos)
          if (!resolved.ok) {
            reply(payload, resolved.message)
            return true
          }
          const records = await repos.audit.listByConversation(resolved.conversation.id as ConversationId)
          reply(payload, formatAudit(resolved.conversation, records.slice(-10)))
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
): Promise<{ ok: true; conversation: Conversation } | { ok: false; message: string }> {
  const target = args[0]?.trim()
  if (!target) {
    const conv = await repos.conversations.findActive(payload.userId, payload.cli, payload.cwd)
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

  const recent = await repos.conversations.listRecentByUser(payload.userId, 50)
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

function truncateForAudit(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= 300) return normalized
  return `${normalized.slice(0, 297)}...`
}

function shortId(id: ConversationId): string {
  return id.slice(0, 8)
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
