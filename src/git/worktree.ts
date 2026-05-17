/**
 * Thin wrapper around `git worktree add -b` for the 实施 flow.
 *
 * We invoke the system `git` binary via `execFile` rather than depend on a
 * git library — keeps the surface minimal and lets the user benefit from
 * whatever git they already have configured.
 */

import { execFile } from 'node:child_process'

export interface WorktreeOpts {
  /** Absolute path to the main workspace root. */
  workspaceRoot: string
  /** Absolute path of the worktree to create. */
  worktreePath: string
  /** New branch name; e.g. `feature/abcd1234`. */
  branch: string
}

/**
 * Create a new git worktree with a freshly-created branch off current HEAD.
 *   git -C <workspaceRoot> worktree add <worktreePath> -b <branch>
 *
 * Rejects with a descriptive Error if git exits non-zero. The caller should
 * surface stderr to the user via a toast.
 */
export async function createWorktree(opts: WorktreeOpts): Promise<void> {
  const { workspaceRoot, worktreePath, branch } = opts
  return new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspaceRoot, 'worktree', 'add', worktreePath, '-b', branch],
      { timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) {
          // execFile sets `err.code` for non-zero exits; for spawn failures
          // (e.g. git not on PATH) it's a string like 'ENOENT'.
          const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
          const trimmed = (stderr ?? '').toString().trim() || err.message
          reject(new Error(`git worktree add 失败 (${code}): ${trimmed}`))
          return
        }
        resolve()
      },
    )
  })
}
