/**
 * Spawns `codex exec review` headlessly and waits for it to finish.
 *
 * Output handling: codex itself is responsible for posting the review back
 * as a PR comment (instructed via the review prompt). This wrapper neither
 * captures stdout nor reads any temp file; failures are logged but never
 * thrown — the webhook coordinator treats review runs as fire-and-forget.
 */

import { execFile } from 'node:child_process'
import { logger } from '../logging/logger'

export interface RunReviewOpts {
  workspaceRoot: string
  /** Already-substituted prompt — placeholders must be resolved by the caller. */
  prompt: string
  /** Spawn timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_STDOUT_BYTES = 10 * 1024 * 1024

/**
 * Run `codex exec review` and wait for it to exit. Errors are logged as
 * warnings; this function never throws.
 */
export async function runReview(opts: RunReviewOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args: string[] = ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', opts.prompt]

  await new Promise<void>((resolve) => {
    execFile(
      'codex',
      args,
      {
        cwd: opts.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES,
        encoding: 'utf-8',
      },
      (err, stdoutBuf, stderrBuf) => {
        if (err) {
          const stderrStr = stderrBuf ?? ''
          const stdoutStr = stdoutBuf ?? ''
          const excerpt = (stderrStr || stdoutStr).slice(0, 500)
          const errAny = err as NodeJS.ErrnoException & { killed?: boolean, signal?: string }
          let message: string
          if (errAny.code === 'ENOENT')
            message = `codex 未安装或不在 PATH 中 (ENOENT): ${err.message}`
          else if (errAny.killed && errAny.signal === 'SIGTERM')
            message = `codex 超时 (${timeoutMs}ms) — stderr: ${excerpt}`
          else
            message = `codex exit 非 0: ${err.message} — stderr: ${excerpt}`
          logger.add({
            level: 'warn',
            source: 'webhook',
            message: 'codex exec review 失败',
            details: message,
          })
        }
        resolve()
      },
    )
  })
}
