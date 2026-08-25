import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from 'react'
import {
  Bell,
  BellOff,
  BellRing,
  Check,
  ArrowDown,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FilePlus2,
  FileText,
  FileVideo,
  Image as ImageIcon,
  LoaderCircle,
  Menu,
  Palette,
  PanelRight,
  Send,
  Settings2,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CommandCatalogEntry } from '../../shared'
import { CommandPalette } from '../command-palette'
import { findFirstPlaceholderRange, searchCommandCatalog } from '../command-palette-model'
import { AppShell } from './app-shell'
import { locationForPage, pageFromLocation, type WebPage } from './navigation-model'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { useLocalPreferences, type WebPreferences } from '../hooks/use-local-preferences'
import {
  getFeedMountScrollTop,
  getFeedScrollState,
  shouldReleaseForcedScroll,
  shouldScrollToLatest,
} from './feed-scroll'

const ConversationsPage = lazy(() =>
  import('../features/conversations/conversations-page').then(module => ({ default: module.ConversationsPage })),
)
const PreferencesPage = lazy(() =>
  import('../features/preferences/preferences-page').then(module => ({ default: module.PreferencesPage })),
)
const MemoriesPage = lazy(() =>
  import('../features/memories/memories-page').then(module => ({ default: module.MemoriesPage })),
)
const AuditsPage = lazy(() => import('../features/audits/audits-page').then(module => ({ default: module.AuditsPage })))
type Translator = (cn: string, en: string) => string
type MessageAttachment = {
  id: string
  kind: string
  fileName: string | null
  mimeType: string | null
  fileSize: number | null
  url: string
}
type CopyAction = { label: string; copyText: string }
type Message = {
  type: 'chat'
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
  streaming?: boolean
  createdAt: number
  copyActions?: CopyAction[]
}
type ServerMessage = Omit<Message, 'type' | 'attachments'> & {
  type?: 'chat'
  attachments?: Array<Omit<MessageAttachment, 'url'>>
}
type ComposerFile = { id: string; file: File; previewUrl: string | null }
type PreviewImage = { name: string; url: string; size: number | null }
type ApprovalState = 'pending' | 'resolving' | 'approved' | 'rejected' | 'unavailable'
type Approval = {
  type: 'approval'
  id: string
  createdAt: number
  approvalId: string
  conversationId: string
  command: string
  detail: string
  status: ApprovalState
  operator: string | null
  automatic: boolean
}
export type TimelineItem = Message | Approval
type ServerApproval = {
  id: string
  conversationId: string
  approvalId: string
  request: { command: string; detail: JsonValue }
  status: 'pending' | 'approved' | 'rejected'
  operator: string | null
  automatic: boolean
  createdAt: number
}
type ServerTimelineItem =
  | (ServerMessage & { type: 'chat' })
  | { type: 'approval'; id: string; createdAt: number; approval: ServerApproval | null }
type Status = {
  platform: 'web'
  cli: string
  cwd: string
  sessionStatus: string
  conversationId: string | null
  model: { name: string } | null
  autoApprove: { enabled: boolean; seconds: number }
}
type Preferences = WebPreferences
type ServerEvent = {
  type?: string
  content?: string
  final?: boolean
  approvalId?: string
  conversationId?: string
  command?: string
  detail?: string
  createdAt?: number
  status?: string
  operator?: string
  automatic?: boolean
  alreadyHandled?: boolean
  message?: string | ServerMessage
  clientMessageId?: string
  attachments?: Array<Omit<MessageAttachment, 'url'>>
  copyActions?: CopyAction[]
}
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type SettingsData = Record<string, JsonValue>

const accents: Preferences['accent'][] = ['blue', 'cyan', 'amber', 'rose', 'violet']
const groupMeta: Record<string, [string, string, string, string]> = {
  http: ['HTTP 服务', 'HTTP service', '监听与管理接口的访问控制。', 'Listener and administrator access control.'],
  transport: [
    '客户端接入',
    'Client transports',
    '机器人平台、白名单与默认消息入口。',
    'Bot platforms, allow lists, and default message entry.',
  ],
  session: [
    '会话',
    'Sessions',
    'CLI、工作目录、空闲策略与会话行为。',
    'CLI, working directory, idle policy, and session behavior.',
  ],
  database: [
    '数据库',
    'Database',
    'Postgres 连接信息。修改后需要重启。',
    'Postgres connection settings. Restart required after changes.',
  ],
  memory: [
    '长期记忆',
    'Long-term memory',
    '记忆提取、召回与嵌入配置。',
    'Memory extraction, retrieval, and embedding configuration.',
  ],
  logging: ['日志', 'Logging', '日志等级和输出策略。', 'Log level and output policy.'],
  proxy: [
    '网络代理',
    'Network proxy',
    '供 API 与 CLI 使用的代理配置。',
    'Proxy settings used by API clients and CLI processes.',
  ],
}
const fieldMeta: Record<string, [string, string, string, string]> = {
  authToken: ['管理 Token', 'Admin token', '用于 API 和 Web 控制台登录。', 'Used by API and Web console login.'],
  host: ['监听地址', 'Bind address', '0.0.0.0 可供反向代理或局域网访问。', 'Use 0.0.0.0 for proxy or LAN access.'],
  port: ['端口', 'Port', 'HTTP 服务监听端口。', 'HTTP listener port.'],
  secureCookie: ['安全 Cookie', 'Secure cookie', 'HTTPS 反代时建议开启。', 'Recommended behind an HTTPS proxy.'],
  whitelistUserIds: [
    '白名单用户',
    'Allowed users',
    '只有列表中的平台用户可进入会话。',
    'Only listed platform users can enter a session.',
  ],
  webUserId: [
    'Web 用户 ID',
    'Web user ID',
    'Web 控制台使用的稳定身份，不随白名单顺序变化。',
    'Stable identity for the Web console; independent from allow-list ordering.',
  ],
  enabled: ['启用', 'Enabled', '是否启用此能力。', 'Whether this capability is enabled.'],
  seconds: ['等待秒数', 'Wait seconds', '自动审批前的等待时长。', 'Delay before automatic approval.'],
  cwd: ['默认工作目录', 'Default directory', '新会话使用的工作目录。', 'Working directory for new sessions.'],
  idleTimeoutSeconds: [
    '空闲超时',
    'Idle timeout',
    '空闲后关闭 CLI 运行时，不关闭会话。',
    'Closes the CLI runtime when idle, not the session.',
  ],
}

export function App() {
  const [token, setToken] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<ComposerFile[]>([])
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyHydrated, setHistoryHydrated] = useState(false)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [settings, setSettings] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [page, setPage] = useState<WebPage>(() => pageFromLocation(window.location.hash))
  const [mobileStatus, setMobileStatus] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandSelection, setCommandSelection] = useState(0)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )
  const [preferences, setPreferences] = useLocalPreferences()
  const socket = useRef<WebSocket | null>(null)
  const retryTimer = useRef<number | null>(null)
  const attempts = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const composerWrap = useRef<HTMLFormElement>(null)
  const feed = useRef<HTMLDivElement>(null)
  const objectUrls = useRef(new Set<string>())
  const prependScrollHeight = useRef<number | null>(null)
  const pinnedToLatest = useRef(true)
  const savedFeedScrollTop = useRef<number | null>(null)
  const forceScrollToLatest = useRef(false)
  const releaseForceScrollAfterLayout = useRef(false)
  const historyLoadingRef = useRef(false)
  const initialHistoryReady = useRef(false)
  const bufferedTimelineEvents = useRef<ServerEvent[]>([])
  const applyServerEventRef = useRef<(payload: ServerEvent) => void>(() => undefined)

  const zh = preferences.locale === 'zh-CN'
  const t: Translator = (cn, en) => (zh ? cn : en)
  const commandLanguage = zh ? 'zh' : 'en'
  const navigationItems = [
    ['chat', t('聊天', 'Chat')],
    ['conversations', t('会话', 'Conversations')],
    ['preferences', t('偏好', 'Preferences')],
    ['memories', t('记忆', 'Memories')],
    ['audits', t('审计', 'Audits')],
  ] as Array<[WebPage, string]>
  const navigateTo = (value: WebPage) => {
    window.location.hash = locationForPage(value)
    setMobileNavOpen(false)
  }
  const commandSuggestions = useMemo(() => searchCommandCatalog(text, commandLanguage), [text, commandLanguage])
  const notificationsActive = preferences.notificationsEnabled && notificationPermission === 'granted'
  const statusLoad = async () => {
    const response = await fetch('/api/web/status')
    if (response.ok) setStatus(((await response.json()) as { status: Status }).status)
  }
  const historyLoad = async (before: string | null = null) => {
    if (historyLoadingRef.current) return
    historyLoadingRef.current = true
    setHistoryLoading(true)
    if (!before) setHistoryHydrated(false)
    if (before && feed.current) prependScrollHeight.current = feed.current.scrollHeight
    try {
      const query = new URLSearchParams({ limit: '10' })
      if (before) query.set('before', before)
      const response = await fetch(`/api/web/history?${query}`)
      if (!response.ok) return
      const value = (await response.json()) as {
        messages: ServerTimelineItem[]
        nextCursor: string | null
      }
      const page = value.messages.map(hydrateTimelineItem)
      setTimeline(current => prependHistory(page, current))
      setHistoryCursor(value.nextCursor)
    } finally {
      historyLoadingRef.current = false
      setHistoryLoading(false)
      if (!before) {
        initialHistoryReady.current = true
        setHistoryHydrated(true)
        const pending = bufferedTimelineEvents.current.splice(0)
        for (const payload of pending) applyServerEventRef.current(payload)
      }
    }
  }
  const updateFeedScrollState = () => {
    const element = feed.current
    if (!element) return
    if (historyHydrated) savedFeedScrollTop.current = element.scrollTop
    const next = getFeedScrollState(element)
    pinnedToLatest.current = next.pinnedToLatest
    setShowScrollToLatest(next.showJumpButton)
  }
  const jumpToLatest = () => {
    const element = feed.current
    if (!element) return
    pinnedToLatest.current = true
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    requestAnimationFrame(updateFeedScrollState)
  }
  const addFiles = (incoming: readonly File[]) => {
    const additions = incoming.map(file => {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      if (previewUrl) objectUrls.current.add(previewUrl)
      return { id: crypto.randomUUID(), file, previewUrl }
    })
    setFiles(current => [...current, ...additions])
    setSelectedFileId(additions.at(-1)?.id ?? null)
  }
  const removeFile = (id: string) => {
    setFiles(current => {
      const target = current.find(item => item.id === id)
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl)
        objectUrls.current.delete(target.previewUrl)
      }
      return current.filter(item => item.id !== id)
    })
    setSelectedFileId(current => (current === id ? null : current))
    setPreviewImage(current => (current?.url === files.find(item => item.id === id)?.previewUrl ? null : current))
  }
  const showNotification = (title: string, body: string) => {
    if (
      !preferences.notificationsEnabled ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted' ||
      document.visibilityState === 'visible'
    )
      return
    new Notification(title, { body: body.slice(0, 180), icon: '/webui/assets/icon.svg' })
  }

  applyServerEventRef.current = payload => {
    if (payload.type === 'output' && typeof payload.content === 'string') {
      const content = payload.content
      if (payload.final === true) releaseForceScrollAfterLayout.current = true
      setTimeline(current =>
        appendOutput(
          current,
          content,
          payload.final === true,
          hydrateAttachments(payload.attachments),
          payload.copyActions,
        ),
      )
      if (payload.final === true)
        showNotification(document.documentElement.lang === 'en' ? 'New reply' : '收到新回复', plainTextPreview(content))
    }
    if (
      payload.type === 'user_message' &&
      typeof payload.clientMessageId === 'string' &&
      typeof payload.message === 'object' &&
      payload.message !== null
    ) {
      const canonical = hydrateMessage(payload.message)
      setTimeline(current => {
        const withoutCanonical = current.filter(item => item.id !== canonical.id)
        const optimisticIndex = withoutCanonical.findIndex(
          item => item.type === 'chat' && item.id === payload.clientMessageId,
        )
        if (optimisticIndex < 0) return [...withoutCanonical, canonical]
        return withoutCanonical.map((item, index) => (index === optimisticIndex ? canonical : item))
      })
    }
    if (
      payload.type === 'approval' &&
      typeof payload.approvalId === 'string' &&
      typeof payload.conversationId === 'string' &&
      typeof payload.command === 'string' &&
      typeof payload.detail === 'string'
    ) {
      const approval: Approval = {
        type: 'approval',
        id: `approval:${payload.approvalId}`,
        createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
        approvalId: payload.approvalId,
        conversationId: payload.conversationId,
        command: payload.command,
        detail: payload.detail,
        status: 'pending',
        operator: null,
        automatic: false,
      }
      setTimeline(current => upsertApproval(current, approval))
      showNotification(document.documentElement.lang === 'en' ? 'Approval required' : '需要审批', approval.command)
    }
    if (
      payload.type === 'approval_resolved' &&
      typeof payload.approvalId === 'string' &&
      (payload.status === 'approved' || payload.status === 'rejected') &&
      typeof payload.operator === 'string'
    ) {
      setTimeline(current =>
        current.map(item =>
          item.type === 'approval' && item.approvalId === payload.approvalId
            ? {
                ...item,
                status: payload.status as 'approved' | 'rejected',
                operator: payload.operator as string,
                automatic: payload.automatic === true,
              }
            : item,
        ),
      )
      if (payload.alreadyHandled === true) setError(t('此次审批已处理。', 'This approval was already handled.'))
    }
    if (payload.type === 'error') {
      forceScrollToLatest.current = false
      releaseForceScrollAfterLayout.current = false
      setError(
        typeof payload.message === 'string' ? payload.message : t('服务器返回错误。', 'The server returned an error.'),
      )
    }
    void statusLoad()
  }

  useEffect(() => {
    if (!ready) return
    let disposed = false
    initialHistoryReady.current = false
    setHistoryHydrated(false)
    pinnedToLatest.current = true
    savedFeedScrollTop.current = null
    setShowScrollToLatest(false)
    bufferedTimelineEvents.current = []
    const scheduleReconnect = () => {
      attempts.current += 1
      setConnection('reconnecting')
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts.current, 4))
      retryTimer.current = window.setTimeout(connect, delay)
    }
    const verifySessionAndReconnect = async () => {
      try {
        const response = await fetch('/api/auth/session')
        if (disposed) return
        if (response.status === 401) {
          socket.current = null
          setError(t('登录会话已过期，请重新输入管理 Token。', 'Session expired. Enter the admin token again.'))
          setReady(false)
          return
        }
      } catch {
        // 服务重启期间请求失败属于正常情况，继续指数退避重连。
      }
      if (!disposed) scheduleReconnect()
    }
    function connect() {
      setConnection(attempts.current ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.current = ws
      ws.onopen = () => {
        attempts.current = 0
        setConnection('connected')
        void statusLoad()
        if (!initialHistoryReady.current && !historyLoadingRef.current) void historyLoad().catch(() => undefined)
      }
      ws.onmessage = event => {
        let payload: ServerEvent
        try {
          payload = JSON.parse(String(event.data)) as ServerEvent
        } catch {
          return
        }
        if (!initialHistoryReady.current && isTimelineServerEvent(payload)) {
          bufferedTimelineEvents.current.push(payload)
          return
        }
        applyServerEventRef.current(payload)
      }
      ws.onclose = () => {
        if (disposed) return
        void verifySessionAndReconnect()
      }
    }
    connect()
    return () => {
      disposed = true
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      socket.current?.close()
    }
  }, [ready])
  useLayoutEffect(() => {
    if (page !== 'chat') return
    const element = feed.current
    if (!element) return
    const frame = requestAnimationFrame(() => {
      const top = getFeedMountScrollTop({
        historyHydrated,
        savedScrollTop: savedFeedScrollTop.current,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })
      if (top === null) return
      element.scrollTo({ top, behavior: 'auto' })
      updateFeedScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [historyHydrated, page])
  useLayoutEffect(() => {
    const element = feed.current
    if (page !== 'chat' || !element) return
    if (prependScrollHeight.current !== null) {
      const previousHeight = prependScrollHeight.current
      prependScrollHeight.current = null
      element.scrollTop += element.scrollHeight - previousHeight
      updateFeedScrollState()
      return
    }
    const force = forceScrollToLatest.current
    const releaseForce = releaseForceScrollAfterLayout.current
    const shouldScroll = shouldScrollToLatest({
      historyHydrated,
      pinnedToLatest: pinnedToLatest.current,
      prepending: false,
      force,
    })
    const frame = requestAnimationFrame(() => {
      if (shouldScroll)
        element.scrollTo({ top: element.scrollHeight, behavior: force ? 'auto' : historyHydrated ? 'smooth' : 'auto' })
      if (shouldReleaseForcedScroll({ force, finalReply: releaseForce })) {
        forceScrollToLatest.current = false
        releaseForceScrollAfterLayout.current = false
      }
      updateFeedScrollState()
    })
    return () => cancelAnimationFrame(frame)
  }, [historyHydrated, page, timeline])
  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url)
      objectUrls.current.clear()
    },
    [],
  )
  useEffect(() => {
    void fetch('/api/auth/session')
      .then(async response =>
        response.ok ? ((await response.json()) as { authenticated?: boolean }).authenticated === true : false,
      )
      .then(setReady)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    const theme =
      preferences.theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : preferences.theme
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.accent = preferences.accent
    document.documentElement.lang = preferences.locale
  }, [preferences])
  useEffect(() => {
    const updatePage = () => setPage(pageFromLocation(window.location.hash))
    window.addEventListener('hashchange', updatePage)
    return () => window.removeEventListener('hashchange', updatePage)
  }, [])
  useEffect(() => {
    const openSettings = () => setSettings(true)
    window.addEventListener('open-server-settings', openSettings)
    return () => window.removeEventListener('open-server-settings', openSettings)
  }, [])
  useEffect(() => {
    if (commandSelection >= commandSuggestions.length) setCommandSelection(0)
  }, [commandSelection, commandSuggestions.length])
  useEffect(() => {
    if (!commandPaletteOpen) return
    const dismissPalette = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || composerWrap.current?.contains(target)) return
      setCommandPaletteOpen(false)
      composer.current?.blur()
    }
    document.addEventListener('pointerdown', dismissPalette, true)
    return () => document.removeEventListener('pointerdown', dismissPalette, true)
  }, [commandPaletteOpen])
  useEffect(() => {
    if (!ready) return
    const focusComposer = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'i' || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey)
        return
      if (settings || mobileStatus || previewImage !== null || event.isComposing) return
      event.preventDefault()
      composer.current?.focus()
    }
    window.addEventListener('keydown', focusComposer)
    return () => window.removeEventListener('keydown', focusComposer)
  }, [ready, settings, mobileStatus, previewImage])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    const response = await fetch('/api/auth/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) {
      setError(t('Token 无效，请重试。', 'Invalid token. Please try again.'))
      return
    }
    setError('')
    setReady(true)
  }
  const send = async (event: FormEvent) => {
    event.preventDefault()
    if ((!text.trim() && !files.length) || socket.current?.readyState !== WebSocket.OPEN) return
    const clientMessageId = crypto.randomUUID()
    const uploadIds: string[] = []
    for (const item of files) {
      const form = new FormData()
      form.set('file', item.file)
      const response = await fetch('/api/web/uploads', { method: 'POST', body: form })
      if (!response.ok) {
        setError(t(`文件上传失败：${item.file.name}`, `Failed to upload: ${item.file.name}`))
        return
      }
      uploadIds.push(((await response.json()) as { upload: { id: string } }).upload.id)
    }
    socket.current.send(JSON.stringify({ v: 1, type: 'message', text, uploadIds, clientMessageId }))
    forceScrollToLatest.current = true
    releaseForceScrollAfterLayout.current = false
    pinnedToLatest.current = true
    setShowScrollToLatest(false)
    setTimeline(current => [
      ...current,
      {
        type: 'chat',
        id: clientMessageId,
        role: 'user',
        content:
          text ||
          files
            .filter(item => !item.previewUrl)
            .map(item => `📎 ${item.file.name}`)
            .join('\n'),
        attachments: files.map(item => ({
          id: item.id,
          kind: item.file.type.startsWith('image/') ? 'photo' : 'document',
          fileName: item.file.name,
          mimeType: item.file.type || null,
          fileSize: item.file.size,
          url: item.previewUrl ?? '',
        })),
        createdAt: Date.now(),
      },
    ])
    setText('')
    setCommandPaletteOpen(false)
    setFiles([])
    setSelectedFileId(null)
  }
  const selectCommand = (entry: CommandCatalogEntry) => {
    const range = findFirstPlaceholderRange(entry.insertText)
    setText(entry.insertText)
    setCommandPaletteOpen(false)
    requestAnimationFrame(() => {
      const element = composer.current
      if (!element) return
      element.focus()
      if (range) element.setSelectionRange(range.start, range.end)
      else element.setSelectionRange(entry.insertText.length, entry.insertText.length)
    })
  }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (commandPaletteOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!commandSuggestions.length) return
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setCommandSelection(current => (current + direction + commandSuggestions.length) % commandSuggestions.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setCommandPaletteOpen(false)
        return
      }
      if (event.key === 'Enter' && commandSuggestions[commandSelection]) {
        event.preventDefault()
        selectCommand(commandSuggestions[commandSelection])
        return
      }
    }
    if (event.key !== 'Enter') return
    const shouldSend = preferences.enterToSend ? !event.shiftKey : event.ctrlKey || event.metaKey
    if (!shouldSend) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
  const decide = (approval: Approval, type: 'approve' | 'reject') => {
    if (socket.current?.readyState !== WebSocket.OPEN) return
    socket.current.send(
      JSON.stringify({ v: 1, type, approvalId: approval.approvalId, conversationId: approval.conversationId }),
    )
    setTimeline(current =>
      current.map(item =>
        item.type === 'approval' && item.approvalId === approval.approvalId ? { ...item, status: 'resolving' } : item,
      ),
    )
  }
  const toggleNotifications = async () => {
    if (typeof Notification === 'undefined') return
    if (preferences.notificationsEnabled) {
      setPreferences(current => ({ ...current, notificationsEnabled: false }))
      return
    }
    if (Notification.permission === 'denied') {
      setNotificationPermission('denied')
      return
    }
    const permission = await Notification.requestPermission()
    setNotificationPermission(permission)
    if (permission === 'granted') setPreferences(current => ({ ...current, notificationsEnabled: true }))
  }

  if (!ready)
    return (
      <Login
        token={token}
        setToken={setToken}
        error={error}
        login={login}
        t={t}
        preferences={preferences}
        setPreferences={setPreferences}
      />
    )
  return (
    <AppShell>
      <header className="app-header">
        <span className="brand" aria-label="AI CLI HUB">
          <img src="/webui/assets/icon.svg" alt="" />
          <span className="brand-label">AI CLI HUB</span>
        </span>
        <nav className="app-nav" aria-label={t('管理页面', 'Administration pages')}>
          {navigationItems.map(([value, label]) => (
            <button
              className={page === value ? 'app-nav-item active' : 'app-nav-item'}
              type="button"
              key={value}
              onClick={() => navigateTo(value)}>
              {label}
            </button>
          ))}
        </nav>
        <Button
          className="mobile-nav-trigger"
          variant="ghost"
          aria-label={t('打开页面菜单', 'Open page menu')}
          onClick={() => setMobileNavOpen(true)}>
          <Menu size={19} />
        </Button>
        <span className={`connection ${connection}`}>
          <i />
          {connection === 'connected' ? t('实时连接', 'Live connection') : t('正在重连', 'Reconnecting')}
        </span>
        <Button
          className={notificationsActive ? 'notification-trigger active' : 'notification-trigger'}
          variant="ghost"
          aria-label={
            preferences.notificationsEnabled
              ? t('关闭消息通知', 'Disable notifications')
              : t('开启消息通知', 'Enable notifications')
          }
          title={
            notificationPermission === 'denied'
              ? t('浏览器已阻止通知，请在站点权限中开启', 'Notifications are blocked in browser site permissions')
              : preferences.notificationsEnabled
                ? t('消息通知已开启，点击关闭', 'Notifications enabled; click to disable')
                : t('消息通知已关闭，点击开启', 'Notifications disabled; click to enable')
          }
          onClick={() => void toggleNotifications()}>
          {preferences.notificationsEnabled && notificationPermission === 'granted' ? (
            <BellRing size={19} />
          ) : notificationPermission === 'denied' ? (
            <BellOff size={19} />
          ) : (
            <Bell size={19} />
          )}
        </Button>
        <Button
          className="mobile-status-trigger"
          variant="ghost"
          aria-label={t('查看当前会话', 'View current session')}
          onClick={() => setMobileStatus(true)}>
          <PanelRight size={19} />
        </Button>
        <Button variant="ghost" aria-label={t('打开设置', 'Open settings')} onClick={() => setSettings(true)}>
          <Settings2 size={19} />
        </Button>
      </header>
      <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogContent className="nav-drawer">
          <DialogHeader>
            <DialogTitle>{t('页面导航', 'Page navigation')}</DialogTitle>
            <DialogDescription>{t('选择要打开的管理页面。', 'Choose a page to open.')}</DialogDescription>
          </DialogHeader>
          <nav className="mobile-nav-list" aria-label={t('管理页面', 'Administration pages')}>
            {navigationItems.map(([value, label]) => (
              <button
                className={page === value ? 'mobile-nav-item active' : 'mobile-nav-item'}
                type="button"
                key={value}
                onClick={() => navigateTo(value)}>
                <span>{label}</span>
                {page === value && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </nav>
        </DialogContent>
      </Dialog>
      {page === 'chat' ? (
        <div className="grid">
          <section className="chat">
            {showScrollToLatest && (
              <button
                className="scroll-latest-button"
                type="button"
                aria-label={t('滚动到最新消息', 'Jump to latest message')}
                title={t('滚动到最新消息', 'Jump to latest message')}
                onClick={jumpToLatest}>
                <ArrowDown size={16} aria-hidden="true" />
                <span>{t('最新消息', 'Latest')}</span>
              </button>
            )}
            <div
              ref={feed}
              className="feed"
              aria-live="polite"
              onScroll={event => {
                updateFeedScrollState()
                if (event.currentTarget.scrollTop <= 80 && historyCursor && !historyLoading)
                  void historyLoad(historyCursor)
              }}>
              {(historyCursor || historyLoading) && (
                <div className="history-loader" aria-live="polite">
                  {historyLoading ? (
                    <>
                      <LoaderCircle size={15} />
                      {t('正在加载更早消息', 'Loading earlier messages')}
                    </>
                  ) : (
                    <button type="button" onClick={() => void historyLoad(historyCursor)}>
                      {t('加载更早消息', 'Load earlier messages')}
                    </button>
                  )}
                </div>
              )}
              {!timeline.length && (
                <div className="empty-state">
                  <span>✦</span>
                  <p>{t('从这里开始一段新的远程对话。', 'Start a new remote conversation here.')}</p>
                </div>
              )}
              {timeline.map(item =>
                item.type === 'chat' ? (
                  <article className={`message ${item.role}`} key={item.id}>
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
                    </div>
                    {item.copyActions?.length ? <CopyActionList actions={item.copyActions} t={t} /> : null}
                    <MessageAttachments attachments={item.attachments} onPreview={setPreviewImage} t={t} />
                    <span className={item.streaming ? 'stream-caret' : ''} />
                  </article>
                ) : (
                  <ApprovalCard key={item.approvalId} approval={item} decide={decide} t={t} />
                ),
              )}
            </div>
            <form ref={composerWrap} className="composer-wrap" onSubmit={send}>
              {commandPaletteOpen && text.startsWith('/') && (
                <CommandPalette
                  items={commandSuggestions}
                  language={commandLanguage}
                  selectedIndex={commandSelection}
                  onSelectedIndexChange={setCommandSelection}
                  onSelect={selectCommand}
                />
              )}
              <div className="compose">
                <input
                  hidden
                  ref={picker}
                  type="file"
                  multiple
                  accept="*/*"
                  onChange={event => {
                    addFiles(Array.from(event.target.files ?? []))
                    event.target.value = ''
                  }}
                />
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={t('上传文件', 'Upload files')}
                  onClick={() => picker.current?.click()}>
                  <FilePlus2 size={19} />
                </Button>
                <div className="compose-content">
                  {files.length > 0 && (
                    <div className="embedded-files" aria-label={t('待发送附件', 'Pending attachments')}>
                      {files.map(item => (
                        <div
                          className={`embedded-file ${selectedFileId === item.id ? 'selected' : ''}`}
                          role="option"
                          aria-selected={selectedFileId === item.id}
                          tabIndex={0}
                          key={item.id}
                          title={item.previewUrl ? t('点击预览', 'Tap to preview') : item.file.name}
                          onClick={() => {
                            setSelectedFileId(item.id)
                            if (item.previewUrl)
                              setPreviewImage({ name: item.file.name, url: item.previewUrl, size: item.file.size })
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              setSelectedFileId(item.id)
                              if (item.previewUrl)
                                setPreviewImage({ name: item.file.name, url: item.previewUrl, size: item.file.size })
                            }
                            if (event.key === 'Delete' || event.key === 'Backspace') removeFile(item.id)
                          }}>
                          {item.previewUrl ? <img src={item.previewUrl} alt={item.file.name} /> : <File size={22} />}
                          <span>{item.file.name}</span>
                          <button
                            type="button"
                            aria-label={t('移除附件', 'Remove attachment')}
                            onClick={event => {
                              event.stopPropagation()
                              removeFile(item.id)
                            }}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composer}
                    rows={1}
                    value={text}
                    aria-autocomplete="list"
                    aria-controls="command-palette"
                    aria-expanded={commandPaletteOpen && text.startsWith('/')}
                    aria-activedescendant={
                      commandPaletteOpen && commandSuggestions[commandSelection]
                        ? `command-option-${commandSuggestions[commandSelection].id}`
                        : undefined
                    }
                    onChange={event => {
                      const value = event.target.value
                      setText(value)
                      setCommandPaletteOpen(value.startsWith('/'))
                      setCommandSelection(0)
                    }}
                    onBlur={() => setCommandPaletteOpen(false)}
                    onFocus={() => setCommandPaletteOpen(text.startsWith('/'))}
                    onKeyDown={handleComposerKeyDown}
                    onPaste={event => {
                      const pasted = Array.from(event.clipboardData.files)
                      if (pasted.length) addFiles(pasted)
                    }}
                    placeholder={t('输入消息，或粘贴图片', 'Write a message or paste an image')}
                  />
                </div>
                <Button className="send" disabled={connection !== 'connected'}>
                  <Send size={16} />
                  <span>{t('发送', 'Send')}</span>
                </Button>
              </div>
            </form>
          </section>
          <StatusPanel status={status} t={t} />
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="admin-page">
              <div className="admin-panel admin-state">{t('正在加载管理页面…', 'Loading administration page…')}</div>
            </div>
          }>
          <AdministrationPage page={page} locale={preferences.locale} />
        </Suspense>
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>{t('控制台设置', 'Console settings')}</DialogTitle>
            <DialogDescription>
              {t(
                '修改后会先校验，敏感字段留空即可保留原值。',
                'Changes are validated first. Leave secret fields blank to preserve their current value.',
              )}
            </DialogDescription>
          </DialogHeader>
          <Settings
            t={t}
            preferences={preferences}
            setPreferences={setPreferences}
            notificationPermission={notificationPermission}
            toggleNotifications={toggleNotifications}
            close={() => setSettings(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={mobileStatus} onOpenChange={setMobileStatus}>
        <DialogContent className="mobile-status-dialog">
          <DialogHeader>
            <DialogTitle>{t('当前会话', 'Current session')}</DialogTitle>
            <DialogDescription>
              {t('Web 控制台当前连接的完整状态。', 'Full status for the current Web console session.')}
            </DialogDescription>
          </DialogHeader>
          <div className="mobile-status-content">
            <StatusContent status={status} t={t} />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={previewImage !== null} onOpenChange={open => !open && setPreviewImage(null)}>
        <DialogContent className="image-preview-dialog">
          <DialogHeader>
            <DialogTitle>{previewImage?.name}</DialogTitle>
            <DialogDescription>
              {previewImage?.size === null || previewImage?.size === undefined ? '' : formatFileSize(previewImage.size)}
            </DialogDescription>
          </DialogHeader>
          {previewImage && <img src={previewImage.url} alt={previewImage.name} />}
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}

function AdministrationPage({ page, locale }: { page: Exclude<WebPage, 'chat'>; locale: 'zh-CN' | 'en' }) {
  if (page === 'conversations') return <ConversationsPage locale={locale} />
  if (page === 'preferences') return <PreferencesPage locale={locale} />
  if (page === 'memories') return <MemoriesPage locale={locale} />
  return <AuditsPage locale={locale} />
}

function Login({
  token,
  setToken,
  error,
  login,
  t,
  preferences,
  setPreferences,
}: {
  token: string
  setToken: Dispatch<SetStateAction<string>>
  error: string
  login: (event: FormEvent) => void
  t: Translator
  preferences: Preferences
  setPreferences: Dispatch<SetStateAction<Preferences>>
}) {
  return (
    <main className="login">
      <section>
        <a className="brand" href="/webui/">
          <img src="/webui/assets/icon.svg" alt="" />
          AI CLI HUB
        </a>
        <h1 className="login-title">
          <span className="login-title-line">{t('你的私有', 'Your private')}</span>
          <span className="login-title-line login-title-line-accent">{t('AI 控制台。', 'AI control plane.')}</span>
        </h1>
        <p>
          {t(
            '安全连接你的远程 CLI，会话凭据不会保存在浏览器。',
            'A secure remote CLI connection. Session credentials are never stored in this browser.',
          )}
        </p>
        <form onSubmit={login}>
          <label>
            {t('管理 Token', 'Admin token')}
            <Input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={event => setToken(event.target.value)}
            />
          </label>
          {error && <small className="error">{error}</small>}
          <Button>
            {t('进入控制台', 'Enter console')}
            <ChevronRight size={17} />
          </Button>
        </form>
        <Appearance preferences={preferences} setPreferences={setPreferences} t={t} />
      </section>
    </main>
  )
}

function StatusPanel({ status, t }: { status: Status | null; t: Translator }) {
  return (
    <aside className="status-panel">
      <h2>{t('当前会话', 'Current session')}</h2>
      <p>{t('仅显示 Web 控制台本身的会话。', 'Only the Web console session is shown here.')}</p>
      <StatusContent status={status} t={t} />
    </aside>
  )
}

function StatusContent({ status, t }: { status: Status | null; t: Translator }) {
  const rows = [
    [t('平台', 'Platform'), status?.platform],
    ['CLI', status?.cli],
    [t('模型', 'Model'), status?.model?.name],
    [t('工作目录', 'Directory'), status?.cwd],
    [t('会话状态', 'Session state'), status?.sessionStatus],
    [t('自动审批', 'Auto approve'), status?.autoApprove.enabled ? `${status.autoApprove.seconds}s` : t('关闭', 'Off')],
    ['Conversation ID', status?.conversationId],
  ]
  return (
    <>
      {rows.map(([key, value]) => (
        <dl key={key}>
          <dt>{key}</dt>
          <dd title={value ?? undefined}>{value || '—'}</dd>
        </dl>
      ))}
    </>
  )
}

function MessageAttachments({
  attachments,
  onPreview,
  t,
}: {
  attachments: MessageAttachment[] | undefined
  onPreview: (image: PreviewImage) => void
  t: Translator
}) {
  if (!attachments?.length) return null
  const images = attachments.filter(isImageAttachment)
  const files = attachments.filter(attachment => !isImageAttachment(attachment))
  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className={`message-images ${images.length === 1 ? 'single' : ''}`}>
          {images.map(image => (
            <button
              type="button"
              key={image.id}
              title={t('点击放大图片', 'Tap to enlarge')}
              aria-label={t(
                `预览图片：${image.fileName ?? '未命名图片'}`,
                `Preview image: ${image.fileName ?? 'Image'}`,
              )}
              onClick={() => onPreview({ name: image.fileName ?? 'Image', url: image.url, size: image.fileSize })}>
              <img src={image.url} alt={image.fileName ?? 'Image attachment'} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="message-files">
          {files.map(file => (
            <button
              type="button"
              key={file.id}
              className={`message-file ${attachmentCategory(file)}`}
              title={t('点击下载文件', 'Tap to download')}
              aria-label={t(
                `下载文件：${file.fileName ?? '未命名文件'}`,
                `Download file: ${file.fileName ?? 'Unnamed file'}`,
              )}
              onClick={() => downloadAttachment(file)}>
              <span className="file-icon">
                <AttachmentIcon attachment={file} />
              </span>
              <span className="file-copy">
                <b>{file.fileName ?? t('未命名文件', 'Unnamed file')}</b>
                <small>
                  {attachmentTypeLabel(file, t)}
                  {file.fileSize === null ? '' : ` · ${formatFileSize(file.fileSize)}`}
                </small>
              </span>
              <Download className="file-download" size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AttachmentIcon({ attachment }: { attachment: MessageAttachment }) {
  const category = attachmentCategory(attachment)
  if (category === 'video') return <FileVideo size={22} />
  if (category === 'audio') return <FileAudio size={22} />
  if (category === 'archive') return <FileArchive size={22} />
  if (category === 'code') return <FileCode2 size={22} />
  if (category === 'text') return <FileText size={22} />
  if (category === 'image') return <ImageIcon size={22} />
  return <File size={22} />
}

function ApprovalCard({
  approval,
  decide,
  t,
}: {
  approval: Approval
  decide: (approval: Approval, action: 'approve' | 'reject') => void
  t: Translator
}) {
  const terminal = approval.status === 'approved' || approval.status === 'rejected' || approval.status === 'unavailable'
  const statusText =
    approval.status === 'approved'
      ? approval.automatic
        ? t('已自动批准', 'Automatically approved')
        : t('已批准', 'Approved')
      : approval.status === 'rejected'
        ? t('已拒绝', 'Rejected')
        : approval.status === 'resolving'
          ? t('正在处理', 'Resolving')
          : approval.status === 'unavailable'
            ? t('审批记录不可用', 'Approval record unavailable')
            : t('需要授权', 'Authorization required')
  return (
    <article className={`approval-card ${approval.status}`}>
      <div>
        <span>{statusText}</span>
        <b>{approval.command}</b>
        <pre>{approval.detail}</pre>
        {terminal && approval.operator && (
          <small>
            {t('操作人', 'Operator')} · {approval.operator}
          </small>
        )}
      </div>
      {!terminal && (
        <footer>
          <Button
            variant="secondary"
            type="button"
            disabled={approval.status === 'resolving'}
            onClick={() => decide(approval, 'reject')}>
            {t('拒绝', 'Reject')}
          </Button>
          <Button type="button" disabled={approval.status === 'resolving'} onClick={() => decide(approval, 'approve')}>
            {approval.status === 'resolving' ? <LoaderCircle size={16} /> : <Check size={16} />}
            {approval.status === 'resolving' ? t('处理中', 'Resolving') : t('允许', 'Allow')}
          </Button>
        </footer>
      )}
    </article>
  )
}

function Appearance({
  preferences,
  setPreferences,
  t,
}: {
  preferences: Preferences
  setPreferences: Dispatch<SetStateAction<Preferences>>
  t: Translator
}) {
  return (
    <div className="appearance">
      <Select
        aria-label={t('界面语言', 'Language')}
        value={preferences.locale}
        onValueChange={value => setPreferences(current => ({ ...current, locale: value as Preferences['locale'] }))}
        options={[
          { value: 'zh-CN', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
      <Select
        aria-label={t('主题', 'Theme')}
        value={preferences.theme}
        onValueChange={value => setPreferences(current => ({ ...current, theme: value as Preferences['theme'] }))}
        options={[
          { value: 'system', label: t('跟随系统', 'System') },
          { value: 'dark', label: t('深色', 'Dark') },
          { value: 'light', label: t('浅色', 'Light') },
        ]}
      />
      <span className="accent-picker">
        <Palette size={15} />
        <span className="sr-only">{t('强调色', 'Accent color')}</span>
        {accents.map(accent => (
          <button
            type="button"
            className={`accent ${accent === preferences.accent ? 'active' : ''}`}
            data-accent={accent}
            aria-label={accent}
            key={accent}
            onClick={() => setPreferences(current => ({ ...current, accent }))}
          />
        ))}
      </span>
    </div>
  )
}

function Settings({
  close,
  t,
  preferences,
  setPreferences,
  notificationPermission,
  toggleNotifications,
}: {
  close: () => void
  t: Translator
  preferences: Preferences
  setPreferences: Dispatch<SetStateAction<Preferences>>
  notificationPermission: NotificationPermission
  toggleNotifications: () => Promise<void>
}) {
  const notificationsActive = preferences.notificationsEnabled && notificationPermission === 'granted'
  const [data, setData] = useState<SettingsData | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [result, setResult] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void fetch('/api/settings')
      .then(response => (response.ok ? response.json() : Promise.reject()))
      .then((value: { settings: SettingsData }) => {
        setData(value.settings)
        setSavedSnapshot(JSON.stringify(value.settings))
      })
      .catch(() => setResult(t('无法加载配置。', 'Unable to load settings.')))
  }, [])
  const save = async () => {
    if (!data) return
    setSaving(true)
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
    setSaving(false)
    if (response.ok) setSavedSnapshot(JSON.stringify(data))
    setResult(
      response.ok
        ? t('配置已保存，重启后生效。', 'Settings saved. Restart to apply.')
        : t('保存失败，请检查字段。', 'Save failed. Check the fields.'),
    )
  }
  const settingsChanged = data !== null && JSON.stringify(data) !== savedSnapshot
  return (
    <div className="settings-body">
      {data ? (
        <>
          <section className="system-preferences">
            <header className="settings-section-heading">
              <span>{t('Web 系统设置', 'Web preferences')}</span>
              <p>{t('立即生效并保存在当前浏览器中。', 'Applied immediately and stored in this browser.')}</p>
            </header>
            <div className="system-preference-grid">
              <section className="preference-section">
                <h3>{t('外观', 'Appearance')}</h3>
                <Appearance preferences={preferences} setPreferences={setPreferences} t={t} />
              </section>
              <section className="preference-section">
                <h3>{t('消息输入', 'Message input')}</h3>
                <label className="field switch-field">
                  <span>
                    <b>{t('回车发送', 'Enter to send')}</b>
                    <small>
                      {preferences.enterToSend
                        ? t('Enter 发送，Shift + Enter 换行。', 'Enter sends; Shift + Enter adds a new line.')
                        : t('Enter 换行，Ctrl/Cmd + Enter 发送。', 'Enter adds a new line; Ctrl/Cmd + Enter sends.')}
                    </small>
                  </span>
                  <button
                    className={`switch ${preferences.enterToSend ? 'on' : ''}`}
                    type="button"
                    role="switch"
                    aria-checked={preferences.enterToSend}
                    onClick={() => setPreferences(current => ({ ...current, enterToSend: !current.enterToSend }))}>
                    <i />
                  </button>
                </label>
                <label
                  className={`field switch-field ${
                    notificationsActive ? 'notification-field active' : 'notification-field'
                  }`}>
                  <span>
                    <b>{t('浏览器通知', 'Browser notifications')}</b>
                    <small>
                      {notificationPermission === 'denied'
                        ? t(
                            '浏览器已阻止通知，请在站点权限中重新开启。',
                            'Blocked by the browser; enable it in site permissions.',
                          )
                        : preferences.notificationsEnabled
                          ? t(
                              '页面在后台时显示新消息通知。',
                              'Show new-message notifications while the page is in the background.',
                            )
                          : t('当前浏览器不会显示消息通知。', 'This browser will not show message notifications.')}
                    </small>
                  </span>
                  <button
                    className={`switch ${preferences.notificationsEnabled ? 'on' : ''}`}
                    type="button"
                    role="switch"
                    aria-checked={preferences.notificationsEnabled}
                    onClick={() => void toggleNotifications()}>
                    <i />
                  </button>
                </label>
              </section>
            </div>
          </section>
          <header className="settings-section-heading settings-json-heading">
            <span>settings.json</span>
            <p>{t('服务端配置，保存后重启生效。', 'Server configuration; restart after saving.')}</p>
          </header>
          <div className="settings-masonry">
            {Object.entries(data).map(([group, value]) => (
              <ConfigGroup key={group} group={group} value={value} setData={setData} t={t} />
            ))}
          </div>
        </>
      ) : (
        <p className="loading">
          <LoaderCircle />
          {t('正在加载配置…', 'Loading settings…')}
        </p>
      )}
      <footer className="settings-actions">
        <small>{result}</small>
        <Button variant="secondary" type="button" onClick={close}>
          {t('关闭', 'Close')}
        </Button>
        <Button type="button" disabled={!settingsChanged || saving} onClick={() => void save()}>
          {saving && <LoaderCircle className="spin" size={16} />}
          {t('保存配置', 'Save settings')}
        </Button>
      </footer>
    </div>
  )
}

function ConfigGroup({
  group,
  value,
  setData,
  t,
}: {
  group: string
  value: JsonValue
  setData: Dispatch<SetStateAction<SettingsData | null>>
  t: Translator
}) {
  const meta = groupMeta[group] ?? [group, group, '', '']
  const fields = isRecord(value) ? value : { value }
  return (
    <section className="config-group">
      <header>
        <div>
          <h3>{t(meta[0], meta[1])}</h3>
          <p>{t(meta[2], meta[3])}</p>
        </div>
      </header>
      <div className="config-fields">
        {Object.entries(fields).map(([key, field]) => (
          <ConfigField
            key={key}
            path={[group, key]}
            label={key}
            value={field}
            onChange={next =>
              setData(current => (current ? (setAtPath(current, [group, key], next) as SettingsData) : current))
            }
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

function ConfigField({
  path,
  label,
  value,
  onChange,
  t,
}: {
  path: string[]
  label: string
  value: JsonValue
  onChange: (value: JsonValue) => void
  t: Translator
}) {
  const meta = fieldMeta[label] ?? [
    label,
    label,
    t('修改此项的配置值。', 'Edit this configuration value.'),
    t('Edit this configuration value.', 'Edit this configuration value.'),
  ]
  const title = t(meta[0], meta[1])
  const hint = t(meta[2], meta[3])
  if (Array.isArray(value))
    return (
      <label className="field">
        <span>
          <b>{title}</b>
          <small>{hint}</small>
        </span>
        <ArrayField values={value} onChange={onChange} t={t} />
      </label>
    )
  const sensitive =
    isSensitiveMarker(value) ||
    label.toLowerCase().includes('token') ||
    label.toLowerCase().includes('password') ||
    label.toLowerCase().includes('secret')
  if (isRecord(value) && !isSensitiveMarker(value))
    return (
      <fieldset className="nested-field">
        <legend>
          {title}
          <small>{hint}</small>
        </legend>
        {Object.entries(value).map(([key, child]) => (
          <ConfigField
            key={key}
            path={[...path, key]}
            label={key}
            value={child}
            onChange={next => onChange(setAtPath(value, [key], next))}
            t={t}
          />
        ))}
      </fieldset>
    )
  if (typeof value === 'boolean')
    return (
      <label className="field switch-field">
        <span>
          <b>{title}</b>
          <small>{hint}</small>
        </span>
        <button
          className={`switch ${value ? 'on' : ''}`}
          type="button"
          role="switch"
          aria-checked={value}
          onClick={() => onChange(!value)}>
          <i />
        </button>
      </label>
    )
  return (
    <label className="field">
      <span>
        <b>{title}</b>
        <small>{hint}</small>
      </span>
      <Input
        type={sensitive ? 'password' : typeof value === 'number' ? 'number' : 'text'}
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        placeholder={sensitive ? t('输入新值；留空保持不变', 'Enter a replacement; blank preserves it') : ''}
        onChange={event => onChange(typeof value === 'number' ? Number(event.target.value) : event.target.value)}
      />
    </label>
  )
}

function ArrayField({
  values,
  onChange,
  t,
}: {
  values: JsonValue[]
  onChange: (value: JsonValue) => void
  t: Translator
}) {
  const items = values.map(item => String(item))
  return (
    <div className="array-field">
      {items.map((value, index) => (
        <div key={`${index}-${value}`}>
          <Input
            value={value}
            onChange={event =>
              onChange(items.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))
            }
          />
          <Button
            variant="ghost"
            type="button"
            aria-label={t('删除此项', 'Remove item')}
            onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>
            <X size={15} />
          </Button>
        </div>
      ))}
      <Button variant="secondary" type="button" onClick={() => onChange([...items, ''])}>
        ＋ {t('添加一项', 'Add item')}
      </Button>
    </div>
  )
}

export function appendOutput(
  timeline: TimelineItem[],
  content: string,
  final: boolean,
  attachments: MessageAttachment[] = [],
  copyActions: CopyAction[] = [],
) {
  let streamingIndex = -1
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]
    if (item?.type === 'chat' && item.role === 'assistant' && item.streaming) {
      streamingIndex = index
      break
    }
  }
  if (streamingIndex >= 0) {
    const streamingItem = timeline[streamingIndex]
    if (streamingItem?.type !== 'chat') return timeline
    return timeline.map((item, index) =>
      index === streamingIndex
        ? {
            ...streamingItem,
            content,
            attachments: attachments.length ? attachments : streamingItem.attachments,
            copyActions: copyActions.length ? copyActions : streamingItem.copyActions,
            streaming: !final,
          }
        : item,
    )
  }
  return [
    ...timeline,
    {
      type: 'chat' as const,
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content,
      attachments,
      copyActions,
      streaming: !final,
      createdAt: Date.now(),
    },
  ]
}

function CopyActionList({ actions, t }: { actions: CopyAction[]; t: Translator }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (action: CopyAction) => {
    try {
      await navigator.clipboard.writeText(action.copyText)
      setCopied(action.copyText)
      window.setTimeout(() => setCopied(current => (current === action.copyText ? null : current)), 1400)
    } catch {
      setCopied(null)
    }
  }
  return (
    <div className="copy-action-list" aria-label={t('可用模型', 'Available models')}>
      {actions.map(action => (
        <button
          className="copy-action-item"
          type="button"
          key={`${action.label}:${action.copyText}`}
          title={action.copyText}
          onClick={() => void copy(action)}>
          <span>📋 {action.label}</span>
          <code>{copied === action.copyText ? t('已复制', 'Copied') : action.copyText}</code>
        </button>
      ))}
    </div>
  )
}
function plainTextPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/[#*_>`[\]()~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function hydrateMessage(message: ServerMessage): Message {
  return { ...message, type: 'chat', attachments: hydrateAttachments(message.attachments) }
}
function hydrateTimelineItem(item: ServerTimelineItem): TimelineItem {
  if (item.type === 'chat') return hydrateMessage(item)
  if (!item.approval) {
    return {
      type: 'approval',
      id: item.id,
      createdAt: item.createdAt,
      approvalId: `unavailable:${item.id}`,
      conversationId: '',
      command: '—',
      detail: '',
      status: 'unavailable',
      operator: null,
      automatic: false,
    }
  }
  return {
    type: 'approval',
    id: item.id,
    createdAt: item.createdAt,
    approvalId: item.approval.approvalId,
    conversationId: item.approval.conversationId,
    command: item.approval.request.command,
    detail: formatApprovalDetail(item.approval.request.detail),
    status: item.approval.status,
    operator: item.approval.operator,
    automatic: item.approval.automatic,
  }
}
function formatApprovalDetail(detail: JsonValue): string {
  return typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
}
function timelineKey(item: TimelineItem): string {
  return item.type === 'approval' ? `approval:${item.approvalId}` : `chat:${item.id}`
}
function prependHistory(page: TimelineItem[], current: TimelineItem[]): TimelineItem[] {
  const currentKeys = new Set(current.map(timelineKey))
  return [...page.filter(item => !currentKeys.has(timelineKey(item))), ...current]
}
function upsertApproval(timeline: TimelineItem[], incoming: Approval): TimelineItem[] {
  const index = timeline.findIndex(item => item.type === 'approval' && item.approvalId === incoming.approvalId)
  if (index < 0) return [...timeline, incoming]
  return timeline.map((item, itemIndex) => {
    if (itemIndex !== index || item.type !== 'approval') return item
    if (item.status === 'approved' || item.status === 'rejected') return item
    return { ...incoming, id: item.id, createdAt: item.createdAt }
  })
}
function isTimelineServerEvent(payload: ServerEvent): boolean {
  return (
    payload.type === 'output' ||
    payload.type === 'user_message' ||
    payload.type === 'approval' ||
    payload.type === 'approval_resolved'
  )
}
function hydrateAttachments(attachments: Array<Omit<MessageAttachment, 'url'>> | undefined): MessageAttachment[] {
  return (attachments ?? []).map(attachment => ({
    ...attachment,
    url: `/api/web/files/${encodeURIComponent(attachment.id)}`,
  }))
}
function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.kind === 'photo' || attachment.mimeType?.startsWith('image/') === true
}
function attachmentCategory(attachment: MessageAttachment): string {
  const mime = attachment.mimeType?.toLowerCase() ?? ''
  const name = attachment.fileName?.toLowerCase() ?? ''
  if (isImageAttachment(attachment)) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (
    mime.includes('zip') ||
    mime.includes('compressed') ||
    mime.includes('archive') ||
    /\.(zip|rar|7z|tar|gz|bz2)$/.test(name)
  )
    return 'archive'
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    /\.(txt|md|json|ya?ml|xml|csv|ts|tsx|js|jsx|py|java|go|rs|sh)$/.test(name)
  )
    return mime.startsWith('text/plain') || /\.(txt|md|csv)$/.test(name) ? 'text' : 'code'
  return 'document'
}
function attachmentTypeLabel(attachment: MessageAttachment, t: Translator): string {
  const category = attachmentCategory(attachment)
  const labels: Record<string, [string, string]> = {
    video: ['视频', 'Video'],
    audio: ['音频', 'Audio'],
    archive: ['压缩包', 'Archive'],
    code: ['代码文件', 'Code'],
    text: ['文本文件', 'Text'],
    image: ['图片', 'Image'],
    document: ['文档', 'Document'],
  }
  const label = labels[category] ?? labels.document!
  return t(label[0], label[1])
}
function downloadAttachment(attachment: MessageAttachment): void {
  if (!attachment.url) return
  const link = document.createElement('a')
  link.href = attachment.url
  link.download = attachment.fileName ?? 'download'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isSensitiveMarker(value: JsonValue): value is { configured: true } {
  return isRecord(value) && value.configured === true && Object.keys(value).length === 1
}
function setAtPath(value: JsonValue, path: string[], next: JsonValue): JsonValue {
  if (!path.length) return next
  if (!isRecord(value)) return value
  const [key, ...rest] = path
  if (key === undefined) return value
  return { ...value, [key]: rest.length ? setAtPath(value[key] ?? {}, rest, next) : next }
}
