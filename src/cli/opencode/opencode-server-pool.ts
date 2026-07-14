import type { Config, OpencodeClient } from '@opencode-ai/sdk'

export type CreateOpenCodeFn = (options?: { signal?: AbortSignal; config?: Config }) => Promise<{
  client: OpencodeClient
  server: {
    url: string
    close(): void
  }
}>

export interface OpenCodeServerLease {
  client: OpencodeClient
  release(): Promise<void>
}

export interface OpenCodeServerPool {
  acquire(config: Config): Promise<OpenCodeServerLease>
  close(): Promise<void>
}

export interface OpenCodeServerPoolDeps {
  createOpencodeFn?: CreateOpenCodeFn
}

/**
 * `@opencode-ai/sdk` 固定以 4096 端口拉起 server；多个 adapter 必须共享同一实例。
 * 每个 adapter 通过独立 lease 持有自身 session，最后一个 lease 释放才关闭 server。
 */
export function createOpenCodeServerPool(deps?: OpenCodeServerPoolDeps): OpenCodeServerPool {
  const createOpencodeFn = deps?.createOpencodeFn ?? defaultCreateOpencode
  let instance: Awaited<ReturnType<CreateOpenCodeFn>> | null = null
  let starting: Promise<Awaited<ReturnType<CreateOpenCodeFn>>> | null = null
  let leases = 0

  async function acquire(config: Config): Promise<OpenCodeServerLease> {
    const active = instance ?? (starting ??= createOpencodeFn({ config }))
    try {
      const created = await active
      instance = created
      leases += 1
      let released = false
      return {
        client: created.client,
        async release() {
          if (released) return
          released = true
          leases = Math.max(0, leases - 1)
          if (leases !== 0 || instance !== created) return
          instance = null
          created.server.close()
        },
      }
    } finally {
      if (starting === active) starting = null
    }
  }

  return {
    acquire,
    async close() {
      const active = instance ?? (starting ? await starting : null)
      starting = null
      instance = null
      leases = 0
      active?.server.close()
    },
  }
}

async function defaultCreateOpencode(options?: Parameters<CreateOpenCodeFn>[0]): ReturnType<CreateOpenCodeFn> {
  const sdk = await import('@opencode-ai/sdk')
  return sdk.createOpencode(options)
}
