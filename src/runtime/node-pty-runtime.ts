/**
 * NodePtyRuntime —— node-pty 实现的 PtyRuntime。
 *
 * 职责：
 *  - spawn node-pty 进程
 *  - 数据输出触发 onData 回调（含 ANSI）
 *  - 进程退出触发 onExit 回调
 *  - 空闲超时自动 kill（idleTimeoutMs）
 *  - resize / write 透传
 *
 * 依赖矩阵：runtime/ 允许依赖 cli/base（SpawnOptions）和 shared/。
 */
import type { IPty } from 'node-pty'
import { spawn as nodePtySpawn } from 'node-pty'
import type { NodePtyOptions, PtyRuntime } from './types'

/** node-pty spawn 签名（可注入，便于测试）。 */
export type SpawnFn = typeof nodePtySpawn

/** 默认 shell：Windows 用 powershell.exe，其余用 bash */
function defaultShell(): string {
  if (typeof process !== 'undefined' && process.platform === 'win32') {
    return 'powershell.exe'
  }
  return 'bash'
}

export function createPtyRuntime(opts?: NodePtyOptions & { spawnFn?: SpawnFn }): PtyRuntime {
  const spawn = opts?.spawnFn ?? nodePtySpawn
  let pty: IPty | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 300_000

  const dataHandlers: Array<(chunk: string) => void> = []
  const exitHandlers: Array<(code: number | null) => void> = []

  function resetIdleTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (pty && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        pty?.kill()
      }, idleTimeoutMs)
    }
  }

  return {
    async spawn(opts_) {
      if (pty) throw new Error('PtyRuntime: already spawned')

      pty = spawn(defaultShell(), [], {
        name: 'xterm-256color',
        cols: opts_.cols ?? 80,
        rows: opts_.rows ?? 24,
        cwd: opts_.cwd,
        // env 省略时 node-pty 继承 process.env（读 env 只允许在 config/，见 CLAUDE.md §5）
        ...(opts_.env ? { env: opts_.env } : {}),
      })

      pty.onData((chunk: string) => {
        resetIdleTimer()
        for (const h of dataHandlers) h(chunk)
      })

      pty.onExit(({ exitCode }) => {
        if (idleTimer !== null) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
        for (const h of exitHandlers) h(exitCode)
        pty = null
      })

      resetIdleTimer()
    },

    write(data: string) {
      if (!pty) throw new Error('PtyRuntime: not spawned')
      pty.write(data)
      resetIdleTimer()
    },

    kill(signal?: string) {
      if (pty) {
        pty.kill(signal)
        pty = null
      }
    },

    resize(cols: number, rows: number) {
      if (!pty) throw new Error('PtyRuntime: not spawned')
      pty.resize(cols, rows)
    },

    onData(handler: (chunk: string) => void) {
      dataHandlers.push(handler)
      return () => {
        const idx = dataHandlers.indexOf(handler)
        if (idx >= 0) dataHandlers.splice(idx, 1)
      }
    },

    onExit(handler: (code: number | null) => void) {
      exitHandlers.push(handler)
      return () => {
        const idx = exitHandlers.indexOf(handler)
        if (idx >= 0) exitHandlers.splice(idx, 1)
      }
    },
  }
}
