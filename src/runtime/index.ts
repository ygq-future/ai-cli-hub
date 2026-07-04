// runtime —— PTY 家族底层字节容器（node-pty），SDK 家族不经此层。
// 契约见 docs/03-Interface-Contracts.md §3.2，家族划分见决策 D11。
export type { PtyRuntime, NodePtyOptions } from './types'
export { createPtyRuntime } from './node-pty-runtime'
