// config —— 唯一读取 process.env 的模块（Zod 强类型 + fail-fast）。
// 契约见 docs/03-Interface-Contracts.md §6。
export { ConfigSchema, loadConfig, normalizeProxyEnvironment } from './schema'
export type { AppConfig, ConfigSource } from './schema'
