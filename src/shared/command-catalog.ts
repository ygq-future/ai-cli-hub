import type { UserLanguage } from './types/common'

export type CommandCatalogCategory = 'general' | 'session' | 'memory' | 'operations'

export interface CommandCatalogEntry {
  id: string
  category: CommandCatalogCategory
  command: string
  insertText: string
  description: Readonly<{ zh: string; en: string }>
  keywords: Readonly<{ zh: readonly string[]; en: readonly string[] }>
  primaryHelp: boolean
}

export const COMMAND_CATALOG = [
  {
    id: 'start',
    category: 'general',
    command: '/start',
    insertText: '/start',
    description: { zh: '显示欢迎信息和使用入口。', en: 'Show the welcome message and usage entry points.' },
    keywords: { zh: ['开始', '欢迎', '首页'], en: ['start', 'welcome', 'home'] },
    primaryHelp: true,
  },
  {
    id: 'help',
    category: 'general',
    command: '/help',
    insertText: '/help',
    description: { zh: '查看所有可用命令和文件指令。', en: 'Show all commands and file directives.' },
    keywords: { zh: ['帮助', '命令', '指令'], en: ['help', 'commands', 'guide'] },
    primaryHelp: true,
  },
  {
    id: 'chatid',
    category: 'session',
    command: '/chatid',
    insertText: '/chatid',
    description: { zh: '查看当前平台 Chat ID。', en: 'Show the current platform chat ID.' },
    keywords: { zh: ['聊天编号', '平台编号', '会话标识'], en: ['chat id', 'platform id', 'identifier'] },
    primaryHelp: true,
  },
  {
    id: 'switch',
    category: 'session',
    command: '/switch',
    insertText: '/switch <cli> [path]',
    description: {
      zh: '切换或创建指定 CLI 会话，可指定工作目录。',
      en: 'Switch to or create a CLI session with an optional directory.',
    },
    keywords: { zh: ['切换', '命令行', '工作目录', '路径'], en: ['switch', 'cli', 'directory', 'path'] },
    primaryHelp: true,
  },
  {
    id: 'model',
    category: 'session',
    command: '/model',
    insertText: '/model [model_name|model_id]',
    description: { zh: '列出可用模型，或按名称、ID 更换模型。', en: 'List models or change one by name or ID.' },
    keywords: { zh: ['模型', '更换模型', '选择模型'], en: ['model', 'change model', 'select model'] },
    primaryHelp: true,
  },
  {
    id: 'close',
    category: 'session',
    command: '/close',
    insertText: '/close',
    description: { zh: '关闭当前 CLI 会话。', en: 'Close the current CLI session.' },
    keywords: { zh: ['关闭', '结束', '会话'], en: ['close', 'end', 'session'] },
    primaryHelp: true,
  },
  {
    id: 'status',
    category: 'session',
    command: '/status',
    insertText: '/status',
    description: {
      zh: '查看当前会话、模型和自动审批状态。',
      en: 'Show the current session, model, and auto-approval state.',
    },
    keywords: { zh: ['状态', '会话详情', '运行'], en: ['status', 'session details', 'running'] },
    primaryHelp: true,
  },
  {
    id: 'sessions',
    category: 'session',
    command: '/sessions',
    insertText: '/sessions',
    description: { zh: '列出当前用户的近期会话。', en: 'List recent sessions for the current user.' },
    keywords: { zh: ['会话列表', '历史会话', '最近'], en: ['sessions', 'history', 'recent'] },
    primaryHelp: true,
  },
  {
    id: 'clear',
    category: 'session',
    command: '/clear',
    insertText: '/clear',
    description: {
      zh: '清空消息、暂存文件和 CLI 上下文，不关闭会话。',
      en: 'Clear messages, staged files, and CLI context without closing.',
    },
    keywords: { zh: ['清空', '上下文', '消息'], en: ['clear', 'context', 'messages'] },
    primaryHelp: true,
  },
  {
    id: 'reset',
    category: 'session',
    command: '/reset',
    insertText: '/reset',
    description: {
      zh: '清空当前会话并恢复用户和 CLI 默认偏好。',
      en: 'Clear the session and restore default user and CLI preferences.',
    },
    keywords: { zh: ['重置', '恢复默认', '偏好'], en: ['reset', 'defaults', 'preferences'] },
    primaryHelp: true,
  },
  {
    id: 'audit',
    category: 'operations',
    command: '/audit',
    insertText: '/audit [conversationId]',
    description: {
      zh: '查看当前或指定会话的审批审计记录。',
      en: 'View approval audit records for the current or specified session.',
    },
    keywords: { zh: ['审计', '审批历史', '授权'], en: ['audit', 'approval history', 'authorization'] },
    primaryHelp: true,
  },
  {
    id: 'file',
    category: 'operations',
    command: '/file',
    insertText: '/file [limit] [keyword]',
    description: {
      zh: '列出当前会话文件，可限制数量或按文件名筛选。',
      en: 'List session files with an optional limit and filename filter.',
    },
    keywords: { zh: ['文件', '附件', '查找文件'], en: ['file', 'attachment', 'find file'] },
    primaryHelp: true,
  },
  {
    id: 'autoapprove',
    category: 'operations',
    command: '/autoapprove',
    insertText: '/autoapprove [on|off] [seconds]',
    description: {
      zh: '查看、开启或关闭自动审批并设置倒计时。',
      en: 'View, enable, or disable auto-approval and its countdown.',
    },
    keywords: { zh: ['自动审批', '自动授权', '倒计时'], en: ['auto approve', 'automatic approval', 'countdown'] },
    primaryHelp: true,
  },
  {
    id: 'remember',
    category: 'memory',
    command: '/remember',
    insertText: '/remember <text>',
    description: { zh: '写入一条实例级长期记忆。', en: 'Save an instance-wide long-term memory.' },
    keywords: { zh: ['记住', '长期记忆', '保存记忆'], en: ['remember', 'long-term memory', 'save memory'] },
    primaryHelp: true,
  },
  {
    id: 'memory',
    category: 'memory',
    command: '/memory',
    insertText: '/memory',
    description: { zh: '查看实例级长期记忆。', en: 'View instance-wide long-term memories.' },
    keywords: { zh: ['记忆', '记忆列表', '长期'], en: ['memory', 'memory list', 'long term'] },
    primaryHelp: true,
  },
  {
    id: 'forget',
    category: 'memory',
    command: '/forget',
    insertText: '/forget <memoryId>',
    description: { zh: '按记忆 ID 删除一条长期记忆。', en: 'Delete a long-term memory by ID.' },
    keywords: { zh: ['忘记', '删除记忆', '记忆编号'], en: ['forget', 'delete memory', 'memory id'] },
    primaryHelp: true,
  },
  {
    id: 'env',
    category: 'operations',
    command: '/env',
    insertText: '/env',
    description: { zh: '刷新并查看服务器环境快照。', en: 'Refresh and show the server environment snapshot.' },
    keywords: { zh: ['环境', '服务器', '运行时'], en: ['environment', 'server', 'runtime'] },
    primaryHelp: true,
  },
  {
    id: 'health',
    category: 'operations',
    command: '/health',
    insertText: '/health',
    description: { zh: '执行数据库、目录和 CLI 健康检查。', en: 'Run database, directory, and CLI health checks.' },
    keywords: { zh: ['健康检查', '自检', '服务状态'], en: ['health', 'self check', 'service status'] },
    primaryHelp: true,
  },
  {
    id: 'update',
    category: 'operations',
    command: '/update',
    insertText: '/update',
    description: {
      zh: '预览受控自更新计划；使用 /update confirm 执行。',
      en: 'Preview the controlled self-update plan; use /update confirm to execute.',
    },
    keywords: { zh: ['更新', '升级', '拉取代码'], en: ['update', 'upgrade', 'pull code'] },
    primaryHelp: true,
  },
  {
    id: 'update-confirm',
    category: 'operations',
    command: '/update confirm',
    insertText: '/update confirm',
    description: { zh: '确认执行受控自更新。', en: 'Confirm and execute the controlled self-update.' },
    keywords: { zh: ['确认更新', '执行更新', '升级'], en: ['confirm update', 'execute update', 'upgrade'] },
    primaryHelp: false,
  },
  {
    id: 'restart',
    category: 'operations',
    command: '/restart',
    insertText: '/restart',
    description: {
      zh: '预览服务重启计划；使用 /restart confirm 执行。',
      en: 'Preview the service restart plan; use /restart confirm to execute.',
    },
    keywords: { zh: ['重启', '重新启动', '服务'], en: ['restart', 'reboot', 'service'] },
    primaryHelp: true,
  },
  {
    id: 'restart-confirm',
    category: 'operations',
    command: '/restart confirm',
    insertText: '/restart confirm',
    description: { zh: '确认执行服务重启。', en: 'Confirm and execute the service restart.' },
    keywords: { zh: ['确认重启', '执行重启', '重新启动'], en: ['confirm restart', 'execute restart', 'reboot'] },
    primaryHelp: false,
  },
  {
    id: 'lang',
    category: 'general',
    command: '/lang',
    insertText: '/lang <zh|en>',
    description: { zh: '切换系统和 AI 回复语言。', en: 'Change the system and AI reply language.' },
    keywords: { zh: ['语言', '中文', '英文'], en: ['language', 'chinese', 'english'] },
    primaryHelp: true,
  },
] as const satisfies readonly CommandCatalogEntry[]

export function getCommandDescription(entry: CommandCatalogEntry, language: UserLanguage): string {
  return entry.description[language]
}

export function getPrimaryHelpCommands(): readonly CommandCatalogEntry[] {
  return COMMAND_CATALOG.filter(entry => entry.primaryHelp)
}
