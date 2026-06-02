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

/**
 * 轮询版会话捕获：snapshot 现有 .jsonl，之后每 intervalMs 轮询一次目录，
 * 返回首个新出现的 .jsonl 的 session id（去掉 .jsonl 后缀）。超时返回 null。
 *
 * 比 fs.watch 在繁忙/共享 projects 目录里更可靠：fs.watch 的 rename 事件在
 * 高并发写入的目录里会漏掉，导致永远等不到新会话。轮询通过周期性 readdir
 * diff 来避免这个问题。
 *
 * Caller is responsible for ensuring the directory exists before calling
 * (use `fs.mkdir(dir, { recursive: true })`).
 */
export async function pollForNewSession(opts: {
  projectsDir: string
  timeoutMs?: number
  intervalMs?: number
}): Promise<string | null> {
  const { projectsDir, timeoutMs = 120_000, intervalMs = 1000 } = opts

  let snapshot: Set<string>
  try {
    const existing = await fsp.readdir(projectsDir)
    snapshot = new Set(existing.filter(n => n.endsWith('.jsonl')))
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[superpowers] sessionWatcher: poll readdir failed', err)
    return null
  }

  return new Promise<string | null>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const deadline = Date.now() + timeoutMs

    const done = (sid: string | null): void => {
      if (settled)
        return
      settled = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      resolve(sid)
    }

    const tick = async (): Promise<void> => {
      if (settled)
        return
      if (Date.now() >= deadline) {
        done(null)
        return
      }
      let current: string[]
      try {
        current = await fsp.readdir(projectsDir)
      }
      catch {
        // 目录可能临时 readdir 失败（被并发改写等）；忽略本轮，继续轮询。
        return
      }
      const fresh = current.filter(n => n.endsWith('.jsonl') && !snapshot.has(n))
      if (fresh.length === 0)
        return
      // 多个新文件时取 mtime 最新的那个。
      let newest: string | null = null
      let newestMtime = -1
      for (const name of fresh) {
        try {
          const st = await fsp.stat(path.join(projectsDir, name))
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs
            newest = name
          }
        }
        catch {
          // 文件可能已被删除；跳过。
        }
      }
      if (settled)
        return
      if (newest)
        done(newest.slice(0, -'.jsonl'.length))
    }

    timer = setInterval(() => {
      void tick()
    }, intervalMs)
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
