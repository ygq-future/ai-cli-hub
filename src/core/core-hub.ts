/**
 * CoreHub —— 核心调度中心，装配 SessionManager + Auth + MessageRouter。
 *
 * 是 Composition Root 注入依赖后的调用入口，不依赖具体 Transport/Adapter/Storage。
 * docs/02-Architecture.md §3.2。
 */
import type { AppConfig } from '../config'
import type { EventBus } from '../event'
import type { Repositories } from '../repository'
import type { CliType, MessageRef, Platform, UserLanguage } from '../shared'
import { createAuth, type Auth } from './auth'
import { createCommandRouter, type CommandRouter } from './commands'
import { createSessionManager, type SessionManager } from './session-manager'
import { createMessageRouter, type MessageRouter, type MessageHandler } from './message-router'

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
  handler?: MessageHandler
  commandRouter?: CommandRouter
  getUserLanguage?: (platform: Platform, userId: string) => Promise<UserLanguage> | UserLanguage
  getUserTarget?: (platform: Platform, userId: string) => Promise<{ cli: CliType; cwd: string }>
  getCwdForCli?: (platform: Platform, userId: string, cli: CliType) => Promise<string>
  setUserTarget?: (platform: Platform, userId: string, target: { cli: CliType; cwd: string }) => Promise<void>
  getAutoApproveEnabled?: (platform: Platform, userId: string) => Promise<boolean>
  setAutoApproveEnabled?: (platform: Platform, userId: string, enabled: boolean) => Promise<void>
  refreshEnvironmentSnapshot?: () => Promise<void>
  getHealthReport?: () => Promise<string>
  getUpdatePreview?: () => string
  performUpdate?: (ref: MessageRef) => Promise<string>
  getRestartPreview?: () => string
  performRestart?: (ref: MessageRef) => Promise<string>
  resolveCwd?: (
    cwd: string,
  ) =>
    | Promise<{ ok: true; cwd: string } | { ok: false; message: string }>
    | { ok: true; cwd: string }
    | { ok: false; message: string }
}

export function createCoreHub(opts: CoreHubOptions): CoreHub {
  const { bus, repos, config } = opts

  // Auth：白名单纵深防御
  const auth = createAuth(config.WHITELIST_USER_IDS)

  // SessionManager：会话生命周期
  const sessionManager = createSessionManager(bus, repos, config.SESSION_ARCHIVE_DAYS, opts.getUserTarget)

  const commandRouter =
    opts.commandRouter ??
    createCommandRouter({
      bus,
      repos,
      sessionManager,
      getUserLanguage: opts.getUserLanguage,
      getUserTarget: opts.getUserTarget,
      getCwdForCli: opts.getCwdForCli,
      setUserTarget: opts.setUserTarget,
      getAutoApproveEnabled: opts.getAutoApproveEnabled,
      setAutoApproveEnabled: opts.setAutoApproveEnabled,
      resolveCwd: opts.resolveCwd,
      refreshEnvironmentSnapshot: opts.refreshEnvironmentSnapshot,
      getHealthReport: opts.getHealthReport,
      getUpdatePreview: opts.getUpdatePreview,
      performUpdate: opts.performUpdate,
      getRestartPreview: opts.getRestartPreview,
      performRestart: opts.performRestart,
    })

  // MessageRouter：消息路由 + handler 处理（M6 由 orchestrator 注入真实 adapter 驱动）
  const messageRouter = createMessageRouter(
    bus,
    repos,
    sessionManager,
    commandRouter,
    opts.handler,
    opts.getUserLanguage,
    config.MEMORY_REQUESTED_SUMMARY_MESSAGE_LIMIT,
  )

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
