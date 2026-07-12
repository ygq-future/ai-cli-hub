/**
 * CommandRouter —— 系统命令路由。
 *
 * 只处理以 "/" 开头、不会进入 CLI 的命令；普通文本返回 false 交还 MessageRouter。
 * 回复经 CommandReply 事件发回原始 MessageRef，避免为 /status 等只读命令创建会话。
 */
import type { EventBus, EventMap } from '../event'
import {
  DEFAULT_AUTO_APPROVE_SECONDS,
  DEFAULT_MEMORY_NAMESPACE,
  MAX_AUTO_APPROVE_SECONDS,
  MIN_AUTO_APPROVE_SECONDS,
  type AutoApprovePreference,
  type CliType,
  type ConversationId,
  type MemoryType,
  type Platform,
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
  getUserLanguage?: (platform: Platform, userId: string) => Promise<UserLanguage> | UserLanguage
  getUserTarget?: (platform: Platform, userId: string) => Promise<{ cli: CliType; cwd: string }>
  getCwdForCli?: (platform: Platform, userId: string, cli: CliType) => Promise<string>
  setUserTarget?: (platform: Platform, userId: string, target: { cli: CliType; cwd: string }) => Promise<void>
  getAutoApprove?: (platform: Platform, userId: string) => Promise<AutoApprovePreference>
  setAutoApprove?: (platform: Platform, userId: string, preference: AutoApprovePreference) => Promise<void>
  resolveCwd?: (cwd: string) => Promise<CwdResolveResult> | CwdResolveResult
  refreshEnvironmentSnapshot?: () => Promise<void>
  getHealthReport?: () => Promise<string>
  getUpdatePreview?: () => string
  performUpdate?: (ref: EventMap['MessageReceived']['ref']) => Promise<string>
  getRestartPreview?: () => string
  performRestart?: (ref: EventMap['MessageReceived']['ref']) => Promise<string>
}

type CwdResolveResult = { ok: true; cwd: string } | { ok: false; message: string }
type SessionTargetResolveResult =
  { ok: true; cli: CliType; cwd: string; cliExplicit: boolean; cwdExplicit: boolean } | { ok: false; message: string }

const KNOWN_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude', 'opencode', 'codex', 'gemini'])
const SUPPORTED_CLI_TYPES: ReadonlySet<CliType> = new Set(['claude', 'opencode'])
const RECENT_SESSIONS_LIMIT = 10
const ID_PREFIX_SEARCH_LIMIT = 50
const SHORT_ID_CHARS = 8
const MEMORY_PREVIEW_CHARS = 160
const AUDIT_COMMAND_PREVIEW_CHARS = 300

export function createCommandRouter(deps: CommandRouterDeps): CommandRouter {
  const { bus, repos, sessionManager } = deps
  const getUserLanguage = deps.getUserLanguage ?? (() => 'zh' as const)
  const getUserTarget = deps.getUserTarget
  const getCwdForCli = deps.getCwdForCli
  const setUserTarget =
    deps.setUserTarget ??
    (async (platform: Platform, userId: string, target: { cli: CliType; cwd: string }) => {
      bus.emit('UserTargetChanged', { platform, userId, ...target })
    })
  const resolveCwd = deps.resolveCwd ?? ((cwd: string) => ({ ok: true as const, cwd }))

  function reply(payload: EventMap['MessageReceived'], content: string) {
    bus.emit('CommandReply', { ref: payload.ref, content: ensureMarkdownCommandReply(content) })
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
          const fallback = getUserTarget
            ? await getUserTarget(payload.platform, payload.userId)
            : { cli: payload.cli, cwd: payload.cwd }
          const target = await parseSessionTarget(
            parsed.args,
            fallback.cli,
            fallback.cwd,
            resolveCwd,
            cli => getCwdForCli?.(payload.platform, payload.userId, cli) ?? Promise.resolve(fallback.cwd),
          )
          if (!target.ok) {
            reply(payload, commandError('无法创建会话', target.message, '/new [cli] [cwd]'))
            return true
          }
          const { cli, cwd, cliExplicit, cwdExplicit } = target
          const current = await currentConversation(payload)
          if (current) await sessionManager.close(current.id as ConversationId, 'user')
          const cid = await sessionManager.forceNew({
            userId: payload.userId,
            platform: payload.platform,
            cli,
            cwd,
            text: payload.text,
            cliExplicit,
            cwdExplicit,
          })
          const created = await repos.conversations.findById(cid)
          await setUserTarget(payload.platform, payload.userId, { cli, cwd })
          reply(
            payload,
            [
              '## 🆕 新会话已创建',
              '',
              `- **ID**: \`${cid}\``,
              `- **CLI**: \`${created?.cli ?? cli}\``,
              `- **CWD**: \`${created?.cwd ?? cwd}\``,
            ].join('\n'),
          )
          return true
        }

        case 'close': {
          const conv = await currentConversation(payload)
          if (!conv) {
            reply(payload, commandError('无法关闭会话', '当前没有可关闭的活跃会话。'))
            return true
          }
          await sessionManager.close(conv.id as ConversationId, 'user')
          reply(payload, `## ✅ 会话已关闭\n\n- **ID**: \`${conv.id}\``)
          return true
        }

        case 'cwd': {
          const preferredTarget = getUserTarget
            ? await getUserTarget(payload.platform, payload.userId)
            : { cli: payload.cli, cwd: payload.cwd }
          if (parsed.args.length === 0) {
            reply(
              payload,
              `## 📁 当前工作目录\n\n- **CLI**: \`${preferredTarget.cli}\`\n- **CWD**: \`${preferredTarget.cwd}\``,
            )
            return true
          }
          const conv = await currentConversation(payload)
          const hasActiveConversation = Boolean(conv)
          const [firstArg, ...restArgs] = parsed.args
          if (
            !hasActiveConversation &&
            (!firstArg || !KNOWN_CLI_TYPES.has(firstArg as CliType) || restArgs.length === 0)
          ) {
            reply(
              payload,
              commandError('无法切换工作目录', '当前没有活跃会话，必须明确指定 CLI。', '/cwd <cli> <绝对路径>'),
            )
            return true
          }
          const cli = hasActiveConversation ? (conv!.cli as CliType) : (firstArg as CliType)
          if (!SUPPORTED_CLI_TYPES.has(cli)) {
            reply(payload, commandError('不支持的 CLI', `\`${cli}\` 尚未接入。`))
            return true
          }
          const rawCwd = hasActiveConversation ? parsed.args.join(' ') : restArgs.join(' ')
          const resolved = await resolveCwd(rawCwd)
          if (!resolved.ok) {
            reply(payload, commandError('工作目录无效', resolved.message, '/cwd <cli> <绝对路径>'))
            return true
          }
          if (conv) await sessionManager.close(conv.id as ConversationId, 'user')
          await setUserTarget(payload.platform, payload.userId, { cli, cwd: resolved.cwd })
          reply(
            payload,
            conv
              ? `## 📁 工作目录已切换\n\n- **CLI**: \`${cli}\`\n- **CWD**: \`${resolved.cwd}\`\n\n当前会话已关闭，下一条消息会在新目录启动。`
              : `## 📁 工作目录已保存\n\n- **CLI**: \`${cli}\`\n- **CWD**: \`${resolved.cwd}\`\n\n下一条消息会在此目录创建新会话。`,
          )
          return true
        }

        case 'status': {
          const conv = await currentConversation(payload)
          if (!conv) {
            const preferredTarget = getUserTarget
              ? await getUserTarget(payload.platform, payload.userId)
              : { cli: payload.cli, cwd: payload.cwd }
            const language = await getUserLanguage(payload.platform, payload.userId)
            const isEnglish = language === 'en'
            reply(
              payload,
              [
                isEnglish ? '## 📊 Session status' : '## 📊 会话状态',
                '',
                isEnglish
                  ? '_No active session. Send a message to create one automatically._'
                  : '_当前没有活跃会话。直接发送消息会自动创建新会话。_',
                '',
                `- **${isEnglish ? 'Target CLI' : '目标 CLI'}**: \`${preferredTarget.cli}\``,
                `- **${isEnglish ? 'Target CWD' : '目标 CWD'}**: \`${preferredTarget.cwd}\``,
                `- **${isEnglish ? 'Language' : '语言'}**: \`${language}\``,
              ].join('\n'),
            )
            return true
          }
          reply(
            payload,
            formatStatus(conv, await getUserLanguage(payload.platform, payload.userId), conv.cli as CliType, conv.cwd),
          )
          return true
        }

        case 'autoapprove': {
          const language = await getUserLanguage(payload.platform, payload.userId)
          const isEnglish = language === 'en'
          const value = parsed.args[0]?.toLowerCase()
          if (!value) {
            const preference = (await deps.getAutoApprove?.(payload.platform, payload.userId)) ?? {
              enabled: false,
              seconds: DEFAULT_AUTO_APPROVE_SECONDS,
            }
            reply(
              payload,
              [
                isEnglish ? '## ⚡ Auto approval' : '## ⚡ 自动审批',
                '',
                `- **${isEnglish ? 'Status' : '状态'}**: ${preference.enabled ? '✅ ON' : '⛔ OFF'}`,
                `- **${isEnglish ? 'Countdown' : '倒计时'}**: ${preference.seconds} ${isEnglish ? 'seconds' : '秒'}`,
                '',
                isEnglish
                  ? 'Use `/autoapprove on|off [seconds]` to change it.'
                  : '使用 `/autoapprove on|off [seconds]` 修改。',
              ].join('\n'),
            )
            return true
          }
          const secondsRaw = parsed.args[1]
          const seconds = secondsRaw === undefined ? DEFAULT_AUTO_APPROVE_SECONDS : Number(secondsRaw)
          if (
            (value !== 'on' && value !== 'off') ||
            parsed.args.length > 2 ||
            !Number.isInteger(seconds) ||
            seconds < MIN_AUTO_APPROVE_SECONDS ||
            seconds > MAX_AUTO_APPROVE_SECONDS
          ) {
            reply(
              payload,
              commandError(
                isEnglish ? 'Invalid auto-approval option' : '自动审批参数无效',
                isEnglish
                  ? `Use \`on\` or \`off\` and an integer from ${MIN_AUTO_APPROVE_SECONDS} to ${MAX_AUTO_APPROVE_SECONDS} seconds.`
                  : `请使用 \`on\` 或 \`off\`，秒数必须是 ${MIN_AUTO_APPROVE_SECONDS}–${MAX_AUTO_APPROVE_SECONDS} 的整数。`,
                '/autoapprove on|off [seconds]',
              ),
            )
            return true
          }
          const enabled = value === 'on'
          await deps.setAutoApprove?.(payload.platform, payload.userId, { enabled, seconds })
          reply(
            payload,
            enabled
              ? isEnglish
                ? `## ⚡ Auto approval enabled\n\nCLI approval requests will be approved automatically after **${seconds} seconds** unless you reject the current turn.`
                : `## ⚡ 自动审批已开启\n\nCLI 审批请求将在 **${seconds} 秒后**自动批准；期间可拒绝并中断本轮操作。`
              : isEnglish
                ? `## ⛔ Auto approval disabled\n\nCLI approval requests now require a manual decision. The saved countdown is **${seconds} seconds**.`
                : `## ⛔ 自动审批已关闭\n\nCLI 审批请求恢复为手动处理；已保存倒计时 **${seconds} 秒**。`,
          )
          return true
        }

        case 'sessions': {
          const sessions = await repos.conversations.listRecentByUser(
            payload.platform,
            payload.userId,
            RECENT_SESSIONS_LIMIT,
          )
          reply(payload, formatSessions(sessions, await getUserLanguage(payload.platform, payload.userId)))
          return true
        }

        case 'audit': {
          const resolved = await resolveAuditConversation(parsed.args, payload, repos, currentConversation)
          if (!resolved.ok) {
            reply(payload, commandError('无法查看审批审计', resolved.message, '/audit [conversationId]'))
            return true
          }
          const records = await repos.audit.listByConversation(resolved.conversation.id as ConversationId)
          reply(payload, formatAudit(resolved.conversation, records.slice(-10)))
          return true
        }

        case 'remember': {
          const raw = parsed.args.join(' ').trim()
          if (!raw) {
            reply(payload, commandError('缺少记忆内容', '请提供要长期保存的事实或偏好。', '/remember <text>'))
            return true
          }
          const classified = classifyManualMemory(raw)
          if (!classified.content) {
            reply(payload, commandError('记忆内容为空', '请提供有效的事实或偏好。', '/remember <text>'))
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
            [
              '## 🧠 长期记忆已保存',
              '',
              `- **ID**: \`${memory.id}\``,
              `- **Type**: \`${memory.type}\``,
              '',
              '### 内容',
              memory.content,
              '',
              '> 下一条消息会加载最新记忆。',
            ].join('\n'),
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
            reply(payload, commandError('健康检查不可用', '服务尚未配置健康检查实现。'))
            return true
          }
          reply(payload, await deps.getHealthReport())
          return true
        }

        case 'update': {
          if (!deps.getUpdatePreview || !deps.performUpdate) {
            reply(payload, commandError('自更新不可用', '服务尚未配置自更新实现。'))
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
          reply(
            payload,
            commandError('自更新参数无效', '先查看更新计划，再明确确认执行。', '/update 或 /update confirm'),
          )
          return true
        }

        case 'restart': {
          if (!deps.getRestartPreview || !deps.performRestart) {
            reply(payload, commandError('重启不可用', '服务尚未配置受控重启实现。'))
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
          reply(
            payload,
            commandError('重启参数无效', '先查看重启计划，再明确确认执行。', '/restart 或 /restart confirm'),
          )
          return true
        }

        case 'forget': {
          const target = parsed.args[0]?.trim()
          if (!target) {
            reply(payload, commandError('缺少记忆 ID', '请指定要删除的长期记忆。', '/forget <memoryId>'))
            return true
          }
          const resolved = await resolveMemory(target, repos)
          if (!resolved.ok) {
            reply(payload, commandError('无法删除记忆', resolved.message, '/forget <memoryId>'))
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
          reply(payload, `## 🗑️ 长期记忆已删除\n\n- **ID**: \`${resolved.memory.id}\`\n\n> 下一条消息会加载最新记忆。`)
          return true
        }

        default:
          reply(payload, commandError('未知命令', `无法识别 \`/${parsed.name}\`。`, '/help'))
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

function ensureMarkdownCommandReply(content: string): string {
  const trimmed = content.trim()
  if (/^(#{1,6}\s|\*\*|_|>|```|[-*+]\s|\d+\.\s)/.test(trimmed)) return trimmed
  return `## ℹ️ 系统回复\n\n${trimmed}`
}

function commandError(title: string, detail: string, usage?: string): string {
  return [`## ❌ ${title}`, '', detail, ...(usage ? ['', '### 用法', `\`${usage}\``] : [])].join('\n')
}

async function parseSessionTarget(
  args: string[],
  fallbackCli: CliType,
  fallbackCwd: string,
  resolveCwd: (cwd: string) => Promise<CwdResolveResult> | CwdResolveResult,
  getCwdForCli: (cli: CliType) => Promise<string>,
): Promise<SessionTargetResolveResult> {
  const [first, ...rest] = args
  if (!first) return { ok: true, cli: fallbackCli, cwd: fallbackCwd, cliExplicit: false, cwdExplicit: false }

  if (KNOWN_CLI_TYPES.has(first as CliType)) {
    const cli = first as CliType
    if (!SUPPORTED_CLI_TYPES.has(cli)) return { ok: false, message: `暂不支持 CLI：${cli}` }
    if (rest.length === 0) return { ok: true, cli, cwd: await getCwdForCli(cli), cliExplicit: true, cwdExplicit: false }
    const resolved = await resolveCwd(rest.join(' '))
    return resolved.ok ? { ...resolved, cli, cliExplicit: true, cwdExplicit: true } : resolved
  }

  if (looksLikeAbsolutePath(first)) {
    const resolved = await resolveCwd(args.join(' '))
    return resolved.ok ? { ...resolved, cli: fallbackCli, cliExplicit: false, cwdExplicit: true } : resolved
  }

  return { ok: false, message: `不支持的 CLI：${first}` }
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(value)
}

function formatStatus(conv: Conversation, language: UserLanguage, targetCli: CliType, targetCwd: string): string {
  const isEnglish = language === 'en'
  return [
    isEnglish ? '## 📊 Current session' : '## 📊 当前会话',
    '',
    `- **${isEnglish ? 'Session ID' : '会话 ID'}**: \`${conv.id}\``,
    `- **${isEnglish ? 'Status' : '状态'}**: \`${conv.status}\``,
    `- **${isEnglish ? 'Platform' : '平台'}**: \`${conv.platform}\``,
    `- **CLI**: \`${conv.cli}\``,
    `- **${isEnglish ? 'Language' : '语言'}**: \`${language}\``,
    `- **CWD**: \`${conv.cwd}\``,
    '',
    `### ${isEnglish ? 'Current target' : '当前目标'}`,
    `- **CLI**: \`${targetCli}\``,
    `- **CWD**: \`${targetCwd}\``,
    `- **${isEnglish ? 'Alive' : '已存活'}**: ${formatDuration(Date.now() - conv.createdAt)}`,
  ].join('\n')
}

function formatSessions(sessions: Conversation[], language: UserLanguage): string {
  const isEnglish = language === 'en'
  if (sessions.length === 0)
    return isEnglish ? '## 🗂️ Recent sessions\n\n_No session history yet._' : '## 🗂️ 最近会话\n\n_暂无历史会话。_'

  return [
    isEnglish ? '## 🗂️ Recent sessions' : '## 🗂️ 最近会话',
    ...sessions.map((session, index) =>
      [
        '',
        `${index + 1}. **\`${shortId(session.id as ConversationId)}\`**`,
        `   - **${isEnglish ? 'Status' : '状态'}**: \`${session.status}\``,
        `   - **CLI**: \`${session.cli}\``,
        `   - **${isEnglish ? 'Updated' : '更新时间'}**: ${formatDate(session.updatedAt)}`,
        `   - **CWD**: \`${session.cwd}\``,
      ].join('\n'),
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
  if (exact) {
    return exact.userId === payload.userId && exact.platform === payload.platform
      ? { ok: true, conversation: exact }
      : auditNotFound(target)
  }

  const recent = await repos.conversations.listRecentByUser(payload.platform, payload.userId, ID_PREFIX_SEARCH_LIMIT)
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
    return ['## 🧾 审批审计', '', `- **Conversation**: \`${conv.id}\``, '', '_暂无审批记录。_'].join('\n')
  }

  return [
    '## 🧾 审批审计',
    '',
    `- **Conversation**: \`${conv.id}\``,
    ...records.map((record, index) =>
      [
        '',
        `### ${index + 1}. ${formatAuditAction(record.action)}`,
        `- **Time**: \`${formatDate(record.createdAt)}\``,
        `- **Operator**: \`${record.operator}\``,
        '',
        '```text',
        truncateForAudit(record.command),
        '```',
      ].join('\n'),
    ),
  ].join('\n')
}

function formatAuditAction(action: AuditLog['action']): string {
  return action === 'approve' ? '✅ approved' : '❌ rejected'
}

function formatMemories(memories: Memory[]): string {
  const globalMemories = memories
    .filter(m => m.namespace === DEFAULT_MEMORY_NAMESPACE && m.conversationId === null)
    .sort((a, b) => b.createdAt - a.createdAt)
  if (globalMemories.length === 0) return '## 🧠 长期记忆\n\n_暂无长期记忆。_'

  return [
    '## 🧠 长期记忆',
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
  if (envMemories.length === 0) return '## 🖥️ 环境快照\n\n_暂无环境快照。_'

  return ['## 🖥️ 环境快照', ...envMemories.map(m => `- **${m.tag}**\n${m.content.trim()}`)].join('\n\n')
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
