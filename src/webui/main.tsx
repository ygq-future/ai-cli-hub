import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from 'react'
import { createRoot } from 'react-dom/client'
import { Check, ChevronRight, FilePlus2, LoaderCircle, Palette, Send, Settings2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Select } from './components/ui/select'
import './react.css'

type Translator = (cn: string, en: string) => string
type Message = { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }
type Approval = { approvalId: string; conversationId: string; command: string; detail: string }
type Status = {
  platform: 'web'
  cli: string
  cwd: string
  sessionStatus: string
  conversationId: string | null
  model: { name: string } | null
  autoApprove: { enabled: boolean; seconds: number }
}
type Preferences = {
  locale: 'zh-CN' | 'en'
  theme: 'system' | 'light' | 'dark'
  accent: 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet'
  enterToSend: boolean
}
type ServerEvent = {
  type?: string
  content?: string
  final?: boolean
  approvalId?: string
  conversationId?: string
  command?: string
  detail?: string
  message?: string
}
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type SettingsData = Record<string, JsonValue>

const preferenceKey = 'ai-cli-hub.webui.preferences'
const accents: Preferences['accent'][] = ['cyan', 'emerald', 'amber', 'rose', 'violet']
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

function App() {
  const [token, setToken] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [settings, setSettings] = useState(false)
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences())
  const socket = useRef<WebSocket | null>(null)
  const retryTimer = useRef<number | null>(null)
  const attempts = useRef(0)
  const picker = useRef<HTMLInputElement>(null)

  const zh = preferences.locale === 'zh-CN'
  const t: Translator = (cn, en) => (zh ? cn : en)
  const statusLoad = async () => {
    const response = await fetch('/api/web/status')
    if (response.ok) setStatus(((await response.json()) as { status: Status }).status)
  }

  useEffect(() => {
    if (!ready) return
    let disposed = false
    const connect = () => {
      setConnection(attempts.current ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.current = ws
      ws.onopen = () => {
        attempts.current = 0
        setConnection('connected')
        void statusLoad()
      }
      ws.onmessage = event => {
        let payload: ServerEvent
        try {
          payload = JSON.parse(String(event.data)) as ServerEvent
        } catch {
          return
        }
        if (payload.type === 'output' && typeof payload.content === 'string') {
          const content = payload.content
          setMessages(current => appendOutput(current, content, payload.final === true))
        }
        if (
          payload.type === 'approval' &&
          typeof payload.approvalId === 'string' &&
          typeof payload.conversationId === 'string' &&
          typeof payload.command === 'string' &&
          typeof payload.detail === 'string'
        ) {
          const approval: Approval = {
            approvalId: payload.approvalId,
            conversationId: payload.conversationId,
            command: payload.command,
            detail: payload.detail,
          }
          setApprovals(current => [...current.filter(item => item.approvalId !== approval.approvalId), approval])
        }
        if (payload.type === 'error')
          setError(payload.message ?? t('服务器返回错误。', 'The server returned an error.'))
        void statusLoad()
      }
      ws.onclose = () => {
        if (disposed) return
        attempts.current += 1
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts.current, 4))
        retryTimer.current = window.setTimeout(connect, delay)
      }
    }
    connect()
    return () => {
      disposed = true
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
      socket.current?.close()
    }
  }, [ready])
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
    localStorage.setItem(preferenceKey, JSON.stringify(preferences))
  }, [preferences])

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
    const uploadIds: string[] = []
    for (const file of files) {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch('/api/web/uploads', { method: 'POST', body: form })
      if (response.ok) uploadIds.push(((await response.json()) as { upload: { id: string } }).upload.id)
    }
    socket.current.send(JSON.stringify({ v: 1, type: 'message', text, uploadIds }))
    setMessages(current => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: text || files.map(file => `📎 ${file.name}`).join('\n') },
    ])
    setText('')
    setFiles([])
  }
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
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
    setApprovals(current => current.filter(item => item.approvalId !== approval.approvalId))
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
    <main className="app">
      <header className="app-header">
        <a className="brand" href="/webui/" aria-label="AI CLI HUB">
          <img src="/webui/assets/icon.svg" alt="" />
          AI CLI HUB
        </a>
        <span className={`connection ${connection}`}>
          <i />
          {connection === 'connected' ? t('实时连接', 'Live connection') : t('正在重连', 'Reconnecting')}
        </span>
        <Button variant="ghost" aria-label={t('打开设置', 'Open settings')} onClick={() => setSettings(true)}>
          <Settings2 size={19} />
        </Button>
      </header>
      <div className="grid">
        <section className="chat">
          <div className="feed" aria-live="polite">
            {!messages.length && !approvals.length && (
              <div className="empty-state">
                <span>✦</span>
                <p>{t('从这里开始一段新的远程对话。', 'Start a new remote conversation here.')}</p>
              </div>
            )}
            {messages.map(message => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                </div>
                <span className={message.streaming ? 'stream-caret' : ''} />
              </article>
            ))}
            {approvals.map(approval => (
              <ApprovalCard key={approval.approvalId} approval={approval} decide={decide} t={t} />
            ))}
          </div>
          <form className="composer-wrap" onSubmit={send}>
            {files.length > 0 && (
              <div className="files">
                {files.map((file, index) => (
                  <span key={`${file.name}-${index}`}>
                    {file.name}
                    <button
                      type="button"
                      onClick={() => setFiles(current => current.filter((_, fileIndex) => fileIndex !== index))}>
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="compose">
              <input
                hidden
                ref={picker}
                type="file"
                multiple
                accept="*/*"
                onChange={event => setFiles(current => [...current, ...Array.from(event.target.files ?? [])])}
              />
              <Button
                variant="ghost"
                type="button"
                aria-label={t('上传文件', 'Upload files')}
                onClick={() => picker.current?.click()}>
                <FilePlus2 size={19} />
              </Button>
              <textarea
                rows={1}
                value={text}
                onChange={event => setText(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                onPaste={event => {
                  const pasted = Array.from(event.clipboardData.files)
                  if (pasted.length) setFiles(current => [...current, ...pasted])
                }}
                placeholder={t('输入消息，或粘贴图片', 'Write a message or paste an image')}
              />
              <Button className="send" disabled={connection !== 'connected'}>
                <Send size={16} />
                {t('发送', 'Send')}
              </Button>
            </div>
          </form>
        </section>
        <StatusPanel status={status} t={t} />
      </div>
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
          <Settings t={t} preferences={preferences} setPreferences={setPreferences} close={() => setSettings(false)} />
        </DialogContent>
      </Dialog>
    </main>
  )
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
        <h1>
          {t('你的私有', 'Your private')}
          <br />
          {t('AI 控制台。', 'AI control plane.')}
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
    <aside className="status-panel">
      <h2>{t('当前会话', 'Current session')}</h2>
      <p>{t('仅显示 Web 控制台本身的会话。', 'Only the Web console session is shown here.')}</p>
      {rows.map(([key, value]) => (
        <dl key={key}>
          <dt>{key}</dt>
          <dd title={value ?? undefined}>{value || '—'}</dd>
        </dl>
      ))}
    </aside>
  )
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
  return (
    <article className="approval-card">
      <div>
        <span>{t('需要授权', 'Authorization required')}</span>
        <b>{approval.command}</b>
        <pre>{approval.detail}</pre>
      </div>
      <footer>
        <Button variant="secondary" type="button" onClick={() => decide(approval, 'reject')}>
          {t('拒绝', 'Reject')}
        </Button>
        <Button type="button" onClick={() => decide(approval, 'approve')}>
          <Check size={16} />
          {t('允许', 'Allow')}
        </Button>
      </footer>
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
}: {
  close: () => void
  t: Translator
  preferences: Preferences
  setPreferences: Dispatch<SetStateAction<Preferences>>
}) {
  const [data, setData] = useState<SettingsData | null>(null)
  const [result, setResult] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void fetch('/api/settings')
      .then(response => (response.ok ? response.json() : Promise.reject()))
      .then((value: { settings: SettingsData }) => setData(value.settings))
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
    setResult(
      response.ok
        ? t('配置已保存，重启后生效。', 'Settings saved. Restart to apply.')
        : t('保存失败，请检查字段。', 'Save failed. Check the fields.'),
    )
  }
  return (
    <div className="settings-body">
      {data ? (
        <div className="settings-groups">
          {Object.entries(data).map(([group, value]) => (
            <ConfigGroup key={group} group={group} value={value} setData={setData} t={t} />
          ))}
        </div>
      ) : (
        <p className="loading">
          <LoaderCircle />
          {t('正在加载配置…', 'Loading settings…')}
        </p>
      )}
      <div className="browser-preferences">
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
        </section>
        <section className="preference-section">
          <h3>{t('外观', 'Appearance')}</h3>
          <Appearance preferences={preferences} setPreferences={setPreferences} t={t} />
        </section>
      </div>
      <footer className="settings-actions">
        <small>{result}</small>
        <Button variant="secondary" type="button" onClick={close}>
          {t('关闭', 'Close')}
        </Button>
        <Button type="button" disabled={!data || saving} onClick={() => void save()}>
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

function appendOutput(messages: Message[], content: string, final: boolean) {
  const last = messages.at(-1)
  if (last?.role === 'assistant' && last.streaming)
    return [...messages.slice(0, -1), { ...last, content, streaming: !final }]
  return [...messages, { id: crypto.randomUUID(), role: 'assistant' as const, content, streaming: !final }]
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
function readPreferences(): Preferences {
  try {
    return {
      locale: 'zh-CN',
      theme: 'system',
      accent: 'emerald',
      enterToSend: true,
      ...(JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') as Partial<Preferences>),
    }
  } catch {
    return { locale: 'zh-CN', theme: 'system', accent: 'emerald', enterToSend: true }
  }
}

createRoot(document.getElementById('root')!).render(<App />)
