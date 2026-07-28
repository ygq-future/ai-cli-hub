import {
  DEFAULT_WEBUI_PREFERENCES,
  normalizeWebUiPreferences,
  resolveTheme,
  type WebUiAccent,
  type WebUiPreferences,
} from './state'

const PREFERENCES_KEY = 'ai-cli-hub.webui.preferences'
const ACCENTS: WebUiAccent[] = ['cyan', 'emerald', 'amber', 'rose', 'violet']

type WebMessage = { role: 'user' | 'assistant'; content: string }
type PendingApproval = { conversationId: string; approvalId: string; command: string; detail: string }
type WebStatus = {
  conversationId: string | null
  cli: string
  cwd: string
  sessionStatus: string
  model: { id: string; name: string } | null
  autoApprove: { enabled: boolean; seconds: number }
}

const copy = {
  'zh-CN': {
    signIn: '进入控制台',
    token: '管理 Token',
    tokenHint: '使用 settings.json 中的 http.authToken',
    secure: 'Token 仅用于建立安全会话，不会保存到浏览器。',
    loginFailed: '登录失败，请检查 Token。',
    connected: '已连接',
    connecting: '正在连接',
    disconnected: '连接已断开',
    command: '输入消息，或粘贴图片',
    send: '发送',
    upload: '添加文件',
    settings: '设置',
    close: '关闭',
    appearance: '外观',
    language: '界面语言',
    theme: '主题',
    accent: '强调色',
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
    status: '当前会话',
    model: '模型',
    runtime: 'CLI',
    directory: '工作目录',
    session: '会话状态',
    conversation: 'Conversation ID',
    autoApprove: '自动审批',
    enabled: '已开启',
    disabled: '已关闭',
    noConversation: '尚未创建会话',
    empty: '从这里开始一段新的远程对话。',
    settingsLoadFailed: '配置读取失败。',
    save: '保存配置',
    savedRestartRequired: '已保存；重启后生效。',
    saveFailed: '保存失败。',
    restart: '保存后重启服务',
    restartPreview: '重启预览',
    confirmRestart: '确认重启服务',
    restartHint: '重启会短暂断开当前连接。',
    configured: '已配置（留空保持不变）',
    invalidFile: '文件上传失败。',
    uploading: '正在上传',
    approve: '同意',
    reject: '拒绝',
    pendingApproval: '需要授权',
  },
  en: {
    signIn: 'Enter console',
    token: 'Admin token',
    tokenHint: 'Use http.authToken from settings.json',
    secure: 'The token only establishes a secure session and is never stored in this browser.',
    loginFailed: 'Sign-in failed. Check the token.',
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Disconnected',
    command: 'Write a message or paste an image',
    send: 'Send',
    upload: 'Add file',
    settings: 'Settings',
    close: 'Close',
    appearance: 'Appearance',
    language: 'Language',
    theme: 'Theme',
    accent: 'Accent',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    status: 'Current session',
    model: 'Model',
    runtime: 'CLI',
    directory: 'Working directory',
    session: 'Session state',
    conversation: 'Conversation ID',
    autoApprove: 'Auto approve',
    enabled: 'Enabled',
    disabled: 'Disabled',
    noConversation: 'No conversation yet',
    empty: 'Start a new remote conversation here.',
    settingsLoadFailed: 'Could not load settings.',
    save: 'Save settings',
    savedRestartRequired: 'Saved. Restart required.',
    saveFailed: 'Save failed.',
    restart: 'Save and restart',
    restartPreview: 'Restart preview',
    confirmRestart: 'Confirm restart',
    restartHint: 'Restarting briefly disconnects this connection.',
    configured: 'Configured (leave blank to keep)',
    invalidFile: 'Upload failed.',
    uploading: 'Uploading',
    approve: 'Approve',
    reject: 'Reject',
    pendingApproval: 'Authorization required',
  },
} as const

function readPreferences(): WebUiPreferences {
  try {
    return normalizeWebUiPreferences(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null'), navigator.language)
  } catch {
    return normalizeWebUiPreferences(DEFAULT_WEBUI_PREFERENCES, navigator.language)
  }
}

class HubConsole extends HTMLElement {
  private preferences = readPreferences()
  private authenticated = false
  private socket: WebSocket | null = null
  private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private loginError = ''
  private messages: WebMessage[] = []
  private approvals: PendingApproval[] = []
  private status: WebStatus | null = null
  private settingsOpen = false
  private dropdown: 'locale' | 'theme' | null = null
  private settingsData: Record<string, unknown> | null = null
  private settingsStatus = ''
  private restartPreview = ''
  private uploadIds: string[] = []
  private uploads: Array<{ id: string; name: string; preview: string | null; state: 'uploading' | 'ready' }> = []

  connectedCallback(): void {
    this.applyPreferences()
    this.render()
    void this.restoreSession()
  }
  disconnectedCallback(): void {
    this.authenticated = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
  }

  private applyPreferences(): void {
    document.documentElement.lang = this.preferences.locale
    document.documentElement.dataset.theme = resolveTheme(
      this.preferences.theme,
      matchMedia('(prefers-color-scheme: dark)').matches,
    )
    document.documentElement.dataset.accent = this.preferences.accent
  }
  private setPreference(key: keyof WebUiPreferences, value: string): void {
    this.preferences = { ...this.preferences, [key]: value } as WebUiPreferences
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences))
    this.applyPreferences()
    this.dropdown = null
    this.render()
  }
  private async restoreSession(): Promise<void> {
    try {
      const response = await fetch('/api/auth/session')
      if (!((await response.json()) as { authenticated?: boolean }).authenticated) return
      this.authenticated = true
      this.connectWebSocket()
      void this.loadSettings()
      void this.loadStatus()
      this.render()
    } catch {
      /* Login remains available while server is unreachable. */
    }
  }
  private render(): void {
    this.innerHTML = this.authenticated ? this.consoleTemplate() : this.loginTemplate()
    this.bindEvents()
  }
  private loginTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<main class="login-shell"><section class="login-card"><span class="brand">AI CLI HUB</span><h1>Remote control,<br>without the noise.</h1><p>${t.secure}</p><form data-login-form><label>${t.token}<input class="field-control" id="token" type="password" required autocomplete="current-password" placeholder="••••••••••••"></label><small>${t.tokenHint}</small>${this.loginError ? `<output class="error">${this.loginError}</output>` : ''}<button class="button primary" type="submit">${t.signIn}<span>→</span></button></form>${this.appearanceTemplate()}</section></main>`
  }
  private consoleTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<main class="app-shell"><section class="console-shell"><header class="topbar"><span class="brand">AI CLI HUB</span><span class="connection ${this.connectionState}"><i></i>${this.connectionLabel()}</span><button class="icon-button" data-open-settings aria-label="${t.settings}">⚙</button></header><div class="console-grid"><section class="chat-column">${this.chatTemplate()}</section><aside class="status-column">${this.statusTemplate()}</aside></div>${this.settingsOpen ? this.settingsTemplate() : ''}</section></main>`
  }
  private connectionLabel(): string {
    const t = copy[this.preferences.locale]
    return this.connectionState === 'connected'
      ? t.connected
      : this.connectionState === 'connecting'
        ? t.connecting
        : t.disconnected
  }
  private chatTemplate(): string {
    const t = copy[this.preferences.locale]
    const messages = this.messages
      .map(message => `<article class="message ${message.role}"><p>${escapeHtml(message.content)}</p></article>`)
      .join('')
    const approvals = this.approvals
      .map(
        item =>
          `<article class="approval-card"><p class="eyebrow">${t.pendingApproval}</p><strong>${escapeHtml(item.command)}</strong><p>${escapeHtml(item.detail)}</p><div><button class="button primary" data-approval="approve" data-approval-id="${item.approvalId}" data-conversation-id="${item.conversationId}">${t.approve}</button><button class="button secondary" data-approval="reject" data-approval-id="${item.approvalId}" data-conversation-id="${item.conversationId}">${t.reject}</button></div></article>`,
      )
      .join('')
    const uploadList = this.uploads.length
      ? `<div class="upload-list">${this.uploads.map(file => `<div class="upload-chip">${file.preview ? `<img src="${file.preview}" alt="">` : '<span>FILE</span>'}<b>${escapeHtml(file.name)}</b><small>${file.state === 'uploading' ? t.uploading : '✓'}</small><button data-remove-upload="${file.id}" aria-label="remove">×</button></div>`).join('')}</div>`
      : ''
    return `<div class="message-scroll" data-message-scroll><div class="message-stack">${messages || `<p class="empty-state">${t.empty}</p>`}${approvals}</div></div><form class="composer" data-chat-form>${uploadList}<div class="composer-box"><input hidden data-file-input type="file" multiple><button type="button" class="icon-button attach" data-select-files aria-label="${t.upload}">＋</button><textarea data-chat-input rows="1" placeholder="${t.command}" ${this.connectionState === 'connected' ? '' : 'disabled'}></textarea><button class="button primary send" ${this.connectionState === 'connected' ? '' : 'disabled'}>${t.send}<span>↑</span></button></div></form>`
  }
  private statusTemplate(): string {
    const t = copy[this.preferences.locale],
      status = this.status
    const rows: Array<[string, string]> = [
      [t.runtime, status?.cli ?? '—'],
      [t.model, status?.model?.name ?? '—'],
      [t.directory, status?.cwd ?? '—'],
      [t.session, status?.sessionStatus ?? 'idle'],
      [
        t.autoApprove,
        status
          ? `${status.autoApprove.enabled ? t.enabled : t.disabled}${status.autoApprove.enabled ? ` · ${status.autoApprove.seconds}s` : ''}`
          : '—',
      ],
      [t.conversation, status?.conversationId ?? t.noConversation],
    ]
    return `<div class="status-head"><p class="eyebrow">WEBSOCKET</p><h2>${t.status}</h2></div><dl class="status-list">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join('')}</dl><div class="status-footer"><i></i>${this.connectionLabel()}</div>`
  }
  private settingsTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<section class="settings-layer"><div class="settings-panel"><header><div><p class="eyebrow">CONTROL PLANE</p><h2>${t.settings}</h2></div><button class="icon-button" data-close-settings aria-label="${t.close}">×</button></header><div class="settings-scroll">${this.appearanceTemplate()}<section class="settings-section"><div class="section-title"><h3>settings.json</h3><p>Configuration fields are validated before saving.</p></div>${this.settingsData ? this.settingsForm(this.settingsData) : '<p class="empty-state">Loading…</p>'}</section>${this.settingsStatus ? `<output class="settings-result">${escapeHtml(this.settingsStatus)}</output>` : ''}<div class="settings-actions"><button class="button secondary" data-save-settings>${t.save}</button><button class="button primary" data-restart>${t.restart}</button></div>${this.restartPreview ? `<section class="restart-card"><p>${t.restartPreview}</p><pre>${escapeHtml(this.restartPreview)}</pre><small>${t.restartHint}</small><button class="button primary" data-confirm-restart>${t.confirmRestart}</button></section>` : ''}</div></div></section>`
  }
  private appearanceTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<section class="appearance settings-section"><div class="section-title"><h3>${t.appearance}</h3></div><div class="appearance-grid">${this.selectTemplate(
      'locale',
      t.language,
      this.preferences.locale === 'zh-CN' ? '中文' : 'English',
      [
        ['zh-CN', '中文'],
        ['en', 'English'],
      ],
    )}${this.selectTemplate('theme', t.theme, t[this.preferences.theme], [
      ['system', t.system],
      ['light', t.light],
      ['dark', t.dark],
    ])}<div class="preference"><span>${t.accent}</span><div class="accent-row">${ACCENTS.map(item => `<button data-accent="${item}" class="accent-dot ${this.preferences.accent === item ? 'selected' : ''}" aria-label="${item}" style="--dot:${accentValue(item)}"></button>`).join('')}</div></div></div></section>`
  }
  private selectTemplate(
    key: 'locale' | 'theme',
    label: string,
    value: string,
    options: Array<[string, string]>,
  ): string {
    return `<div class="preference"><span>${label}</span><div class="custom-select"><button type="button" class="select-trigger" data-toggle-select="${key}" aria-expanded="${this.dropdown === key}">${value}<b>⌄</b></button>${this.dropdown === key ? `<div class="select-menu">${options.map(([id, name]) => `<button type="button" data-preference="${key}" data-value="${id}">${name}${value === name ? '<b>✓</b>' : ''}</button>`).join('')}</div>` : ''}</div></div>`
  }
  private settingsForm(data: Record<string, unknown>): string {
    return Object.entries(data)
      .map(
        ([key, value]) =>
          `<details class="config-group" open><summary>${escapeHtml(key)}<span>⌄</span></summary><div>${this.configFields(value, [key])}</div></details>`,
      )
      .join('')
  }
  private configFields(value: unknown, path: string[]): string {
    if (isRecord(value))
      return Object.entries(value)
        .map(([key, item]) => this.configFields(item, [...path, key]))
        .join('')
    const label = path.at(-1) ?? '',
      key = path.join('.')
    if (typeof value === 'boolean')
      return `<label class="config-field switch-field"><span>${escapeHtml(label)}</span><button type="button" data-setting-toggle="${key}" class="switch ${value ? 'on' : ''}" role="switch" aria-checked="${value}"><i></i></button></label>`
    const configured = isRecord(value) && value.configured === true
    const raw = Array.isArray(value) ? value.join(', ') : configured ? '' : String(value ?? '')
    return `<label class="config-field"><span>${escapeHtml(label)}</span><input class="field-control" data-setting="${key}" data-kind="${configured ? 'configured' : Array.isArray(value) ? 'array' : typeof value}" ${configured ? 'type="password" placeholder="已配置（留空保持不变）"' : ''} value="${escapeHtml(raw)}"></label>`
  }
  private bindEvents(): void {
    this.querySelector<HTMLFormElement>('[data-login-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const token = this.querySelector<HTMLInputElement>('#token')?.value ?? ''
      void fetch('/api/auth/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        .then(async response => {
          if (!response.ok) throw new Error()
          this.authenticated = true
          this.loginError = ''
          this.connectWebSocket()
          void this.loadSettings()
          void this.loadStatus()
          this.render()
        })
        .catch(() => {
          this.loginError = copy[this.preferences.locale].loginFailed
          this.render()
        })
    })
    this.querySelector('[data-open-settings]')?.addEventListener('click', () => {
      this.settingsOpen = true
      void this.loadSettings()
      this.render()
    })
    this.querySelector('[data-close-settings]')?.addEventListener('click', () => {
      this.settingsOpen = false
      this.render()
    })
    this.querySelectorAll<HTMLButtonElement>('[data-toggle-select]').forEach(button =>
      button.addEventListener('click', () => {
        const value = button.dataset.toggleSelect
        this.dropdown = this.dropdown === value ? null : value === 'locale' ? 'locale' : 'theme'
        this.render()
      }),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-preference]').forEach(button =>
      button.addEventListener('click', () =>
        this.setPreference(button.dataset.preference as keyof WebUiPreferences, button.dataset.value ?? ''),
      ),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach(button =>
      button.addEventListener('click', () => this.setPreference('accent', button.dataset.accent ?? 'cyan')),
    )
    this.querySelector<HTMLFormElement>('[data-chat-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const input = this.querySelector<HTMLTextAreaElement>('[data-chat-input]')
      const text = input?.value.trim() ?? ''
      if ((!text && !this.uploadIds.length) || this.socket?.readyState !== WebSocket.OPEN) return
      this.socket.send(JSON.stringify({ v: 1, type: 'message', text, uploadIds: this.uploadIds }))
      this.messages.push({ role: 'user', content: text || this.uploads.map(file => `📎 ${file.name}`).join('\n') })
      this.uploadIds = []
      this.uploads = []
      if (input) input.value = ''
      this.render()
    })
    this.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        this.querySelector<HTMLFormElement>('[data-chat-form]')?.requestSubmit()
      }
    })
    this.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'))
      if (files.length) void this.uploadFiles(files)
    })
    this.querySelector('[data-select-files]')?.addEventListener('click', () =>
      this.querySelector<HTMLInputElement>('[data-file-input]')?.click(),
    )
    this.querySelector<HTMLInputElement>('[data-file-input]')?.addEventListener(
      'change',
      event => void this.uploadFiles(Array.from((event.currentTarget as HTMLInputElement).files ?? [])),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-remove-upload]').forEach(button =>
      button.addEventListener('click', () => {
        const id = button.dataset.removeUpload
        this.uploads = this.uploads.filter(file => file.id !== id)
        this.uploadIds = this.uploadIds.filter(item => item !== id)
        this.render()
      }),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach(button =>
      button.addEventListener('click', () => {
        const approvalId = button.dataset.approvalId,
          conversationId = button.dataset.conversationId,
          type = button.dataset.approval
        if (!approvalId || !conversationId || (type !== 'approve' && type !== 'reject')) return
        this.socket?.send(JSON.stringify({ v: 1, type, approvalId, conversationId }))
        this.approvals = this.approvals.filter(item => item.approvalId !== approvalId)
        this.render()
      }),
    )
    this.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input =>
      input.addEventListener('input', () =>
        this.updateSetting(input.dataset.setting ?? '', input.value, input.dataset.kind ?? 'string'),
      ),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-setting-toggle]').forEach(button =>
      button.addEventListener('click', () => {
        const path = button.dataset.settingToggle ?? ''
        this.updateSetting(path, String(!getPath(this.settingsData ?? {}, path)), 'boolean')
        this.render()
      }),
    )
    this.querySelector('[data-save-settings]')?.addEventListener('click', () => void this.saveSettings())
    this.querySelector('[data-restart]')?.addEventListener('click', () => void this.previewRestart())
    this.querySelector('[data-confirm-restart]')?.addEventListener('click', () => void this.confirmRestart())
  }
  private async uploadFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const id = crypto.randomUUID(),
        preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      this.uploads.push({ id, name: file.name, preview, state: 'uploading' })
      this.render()
      try {
        const form = new FormData()
        form.set('file', file)
        const response = await fetch('/api/web/uploads', { method: 'POST', body: form })
        const payload = (await response.json()) as { upload?: { id?: string } }
        if (!response.ok || !payload.upload?.id) throw new Error()
        const item = this.uploads.find(upload => upload.id === id)
        if (item) {
          item.id = payload.upload.id
          item.state = 'ready'
        }
        this.uploadIds.push(payload.upload.id)
      } catch {
        this.uploads = this.uploads.filter(upload => upload.id !== id)
        this.settingsStatus = copy[this.preferences.locale].invalidFile
      }
      this.render()
    }
  }
  private updateSetting(path: string, raw: string, kind: string): void {
    if (!this.settingsData || !path || (kind === 'configured' && !raw)) return
    const value: unknown =
      kind === 'boolean'
        ? raw === 'true'
        : kind === 'number'
          ? Number(raw)
          : kind === 'array'
            ? raw
                .split(',')
                .map(item => item.trim())
                .filter(Boolean)
            : raw
    setPath(this.settingsData, path, value)
  }
  private async saveSettings(): Promise<void> {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.settingsData),
      })
      if (!response.ok) throw new Error()
      this.settingsStatus = copy[this.preferences.locale].savedRestartRequired
    } catch {
      this.settingsStatus = copy[this.preferences.locale].saveFailed
    }
    this.render()
  }
  private async previewRestart(): Promise<void> {
    try {
      const response = await fetch('/api/restart')
      const payload = (await response.json()) as { preview?: string }
      if (!response.ok) throw new Error()
      this.restartPreview = payload.preview ?? ''
    } catch {
      this.settingsStatus = copy[this.preferences.locale].saveFailed
    }
    this.render()
  }
  private async confirmRestart(): Promise<void> {
    try {
      const response = await fetch('/api/restart', { method: 'POST' })
      if (!response.ok) throw new Error()
      this.restartPreview = ''
      this.settingsStatus = copy[this.preferences.locale].savedRestartRequired
    } catch {
      this.settingsStatus = copy[this.preferences.locale].saveFailed
    }
    this.render()
  }
  private async loadSettings(): Promise<void> {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) throw new Error()
      this.settingsData = ((await response.json()) as { settings?: Record<string, unknown> }).settings ?? {}
      this.settingsStatus = ''
    } catch {
      this.settingsStatus = copy[this.preferences.locale].settingsLoadFailed
    }
    if (this.settingsOpen) this.render()
  }
  private async loadStatus(): Promise<void> {
    try {
      const response = await fetch('/api/web/status')
      if (!response.ok) throw new Error()
      this.status = ((await response.json()) as { status?: WebStatus }).status ?? null
      this.render()
    } catch {
      /* The connection indicator is still meaningful without status. */
    }
  }
  private connectWebSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.close()
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`)
    this.socket = socket
    this.connectionState = 'connecting'
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.connectionState = 'connected'
      this.reconnectAttempts = 0
      void this.loadStatus()
      this.render()
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.connectionState = 'disconnected'
      this.render()
      if (!this.authenticated) return
      this.reconnectTimer = window.setTimeout(
        () => this.connectWebSocket(),
        Math.min(10_000, 500 * 2 ** this.reconnectAttempts++),
      )
    }
    socket.onmessage = event => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string
          content?: string
          conversationId?: string
          approvalId?: string
          command?: string
          detail?: string
        }
        if (payload.type === 'output' && typeof payload.content === 'string') {
          const last = this.messages.at(-1)
          if (last?.role === 'assistant') last.content = payload.content
          else this.messages.push({ role: 'assistant', content: payload.content })
        }
        if (
          payload.type === 'approval' &&
          payload.conversationId &&
          payload.approvalId &&
          payload.command &&
          payload.detail
        )
          this.approvals.push({
            conversationId: payload.conversationId,
            approvalId: payload.approvalId,
            command: payload.command,
            detail: payload.detail,
          })
        if (payload.type === 'connected' || payload.type === 'output') void this.loadStatus()
        this.render()
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function getPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value)
}
function setPath(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = value
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(current[key])) current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[keys.at(-1) ?? ''] = next
}
function accentValue(value: WebUiAccent): string {
  return { cyan: '#18a7a2', emerald: '#28a36d', amber: '#da9027', rose: '#d95b71', violet: '#8772d7' }[value]
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character,
  )
}
customElements.define('hub-console', HubConsole)
