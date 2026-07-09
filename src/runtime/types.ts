/**
 * PtyRuntime —— PTY 家族内部字节容器。
 *
 * ⚠️ 仅 PTY 家族（无 SDK 的 CLI）使用。SDK 家族的 Adapter 既不实现也不使用它。
 * docs/03-Interface-Contracts.md §3.2
 */
import type { SpawnOptions } from '../cli'
import type { Unsubscribe } from '../shared'

export interface PtyRuntime {
  spawn(opts: SpawnOptions): Promise<void>
  write(data: string): void // 注入字节，含 "y\r" / "n\r"
  kill(signal?: string): void
  resize(cols: number, rows: number): void
  onData(handler: (chunk: string) => void): Unsubscribe // 裸字节流（含 ANSI）
  onExit(handler: (code: number | null) => void): Unsubscribe
}

export interface NodePtyOptions {
  /** PTY 家族空闲超时，超时自动 kill */
  idleTimeoutMs: number
}
