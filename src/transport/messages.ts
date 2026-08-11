/** 所有 Transport 共用的静态命令文案。 */
import {
  getCommandDescription,
  getPrimaryHelpCommands,
  type CommandCatalogCategory,
  type UserLanguage,
} from '../shared'

export function getStartText(language: UserLanguage): string {
  return language === 'en'
    ? '## 👋 AI CLI Hub is ready\n\nSend a message to start a conversation. Write operations will request approval.\n\nUse `/help` to see available commands.'
    : '## 👋 AI CLI Hub 已就绪\n\n直接发送消息即可开始对话；涉及写操作时会请求授权。\n\n发送 `/help` 查看可用命令。'
}

export function getHelpText(language: UserLanguage): string {
  const section = (title: string, categories: readonly CommandCatalogCategory[]) => [
    `### ${title}`,
    ...getPrimaryHelpCommands()
      .filter(entry => categories.includes(entry.category))
      .map(entry => `- \`${entry.insertText}\` — ${getCommandDescription(entry, language)}`),
  ]
  const headings =
    language === 'en'
      ? {
          title: '## 📖 Available commands',
          general: 'General',
          sessions: 'Sessions',
          operations: 'Memory and operations',
        }
      : { title: '## 📖 可用命令', general: '常用', sessions: '会话', operations: '记忆与运维' }
  const notes =
    language === 'en'
      ? [
          '> You can also say “remember this” naturally. The hub summarizes recent user/assistant messages with the configured memory model and saves a session-derived memory; it does not send that request to the CLI.',
          '> A path passed to `/switch` is used only when that CLI has no open session. To change an existing CLI directory, run `/close`, then `/switch <cli> <path>`.',
          '> Shell pipelines and command lists run without approval only when every AST node is confirmed read-only. Mutating or unknown commands still require approval.',
          '> Images are OCRed automatically. Other files are stored without being sent to the AI; use `@read1` to read file 1, `@file1` to pass its path, or `@view1` to preview it in chat.',
        ]
      : [
          '> 也可自然地说“记住这个/记一下”。系统会用记忆模型总结当前会话最近的用户与助手消息，写入会话派生记忆；该请求不会发送给 CLI。',
          '> `/switch` 的 path 仅在目标 CLI 没有未关闭会话时生效。若要更换已有 CLI 的目录，请先执行 `/close`，再执行 `/switch <cli> <path>`。',
          '> Shell 管道和组合命令仅在 AST 的每个节点都确认只读时免审批；写操作及无法确认安全性的命令仍会请求审批。',
          '> 图片会自动 OCR；其他文件只暂存且不会告知 AI。使用 `@read1` 读取文件、`@file1` 引用路径，或用 `@view1` 在聊天中预览。',
        ]

  return [
    headings.title,
    '',
    ...section(headings.general, ['general']),
    '',
    ...section(headings.sessions, ['session']),
    '',
    ...section(headings.operations, ['memory', 'operations']),
    '',
    ...notes,
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
