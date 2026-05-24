/**
 * Spawn user-provided shell scripts around the worktree create / remove
 * lifecycle. Lets the user perform setup (copy `.env`, open IDE, …) and
 * teardown (close IDE, archive logs, …) without modifying extension code.
 *
 * Behavior contract:
 *   - script absent on disk → silently return `skipped` (default state).
 *   - script exits 0       → `ok`.
 *   - non-zero exit / spawn ENOENT / timeout → returned as a non-`ok`
 *     status; the caller surfaces a `warn`-style toast but never aborts
 *     the surrounding flow.
 *
 * Env vars injected into the child process:
 *   - WORKTREE_PATH    — absolute path of the worktree
 *   - WORKSPACE_ROOT   — absolute path of the main workspace
 *   - BRANCH           — feature branch name
 *   - ISSUE_NUMBER     — gitea issue number (decimal string)
 *   - MAIN_BRANCH      — settings.devBranch (default 'main')
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

const DEFAULT_POST_CREATE_REL = '.spx/worktree-post-create.sh'
const DEFAULT_PRE_REMOVE_REL = '.spx/worktree-pre-remove.sh'
const DEFAULT_IMPL_TAB_PRE_CREATE_REL = '.spx/impl-tab-pre-create.sh'
const DEFAULT_IMPL_TAB_POST_CLOSE_REL = '.spx/impl-tab-post-close.sh'
const HOOK_TIMEOUT_MS = 30_000

export interface HookContext {
  workspaceRoot: string
  worktreePath: string
  branch: string
  issueNumber: number
  mainBranch: string
  /** User-configured override path. Empty / undefined → use the default
   * `<workspaceRoot>/.spx/worktree-*.sh` location. */
  customScriptPath?: string
}

export type HookStatus = 'skipped' | 'ok' | 'failed' | 'timeout' | 'enoent'

export interface HookResult {
  status: HookStatus
  exitCode?: number
  stdout?: string
  stderr?: string
  errorMessage?: string
  scriptPath?: string
}

function resolveScriptPath(ctx: HookContext, defaultRelPath: string): string {
  const custom = (ctx.customScriptPath ?? '').trim()
  if (custom.length > 0)
    return path.isAbsolute(custom) ? custom : path.join(ctx.workspaceRoot, custom)
  return path.join(ctx.workspaceRoot, defaultRelPath)
}

async function runHook(ctx: HookContext, defaultRelPath: string): Promise<HookResult> {
  const scriptPath = resolveScriptPath(ctx, defaultRelPath)
  if (!existsSync(scriptPath))
    return { status: 'skipped', scriptPath }

  return new Promise<HookResult>((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        cwd: ctx.worktreePath,
        env: {
          ...process.env,
          WORKTREE_PATH: ctx.worktreePath,
          WORKSPACE_ROOT: ctx.workspaceRoot,
          BRANCH: ctx.branch,
          ISSUE_NUMBER: String(ctx.issueNumber),
          MAIN_BRANCH: ctx.mainBranch,
        },
        timeout: HOOK_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 'ok', exitCode: 0, stdout, stderr, scriptPath })
          return
        }
        const errCode = (err as NodeJS.ErrnoException).code
        // ENOENT here means `bash` itself isn't on PATH (script presence
        // was already checked above). Surface it distinctly so the warn
        // toast can be informative.
        if (errCode === 'ENOENT') {
          resolve({
            status: 'enoent',
            errorMessage: 'bash 不存在（PATH 中找不到）',
            stdout,
            stderr,
            scriptPath,
          })
          return
        }
        // Node's execFile reports timeout via `ETIMEDOUT` on err.code (and
        // also kills the process with SIGTERM by default).
        if (errCode === 'ETIMEDOUT' || (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          resolve({
            status: 'timeout',
            errorMessage: `脚本超时（${HOOK_TIMEOUT_MS / 1000}s）`,
            stdout,
            stderr,
            scriptPath,
          })
          return
        }
        resolve({
          status: 'failed',
          exitCode: typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
            ? (err as unknown as { code: number }).code
            : undefined,
          errorMessage: err.message,
          stdout,
          stderr,
          scriptPath,
        })
      },
    )
  })
}

export function runPostCreateHook(ctx: HookContext): Promise<HookResult> {
  return runHook(ctx, DEFAULT_POST_CREATE_REL)
}

export function runPreRemoveHook(ctx: HookContext): Promise<HookResult> {
  return runHook(ctx, DEFAULT_PRE_REMOVE_REL)
}

export function runImplTabPreCreateHook(ctx: HookContext): Promise<HookResult> {
  return runHook(ctx, DEFAULT_IMPL_TAB_PRE_CREATE_REL)
}

export function runImplTabPostCloseHook(ctx: HookContext): Promise<HookResult> {
  return runHook(ctx, DEFAULT_IMPL_TAB_POST_CLOSE_REL)
}
