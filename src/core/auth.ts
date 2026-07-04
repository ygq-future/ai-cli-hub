/**
 * Auth —— 白名单二次校验（纵深防御，docs/02-Architecture.md §8）。
 *
 * Transport 层已做前置拦截，此处为 Core 内的二次校验。
 * Fail-closed：空白名单或非白名单用户均拒绝。
 */
export interface Auth {
  /** 校验用户是否在白名单中。 */
  check(userId: string): AuthResult
}

export type AuthResult = { allowed: true } | { allowed: false; reason: string }

/**
 * 创建 Auth 实例。
 * @param whitelist 白名单用户 ID 数组。空数组即拒绝一切。
 */
export function createAuth(whitelist: string[]): Auth {
  // 使用 Set 加速查找
  const allowed = new Set(whitelist)

  return {
    check(userId: string): AuthResult {
      if (whitelist.length === 0) {
        return { allowed: false, reason: '白名单为空，拒绝所有请求' }
      }
      if (!allowed.has(userId)) {
        return { allowed: false, reason: `用户 ${userId} 不在白名单中` }
      }
      return { allowed: true }
    },
  }
}
