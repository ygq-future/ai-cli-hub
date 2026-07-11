// config —— 唯一读取配置的模块（settings.json → Zod 强类型 + fail-fast）。
// 契约见 docs/03-Interface-Contracts.md §6。
export { loadConfig, SettingsJsonSchema } from './schema'
export type { AppConfig, SettingsJson } from './schema'
