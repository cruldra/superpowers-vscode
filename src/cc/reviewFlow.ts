/**
 * Wraps `codex exec review` (and `codex exec resume`) for the auto-review
 * flow. Spawns codex headlessly, captures the rendered review text via the
 * `-o <file>` output flag, and parses the JSON event stream just enough to
 * pick up the `thread.started` thread_id so the caller can persist it for
 * subsequent `synchronize` callbacks.
 *
 * Output buffering note: stdout is capped at 10 MiB, which is enormous for
 * a single review run (JSON events are short). The actual review prose is
 * written to a temp file and read back as UTF-8 after exit.
 */

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface RunReviewOpts {
  workspaceRoot: string
  /** Already-substituted prompt — placeholders must be resolved by the caller. */
  prompt: string
  /** If set, resume an existing codex thread instead of starting a new one. */
  resumeFrom?: string
  /** Spawn timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number
}

export interface RunReviewResult {
  /** New codex thread id captured from a `thread.started` event, or null when
   * resuming (codex doesn't always re-emit that event on resume). */
  sessionId: string | null
  /** UTF-8 contents of the review output file. */
  text: string
}

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_STDOUT_BYTES = 10 * 1024 * 1024

/**
 * Run `codex exec review` (or `codex exec resume <id>`) and capture the
 * rendered review text plus the new thread id (when starting fresh).
 *
 * Rejects with a descriptive Error on spawn failure (ENOENT), non-zero
 * exit, or timeout — including a stderr excerpt in the message.
 */
export async function runReview(opts: RunReviewOpts): Promise<RunReviewResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tmpFile = path.join(
    os.tmpdir(),
    `superpowers-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  )

  const args: string[] = opts.resumeFrom
    ? ['exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', opts.resumeFrom, '--json', '-o', tmpFile, opts.prompt]
    : ['exec', 'review', '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', tmpFile, opts.prompt]

  const { stdout, stderr } = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
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
        const stdoutStr = stdoutBuf ?? ''
        const stderrStr = stderrBuf ?? ''
        if (err) {
          const errAny = err as NodeJS.ErrnoException & { killed?: boolean, signal?: string }
          const excerpt = (stderrStr || stdoutStr).slice(0, 500)
          if (errAny.code === 'ENOENT') {
            reject(new Error(`codex 未安装或不在 PATH 中 (ENOENT): ${err.message}`))
            return
          }
          if (errAny.killed && errAny.signal === 'SIGTERM') {
            reject(new Error(`codex 超时 (${timeoutMs}ms) — stderr: ${excerpt}`))
            return
          }
          reject(new Error(`codex exit 非 0: ${err.message} — stderr: ${excerpt}`))
          return
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr })
      },
    )
  })

  // Pick out the first thread.started event for the session id.
  let sessionId: string | null = null
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line)
      continue
    try {
      const parsed = JSON.parse(line) as { type?: unknown, thread_id?: unknown }
      if (parsed && typeof parsed === 'object'
        && parsed.type === 'thread.started'
        && typeof parsed.thread_id === 'string'
        && parsed.thread_id.length > 0) {
        sessionId = parsed.thread_id
        break
      }
    }
    catch {
      // Non-JSON line (e.g. banner). Ignore.
    }
  }

  let text: string
  try {
    text = await fsp.readFile(tmpFile, 'utf-8')
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`读取 codex 输出文件失败 (${tmpFile}): ${message} — stderr: ${stderr.slice(0, 500)}`)
  }

  // Best-effort cleanup; ignore failures.
  fsp.unlink(tmpFile).catch(() => {})

  return { sessionId, text }
}
