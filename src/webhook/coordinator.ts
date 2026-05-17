/**
 * Module-level singleton that owns the webhook HTTP server lifecycle for the
 * whole extension. Lives from `activate()` to window close, so PR callbacks
 * keep arriving even when the Kanban panel is closed.
 *
 * Ownership moved here from `KanbanWebviewPanel` so that closing the panel
 * (or switching focus away from it) no longer cancels in-flight implement
 * flows. The panel only registers itself as the "active panel" for refresh
 * callbacks while it's open.
 */

import type { ExtensionContext } from 'vscode'
import { env, Uri, window } from 'vscode'
import { getToken } from '../auth/secrets'
import { deleteWebhook } from '../gitea/api'
import { mergeStateJsonComment } from '../gitea/stateJson'
import { logger } from '../logging/logger'
import { getSettings } from '../settings/store'
import type { KanbanWebviewPanel } from '../panel/KanbanPanel'
import type { WebhookEvent } from './server'
import { WebhookServer } from './server'

/**
 * workspaceState key for persisting in-flight webhook registrations across
 * VS Code reloads. Kept on workspaceState (not globalState) because the
 * gitea hooks are repo-scoped, which is workspace-scoped.
 */
const PENDING_HOOKS_KEY = 'superpowers.pendingHooks'

export interface PendingHook {
  hookId: number
  host: string
  owner: string
  repo: string
  feature: string
}

class WebhookCoordinator {
  private ctx?: ExtensionContext
  private server?: WebhookServer
  private pendingHooks = new Map<number, PendingHook>()
  private activePanel: KanbanWebviewPanel | undefined
  private initialized = false
  private eventSubscription?: { dispose: () => void }

  /** Called once from extension.ts activate(). Idempotent. */
  init(ctx: ExtensionContext): void {
    if (this.initialized) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: 'coordinator.init 重复调用，忽略',
      })
      return
    }
    this.initialized = true
    this.ctx = ctx
    logger.add({
      level: 'info',
      source: 'webhook',
      message: 'coordinator 初始化中',
    })

    // Restore pending webhook registrations from workspaceState.
    const stored = ctx.workspaceState.get<Record<string, PendingHook>>(PENDING_HOOKS_KEY) ?? {}
    for (const [k, v] of Object.entries(stored)) {
      const n = Number(k)
      if (Number.isFinite(n) && v && typeof v === 'object')
        this.pendingHooks.set(n, v)
    }

    this.server = new WebhookServer()
    this.eventSubscription = this.server.onEvent((event: WebhookEvent) => {
      void this.handleEvent(event)
    })

    const port = getSettings(ctx).webhookPort
    this.server.start(port).then(() => {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `coordinator 启动成功 port=${port}`,
      })
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'webhook',
        message: 'coordinator 启动失败',
        details: message,
      })
    })
  }

  /** Stops the HTTP server. Called via ctx.subscriptions when the window closes. */
  async dispose(): Promise<void> {
    if (!this.initialized)
      return
    logger.add({
      level: 'info',
      source: 'webhook',
      message: 'coordinator 停止中',
    })
    this.eventSubscription?.dispose()
    this.eventSubscription = undefined
    const srv = this.server
    this.server = undefined
    if (srv) {
      try {
        await srv.stop()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'coordinator 停止失败',
          details: message,
        })
      }
    }
    this.activePanel = undefined
    this.initialized = false
    logger.add({
      level: 'info',
      source: 'webhook',
      message: 'coordinator 已停止',
    })
  }

  /** Restart the server only if `port` differs from the currently-bound one. */
  async ensurePort(port: number): Promise<void> {
    const srv = this.server
    if (!srv)
      return
    if (srv.currentPort === port)
      return
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `coordinator 切换端口 ${srv.currentPort ?? '?'} → ${port}`,
    })
    await srv.stop()
    await srv.start(port)
  }

  /** Register a pending hook after createWebhook on gitea succeeded. */
  async addPending(issueNumber: number, info: PendingHook): Promise<void> {
    this.pendingHooks.set(issueNumber, info)
    await this.persist()
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `addPending #${issueNumber} hookId=${info.hookId}`,
      details: `${info.host}/${info.owner}/${info.repo} feature=${info.feature}`,
    })
  }

  /** Remove a pending hook (no-op if absent). Persists. */
  async removePending(issueNumber: number): Promise<void> {
    if (!this.pendingHooks.has(issueNumber))
      return
    this.pendingHooks.delete(issueNumber)
    await this.persist()
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `removePending #${issueNumber}`,
    })
  }

  /** Read current map (defensive copy). */
  snapshot(): Map<number, PendingHook> {
    return new Map(this.pendingHooks)
  }

  /** Webview panel binding for refresh + toast. Pass undefined when closing. */
  setActivePanel(p: KanbanWebviewPanel | undefined): void {
    this.activePanel = p
  }

  private async persist(): Promise<void> {
    if (!this.ctx)
      return
    const obj: Record<string, PendingHook> = {}
    for (const [k, v] of this.pendingHooks)
      obj[String(k)] = v
    await this.ctx.workspaceState.update(PENDING_HOOKS_KEY, obj)
  }

  /**
   * Process a single `pull_request` webhook delivery: merge the PR number
   * into the issue's state-JSON comment, delete the gitea webhook, and (if
   * a panel is open) refresh the kanban so the new fields surface
   * immediately. Always shows a toast — `window.showInformationMessage`
   * works regardless of panel state.
   */
  private async handleEvent(event: WebhookEvent): Promise<void> {
    if (!this.ctx) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'handleEvent 调用时 ctx 未初始化',
      })
      return
    }
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `收到 webhook 事件 issue=#${event.issueNumber} pr=#${event.pr}`,
    })
    const pending = this.pendingHooks.get(event.issueNumber)
    if (!pending) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '收到未跟踪的 issue 回调',
        details: `issue=#${event.issueNumber} pr=#${event.pr}`,
      })
      return
    }
    const token = await getToken(this.ctx, pending.host)
    if (!token) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `缺少 token，无法处理 #${event.issueNumber}`,
        details: `host=${pending.host}`,
      })
      return
    }

    try {
      await mergeStateJsonComment({
        host: pending.host,
        owner: pending.owner,
        repo: pending.repo,
        token,
        issueNumber: event.issueNumber,
        extra: {
          pr: event.pr,
          implementStatus: 'done',
        },
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'webhook',
        message: '更新 state JSON 失败',
        details: message,
      })
      // Continue: still try to clean up the gitea-side hook.
    }

    try {
      await deleteWebhook({
        host: pending.host,
        token,
        owner: pending.owner,
        repo: pending.repo,
        hookId: pending.hookId,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '删除 gitea hook 失败',
        details: message,
      })
    }

    await this.removePending(event.issueNumber)

    // Refresh the kanban if a panel is currently bound.
    if (this.activePanel) {
      try {
        await this.activePanel.loadAndPush()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'panel.loadAndPush 失败',
          details: message,
        })
      }
    }

    const action = 'Open PR'
    try {
      const pick = await window.showInformationMessage(
        `#${event.issueNumber} 已关联 PR !${event.pr}`,
        action,
      )
      if (pick === action)
        void env.openExternal(Uri.parse(event.htmlUrl))
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '展示 toast 失败',
        details: message,
      })
    }
  }
}

export const webhookCoordinator = new WebhookCoordinator()
