/**
 * Spawns `codex exec review --json` headlessly and waits for it to finish.
 *
 * Output handling: codex itself is responsible for posting the review back
 * as a PR comment (instructed via the review prompt). This wrapper only
 * scans codex's NDJSON stdout for the very first `thread.started` event so
 * the caller can persist the `thread_id` (review session id) for manual
 * resume; everything after that is ignored. Failures are logged but never
 * thrown — the webhook coordinator treats review runs as fire-and-forget.
 */

import { spawn } from 'node:child_process'
import { logger } from '../logging/logger'

export interface RunReviewOpts {
  workspaceRoot: string
  /** Already-substituted prompt — placeholders must be resolved by the caller. */
  prompt: string
  /** Spawn timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number
  /**
   * Called once with the codex `thread_id` parsed from the first
   * `thread.started` NDJSON event. Errors thrown inside this callback are
   * caught and logged — they never propagate out of `runReview`.
   */
  onThreadId?: (id: string) => void | Promise<void>
}

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Run `codex exec review --json` and wait for it to exit. Errors are
 * logged as warnings; this function never throws.
 */
export async function runReview(opts: RunReviewOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args: string[] = [
    'exec',
    '-c',
    'model_reasoning_effort=xhigh',
    'review',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    opts.prompt,
  ]

  await new Promise<void>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('codex', args, {
        cwd: opts.workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    catch (err) {
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'codex exec review 启动失败',
        details: err instanceof Error ? err.message : String(err),
      })
      resolve()
      return
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      }
      catch {
        // ignore
      }
    }, timeoutMs)

    // NDJSON parsing: accumulate stdout, split on newline, parse each line.
    // Stop parsing after the first `thread.started` event — let the rest
    // of stdout drain to /dev/null so codex can keep running.
    let buf = ''
    let threadIdHandled = false
    let stderrTail = ''

    let diagLogged = 0
    const handleLine = (line: string): void => {
      if (threadIdHandled || !line.trim())
        return
      // Diagnostic: log the first 3 lines so we can inspect codex's actual
      // event shape if thread id detection misses.
      if (diagLogged < 3) {
        logger.add({
          level: 'info',
          source: 'webhook',
          message: `codex stdout[${diagLogged}]`,
          details: line.slice(0, 500),
        })
        diagLogged += 1
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      }
      catch {
        return
      }
      if (!parsed || typeof parsed !== 'object')
        return
      const obj = parsed as { type?: unknown, thread_id?: unknown, session_id?: unknown, id?: unknown }
      // Try multiple field names: thread_id (current), session_id (older
      // codex), id (fallback when the event is a "session created" shape).
      // Accept any event so long as it carries one of these as a string.
      const candidate
        = (typeof obj.thread_id === 'string' && obj.thread_id.length > 0 && obj.thread_id)
        || (typeof obj.session_id === 'string' && obj.session_id.length > 0 && obj.session_id)
        || (typeof obj.id === 'string' && obj.id.length > 0 && /^[0-9a-f-]{16,}$/i.test(obj.id) && obj.id)
        || ''
      if (candidate) {
        threadIdHandled = true
        const id = candidate
        if (opts.onThreadId) {
          try {
            const ret = opts.onThreadId(id)
            if (ret && typeof (ret as Promise<unknown>).then === 'function') {
              ;(ret as Promise<unknown>).catch((err) => {
                logger.add({
                  level: 'warn',
                  source: 'webhook',
                  message: 'onThreadId 回调异常',
                  details: err instanceof Error ? err.message : String(err),
                })
              })
            }
          }
          catch (err) {
            logger.add({
              level: 'warn',
              source: 'webhook',
              message: 'onThreadId 回调抛错',
              details: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    }

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (threadIdHandled)
        return
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        handleLine(line)
        if (threadIdHandled) {
          buf = ''
          break
        }
        idx = buf.indexOf('\n')
      }
    })

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      // Keep only the tail so we can include it in the failure message.
      stderrTail = (stderrTail + chunk).slice(-2000)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      logger.add({
        level: 'warn',
        source: 'webhook',
        message: 'codex exec review 进程错误',
        details: err instanceof Error ? err.message : String(err),
      })
      resolve()
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: `codex exec review 超时 (${timeoutMs}ms)`,
          details: stderrTail.slice(-500),
        })
      }
      else if ((code !== null && code !== 0) || (signal && !timedOut)) {
        logger.add({
          level: 'warn',
          source: 'webhook',
          message: `codex exec review 退出码异常 code=${code} signal=${signal ?? '<none>'}`,
          details: stderrTail.slice(-500),
        })
      }
      resolve()
    })
  })
}
