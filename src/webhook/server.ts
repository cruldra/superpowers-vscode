/**
 * Minimal HTTP server that listens for Gitea webhooks and fires a VS Code
 * `Event<WebhookEvent>` for each accepted payload. Two payload shapes are
 * supported, discriminated by the `X-Gitea-Event` header:
 *   - `pull_request` → {@link PrWebhookEvent}
 *   - `issues`       → {@link IssueWebhookEvent} (used by the new-issue
 *                      flow to round-trip a `<!-- spx:nonce=... -->` marker
 *                      back into the panel)
 *
 * Routes accepted:
 *   - `POST /webhook/:issueNumber` (legacy) — the issue number is taken from
 *     the path and round-tripped on the event. Kept so per-issue webhooks
 *     that the extension previously created on gitea keep working.
 *   - `POST /webhook` (canonical) — the user configures a single shared
 *     webhook in gitea pointing here; the event leaves `issueNumber`
 *     undefined (PR case) and the coordinator resolves it from the PR body
 *     (`Closes #N` / branch fallback). Issue events carry the number
 *     directly in the payload, so the path doesn't matter for them.
 *
 * Other paths/methods get a 404/405. Malformed JSON or missing fields → 400.
 * Non-matching actions still respond 200 but skip the emit (gitea retries
 * less aggressively that way).
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Event } from 'vscode'
import { createServer } from 'node:http'
import { EventEmitter } from 'vscode'
import { logger } from '../logging/logger'

export type WebhookEvent = PrWebhookEvent | IssueWebhookEvent | IssueCommentWebhookEvent

export interface PrWebhookEvent {
  /** Discriminator: this event came from a `pull_request` payload. */
  kind: 'pr'
  /**
   * Issue number from the legacy `/webhook/:n` path. `undefined` when the
   * canonical `/webhook` route was used — the coordinator then resolves the
   * issue via PR body / branch heuristics.
   */
  issueNumber: number | undefined
  /**
   * The `action` field from the `pull_request` payload (e.g. `opened`,
   * `reopened`, `synchronize`, `closed`, `edited`). The server fires this
   * event on every `pull_request` action whose payload parses correctly;
   * downstream code dispatches on `action` to decide what to do.
   */
  action: string
  /** PR number as string. */
  pr: string
  /** Head branch ref. */
  branch: string
  /** Browser URL to the PR. */
  htmlUrl: string
  /** PR title (best-effort; empty string if missing). */
  title: string
  /** PR body / description — used by the coordinator for `Closes #N` parsing. */
  body: string
  /** Raw JSON payload, in case downstream needs more fields. */
  raw: unknown
}

export interface IssueWebhookEvent {
  /** Discriminator: this event came from an `issues` payload. */
  kind: 'issue'
  /**
   * The `action` field from the `issues` payload (`opened` / `closed` /
   * `edited` / `reopened` / `deleted`...). The server fires for every
   * action; the coordinator decides which ones it actually handles.
   */
  action: string
  /** Issue number. */
  issueNumber: number
  /** Issue title (best-effort). */
  title: string
  /** Issue body — used to extract the `<!-- spx:nonce=... -->` marker. */
  body: string
  /** Browser URL to the issue. */
  htmlUrl: string
  /** Raw JSON payload. */
  raw: unknown
}

export interface IssueCommentWebhookEvent {
  /** Discriminator: this event came from an `issue_comment` payload. */
  kind: 'issue_comment'
  /** Action: 'created' / 'edited' / 'deleted'. */
  action: string
  /**
   * Issue number — gitea uses the same number for issues and PRs. If the
   * issue is actually a PR, {@link prNumber} is also set.
   */
  issueNumber: number
  /** PR number when the comment is on a PR; otherwise undefined. */
  prNumber: number | undefined
  /** Comment body — caller scans for the `<!-- spx:review=1 -->` marker. */
  commentBody: string
  /** Browser URL to the comment. */
  commentHtmlUrl: string
  /** Raw JSON payload. */
  raw: unknown
}

export class WebhookServer {
  private server?: Server
  private port?: number
  private readonly emitter = new EventEmitter<WebhookEvent>()

  readonly onEvent: Event<WebhookEvent> = this.emitter.event

  /** The port currently bound, or undefined if the server is not listening. */
  get currentPort(): number | undefined {
    return this.port
  }

  /**
   * Start (or move) the server on `port`. If already listening on the same
   * port this is a no-op. If listening on a different port, the old server
   * is closed and a new one started. Resolves once the listen succeeds.
   */
  async start(port: number): Promise<void> {
    if (this.server && this.port === port)
      return
    if (this.server)
      await this.stop()

    const server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening)
        logger.add({
          level: 'error',
          source: 'webhook',
          message: 'bind 失败',
          details: err.message,
        })
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port)
    })
    this.server = server
    this.port = port
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `HTTP server listening on :${port}`,
    })
  }

  async stop(): Promise<void> {
    const srv = this.server
    if (!srv)
      return
    this.server = undefined
    this.port = undefined
    await new Promise<void>((resolve) => {
      srv.close(() => resolve())
    })
    logger.add({
      level: 'info',
      source: 'webhook',
      message: 'HTTP server 已停止',
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = req.url ?? ''
      logger.add({
        level: 'info',
        source: 'webhook',
        message: `收到 ${req.method ?? '?'} ${url}`,
      })
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
        return
      }

      // Two accepted shapes:
      //   /webhook            → issueNumber resolved later from PR body
      //   /webhook/<digits>   → legacy per-issue, issueNumber set from path
      let issueNumber: number | undefined
      let routeMatched = false
      const legacyMatch = /^\/webhook\/(\d+)(?:\?.*)?$/.exec(url)
      if (legacyMatch) {
        issueNumber = Number(legacyMatch[1])
        routeMatched = true
      }
      else if (/^\/webhook(?:\?.*)?$/.test(url)) {
        issueNumber = undefined
        routeMatched = true
      }
      if (!routeMatched) {
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: '路径不匹配',
          details: url,
        })
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'not_found' }))
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const eventHeader = (req.headers['x-gitea-event'] || '').toString() || '<missing>'
          logger.add({
            level: 'info',
            source: 'webhook',
            message: `收到请求 X-Gitea-Event=${eventHeader} bodyLen=${body.length}`,
          })
          let parsed: unknown
          try {
            parsed = JSON.parse(body) as unknown
          }
          catch {
            logger.add({
              level: 'warn',
              source: 'webhook',
              message: '请求体解析失败',
              details: body.slice(0, 500),
            })
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }))
            return
          }

          const event = parseEvent(eventHeader, issueNumber, parsed)
          if (event) {
            if (event.kind === 'pr') {
              const issuePart = typeof event.issueNumber === 'number'
                ? `issue=#${event.issueNumber}`
                : 'path=/webhook'
              logger.add({
                level: 'info',
                source: 'webhook',
                message: `匹配 action=${event.action} PR #${event.pr} 分支 ${event.branch} ${issuePart} (event=${eventHeader})`,
              })
            }
            else if (event.kind === 'issue_comment') {
              logger.add({
                level: 'info',
                source: 'webhook',
                message: `匹配 issue_comment action=${event.action} issue=#${event.issueNumber} pr=${event.prNumber ? `#${event.prNumber}` : '<no>'} (event=${eventHeader})`,
              })
            }
            else {
              logger.add({
                level: 'info',
                source: 'webhook',
                message: `匹配 issue action=${event.action} issue=#${event.issueNumber} (event=${eventHeader})`,
              })
            }
            this.emitter.fire(event)
          }
          else {
            logger.add({
              level: 'info',
              source: 'webhook',
              message: `未处理事件，已忽略 (X-Gitea-Event=${eventHeader})`,
            })
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }
        catch (err) {
          console.error('[superpowers/webhook] handler error:', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
        }
      })
      req.on('error', (err) => {
        console.error('[superpowers/webhook] request stream error:', err)
      })
    }
    catch (err) {
      console.error('[superpowers/webhook] top-level error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
    }
  }
}

/**
 * Validate and normalise a gitea pull_request webhook payload. Returns null
 * for missing fields or non-actionable actions; the HTTP handler still
 * responds 200 in both cases. `issueNumber` is forwarded as-is — it's
 * `undefined` when the request came in on the canonical `/webhook` route
 * (the coordinator resolves it from `body` / `branch` in that case).
 */
function parseEvent(
  eventHeader: string,
  issueNumber: number | undefined,
  raw: unknown,
): WebhookEvent | null {
  if (!raw || typeof raw !== 'object')
    return null
  const obj = raw as {
    action?: unknown
    pull_request?: unknown
    issue?: unknown
    comment?: unknown
  }
  if (typeof obj.action !== 'string')
    return null

  if (eventHeader === 'issue_comment') {
    const issue = obj.issue
    const comment = obj.comment
    if (!issue || typeof issue !== 'object')
      return null
    if (!comment || typeof comment !== 'object')
      return null
    const issueObj = issue as {
      number?: unknown
      pull_request?: unknown
    }
    const commentObj = comment as {
      body?: unknown
      html_url?: unknown
    }
    const num = typeof issueObj.number === 'number' ? issueObj.number : Number(issueObj.number)
    if (!Number.isFinite(num))
      return null
    // gitea sets issue.pull_request (non-null object) when the issue is a PR.
    const prNumber = issueObj.pull_request && typeof issueObj.pull_request === 'object'
      ? num
      : undefined
    const commentBody = typeof commentObj.body === 'string' ? commentObj.body : ''
    const commentHtmlUrl = typeof commentObj.html_url === 'string' ? commentObj.html_url : ''
    return {
      kind: 'issue_comment',
      action: obj.action,
      issueNumber: num,
      prNumber,
      commentBody,
      commentHtmlUrl,
      raw,
    }
  }

  if (eventHeader === 'issues') {
    const issue = obj.issue
    if (!issue || typeof issue !== 'object')
      return null
    const issueObj = issue as {
      number?: unknown
      html_url?: unknown
      title?: unknown
      body?: unknown
    }
    const num = typeof issueObj.number === 'number' ? issueObj.number : Number(issueObj.number)
    if (!Number.isFinite(num))
      return null
    const htmlUrl = typeof issueObj.html_url === 'string' ? issueObj.html_url : ''
    const title = typeof issueObj.title === 'string' ? issueObj.title : ''
    const body = typeof issueObj.body === 'string' ? issueObj.body : ''
    return {
      kind: 'issue',
      action: obj.action,
      issueNumber: num,
      title,
      body,
      htmlUrl,
      raw,
    }
  }

  // Default path: pull_request payload (preserves legacy behaviour for any
  // event header value, since gitea historically may not set the header).
  const pr = obj.pull_request
  if (!pr || typeof pr !== 'object')
    return null
  const prObj = pr as {
    number?: unknown
    html_url?: unknown
    head?: unknown
    title?: unknown
    body?: unknown
  }
  const num = typeof prObj.number === 'number' ? prObj.number : Number(prObj.number)
  if (!Number.isFinite(num))
    return null
  const htmlUrl = typeof prObj.html_url === 'string' ? prObj.html_url : ''
  const head = prObj.head as { ref?: unknown } | undefined
  const branch = head && typeof head.ref === 'string' ? head.ref : ''
  const title = typeof prObj.title === 'string' ? prObj.title : ''
  const body = typeof prObj.body === 'string' ? prObj.body : ''

  if (!branch || !htmlUrl)
    return null

  return {
    kind: 'pr',
    issueNumber,
    action: obj.action,
    pr: String(num),
    branch,
    htmlUrl,
    title,
    body,
    raw,
  }
}
