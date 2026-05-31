/**
 * Branch-sync helpers: fast-forward the remote auto-build branch up to the
 * remote dev branch (no working-tree side effects).
 *
 * Drives the toolbar "branch sync" button. Caller is responsible for
 * resolving an empty `autoBuildBranch` to fall back to `devBranch` *before*
 * calling — these helpers treat the inputs as final.
 *
 * We shell out to the system `git` binary via `execFile` to match the rest
 * of this codebase (`src/git/remote.ts`, `src/git/worktree.ts`); no working
 * tree is touched (no checkout / no fetch into local refs that the user
 * might be sitting on).
 */

import { execFile } from 'node:child_process'

export interface BranchSyncStatus {
  /** Commits remote `autoBuildBranch` is behind remote `devBranch`. 0 when
   * already in sync, or when `unavailable` (the field is still numeric so
   * callers don't have to special-case it). */
  behind: number
  devBranch: string
  autoBuildBranch: string
  /** True when sync is structurally impossible (same branch, missing remote
   * ref, fetch failed, not a git repo, …). Disables the toolbar button. */
  unavailable?: boolean
  /** Human-readable explanation, suitable for the button's tooltip. */
  reason?: string
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: string | number | undefined
}

function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? err.message
          resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', code })
          return
        }
        resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: undefined })
      },
    )
  })
}

/**
 * 通用 git fetch origin，best-effort。返回 ok 标志和 stderr 供调用方记日志。
 * 超时 30s。
 */
export async function gitFetch(workspaceRoot: string): Promise<{ ok: boolean, stderr: string, stdout: string }> {
  const r = await runGit(workspaceRoot, ['fetch', 'origin'])
  return { ok: r.ok, stderr: r.stderr, stdout: r.stdout }
}

/**
 * 删除本地分支。分支不存在时视为已清理，避免重复完成流程产生噪音。
 */
export async function deleteLocalBranch(workspaceRoot: string, branch: string): Promise<{ ok: boolean, stdout: string, stderr: string }> {
  const exists = await runGit(workspaceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!exists.ok)
    return { ok: true, stdout: '', stderr: '' }

  const r = await runGit(workspaceRoot, ['branch', '-D', branch])
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr }
}

export interface CheckBranchSyncOpts {
  workspaceRoot: string
  /** Already non-empty (caller falls back to devBranch when autoBuild is ''). */
  devBranch: string
  autoBuildBranch: string
}

/**
 * Returns how far the remote auto-build branch is behind the remote dev
 * branch. Never throws — failures collapse into `unavailable: true` with a
 * `reason` suitable for surfacing in a tooltip.
 */
export async function checkBranchSync(opts: CheckBranchSyncOpts): Promise<BranchSyncStatus> {
  const { workspaceRoot, devBranch, autoBuildBranch } = opts

  if (devBranch === autoBuildBranch) {
    return {
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: '开发分支与自动化构建分支相同',
    }
  }

  // Bail out early if we're not inside a git work-tree at all — otherwise
  // the fetch error message ("not a git repository") would land in the
  // tooltip and look like a real failure.
  const insideRepo = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'], 5_000)
  if (!insideRepo.ok) {
    return {
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: '当前工作区不是 git 仓库',
    }
  }

  // Fetch *just* the two refs we care about. We don't `--prune` because we
  // don't want to perturb other tracking branches the user may be looking at.
  const fetched = await runGit(workspaceRoot, ['fetch', 'origin', devBranch, autoBuildBranch])
  if (!fetched.ok) {
    const trimmed = fetched.stderr.trim() || String(fetched.code ?? 'unknown')
    return {
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: `获取远端失败：${trimmed}`,
    }
  }

  const counted = await runGit(workspaceRoot, [
    'rev-list',
    '--count',
    `origin/${autoBuildBranch}..origin/${devBranch}`,
  ])
  if (!counted.ok) {
    const trimmed = counted.stderr.trim() || String(counted.code ?? 'unknown')
    return {
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: `无法对比分支：${trimmed}`,
    }
  }

  const behind = Number.parseInt(counted.stdout.trim(), 10)
  if (!Number.isInteger(behind) || behind < 0) {
    return {
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: '解析落后提交数失败',
    }
  }

  return { behind, devBranch, autoBuildBranch }
}

export interface RunBranchSyncOpts {
  workspaceRoot: string
  devBranch: string
  autoBuildBranch: string
}

/**
 * Fast-forward push the remote autoBuild branch up to remote dev. Throws on
 * any git failure (caller surfaces as a toast). Never `--force`-pushes —
 * if the push is rejected because autoBuild has diverged, the user has to
 * sort it out manually.
 */
export async function runBranchSync(opts: RunBranchSyncOpts): Promise<void> {
  const { workspaceRoot, devBranch, autoBuildBranch } = opts

  // Re-fetch so the push uses the freshest remote dev SHA. Cheap; matches
  // what checkBranchSync did, but the user may have clicked sync minutes
  // later.
  const fetched = await runGit(workspaceRoot, ['fetch', 'origin', devBranch, autoBuildBranch])
  if (!fetched.ok) {
    const trimmed = fetched.stderr.trim() || String(fetched.code ?? 'unknown')
    throw new Error(`git fetch 失败：${trimmed}`)
  }

  // `git push origin <src>:refs/heads/<dst>` — server-side fast-forward only.
  // We push the *remote-tracking* ref (origin/<dev>) so we don't depend on
  // any local branch checkout state.
  const pushed = await runGit(workspaceRoot, [
    'push',
    'origin',
    `origin/${devBranch}:refs/heads/${autoBuildBranch}`,
  ])
  if (!pushed.ok) {
    const trimmed = pushed.stderr.trim() || pushed.stdout.trim() || String(pushed.code ?? 'unknown')
    throw new Error(`git push 失败：${trimmed}`)
  }
}
