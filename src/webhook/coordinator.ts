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
import { env, Uri, window, workspace } from 'vscode'
import { getToken } from '../auth/secrets'
import { getReviewPrompt } from '../cc/prompts'
import { runReview } from '../cc/reviewFlow'
import { deleteWebhook, listIssueComments } from '../gitea/api'
import { detectRepo } from '../git/remote'
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
   * Resolve the repo context for an incoming webhook event. The pendingHooks
   * map is only a convenience cache — the webhook URL path itself proves the
   * issue belongs to us, so a cache miss is recoverable via detectRepo. Returns
   * null only when there's no workspace, no origin remote, or no saved token.
   */
  private async resolveRepoContext(issueNumber: number): Promise<{
    hookId: number | undefined
    host: string
    owner: string
    repo: string
    token: string
  } | null> {
    if (!this.ctx)
      return null
    const pending = this.pendingHooks.get(issueNumber)
    if (pending) {
      const tok = await getToken(this.ctx, pending.host)
      if (!tok)
        return null
      return { hookId: pending.hookId, host: pending.host, owner: pending.owner, repo: pending.repo, token: tok }
    }
    // Recover via detectRepo + getToken when the in-memory map is empty.
    const ws = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!ws)
      return null
    const remote = await detectRepo(ws)
    if (!remote)
      return null
    const tok = await getToken(this.ctx, remote.host)
    if (!tok)
      return null
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `未在 pendingHooks 中找到 #${issueNumber}，已通过 detectRepo 恢复仓库上下文`,
    })
    return { hookId: undefined, host: remote.host, owner: remote.owner, repo: remote.repo, token: tok }
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
      message: `收到 webhook 事件 action=${event.action} issue=#${event.issueNumber} pr=#${event.pr}`,
    })

    switch (event.action) {
      case 'opened':
      case 'reopened': {
        await this.handlePrOpened(event)
        break
      }
      case 'synchronize': {
        await this.handlePrSynchronize(event)
        break
      }
      case 'closed': {
        await this.handlePrClosed(event)
        break
      }
      case 'deleted': {
        await this.handlePrDeleted(event)
        break
      }
      default: {
        logger.add({
          level: 'info',
          source: 'webhook',
          message: `未处理 action=${event.action}`,
          details: `issue=#${event.issueNumber} pr=#${event.pr}`,
        })
        break
      }
    }
  }

  /**
   * `opened` / `reopened`: persist `pr` + `implementStatus=done` into the
   * state JSON, refresh the kanban, toast. The webhook is *not* deleted
   * here — Phase A keeps it alive for `synchronize` / `closed`.
   */
  private async handlePrOpened(event: WebhookEvent): Promise<void> {
    if (!this.ctx)
      return
    const ctx = await this.resolveRepoContext(event.issueNumber)
    if (!ctx) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `无法解析 #${event.issueNumber} 的仓库上下文，跳过`,
        details: `action=${event.action} pr=#${event.pr}`,
      })
      return
    }
    // Detect PR replacement: if the issue's latest state JSON already has a
    // non-empty `pr` that's different from this new event, the user has
    // hard-deleted the old PR and re-pushed. Reset reviewSessionId so the
    // next review starts a fresh codex thread.
    let oldPr = ''
    try {
      const comments = await listIssueComments({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        index: event.issueNumber,
      })
      const last = comments[comments.length - 1]
      const body = (last?.body ?? '').trim()
      if (body) {
        try {
          const parsed = JSON.parse(body) as { pr?: unknown }
          if (typeof parsed?.pr === 'string')
            oldPr = parsed.pr
        }
        catch {
          // last comment isn't JSON — treat as no prior pr.
        }
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '读取 state JSON 失败（opened）',
        details: message,
      })
    }

    const merge: Record<string, unknown> = {
      pr: event.pr,
      implementStatus: 'done',
    }
    const isReplacement = oldPr.length > 0 && oldPr !== event.pr
    if (isReplacement) {
      merge.reviewSessionId = ''
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `PR 已被替换 #${oldPr} → #${event.pr}, 重置 reviewSessionId`,
        details: `issue=#${event.issueNumber}`,
      })
    }

    try {
      await mergeStateJsonComment({
        host: ctx.host,
        owner: ctx.owner,
        repo: ctx.repo,
        token: ctx.token,
        issueNumber: event.issueNumber,
        extra: merge,
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
    }

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

    // Fire-and-forget the toast — `showInformationMessage` is sticky until the
    // user clicks, so awaiting it would block the auto-review trigger below
    // indefinitely.
    const action = 'Open PR'
    void window.showInformationMessage(
      `#${event.issueNumber} 已关联 PR !${event.pr}`,
      action,
    ).then((pick) => {
      if (pick === action)
        void env.openExternal(Uri.parse(event.htmlUrl))
    }, (err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '展示 toast 失败',
        details: message,
      })
    })

    if (getSettings(this.ctx).autoReview) {
      // Fire-and-forget; the review can take minutes and we don't want to
      // block the webhook response or the panel refresh.
      void this.triggerReview(event.issueNumber, event.pr, undefined, ctx)
    }
  }

  /**
   * `synchronize`: re-fetch the state JSON, look up `reviewSessionId`, and
   * resume the codex thread with a follow-up prompt. Skip entirely when
   * autoReview is off or no prior session exists.
   */
  private async handlePrSynchronize(event: WebhookEvent): Promise<void> {
    if (!this.ctx)
      return
    if (!getSettings(this.ctx).autoReview) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `未启用审查或未审过 synchronize #${event.issueNumber}`,
        details: 'autoReview=off',
      })
      return
    }
    const ctx = await this.resolveRepoContext(event.issueNumber)
    if (!ctx) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `无法解析 #${event.issueNumber} 的仓库上下文，跳过`,
        details: `action=${event.action} pr=#${event.pr}`,
      })
      return
    }
    let reviewSessionId: string | undefined
    try {
      const comments = await listIssueComments({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        index: event.issueNumber,
      })
      const last = comments[comments.length - 1]
      const body = (last?.body ?? '').trim()
      if (body) {
        try {
          const parsed = JSON.parse(body) as { reviewSessionId?: unknown }
          if (typeof parsed?.reviewSessionId === 'string' && parsed.reviewSessionId.length > 0)
            reviewSessionId = parsed.reviewSessionId
        }
        catch {
          // last comment isn't JSON — fine, just no resume id.
        }
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '读取 state JSON 失败（synchronize）',
        details: message,
      })
    }

    if (!reviewSessionId) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `未启用审查或未审过 synchronize #${event.issueNumber}`,
        details: '缺少 reviewSessionId',
      })
      return
    }
    void this.triggerReview(event.issueNumber, event.pr, reviewSessionId, ctx)
  }

  /**
   * `closed`: log only. The webhook stays alive on gitea so a later
   * `reopened` or a "delete + re-push" cycle (which fires `deleted` followed
   * by a fresh `opened`) keeps flowing through the same registration.
   * Cleanup of the webhook is deferred to the future "完成" column trigger.
   */
  private async handlePrClosed(event: WebhookEvent): Promise<void> {
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `PR #${event.pr} closed (保留 webhook 以备 reopen/重建)`,
      details: `issue=#${event.issueNumber}`,
    })
  }

  /**
   * `deleted`: the user hard-deleted the PR on gitea. Clear `pr` and
   * `reviewSessionId` from the state JSON (using empty strings so the loader
   * treats them as unset) and refresh the kanban. The webhook stays alive
   * for the next push.
   */
  private async handlePrDeleted(event: WebhookEvent): Promise<void> {
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `PR #${event.pr} deleted, 清空 state JSON 中的 pr / reviewSessionId`,
      details: `issue=#${event.issueNumber}`,
    })
    const ctx = await this.resolveRepoContext(event.issueNumber)
    if (!ctx) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `无法解析 #${event.issueNumber} 的仓库上下文，跳过`,
        details: `action=${event.action} pr=#${event.pr}`,
      })
      return
    }
    try {
      await mergeStateJsonComment({
        host: ctx.host,
        owner: ctx.owner,
        repo: ctx.repo,
        token: ctx.token,
        issueNumber: event.issueNumber,
        extra: { pr: '', reviewSessionId: '' },
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '清空 state JSON 失败（deleted）',
        details: message,
      })
    }
    if (this.activePanel) {
      try {
        await this.activePanel.loadAndPush()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'panel.loadAndPush 失败（deleted）',
          details: message,
        })
      }
    }
  }

  /**
   * Kept for future "完成" column trigger: deletes the gitea webhook and
   * removes the pending entry. Currently unused — closed PRs no longer
   * trigger cleanup; the user clears them manually via gitea or via a future
   * column transition.
   */
  // kept for future "完成" column trigger
  private async deleteWebhookAndForget(issueNumber: number, pending: PendingHook, token: string): Promise<void> {
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
    await this.removePending(issueNumber)
  }

  /**
   * Run `codex exec review` (or resume) and inject the resulting text into
   * the implementation cc terminal. Persists `reviewSessionId` the first
   * time (when `resumeFrom` is undefined). Best-effort — any failure is
   * logged + toasted but doesn't propagate.
   */
  private async triggerReview(
    issueNumber: number,
    prNumber: string,
    resumeFrom: string | undefined,
    ctx: { host: string, owner: string, repo: string, token: string },
  ): Promise<void> {
    if (!this.ctx)
      return
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `triggerReview 中止 #${issueNumber}：没有工作区`,
      })
      return
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `开始审查 #${issueNumber} resume=${resumeFrom ? 'true' : 'false'}`,
    })

    const prompt = resumeFrom
      ? 'PR 更新了，再次审查'
      : getReviewPrompt(this.ctx, { prNumber })

    let result: { sessionId: string | null, text: string }
    try {
      result = await runReview({
        workspaceRoot,
        prompt,
        resumeFrom,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `审查执行失败 #${issueNumber}`,
        details: message,
      })
      void window.showErrorMessage(`审查执行失败 #${issueNumber}: ${message}`)
      return
    }

    // First-time only: persist the captured codex thread id so synchronize
    // can resume the same conversation.
    if (!resumeFrom && result.sessionId) {
      try {
        await mergeStateJsonComment({
          host: ctx.host,
          owner: ctx.owner,
          repo: ctx.repo,
          token: ctx.token,
          issueNumber,
          extra: { reviewSessionId: result.sessionId },
        })
        if (this.activePanel) {
          try {
            await this.activePanel.loadAndPush()
          }
          catch {
            // Non-fatal; panel might just be closed.
          }
        }
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: `持久化 reviewSessionId 失败 #${issueNumber}`,
          details: message,
        })
      }
    }

    const injected = this.activePanel
      ? this.activePanel.injectIntoImplTerminal(issueNumber, result.text)
      : false
    if (!injected) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `未找到实施终端，审查未注入 #${issueNumber}`,
      })
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `审查完成 #${issueNumber} length=${result.text.length}`,
    })
  }
}

export const webhookCoordinator = new WebhookCoordinator()
