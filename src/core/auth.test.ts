import { describe, expect, test } from 'bun:test'
import { createAuth } from './auth'
import type { AuthResult } from './auth'

function isDenied(r: AuthResult): r is { allowed: false; reason: string } {
  return !r.allowed
}

describe('createAuth', () => {
  test('白名单用户通过校验', () => {
    const auth = createAuth(['user-1', 'user-2'])
    expect(auth.check('user-1')).toEqual({ allowed: true })
    expect(auth.check('user-2')).toEqual({ allowed: true })
  })

  test('非白名单用户被拒绝', () => {
    const auth = createAuth(['user-1'])
    const result = auth.check('user-3')
    if (isDenied(result)) {
      expect(result.reason).toContain('不在白名单中')
    } else {
      expect.unreachable('should be denied')
    }
  })

  test('空白名单拒绝所有请求（fail-closed）', () => {
    const auth = createAuth([])
    const result = auth.check('user-1')
    if (isDenied(result)) {
      expect(result.reason).toContain('白名单为空')
    } else {
      expect.unreachable('should be denied')
    }
  })

  test('多个白名单用户都可通行', () => {
    const auth = createAuth(['alice', 'bob', 'charlie'])
    expect(auth.check('alice').allowed).toBe(true)
    expect(auth.check('bob').allowed).toBe(true)
    expect(auth.check('charlie').allowed).toBe(true)
    expect(auth.check('dave').allowed).toBe(false)
  })

  test('空字符串用户不自动通过（不存在于白名单）', () => {
    const auth = createAuth(['valid-user'])
    expect(auth.check('').allowed).toBe(false)
  })

  test('大小写敏感', () => {
    const auth = createAuth(['User-1'])
    expect(auth.check('User-1').allowed).toBe(true)
    expect(auth.check('user-1').allowed).toBe(false)
  })
})
