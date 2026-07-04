/**
 * CoreHub —— 核心调度中心，装配 SessionManager + Auth + MessageRouter。
 *
 * 是 Composition Root 注入依赖后的调用入口，不依赖具体 Transport/Adapter/Storage。
 * docs/02-Architecture.md §3.2。
 */
import type { AppConfig } from '../config'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import { createAuth, type Auth } from './auth'
import { createSessionManager, type SessionManager } from './session-manager'
import { createMessageRouter, type MessageRouter, type MockHandler } from './message-router'

export interface CoreHub {
  auth: Auth
  sessionManager: SessionManager
  messageRouter: MessageRouter
  destroy(): void
}

export interface CoreHubOptions {
  bus: EventBus
  repos: Repositories
  config: AppConfig
  mockHandler?: MockHandler
}

export function createCoreHub(opts: CoreHubOptions): CoreHub {
  const { bus, repos, config } = opts

  // Auth：白名单纵深防御
  const auth = createAuth(config.WHITELIST_USER_IDS)

  // SessionManager：会话生命周期
  const sessionManager = createSessionManager(bus, repos, config.SESSION_ARCHIVE_DAYS)

  // MessageRouter：消息路由 + MockHandler 处理
  const messageRouter = createMessageRouter(bus, repos, sessionManager, opts.mockHandler)

  return {
    auth,
    sessionManager,
    messageRouter,
    destroy() {
      messageRouter.destroy()
      sessionManager.destroy()
    },
  }
}
