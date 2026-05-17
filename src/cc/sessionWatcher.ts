/**
 * Watch a claude projects directory for the next new .jsonl file to appear.
 *
 * Used by the "实施" flow: when we spawn `claude` in a worktree, the CLI
 * writes its session transcript to `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 * We pre-snapshot the directory, then watch for any new `.jsonl` whose name
 * isn't in the snapshot — that file's basename (minus `.jsonl`) is the
 * implementation session id.
 */

import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Watch a claude projects directory for the next new .jsonl file to appear,
 * returning its basename (without the .jsonl suffix) — that's the session id.
 *
 * Pre-snapshots existing files at start time so a later-created file is what
 * resolves the promise. Times out to null after `timeoutMs`.
 *
 * Caller is responsible for ensuring the directory exists before calling
 * (use `fs.mkdir(dir, { recursive: true })`).
 */
export async function watchForNewSession(opts: {
  projectsDir: string
  timeoutMs?: number
}): Promise<string | null> {
  const { projectsDir, timeoutMs = 120_000 } = opts

  let snapshot: Set<string>
  try {
    const existing = await fsp.readdir(projectsDir)
    snapshot = new Set(existing.filter(n => n.endsWith('.jsonl')))
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[superpowers] sessionWatcher: readdir failed', err)
    return null
  }

  return new Promise<string | null>((resolve) => {
    let settled = false
    let watcher: fs.FSWatcher | null = null
    let timer: NodeJS.Timeout | null = null

    const done = (sid: string | null): void => {
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
      resolve(sid)
    }

    try {
      watcher = fs.watch(projectsDir, { persistent: false }, (event, filename) => {
        if (settled)
          return
        if (event !== 'rename' || !filename)
          return
        const name = filename.toString()
        if (!name.endsWith('.jsonl'))
          return
        if (snapshot.has(name))
          return
        // `rename` fires for both create and delete; confirm the file is
        // really there before resolving.
        const full = path.join(projectsDir, name)
        fsp.stat(full).then(() => {
          if (settled)
            return
          const sid = name.slice(0, -'.jsonl'.length)
          done(sid)
        }).catch(() => {
          // File no longer exists (delete event) — ignore.
        })
      })
      watcher.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.warn('[superpowers] sessionWatcher: watch error', err)
        done(null)
      })
    }
    catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[superpowers] sessionWatcher: fs.watch threw', err)
      done(null)
      return
    }

    timer = setTimeout(() => {
      done(null)
    }, timeoutMs)
  })
}

/** Convert an absolute path to claude's projects-dir encoding ('/' -> '-'). */
export function encodeCwdForProjectsDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-')
}

/** Absolute path of the claude projects subdir for a given cwd. */
export function projectsDirFor(absCwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwdForProjectsDir(absCwd))
}
