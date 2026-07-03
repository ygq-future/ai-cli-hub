// transport —— 客户端接入层（telegram, qq, websocket），实现 Transport 接口。
// 白名单前置丢弃；禁止依赖 core 内部与 storage（见 CLAUDE.md 依赖矩阵）。
// TODO(M6): TelegramTransport。见 docs/03-Interface-Contracts.md §2 / docs/07-Command-UX.md。
export {}
