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

const copy = {
  'zh-CN': {
    signIn: '进入控制台',
    consoleTitle: '安静而专注的远程控制。',
    controlPlane: '控制台',
    openSessions: '打开会话面板',
    openInspector: '打开检查器',
    closePanel: '关闭面板',
    token: '管理 Token',
    tokenHint: '使用 settings.json 中的 http.authToken',
    secure: 'Token 仅用于建立安全会话，不会保存到浏览器。',
    chat: '会话',
    settings: '配置',
    connected: '已连接',
    loginFailed: '登录失败，请检查 Token。',
    settingsLoadFailed: '配置读取失败。',
    saveFailed: '保存失败。',
    savedRestartRequired: '已保存，等待重启。',
    command: '输入消息或 /help',
    send: '发送',
    sessions: '活动会话',
    inspector: '检查器',
    approvals: '待处理授权',
    appearance: '外观',
    language: '界面语言',
    theme: '主题',
    accent: '强调色',
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
    save: '保存配置',
    restart: '保存后重启服务',
    demo: '界面预览 · 尚未连接服务',
    runtime: '运行时',
    model: '模型',
    autoApprove: '自动审批',
    status: '状态',
    running: '运行中',
    connecting: '正在连接…',
    disconnected: '连接已断开',
    you: '你',
    approve: '同意',
    reject: '拒绝',
    restartPreview: '重启预览',
    confirmRestart: '确认重启服务',
    restartHint: '重启会暂时断开当前 WebSocket 连接。',
    validated: '配置会在写入 settings.json 前验证。',
    http: 'HTTP 服务',
    transport: '客户端接入',
    configured: '已配置 Token',
    editEndpoint: '编辑端点',
    manageClients: '管理客户端',
  },
  en: {
    signIn: 'Enter console',
    consoleTitle: 'Remote control, without noise.',
    controlPlane: 'CONTROL PLANE',
    openSessions: 'Open sessions panel',
    openInspector: 'Open inspector',
    closePanel: 'Close panel',
    token: 'Admin token',
    tokenHint: 'Use http.authToken from settings.json',
    secure: 'The token only establishes a secure session and is never stored in this browser.',
    chat: 'Sessions',
    settings: 'Settings',
    connected: 'Connected',
    loginFailed: 'Sign-in failed. Check the token.',
    settingsLoadFailed: 'Could not load settings.',
    saveFailed: 'Save failed.',
    savedRestartRequired: 'Saved. Restart required.',
    command: 'Write a message or /help',
    send: 'Send',
    sessions: 'Active sessions',
    inspector: 'Inspector',
    approvals: 'Pending approvals',
    appearance: 'Appearance',
    language: 'Interface language',
    theme: 'Theme',
    accent: 'Accent color',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    save: 'Save settings',
    restart: 'Save and restart service',
    demo: 'Interface preview · service is not connected',
    runtime: 'Runtime',
    model: 'Model',
    autoApprove: 'Auto approve',
    status: 'Status',
    running: 'running',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    you: 'YOU',
    approve: 'Approve',
    reject: 'Reject',
    restartPreview: 'Restart preview',
    confirmRestart: 'Confirm service restart',
    restartHint: 'Restarting will temporarily disconnect this WebSocket session.',
    validated: 'Configuration is validated before it reaches settings.json.',
    http: 'HTTP service',
    transport: 'Transport',
    configured: 'Token configured',
    editEndpoint: 'Edit endpoint',
    manageClients: 'Manage clients',
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
  private currentView: 'chat' | 'settings' = 'chat'
  private mobilePanel: 'sessions' | 'inspector' | null = null
  private socket: WebSocket | null = null
  private loginError = ''
  private messages: WebMessage[] = []
  private approvals: PendingApproval[] = []
  private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private settingsData: Record<string, unknown> | null = null
  private settingsStatus = ''
  private restartPreview = ''

  connectedCallback(): void {
    this.applyPreferences()
    this.render()
    void this.restoreSession()
  }

  disconnectedCallback(): void {
    this.authenticated = false
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
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
    this.render()
  }

  private async restoreSession(): Promise<void> {
    try {
      const response = await fetch('/api/auth/session')
      if (!response.ok) return
      const payload = (await response.json()) as { authenticated?: boolean }
      if (!payload.authenticated) return
      this.authenticated = true
      this.connectWebSocket()
      void this.loadSettings()
      this.render()
    } catch {
      // 网络暂不可用时保持登录页，用户仍可手动登录。
    }
  }

  private render(): void {
    this.innerHTML = this.authenticated ? this.consoleTemplate() : this.loginTemplate()
    this.bindEvents()
  }

  private loginTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<main class="grid min-h-dvh place-items-center p-4 sm:p-8">
      <section class="surface w-full max-w-md overflow-hidden rounded-[2rem] border shadow-2xl shadow-black/10">
        <div class="relative overflow-hidden px-6 pb-8 pt-10 sm:px-10"><div class="absolute -right-10 -top-12 h-44 w-44 rounded-full opacity-45 blur-3xl" style="background:var(--accent)"></div><div class="relative">
          <div class="mb-8 flex items-center justify-between"><span class="code text-xs tracking-[.22em] text-muted">AI CLI HUB</span><span class="accent-soft rounded-full px-3 py-1 text-xs">${t.controlPlane}</span></div>
          <h1 class="max-w-xs text-4xl font-semibold tracking-tight">${t.consoleTitle}</h1><p class="mt-4 leading-7 text-muted">${t.secure}</p>
          <form class="mt-8 space-y-3" data-login-form><label class="block text-sm font-medium" for="token">${t.token}</label><input id="token" class="w-full rounded-xl border bg-transparent px-4 py-3 outline-none" style="border-color:var(--line)" type="password" autocomplete="current-password" placeholder="••••••••••••" required aria-describedby="token-hint login-error"><p id="token-hint" class="text-xs text-muted">${t.tokenHint}</p>${this.loginError ? `<p id="login-error" class="text-sm" role="alert" style="color:var(--danger)">${this.loginError}</p>` : ''}<button class="accent-bg mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-medium shadow-lg transition hover:brightness-110" type="submit">${t.signIn} <span aria-hidden="true">→</span></button></form>
          ${this.appearanceTemplate(true)}</div></div>
      </section></main>`
  }

  private consoleTemplate(): string {
    const t = copy[this.preferences.locale]
    const overlay = this.mobilePanel
      ? `<button class="absolute inset-0 z-20 bg-black/35 lg:hidden" data-close-panel aria-label="${t.closePanel}"></button>`
      : ''
    return `<main class="min-h-dvh p-2 sm:p-3"><div class="surface relative mx-auto grid min-h-[calc(100dvh-1rem)] max-w-[1800px] grid-cols-1 overflow-hidden rounded-[1.4rem] border md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)_19rem] sm:min-h-[calc(100dvh-1.5rem)]">
      <aside class="drawer absolute inset-y-0 left-0 z-30 w-[min(86vw,19rem)] border-r p-4 md:static md:w-auto ${this.mobilePanel === 'sessions' ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}" style="background:var(--surface);border-color:var(--line)">${this.sessionsTemplate()}</aside>${overlay}
      <section class="flex min-w-0 flex-col" style="background:color-mix(in srgb,var(--surface-raised) 76%,transparent)"><header class="flex items-center gap-2 border-b px-3 py-3 sm:px-5" style="border-color:var(--line)"><button class="rounded-lg p-2 md:hidden" data-panel="sessions" aria-label="${t.openSessions}">☰</button><div class="min-w-0 flex-1"><p class="truncate text-sm font-semibold">Webhook backend · Claude</p><p class="code truncate text-xs text-muted">/home/ubuntu/softs/webhook</p></div><span class="hidden rounded-full px-2.5 py-1 text-xs sm:block accent-soft">● ${t.connected}</span><button class="rounded-lg p-2 lg:hidden" data-panel="inspector" aria-label="${t.openInspector}">◫</button></header>${this.currentView === 'chat' ? this.chatTemplate() : this.settingsTemplate()}</section>
      <aside class="drawer absolute inset-y-0 right-0 z-30 w-[min(90vw,22rem)] border-l p-4 lg:static lg:w-auto ${this.mobilePanel === 'inspector' ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}" style="background:var(--surface);border-color:var(--line)">${this.inspectorTemplate()}</aside>
    </div></main>`
  }

  private sessionsTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<div class="flex h-full flex-col"><div class="mb-7 flex items-center justify-between"><span class="code text-xs tracking-[.18em] accent">AI CLI HUB</span><button class="rounded-md p-1.5 lg:hidden" data-close-panel aria-label="${t.closePanel}">×</button></div><div class="mb-4 flex gap-1 rounded-xl p-1" style="background:var(--surface-muted)"><button data-view="chat" class="flex-1 rounded-lg px-3 py-2 text-sm ${this.currentView === 'chat' ? 'accent-bg' : 'text-muted'}">${t.chat}</button><button data-view="settings" class="flex-1 rounded-lg px-3 py-2 text-sm ${this.currentView === 'settings' ? 'accent-bg' : 'text-muted'}">${t.settings}</button></div><p class="mb-2 text-xs font-medium uppercase tracking-wider text-muted">${t.sessions}</p><button class="mb-2 w-full rounded-xl border p-3 text-left" style="border-color:var(--accent);background:var(--accent-soft)"><span class="block text-sm font-medium">Webhook backend</span><span class="code mt-1 block text-xs text-muted">claude · running</span></button><button class="w-full rounded-xl p-3 text-left hover:bg-black/5"><span class="block text-sm">AI CLI Hub</span><span class="code mt-1 block text-xs text-muted">opencode · idle</span></button><div class="mt-auto border-t pt-4" style="border-color:var(--line)">${this.appearanceTemplate(false)}</div></div>`
  }

  private chatTemplate(): string {
    const t = copy[this.preferences.locale]
    const state =
      this.connectionState === 'connected'
        ? t.connected
        : this.connectionState === 'connecting'
          ? t.connecting
          : t.disconnected
    const messages = this.messages
      .map(
        message =>
          `<article class="${message.role === 'user' ? 'message-out ml-auto' : 'message-in'} max-w-[92%] border p-4 leading-7 sm:max-w-[78%]" style="border-color:var(--line);background:${message.role === 'user' ? 'var(--accent-soft)' : 'var(--surface)'}"><p class="mb-2 text-xs font-medium accent">${message.role === 'user' ? t.you : 'AI CLI'}</p><p>${escapeHtml(message.content)}</p></article>`,
      )
      .join('')
    const approvals = this.approvals
      .map(
        approval =>
          `<article class="message-in max-w-[92%] border p-4 sm:max-w-[78%]" style="border-color:var(--warning)"><p class="mb-2 text-xs font-medium" style="color:var(--warning)">${t.approvals}</p><p class="font-medium">${escapeHtml(approval.command)}</p><p class="mt-2 text-sm text-muted">${escapeHtml(approval.detail)}</p><div class="mt-4 flex gap-2"><button data-approval="approve" data-approval-id="${approval.approvalId}" data-conversation-id="${approval.conversationId}" class="accent-bg rounded-lg px-3 py-2 text-sm">${t.approve}</button><button data-approval="reject" data-approval-id="${approval.approvalId}" data-conversation-id="${approval.conversationId}" class="rounded-lg border px-3 py-2 text-sm" style="border-color:var(--line)">${t.reject}</button></div></article>`,
      )
      .join('')
    return `<div class="scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-5 sm:px-7 sm:py-8" aria-live="polite"><div class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5"><div class="mx-auto rounded-full border px-3 py-1 text-xs text-muted" style="border-color:var(--line)" role="status">${state}</div>${messages || `<p class="my-auto text-center text-sm text-muted">${t.demo}</p>`}${approvals}</div></div><form data-chat-form class="border-t p-3 sm:p-5" style="border-color:var(--line)"><div class="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border p-2" style="border-color:var(--line);background:var(--surface)"><textarea data-chat-input class="max-h-32 min-h-11 flex-1 resize-none bg-transparent px-2 py-2 outline-none" rows="1" placeholder="${t.command}" aria-label="${t.command}" ${this.connectionState === 'connected' ? '' : 'disabled'}></textarea><button class="accent-bg rounded-xl px-4 py-2.5 text-sm font-medium" ${this.connectionState === 'connected' ? '' : 'disabled'}>${t.send}</button></div></form>`
  }

  private inspectorTemplate(): string {
    const t = copy[this.preferences.locale]
    return `<div class="flex h-full flex-col gap-6"><div class="flex items-center justify-between"><h2 class="text-sm font-semibold">${t.inspector}</h2><button class="rounded-md p-1.5 lg:hidden" data-close-panel aria-label="${t.closePanel}">×</button></div><section><p class="mb-3 text-xs font-medium uppercase tracking-wider text-muted">${t.runtime}</p><dl class="space-y-3 text-sm"><div class="flex justify-between gap-4"><dt class="text-muted">${t.model}</dt><dd class="code">claude-sonnet-4</dd></div><div class="flex justify-between gap-4"><dt class="text-muted">${t.autoApprove}</dt><dd class="accent">ON · 5s</dd></div><div class="flex justify-between gap-4"><dt class="text-muted">${t.status}</dt><dd>● ${t.running}</dd></div></dl></section><section class="rounded-2xl border p-4" style="border-color:color-mix(in srgb,var(--warning) 48%,transparent);background:color-mix(in srgb,var(--warning) 9%,transparent)"><p class="mb-1 text-sm font-semibold" style="color:var(--warning)">${t.approvals}</p><p class="text-sm text-muted">git pull --ff-only</p><div class="mt-3 h-1.5 overflow-hidden rounded-full" style="background:var(--line)"><div class="h-full w-3/5 rounded-full" style="background:var(--warning)"></div></div></section><div class="mt-auto rounded-2xl p-4" style="background:var(--accent-soft)"><p class="text-sm font-medium">${t.connected}</p><p class="mt-1 text-xs text-muted">WebSocket · 24 ms</p></div></div>`
  }

  private settingsTemplate(): string {
    const t = copy[this.preferences.locale]
    const data = this.settingsData ? JSON.stringify(this.settingsData, null, 2) : 'Loading…'
    const restartConfirmation = this.restartPreview
      ? `<section class="mt-4 rounded-2xl border p-5" style="border-color:var(--warning)"><p class="text-sm font-semibold">${t.restartPreview}</p><pre class="code mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-muted">${escapeHtml(this.restartPreview)}</pre><p class="mt-3 text-sm text-muted">${t.restartHint}</p><button data-confirm-restart class="accent-bg mt-4 rounded-lg px-3 py-2 text-sm">${t.confirmRestart}</button></section>`
      : ''
    return `<div class="scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"><div class="mx-auto max-w-3xl"><p class="code text-xs tracking-[.18em] accent">CONTROL PLANE</p><h1 class="mt-2 text-3xl font-semibold tracking-tight">${t.settings}</h1><p class="mt-2 text-muted">${t.validated}</p>${this.settingsStatus ? `<p class="mt-3 text-sm" role="status">${this.settingsStatus}</p>` : ''}<section class="surface mt-7 rounded-2xl border p-5"><label class="text-sm font-semibold">settings.json<textarea data-settings-json class="code mt-3 min-h-72 w-full rounded-xl border bg-transparent p-3 text-xs" style="border-color:var(--line)">${escapeHtml(data)}</textarea></label><div class="mt-5 flex flex-wrap gap-2"><button data-save-settings class="rounded-lg border px-3 py-2 text-sm" style="border-color:var(--line)">${t.save}</button><button data-restart class="accent-bg rounded-lg px-3 py-2 text-sm">${t.restart}</button></div>${restartConfirmation}</section><section class="surface mt-4 rounded-2xl border p-5"><p class="text-sm font-semibold">${t.appearance}</p>${this.appearanceTemplate(false)}</section></div></div>`
  }

  private appearanceTemplate(compact: boolean): string {
    const t = copy[this.preferences.locale]
    const selectClass = compact ? 'mt-2 w-full' : 'mt-2 w-full text-sm'
    return `<section class="${compact ? 'mt-7 border-t pt-5' : 'mt-5'}" style="border-color:var(--line)"><p class="text-xs font-medium uppercase tracking-wider text-muted">${t.appearance}</p><label class="mt-3 block text-xs text-muted">${t.language}<select data-preference="locale" class="${selectClass} rounded-lg border bg-transparent px-2 py-2" style="border-color:var(--line)"><option value="zh-CN" ${this.preferences.locale === 'zh-CN' ? 'selected' : ''}>中文</option><option value="en" ${this.preferences.locale === 'en' ? 'selected' : ''}>English</option></select></label><label class="mt-3 block text-xs text-muted">${t.theme}<select data-preference="theme" class="${selectClass} rounded-lg border bg-transparent px-2 py-2" style="border-color:var(--line)"><option value="system" ${this.preferences.theme === 'system' ? 'selected' : ''}>${t.system}</option><option value="light" ${this.preferences.theme === 'light' ? 'selected' : ''}>${t.light}</option><option value="dark" ${this.preferences.theme === 'dark' ? 'selected' : ''}>${t.dark}</option></select></label><p class="mt-3 text-xs text-muted">${t.accent}</p><div class="mt-2 flex gap-2">${ACCENTS.map(accent => `<button data-accent="${accent}" aria-label="${accent}" class="h-6 w-6 rounded-full border-2 ${this.preferences.accent === accent ? 'border-[var(--ink)]' : 'border-transparent'}" style="background:${accent === 'cyan' ? '#18a7a2' : accent === 'emerald' ? '#28a36d' : accent === 'amber' ? '#da9027' : accent === 'rose' ? '#d95b71' : '#8772d7'}"></button>`).join('')}</div></section>`
  }

  private bindEvents(): void {
    this.querySelector<HTMLFormElement>('[data-login-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const token = this.querySelector<HTMLInputElement>('#token')?.value ?? ''
      void fetch('/api/auth/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        .then(response => {
          if (!response.ok) throw new Error('login_failed')
          this.authenticated = true
          this.loginError = ''
          this.connectWebSocket()
          void this.loadSettings()
          this.render()
        })
        .catch(() => {
          this.loginError = copy[this.preferences.locale].loginFailed
          this.render()
        })
    })
    this.querySelector<HTMLFormElement>('[data-chat-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const input = this.querySelector<HTMLTextAreaElement>('[data-chat-input]')
      const text = input?.value.trim()
      if (!text || this.socket?.readyState !== WebSocket.OPEN) return
      this.socket.send(JSON.stringify({ v: 1, type: 'message', text }))
      this.messages.push({ role: 'user', content: text })
      if (input) input.value = ''
      this.render()
    })
    this.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      event.preventDefault()
      this.querySelector<HTMLFormElement>('[data-chat-form]')?.requestSubmit()
    })
    this.querySelectorAll<HTMLButtonElement>('[data-approval]').forEach(button =>
      button.addEventListener('click', () => {
        const approvalId = button.dataset.approvalId
        const conversationId = button.dataset.conversationId
        const type = button.dataset.approval
        if (!approvalId || !conversationId || (type !== 'approve' && type !== 'reject')) return
        this.socket?.send(JSON.stringify({ v: 1, type, approvalId, conversationId }))
        this.approvals = this.approvals.filter(item => item.approvalId !== approvalId)
        this.render()
      }),
    )
    this.querySelector<HTMLButtonElement>('[data-save-settings]')?.addEventListener('click', () => {
      const raw = this.querySelector<HTMLTextAreaElement>('[data-settings-json]')?.value ?? ''
      void fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw })
        .then(response => {
          if (!response.ok) throw new Error()
          this.settingsStatus = copy[this.preferences.locale].savedRestartRequired
          this.render()
        })
        .catch(() => {
          this.settingsStatus = copy[this.preferences.locale].saveFailed
          this.render()
        })
    })
    this.querySelector<HTMLButtonElement>('[data-restart]')?.addEventListener('click', () => {
      void fetch('/api/restart')
        .then(async response => {
          if (!response.ok) throw new Error()
          const payload = (await response.json()) as { preview?: string }
          this.restartPreview = payload.preview ?? ''
          this.settingsStatus = this.restartPreview
            ? ''
            : this.preferences.locale === 'zh-CN'
              ? '无法获取重启预览。'
              : 'Could not load restart preview.'
          this.render()
        })
        .catch(() => {
          this.settingsStatus =
            this.preferences.locale === 'zh-CN' ? '无法获取重启预览。' : 'Could not load restart preview.'
          this.render()
        })
    })
    this.querySelector<HTMLButtonElement>('[data-confirm-restart]')?.addEventListener('click', () => {
      void fetch('/api/restart', { method: 'POST' })
        .then(response => {
          if (!response.ok) throw new Error()
          this.restartPreview = ''
          this.settingsStatus = this.preferences.locale === 'zh-CN' ? '已安排重启。' : 'Restart scheduled.'
          this.render()
        })
        .catch(() => {
          this.settingsStatus = this.preferences.locale === 'zh-CN' ? '重启安排失败。' : 'Could not schedule restart.'
          this.render()
        })
    })
    this.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button =>
      button.addEventListener('click', () => {
        this.currentView = button.dataset.view === 'settings' ? 'settings' : 'chat'
        if (this.currentView === 'settings') void this.loadSettings()
        this.mobilePanel = null
        this.render()
      }),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button =>
      button.addEventListener('click', () => {
        this.mobilePanel = button.dataset.panel === 'inspector' ? 'inspector' : 'sessions'
        this.render()
      }),
    )
    this.querySelectorAll<HTMLElement>('[data-close-panel]').forEach(button =>
      button.addEventListener('click', () => {
        this.mobilePanel = null
        this.render()
      }),
    )
    this.querySelectorAll<HTMLSelectElement>('[data-preference]').forEach(select =>
      select.addEventListener('change', () =>
        this.setPreference(select.dataset.preference as keyof WebUiPreferences, select.value),
      ),
    )
    this.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach(button =>
      button.addEventListener('click', () => this.setPreference('accent', button.dataset.accent ?? 'cyan')),
    )
  }

  private connectWebSocket(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${scheme}//${location.host}/ws`)
    this.socket = socket
    this.connectionState = 'connecting'
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.connectionState = 'connected'
      this.reconnectAttempts = 0
      this.render()
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.connectionState = 'disconnected'
      this.render()
      if (!this.authenticated) return
      const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempts++)
      this.reconnectTimer = window.setTimeout(() => this.connectWebSocket(), delay)
    }
    socket.onmessage = event => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string
          content?: string
          final?: boolean
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
        this.render()
      } catch {
        /* malformed server message is ignored */
      }
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) throw new Error('settings_failed')
      const payload = (await response.json()) as { settings?: Record<string, unknown> }
      this.settingsData = payload.settings ?? null
      this.settingsStatus = ''
      this.render()
    } catch {
      this.settingsStatus = copy[this.preferences.locale].settingsLoadFailed
      this.render()
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character,
  )
}

customElements.define('hub-console', HubConsole)
