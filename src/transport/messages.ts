/** 所有 Transport 共用的静态命令文案。 */
import type { UserLanguage } from '../shared'

export function getStartText(language: UserLanguage): string {
  return language === 'en'
    ? '## 👋 AI CLI Hub is ready\n\nSend a message to start a conversation. Write operations will request approval.\n\nUse `/help` to see available commands.'
    : '## 👋 AI CLI Hub 已就绪\n\n直接发送消息即可开始对话；涉及写操作时会请求授权。\n\n发送 `/help` 查看可用命令。'
}

export function getHelpText(language: UserLanguage): string {
  if (language === 'en') {
    return [
      '## 📖 Available commands',
      '',
      '### Sessions',
      '- `/switch <cli> [path]` — Resume that CLI session, or create one with its saved/default directory.',
      '- `/cwd [path]` — Change the active session CLI working directory.',
      '- `/cwd <cli> <path>` — Save a CLI directory when no session is active.',
      '- `/close` — Close the current session.',
      '- `/status` — Show the current session status.',
      '- `/sessions` — List recent sessions.',
      '',
      '### Memory and operations',
      '- `/audit [conversationId]` — View approval audit records.',
      '- `/autoapprove on|off [seconds]` — Persist automatic approval and its 1–300 second countdown; omitted seconds reset to 5.',
      '- `/remember <text>` — Save a long-term memory.',
      '- `/memory` — View long-term memories.',
      '- `/forget <memoryId>` — Delete a long-term memory.',
      '- `/env` — Refresh and view the environment snapshot.',
      '- `/health` — Run a service health check.',
      '- `/update` — Preview self-update; `/update confirm` executes it.',
      '- `/restart` — Preview restart; `/restart confirm` executes it.',
      '- `/lang zh|en` — Change the reply language.',
      '',
      '> You can also say “remember this” naturally. The hub summarizes recent user/assistant messages with the configured memory model and saves a session-derived memory; it does not send that request to the CLI.',
      '> Shell pipelines and command lists run without approval only when every AST node is confirmed read-only. Mutating or unknown commands still require approval.',
      '> Send text, emoji, stickers, images, or files to chat. Attachments are used only as text context and are never executed.',
    ].join('\n')
  }

  return [
    '## 📖 可用命令',
    '',
    '### 会话',
    '- `/switch <cli> [path]` — 恢复该 CLI 的会话；不存在时按已保存/指定目录创建。',
    '- `/cwd [path]` — 切换当前活跃会话 CLI 的工作目录。',
    '- `/cwd <cli> <path>` — 没有活跃会话时，保存指定 CLI 的工作目录。',
    '- `/close` — 关闭当前会话。',
    '- `/status` — 查看当前会话状态。',
    '- `/sessions` — 查看最近会话。',
    '',
    '### 记忆与运维',
    '- `/audit [conversationId]` — 查看审批审计。',
    '- `/autoapprove on|off [seconds]` — 持久化自动审批及 1–300 秒倒计时；省略秒数时重置为 5 秒。',
    '- `/remember <text>` — 写入长期记忆。',
    '- `/memory` — 查看长期记忆。',
    '- `/forget <memoryId>` — 删除长期记忆。',
    '- `/env` — 刷新并查看环境快照。',
    '- `/health` — 执行服务健康检查。',
    '- `/update` — 查看自更新计划；`/update confirm` 执行。',
    '- `/restart` — 查看重启计划；`/restart confirm` 执行。',
    '- `/lang zh|en` — 切换回复语言。',
    '',
    '> 也可自然地说“记住这个/记一下”。系统会用记忆模型总结当前会话最近的用户与助手消息，写入会话派生记忆；该请求不会发送给 CLI。',
    '> Shell 管道和组合命令仅在 AST 的每个节点都确认只读时免审批；写操作及无法确认安全性的命令仍会请求审批。',
    '> 直接发送文本、emoji、sticker、图片或文件即可对话；附件只作为文本上下文，不会执行。',
  ].join('\n')
}

export function getLanguageUsageText(language: UserLanguage): string {
  return language === 'en'
    ? '## ❌ Invalid language\n\nUse `/lang zh` or `/lang en`.'
    : '## ❌ 语言参数无效\n\n请使用 `/lang zh` 或 `/lang en`。'
}

export function getLanguageChangedText(language: UserLanguage): string {
  return language === 'en'
    ? '## 🌐 Language updated\n\nFuture system and AI replies will use English.'
    : '## 🌐 语言已更新\n\n后续系统回复和 AI 回复将使用中文。'
}
