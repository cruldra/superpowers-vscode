/**
 * Watch the codex sessions root directory for the next new `rollout-*.jsonl`
 * file to appear, returning its thread_id.
 *
 * Used by the auto-review flow: when we `sendText('codex exec review ...')`
 * into a terminal tab, codex writes its session transcript to
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`. We can't sniff
 * the terminal's stdout, so instead we watch this filesystem root for new
 * files and extract the thread_id from the filename / first line.
 *
 * File layout (probed 2026-05-20):
 *
 *   - Directory:   ~/.codex/sessions/YYYY/MM/DD/
 *   - Filename:    rollout-2026-04-27T02-57-26-019dcb27-58a6-70a1-a5d1-bfc7f3ed9d0a.jsonl
 *                                              └────────────── thread_id (UUID v7) ──────────────┘
 *   - First line:  {"timestamp":"...","type":"session_meta","payload":{"id":"019dcb27-...","cwd":"..."}}
 *
 * Strategy: prefer UUID extracted from the filename (no I/O); fall back to
 * parsing the first JSON line if the regex doesn't match.
 */

import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

/** UUID at the tail of `rollout-<ISO>-<uuid>.jsonl`. v7 UUIDs are still 8-4-4-4-12. */
const ROLLOUT_UUID_REGEX = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Try to extract a thread_id (UUID) from a rollout filename.
 * Returns null when the name doesn't match the expected pattern.
 */
function extractIdFromFilename(filename: string): string | null {
  const m = filename.match(ROLLOUT_UUID_REGEX)
  return m ? m[1] : null
}

/**
 * Read the first line of `filePath` and try to extract `payload.id`
 * (codex's session_meta thread id). Also accepts top-level `thread_id` /
 * `session_id` / `id` for robustness against future codex format tweaks.
 */
async function extractIdFromFirstLine(filePath: string): Promise<string | null> {
  let raw: string
  try {
    // Files are typically <100KB at session start; reading the whole thing
    // and slicing to the first newline is simpler than a streaming reader
    // and avoids race-with-partial-write issues.
    raw = await fsp.readFile(filePath, 'utf8')
  }
  catch {
    return null
  }
  const nl = raw.indexOf('\n')
  const firstLine = nl === -1 ? raw : raw.slice(0, nl)
  if (!firstLine.trim())
    return null
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object')
    return null
  const obj = parsed as Record<string, unknown>
  const payload = obj.payload
  if (payload && typeof payload === 'object') {
    const pid = (payload as Record<string, unknown>).id
    if (typeof pid === 'string' && pid.length > 0)
      return pid
  }
  for (const k of ['thread_id', 'session_id', 'id'] as const) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0)
      return v
  }
  return null
}

/**
 * Watch `baseDir` recursively for the next new `rollout-*.jsonl` file and
 * resolve with its thread_id. Resolves with null on timeout, watcher error,
 * or when `fs.watch` isn't supported on this platform.
 *
 * Caller is responsible for ensuring `baseDir` exists; if it doesn't, this
 * returns null immediately.
 */
export async function watchForNewCodexSession(opts: {
  /** Base directory to watch recursively, typically `~/.codex/sessions`. */
  baseDir: string
  /** Max milliseconds to wait before giving up. */
  timeoutMs: number
}): Promise<string | null> {
  const { baseDir, timeoutMs } = opts

  try {
    const stat = await fsp.stat(baseDir)
    if (!stat.isDirectory())
      return null
  }
  catch {
    // baseDir doesn't exist (codex never run on this machine?). The first
    // codex run will create it, but `fs.watch` on a missing path throws —
    // bail out so the caller doesn't hang.
    return null
  }

  return new Promise<string | null>((resolve) => {
    let settled = false
    let watcher: fs.FSWatcher | null = null
    let timer: NodeJS.Timeout | null = null
    // Dedupe: fs.watch fires 'rename' twice on some platforms; skip files we
    // already inspected this session.
    const seen = new Set<string>()

    const done = (id: string | null): void => {
      if (settled)
        return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (watcher) {
        try {
          watcher.close()
        }
        catch {
          // ignore close errors
        }
        watcher = null
      }
      resolve(id)
    }

    try {
      // `recursive: true` is supported on Linux since Node 20. On older
      // runtimes the call throws — fall through to done(null).
      watcher = fs.watch(baseDir, { persistent: false, recursive: true }, (event, filename) => {
        if (settled || !filename)
          return
        if (event !== 'rename')
          return
        const name = filename.toString()
        if (!name.endsWith('.jsonl'))
          return
        const base = path.basename(name)
        if (!base.startsWith('rollout-'))
          return
        if (seen.has(name))
          return
        seen.add(name)

        const full = path.join(baseDir, name)
        // `rename` fires for both create AND delete; confirm the file is
        // really there before claiming a hit.
        fsp.stat(full).then(async () => {
          if (settled)
            return
          let id = extractIdFromFilename(base)
          if (!id)
            id = await extractIdFromFirstLine(full)
          if (id)
            done(id)
        }).catch(() => {
          // File no longer exists (delete event) — ignore.
        })
      })
      watcher.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.warn('[superpowers] codexSessionWatcher: watch error', err)
        done(null)
      })
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[superpowers] codexSessionWatcher: fs.watch threw', err)
      done(null)
      return
    }

    timer = setTimeout(() => {
      done(null)
    }, timeoutMs)
  })
}
