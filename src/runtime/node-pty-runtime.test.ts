import { describe, expect, test } from 'bun:test'
import type { IPty } from 'node-pty'
import { createPtyRuntime, type SpawnFn } from './node-pty-runtime'
import type { SpawnOptions } from '../cli/base'

const SPAWN: SpawnOptions = { conversationId: 'c1' as SpawnOptions['conversationId'], cwd: '/tmp', cols: 80, rows: 24 }

/** 假 IPty：手动触发 data / exit，记录 write/kill/resize 调用。 */
function createFakePty() {
  let dataCb: ((s: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const calls = { write: [] as string[], kill: 0, resize: [] as [number, number][] }

  const pty = {
    onData(cb: (s: string) => void) {
      dataCb = cb
    },
    onExit(cb: (e: { exitCode: number }) => void) {
      exitCb = cb
    },
    write(d: string) {
      calls.write.push(d)
    },
    kill() {
      calls.kill++
    },
    resize(c: number, r: number) {
      calls.resize.push([c, r])
    },
  } as unknown as IPty

  return {
    pty,
    calls,
    emitData: (s: string) => dataCb?.(s),
    emitExit: (code: number) => exitCb?.({ exitCode: code }),
  }
}

describe('NodePtyRuntime', () => {
  test('spawn 后 onData 转发字节流', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    const chunks: string[] = []
    rt.onData(c => chunks.push(c))

    await rt.spawn(SPAWN)
    fake.emitData('\x1b[32mhello\x1b[0m')
    fake.emitData('world')

    expect(chunks).toEqual(['\x1b[32mhello\x1b[0m', 'world'])
  })

  test('onExit 转发退出码', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    const exits: (number | null)[] = []
    rt.onExit(c => exits.push(c))

    await rt.spawn(SPAWN)
    fake.emitExit(0)

    expect(exits).toEqual([0])
  })

  test('write / resize 透传', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    await rt.spawn(SPAWN)

    rt.write('y\r')
    rt.resize(120, 40)

    expect(fake.calls.write).toEqual(['y\r'])
    expect(fake.calls.resize).toEqual([[120, 40]])
  })

  test('未 spawn 时 write / resize 抛错', () => {
    const rt = createPtyRuntime({ idleTimeoutMs: 0 })
    expect(() => rt.write('x')).toThrow('not spawned')
    expect(() => rt.resize(1, 1)).toThrow('not spawned')
  })

  test('重复 spawn 抛错', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    await rt.spawn(SPAWN)
    await expect(rt.spawn(SPAWN)).rejects.toThrow('already spawned')
  })

  test('kill 调用底层 kill', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    await rt.spawn(SPAWN)
    rt.kill()
    expect(fake.calls.kill).toBe(1)
  })

  test('空闲超时自动 kill', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 20 })
    await rt.spawn(SPAWN)
    expect(fake.calls.kill).toBe(0)
    await new Promise(r => setTimeout(r, 40))
    expect(fake.calls.kill).toBe(1)
  })

  test('退订句柄移除 handler', async () => {
    const fake = createFakePty()
    const rt = createPtyRuntime({ spawnFn: (() => fake.pty) as unknown as SpawnFn, idleTimeoutMs: 0 })
    const chunks: string[] = []
    const unsub = rt.onData(c => chunks.push(c))
    await rt.spawn(SPAWN)

    unsub()
    fake.emitData('ignored')
    expect(chunks).toEqual([])
  })
})
