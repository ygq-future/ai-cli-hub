import pino, { type Logger } from 'pino'

export type { Logger }
export { attachEventLogger } from './event-logger'

export interface LoggerOptions {
  level?: string
  /** 开发环境下用 pino-pretty 美化输出；生产设为 false 输出 JSON。 */
  pretty?: boolean
}

/**
 * 全局日志工厂（Pino）。level/pretty 由调用方（main → config）注入，
 * 本模块不读 process.env（见 CLAUDE.md：唯一读 env 的地方是 config/）。
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { level = 'info', pretty = true } = opts
  return pino(
    pretty
      ? {
          level,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : { level },
  )
}
