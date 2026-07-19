// transport —— 客户端接入层（telegram, qq, websocket），实现 Transport 接口。
// 白名单前置丢弃；禁止依赖 core 内部与 storage（见 CLAUDE.md 依赖矩阵）。
// 见 docs/03-Interface-Contracts.md §2 / docs/07-Command-UX.md。
export { createTelegramTransport } from './telegram'
export type { TelegramTransport, TelegramTransportDeps, TelegramBotLike } from './telegram'
export { createQQTransport } from './qq'
export type { QQTransport, QQTransportDeps, QQBotClient } from './qq'
export { createHttpTransport } from './http'
export { createHttpRequestHandler } from './http'
export type { HttpConversationTarget, HttpRequestHandler, HttpTransport, HttpTransportDeps } from './http'
export { getHelpText, getStartText } from './messages'
export { sanitizeFileName, withTimeout } from './utils'
