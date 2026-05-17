/**
 * Minimal HTTP server that listens for Gitea PR webhooks and fires a VS Code
 * `Event<WebhookEvent>` for each `pull_request` payload with action
 * `'opened'` or `'reopened'`.
 *
 * Route: `POST /webhook/:issueNumber`. The issue number is parsed from the
 * path and round-tripped on the event so the orchestrator can look up its
 * own pending state. Other paths/methods get a 404/405. Malformed JSON or
 * missing fields → 400. Non-matching actions still respond 200 but skip the
 * emit (gitea retries less aggressively that way).
 */

import type { Event } from 'vscode'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { EventEmitter } from 'vscode'
import { logger } from '../logging/logger'

export interface WebhookEvent {
  issueNumber: number
  /** PR number as string. */
  pr: string
  /** Head branch ref. */
  branch: string
  /** Browser URL to the PR. */
  htmlUrl: string
  /** Raw JSON payload, in case downstream needs more fields. */
  raw: unknown
}

export class WebhookServer {
  private server?: Server
  private port?: number
  private readonly emitter = new EventEmitter<WebhookEvent>()

  readonly onEvent: Event<WebhookEvent> = this.emitter.event

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

      const match = /^\/webhook\/(\d+)(?:\?.*)?$/.exec(url)
      if (!match) {
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
      const issueNumber = Number(match[1])

      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
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

          const action = extractAction(parsed)
          const event = parseEvent(issueNumber, parsed)
          if (event) {
            logger.add({
              level: 'info',
              source: 'webhook',
              message: `匹配 PR #${event.pr} 分支 ${event.branch}`,
            })
            this.emitter.fire(event)
          }
          else {
            logger.add({
              level: 'info',
              source: 'webhook',
              message: `忽略 action=${action ?? '<missing>'}`,
            })
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }
        catch (err) {
          // eslint-disable-next-line no-console
          console.error('[superpowers/webhook] handler error:', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
        }
      })
      req.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[superpowers/webhook] request stream error:', err)
      })
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error('[superpowers/webhook] top-level error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'internal_error' }))
    }
  }
}

/**
 * Validate and normalise a gitea pull_request webhook payload. Returns null
 * for missing fields or non-actionable actions; the HTTP handler still
 * responds 200 in both cases.
 */
function parseEvent(issueNumber: number, raw: unknown): WebhookEvent | null {
  if (!raw || typeof raw !== 'object')
    return null
  const obj = raw as {
    action?: unknown
    pull_request?: unknown
  }
  if (typeof obj.action !== 'string')
    return null
  if (obj.action !== 'opened' && obj.action !== 'reopened')
    return null

  const pr = obj.pull_request
  if (!pr || typeof pr !== 'object')
    return null
  const prObj = pr as {
    number?: unknown
    html_url?: unknown
    head?: unknown
  }
  const num = typeof prObj.number === 'number' ? prObj.number : Number(prObj.number)
  if (!Number.isFinite(num))
    return null
  const htmlUrl = typeof prObj.html_url === 'string' ? prObj.html_url : ''
  const head = prObj.head as { ref?: unknown } | undefined
  const branch = head && typeof head.ref === 'string' ? head.ref : ''

  if (!branch || !htmlUrl)
    return null

  return {
    issueNumber,
    pr: String(num),
    branch,
    htmlUrl,
    raw,
  }
}

/** Best-effort string read of the `action` field, used only for log output. */
function extractAction(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object')
    return undefined
  const action = (raw as { action?: unknown }).action
  return typeof action === 'string' ? action : undefined
}
