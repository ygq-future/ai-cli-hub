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
      '- `/new [cli] [cwd]` — Start a new session.',
      '- `/cwd [path]` — Show or change the working directory.',
      '- `/close` — Close the current session.',
      '- `/status` — Show the current session status.',
      '- `/sessions` — List recent sessions.',
      '',
      '### Memory and operations',
      '- `/audit [conversationId]` — View approval audit records.',
      '- `/remember <text>` — Save a long-term memory.',
      '- `/memory` — View long-term memories.',
      '- `/forget <memoryId>` — Delete a long-term memory.',
      '- `/env` — Refresh and view the environment snapshot.',
      '- `/health` — Run a service health check.',
      '- `/update` — Preview self-update; `/update confirm` executes it.',
      '- `/restart` — Preview restart; `/restart confirm` executes it.',
      '- `/lang zh|en` — Change the reply language.',
      '',
      '> Send text, emoji, stickers, images, or files to chat. Attachments are used only as text context and are never executed.',
    ].join('\n')
  }

  return [
    '## 📖 可用命令',
    '',
    '### 会话',
    '- `/new [cli] [cwd]` — 开启新会话，可指定 CLI 和工作目录。',
    '- `/cwd [path]` — 查看或切换工作目录。',
    '- `/close` — 关闭当前会话。',
    '- `/status` — 查看当前会话状态。',
    '- `/sessions` — 查看最近会话。',
    '',
    '### 记忆与运维',
    '- `/audit [conversationId]` — 查看审批审计。',
    '- `/remember <text>` — 写入长期记忆。',
    '- `/memory` — 查看长期记忆。',
    '- `/forget <memoryId>` — 删除长期记忆。',
    '- `/env` — 刷新并查看环境快照。',
    '- `/health` — 执行服务健康检查。',
    '- `/update` — 查看自更新计划；`/update confirm` 执行。',
    '- `/restart` — 查看重启计划；`/restart confirm` 执行。',
    '- `/lang zh|en` — 切换回复语言。',
    '',
    '> 直接发送文本、emoji、sticker、图片或文件即可对话；附件只作为文本上下文，不会执行。',
  ].join('\n')
}
