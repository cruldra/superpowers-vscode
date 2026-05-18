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
import type { KanbanWebviewPanel } from '../panel/KanbanPanel'
import type { IssueCommentWebhookEvent, IssueWebhookEvent, PrWebhookEvent, WebhookEvent } from './server'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { env, Uri, window, workspace } from 'vscode'
import { getToken } from '../auth/secrets'
import { getReviewPrompt } from '../cc/prompts'
import { runReview } from '../cc/reviewFlow'
import { detectRepo } from '../git/remote'
import { deleteWebhook, getPullRequest, listIssueComments } from '../gitea/api'
import { loadIssues, loadSingleIssue } from '../gitea/issueLoader'
import { mergeStateJsonComment, readStateJsonComment } from '../gitea/stateJson'
import { logger } from '../logging/logger'
import { getSettings } from '../settings/store'
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

/**
 * A {@link PrWebhookEvent} whose `issueNumber` has been resolved (either from
 * the legacy `/webhook/:n` path or via PR-body / branch heuristics).
 */
type ResolvedWebhookEvent = Omit<PrWebhookEvent, 'issueNumber'> & { issueNumber: number }

class WebhookCoordinator {
  private ctx?: ExtensionContext
  private server?: WebhookServer
  // kept for legacy cleanup; new flow uses one shared webhook
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
  /**
   * Resolve which issue an incoming webhook event belongs to.
   *
   * Order of attempts:
   *   1. `event.issueNumber` (set by the legacy `/webhook/:n` path).
   *   2. Parse PR body for `Closes #N` / `Fixes #N` / `Resolves #N` (and
   *      the short forms `close`/`fix`/`resolve`). First match wins,
   *      case-insensitive.
   *   3. Branch-name fallback: scan kanban issues for one whose `branch`
   *      matches the event's head branch (strict equality).
   *
   * Returns `null` when none of the strategies produced a match — the
   * caller drops the event with a warning.
   */
  private async resolveIssueNumber(event: PrWebhookEvent): Promise<number | null> {
    if (typeof event.issueNumber === 'number')
      return event.issueNumber

    const body = event.body || ''
    const m = body.match(/\b(?:closes|fixes|resolves|close|fix|resolve)\s+#(\d+)/i)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `通过 PR body 关键词解析到 issue=#${n}`,
      })
      return n
    }

    if (this.activePanel && event.branch) {
      try {
        const ws = workspace.workspaceFolders?.[0]?.uri.fsPath
        if (!ws)
          return null
        const remote = await detectRepo(ws)
        if (!remote)
          return null
        const tok = await getToken(this.ctx!, remote.host)
        if (!tok)
          return null
        const issues = await loadIssues({ host: remote.host, token: tok, owner: remote.owner, repo: remote.repo })
        const found = issues.find(i => i.branch === event.branch)
        if (found) {
          logger.add({
            level: 'info',
            source: 'webhook',
            message: `通过分支名 ${event.branch} 反查到 issue=#${found.number}`,
          })
          return found.number
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: '分支兜底反查失败',
          details: msg,
        })
      }
    }

    logger.add({
      level: 'warn',
      source: 'webhook',
      message: '无法定位工单（既无 path 也无 body 关键词也无 branch 匹配）',
      details: `branch=${event.branch} bodyLen=${body.length}`,
    })
    return null
  }

  private async handleEvent(event: WebhookEvent): Promise<void> {
    if (!this.ctx) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'handleEvent 调用时 ctx 未初始化',
      })
      return
    }

    if (event.kind === 'issue') {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `收到 issue 事件 action=${event.action} issue=#${event.issueNumber}`,
      })
      if (event.action === 'opened' || event.action === 'reopened') {
        await this.handleIssueOpened(event)
      }
      else if (event.action === 'edited') {
        await this.handleIssueEdited(event)
      }
      else {
        logger.add({
          level: 'info',
          source: 'webhook',
          message: `未处理 issue action=${event.action}`,
          details: `issue=#${event.issueNumber}`,
        })
      }
      return
    }

    if (event.kind === 'issue_comment') {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `收到 issue_comment 事件 action=${event.action} issue=#${event.issueNumber}`,
      })
      await this.handleIssueCommentCreated(event)
      return
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `收到 webhook 事件 action=${event.action} issue=${typeof event.issueNumber === 'number' ? `#${event.issueNumber}` : '<未定>'} pr=#${event.pr}`,
    })

    const issueNumber = await this.resolveIssueNumber(event)
    if (issueNumber === null)
      return
    // Narrow `issueNumber` for downstream handlers. We build a fresh
    // object instead of mutating `event` so TypeScript can see the
    // non-undefined type without casts at every call site.
    const resolved: ResolvedWebhookEvent = { ...event, issueNumber }

    switch (resolved.action) {
      case 'opened':
      case 'reopened': {
        await this.handlePrOpened(resolved)
        break
      }
      case 'synchronize':
      case 'synchronized': {
        // Gitea uses 'synchronized' (with d) per source; some examples
        // floating around use 'synchronize' without the d. Accept both
        // defensively.
        await this.handlePrSynchronize(resolved)
        break
      }
      case 'closed': {
        await this.handlePrClosed(resolved)
        break
      }
      case 'deleted': {
        await this.handlePrDeleted(resolved)
        break
      }
      default: {
        logger.add({
          level: 'info',
          source: 'webhook',
          message: `未处理 action=${resolved.action}`,
          details: `issue=#${resolved.issueNumber} pr=#${resolved.pr}`,
        })
        break
      }
    }
  }

  /**
   * Handles a freshly opened gitea issue. Two paths:
   *   - The issue body carries `<!-- spx:nonce=... -->` and matches a
   *     pending creation tracked by the panel → merge column / sessionId /
   *     profilePath / color into the state-JSON comment, append the card
   *     incrementally, then clean up the inbox tmpdir.
   *   - No nonce / no match (external creation, e.g. manual `tea issues
   *     create`) → just append the card so the kanban stays in sync; do
   *     NOT touch the state-JSON comment.
   */
  private async handleIssueOpened(event: IssueWebhookEvent): Promise<void> {
    if (!this.ctx)
      return

    const ws = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!ws) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue 事件忽略：未打开工作区',
      })
      return
    }
    const remote = await detectRepo(ws)
    if (!remote) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue 事件忽略：工作区未关联 gitea',
      })
      return
    }
    const token = await getToken(this.ctx, remote.host)
    if (!token) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue 事件忽略：未配置 token',
      })
      return
    }

    const nonceMatch = event.body.match(/<!--\s*spx:nonce=([0-9a-f-]+)\s*-->/i)
    const nonce = nonceMatch ? nonceMatch[1] : null
    // Promote the in-flight brainstorm terminal into the panel's
    // issueNumber-keyed map BEFORE we drain the pending entry. The terminal
    // tab was created with name `issue-new-{nonce}-规划` (we didn't know
    // issueNumber yet) and VS Code can't rename it, so this side-map is what
    // lets card↔terminal selection round-trip after the webhook arrives.
    if (nonce && this.activePanel)
      this.activePanel.linkPendingTerminalToIssue(nonce, event.issueNumber)
    const pending = nonce && this.activePanel
      ? this.activePanel.takePendingIssueCreation(nonce)
      : undefined

    if (pending) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `匹配到 pending 创建 nonce=${nonce} → 写入 state JSON`,
        details: `issue=#${event.issueNumber} sessionId=${pending.sessionId ?? '<待定>'}`,
      })
      const extra: Record<string, unknown> = {
        column: 'todo',
        color: pending.color,
      }
      if (typeof pending.sessionId === 'string' && pending.sessionId.length > 0)
        extra.sessionId = pending.sessionId
      if (typeof pending.profilePath === 'string' && pending.profilePath.length > 0)
        extra.profilePath = pending.profilePath

      try {
        await mergeStateJsonComment({
          host: remote.host,
          owner: remote.owner,
          repo: remote.repo,
          token,
          issueNumber: event.issueNumber,
          extra,
        })
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'mergeStateJsonComment 失败（继续 append）',
          details: msg,
        })
      }

      // Best-effort cleanup of the inbox tmpdir.
      try {
        await fsp.rm(pending.inboxDir, { recursive: true, force: true })
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'inbox 清理失败',
          details: msg,
        })
      }
    }
    else if (nonce) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `issue body 含 nonce=${nonce} 但未匹配到 pending → 当作外部创建`,
      })
    }
    else {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `issue body 无 spx:nonce → 当作外部创建`,
      })
    }

    if (this.activePanel) {
      try {
        const issue = await loadSingleIssue({
          host: remote.host,
          owner: remote.owner,
          repo: remote.repo,
          token,
          workspaceRoot: ws,
          issueNumber: event.issueNumber,
        })
        if (issue) {
          this.activePanel.postMessage({ type: 'issue/append', issue, select: pending ? true : undefined })
          if (pending) {
            this.activePanel.postMessage({
              type: 'toast/show',
              id: `issue-created-${event.issueNumber}`,
              level: 'success',
              message: `#${event.issueNumber} 已创建`,
              link: { label: '查看', url: event.htmlUrl },
              dismissOnTimer: 8000,
            })
          }
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'loadSingleIssue 失败',
          details: msg,
        })
      }
    }
  }

  /**
   * Issue `edited` payload: cc updates the issue body with `<!-- spx:spec=... -->`
   * / `<!-- spx:plan=... -->` annotation lines as it discovers spec/plan files.
   * We scan the body for those markers, diff against the state-JSON comment,
   * and (if anything changed) merge the new paths in + patch the open panel
   * so the detail view refreshes without a full kanban reload.
   */
  private async handleIssueEdited(event: IssueWebhookEvent): Promise<void> {
    if (!this.ctx)
      return

    const ws = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!ws) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue edited 事件忽略：未打开工作区',
      })
      return
    }
    const remote = await detectRepo(ws)
    if (!remote) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue edited 事件忽略：工作区未关联 gitea',
      })
      return
    }
    const token = await getToken(this.ctx, remote.host)
    if (!token) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'issue edited 事件忽略：未配置 token',
      })
      return
    }

    const specMatch = event.body.match(/<!--\s*spx:spec=([^\s>]+)\s*-->/)
    const planMatch = event.body.match(/<!--\s*spx:plan=([^\s>]+)\s*-->/)
    const specFile = specMatch ? specMatch[1] : undefined
    const planFile = planMatch ? planMatch[1] : undefined

    if (!specFile && !planFile) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `issue=#${event.issueNumber} edited body 无 spx:spec/spx:plan 注释，跳过`,
      })
      return
    }

    let currentState: Record<string, unknown> = {}
    try {
      currentState = await readStateJsonComment({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        issueNumber: event.issueNumber,
      })
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'readStateJsonComment 失败（继续尝试合并）',
        details: msg,
      })
    }

    const currentSpec = typeof currentState.specFile === 'string' ? currentState.specFile : undefined
    const currentPlan = typeof currentState.planFile === 'string' ? currentState.planFile : undefined

    // cc only adds or updates; it never deletes. Treat an absent marker
    // (undefined) as "no signal", not "clear" — that way deleting a spec
    // line by mistake won't lose the existing pointer.
    const nextSpec = specFile ?? currentSpec
    const nextPlan = planFile ?? currentPlan
    if (currentSpec === nextSpec && currentPlan === nextPlan) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `issue=#${event.issueNumber} edited spec/plan 无变化，跳过 (spec=${nextSpec ?? '<空>'} plan=${nextPlan ?? '<空>'})`,
      })
      return
    }

    const extra: Record<string, unknown> = {}
    if (specFile)
      extra.specFile = specFile
    if (planFile)
      extra.planFile = planFile

    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber: event.issueNumber,
        extra,
      })
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'mergeStateJsonComment 失败（issue edited）',
        details: msg,
      })
      return
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `issue=#${event.issueNumber} edited spec/plan 已同步`,
      details: `spec=${specFile ?? '<未变>'} plan=${planFile ?? '<未变>'}`,
    })

    if (this.activePanel) {
      const patch: { specFile?: string, planFile?: string } = {}
      if (specFile)
        patch.specFile = specFile
      if (planFile)
        patch.planFile = planFile
      this.activePanel.postMessage({
        type: 'issue/patch',
        issueNumber: event.issueNumber,
        patch,
      })
    }
  }

  /**
   * `opened` / `reopened`: persist `pr` + `implementStatus=done` into the
   * state JSON, refresh the kanban, toast. The webhook is *not* deleted
   * here — Phase A keeps it alive for `synchronize` / `closed`.
   */
  private async handlePrOpened(event: ResolvedWebhookEvent): Promise<void> {
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

    try {
      await mergeStateJsonComment({
        host: ctx.host,
        owner: ctx.owner,
        repo: ctx.repo,
        token: ctx.token,
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
    }

    if (this.activePanel) {
      try {
        this.activePanel.postMessage({
          type: 'issue/patch',
          issueNumber: event.issueNumber,
          patch: { pr: event.pr, implementStatus: 'done' },
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'panel.postMessage 失败',
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

    // Per-issue override takes precedence over the global setting. The
    // state JSON's `autoReview` field is set the first time the user toggles
    // the checkbox in the detail panel; absent ⇒ follow global.
    let effectiveAutoReview = getSettings(this.ctx).autoReview
    let autoReviewSource: 'issue' | 'global' = 'global'
    try {
      const stateJson = await readStateJsonComment({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: event.issueNumber,
      })
      if (typeof stateJson.autoReview === 'boolean') {
        effectiveAutoReview = stateJson.autoReview
        autoReviewSource = 'issue'
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '读取 state JSON 失败（autoReview override）',
        details: message,
      })
    }

    if (effectiveAutoReview) {
      // Fire-and-forget; the review can take minutes and we don't want to
      // block the webhook response or the panel refresh.
      void this.triggerReview(event.issueNumber, event.pr, ctx)
    }
    else {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `跳过自动审查 #${event.issueNumber}`,
        details: `autoReview=off (source=${autoReviewSource})`,
      })
    }
  }

  /**
   * `synchronize`: kick off a fresh `codex exec review` run when autoReview
   * is on. Codex itself posts the review back as a PR comment, which loops
   * around through {@link handleIssueCommentCreated} to inject into the
   * implementation terminal.
   */
  private async handlePrSynchronize(event: ResolvedWebhookEvent): Promise<void> {
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

    // Per-issue override takes precedence over the global setting.
    let effectiveAutoReview = getSettings(this.ctx).autoReview
    let autoReviewSource: 'issue' | 'global' = 'global'
    try {
      const stateJson = await readStateJsonComment({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: event.issueNumber,
      })
      if (typeof stateJson.autoReview === 'boolean') {
        effectiveAutoReview = stateJson.autoReview
        autoReviewSource = 'issue'
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '读取 state JSON 失败（autoReview override, synchronize）',
        details: message,
      })
    }
    if (!effectiveAutoReview) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `跳过 synchronize 自动审查 #${event.issueNumber}`,
        details: `autoReview=off (source=${autoReviewSource})`,
      })
      return
    }
    void this.triggerReview(event.issueNumber, event.pr, ctx)
  }

  /**
   * `closed`: log only. The webhook stays alive on gitea so a later
   * `reopened` or a "delete + re-push" cycle (which fires `deleted` followed
   * by a fresh `opened`) keeps flowing through the same registration.
   * Cleanup of the webhook is deferred to the future "完成" column trigger.
   */
  private async handlePrClosed(event: ResolvedWebhookEvent): Promise<void> {
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `PR #${event.pr} closed (保留 webhook 以备 reopen/重建)`,
      details: `issue=#${event.issueNumber}`,
    })

    // 判断是否为合并关闭 —— gitea PR payload 里 merged 字段不在 ResolvedWebhookEvent
    // 类型上，主动查一次 API 取 merged 状态（成本低，避免 server.ts 解析变动）。
    if (!this.ctx)
      return
    const ctx = await this.resolveRepoContext(event.issueNumber)
    if (!ctx)
      return
    const prIndex = Number.parseInt(event.pr, 10)
    if (!Number.isFinite(prIndex))
      return

    let merged = false
    try {
      const pr = await getPullRequest({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        index: prIndex,
      })
      merged = pr.merged
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `查询 PR #${event.pr} merged 状态失败`,
        details: message,
      })
      return
    }

    if (!merged)
      return

    try {
      await mergeStateJsonComment({
        host: ctx.host,
        owner: ctx.owner,
        repo: ctx.repo,
        token: ctx.token,
        issueNumber: event.issueNumber,
        extra: { prMerged: true },
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: '写入 prMerged=true 到 state JSON 失败',
        details: message,
      })
    }

    if (this.activePanel) {
      try {
        this.activePanel.postMessage({
          type: 'issue/patch',
          issueNumber: event.issueNumber,
          patch: { prMerged: true },
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'panel.postMessage (prMerged) 失败',
          details: message,
        })
      }
    }
  }

  /**
   * `deleted`: the user hard-deleted the PR on gitea. Clear `pr` from the
   * state JSON (using the empty string so the loader treats it as unset) and
   * refresh the kanban. The webhook stays alive for the next push.
   */
  private async handlePrDeleted(event: ResolvedWebhookEvent): Promise<void> {
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `PR #${event.pr} deleted, 清空 state JSON 中的 pr`,
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
        extra: { pr: '' },
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
        this.activePanel.postMessage({
          type: 'issue/patch',
          issueNumber: event.issueNumber,
          patch: { pr: undefined },
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: 'panel.postMessage 失败（deleted）',
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
   * Inbound `issue_comment created` handler — picks up the marker comment that
   * the codex review run posts back, strips the marker line, and injects the
   * remaining markdown into the issue's implementation cc terminal.
   *
   * Comments without the `<!-- spx:review=1 -->` marker are ignored. Edited /
   * deleted comments are also ignored (the dispatcher only routes 'created').
   *
   * `isFirstReview` is derived by counting the marker across the issue's
   * existing comments — when this is the only one (count <= 1), it's the
   * first review and `injectIntoImplTerminal` appends the merge-to-main
   * suffix.
   */
  private async handleIssueCommentCreated(event: IssueCommentWebhookEvent): Promise<void> {
    if (event.action !== 'created') {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `跳过 issue_comment action=${event.action} #${event.issueNumber}`,
      })
      return
    }
    const body = event.commentBody
    if (!/<!--\s*spx:review=1\s*-->/i.test(body)) {
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `issue_comment 无 spx:review 标识，忽略 #${event.issueNumber}`,
      })
      return
    }
    const text = body.replace(/<!--\s*spx:review=1\s*-->\s*\n?/i, '').trim()
    if (!text) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `审查评论正文为空 #${event.issueNumber}`,
      })
      return
    }

    const ctx = await this.resolveRepoContext(event.issueNumber)
    if (!ctx) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `无法解析 #${event.issueNumber} 的仓库上下文（issue_comment），跳过`,
      })
      return
    }

    // Count marker comments to determine isFirstReview. This call also
    // includes the just-posted comment, so a first review yields count=1.
    let reviewCount = 1
    try {
      const comments = await listIssueComments({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        index: event.issueNumber,
      })
      reviewCount = comments.filter(c => /<!--\s*spx:review=1\s*-->/i.test(c.body ?? '')).length
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `统计审查评论数失败 #${event.issueNumber}（按首次处理）`,
        details: message,
      })
    }
    const isFirstReview = reviewCount <= 1

    const injected = this.activePanel
      ? this.activePanel.injectIntoImplTerminal(event.issueNumber, text, isFirstReview)
      : false
    if (!injected) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `审查注入失败（实施 tab 未找到）#${event.issueNumber}`,
      })
      return
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `审查反馈已注入实施终端 #${event.issueNumber} isFirstReview=${isFirstReview} length=${text.length}`,
    })
  }

  /**
   * Spawn `codex exec review` in the issue's worktree. Codex itself is
   * instructed (via the review prompt) to post the review back as a PR
   * comment with the `<!-- spx:review=1 -->` marker; the comment hits
   * the webhook again as an `issue_comment created` event and loops
   * around through {@link handleIssueCommentCreated}. Fire-and-forget.
   */

  private async triggerReview(
    issueNumber: number,
    prNumber: string,
    ctx: { host: string, owner: string, repo: string, token: string },
  ): Promise<void> {
    if (!this.ctx)
      return

    // Read current column from state JSON; if it's still 'in-progress',
    // auto-advance to 'review' so the kanban reflects "审查中" status. Skip if
    // already in review/done to avoid bouncing the card around.
    try {
      const stateJson = await readStateJsonComment({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber,
      })
      if (stateJson.column === 'in-progress') {
        await mergeStateJsonComment({
          host: ctx.host,
          token: ctx.token,
          owner: ctx.owner,
          repo: ctx.repo,
          issueNumber,
          extra: { column: 'review' },
        })
        this.activePanel?.postMessage({
          type: 'issue/patch',
          issueNumber,
          patch: { column: 'review' },
        })
        logger.add({
          level: 'info',
          source: 'webhook',
          message: `自动推进 #${issueNumber}: in-progress → review`,
        })
      }
    }
    catch (err) {
      // Non-fatal: log and keep going with the review.
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `读取/更新 column 失败 (auto-advance review) #${issueNumber}`,
        details: message,
      })
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `triggerReview 中止 #${issueNumber}：没有工作区`,
      })
      return
    }

    // Re-fetch state JSON to pick up the issue's worktreePath.
    let worktreePath: string | undefined
    try {
      const comments = await listIssueComments({
        host: ctx.host,
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        index: issueNumber,
      })
      const last = comments[comments.length - 1]
      const body = (last?.body ?? '').trim()
      if (body) {
        try {
          const parsed = JSON.parse(body) as { worktreePath?: unknown }
          if (typeof parsed?.worktreePath === 'string' && parsed.worktreePath.length > 0)
            worktreePath = parsed.worktreePath
        }
        catch {
          // last comment isn't JSON — proceed without a worktree.
        }
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: `读取 state JSON 失败（triggerReview）#${issueNumber}`,
        details: message,
      })
    }

    if (!worktreePath) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `审查中止 #${issueNumber}：state JSON 中无 worktreePath`,
      })
      return
    }
    const worktreeAbs = path.join(workspaceRoot, worktreePath)
    if (!fs.existsSync(worktreeAbs)) {
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `审查中止 #${issueNumber}：worktree 不存在 ${worktreeAbs}`,
      })
      return
    }
    const cwd = worktreeAbs

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `开始审查 #${issueNumber} cwd=${cwd}`,
    })

    const prompt = getReviewPrompt(this.ctx, { prNumber })

    try {
      await runReview({ workspaceRoot: cwd, prompt })
    }
    catch (err) {
      // runReview never throws now (it logs internally) but defensively
      // catch in case future refactors reintroduce throws.
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'webhook',
        message: `审查执行失败 #${issueNumber}`,
        details: message,
      })
      return
    }

    logger.add({
      level: 'info',
      source: 'webhook',
      message: `审查 spawn 完成 #${issueNumber}，等待 codex 通过 PR 评论回流`,
    })
  }
}

export const webhookCoordinator = new WebhookCoordinator()
