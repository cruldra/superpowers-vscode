import type { HookContext } from '../../git/worktreeHooks'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { commands, Uri, window, workspace } from 'vscode'
import { getToken } from '../../auth/secrets'
import { detectRepo } from '../../git/remote'
import {
  runImplTabPostCloseHook,
  runImplTabPreCreateHook,
  runPostCreateHook,
  runPreRemoveHook,
} from '../../git/worktreeHooks'
import { mergeStateJsonComment, readStateJsonComment } from '../../gitea/stateJson'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { makeNonce } from '../KanbanPanel'

/**
 * Open the worktree directory in a **new** VS Code window. The Boolean
 * third arg to `vscode.openFolder` is "forceNewWindow"; we always force
 * a new window so the user keeps the kanban window open in parallel.
 */
export async function handleOpenWorktree(panel: KanbanWebviewPanel, relPath: string): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showErrorMessage('请先打开一个工作区文件夹')
    return
  }
  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath)
  try {
    await commands.executeCommand('vscode.openFolder', Uri.file(abs), true)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void window.showErrorMessage(`打开 worktree 失败: ${message}`)
  }
}

/**
 * Confirm + run `git worktree remove <abs>` (no --force), then clear
 * `worktreePath`/`branch` from the issue's state JSON and refresh the
 * board. If `git` rejects due to uncommitted changes we surface stderr
 * verbatim — the user can resolve manually and re-try.
 */
export async function handleDeleteWorktree(panel: KanbanWebviewPanel, issueNumber: number, relPath: string): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showErrorMessage('请先打开一个工作区文件夹')
    return
  }
  const choice = await window.showWarningMessage(
    `确认删除 worktree ${relPath}?`,
    { modal: true },
    '删除',
  )
  if (choice !== '删除')
    return

  const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath)

  // Run the pre-remove lifecycle hook so the user can tear down resources
  // (close IDE windows, etc.) before the worktree dir vanishes. Best-effort
  // — never blocks the removal.
  const settingsForHook = getSettings(panel.context)
  await dispatchWorktreeHook(panel, 'pre-remove', {
    workspaceRoot,
    worktreePath: abs,
    branch: '',
    issueNumber,
    mainBranch: settingsForHook.devBranch || 'main',
    customScriptPath: settingsForHook.worktreePreRemoveScript,
  })

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['-C', workspaceRoot, 'worktree', 'remove', abs],
        { timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (err) {
            const detail = (stderr ?? '').trim() || err.message
            reject(new Error(detail))
            return
          }
          resolve()
        },
      )
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void window.showErrorMessage(`git worktree remove 失败: ${message}`)
    return
  }

  // Best-effort: clear worktreePath + branch from the state JSON so the
  // detail panel reflects reality on the next refresh. Failures here are
  // non-fatal (worktree is already gone on disk).
  try {
    const remote = await detectRepo(workspaceRoot)
    if (remote) {
      const token = await getToken(panel.context, remote.host)
      if (token) {
        await mergeStateJsonComment({
          host: remote.host,
          owner: remote.owner,
          repo: remote.repo,
          token,
          issueNumber,
          extra: { worktreePath: '', branch: '' },
        })
      }
    }
  }
  catch (err) {
    console.warn('[superpowers] failed to clear worktree state JSON:', err)
  }

  panel.postMessage({
    type: 'issue/patch',
    issueNumber,
    patch: {
      worktreePath: undefined,
      branch: undefined,
      worktreeExists: false,
    },
  })
  void window.showInformationMessage(`已删除 worktree #${issueNumber}`)
}

/**
 * Run a user-provided shell script (post-create / pre-remove) and surface
 * the outcome via logger + a toast. Always returns — failures of any
 * kind never abort the calling flow, per the lifecycle-hook contract:
 * worktree creation / removal is the source of truth, user scripts are
 * best-effort sidecars.
 */
export async function dispatchWorktreeHook(
  panel: KanbanWebviewPanel,
  phase: 'post-create' | 'pre-remove' | 'impl-tab-pre-create' | 'impl-tab-post-close',
  ctx: HookContext,
): Promise<void> {
  let result
  switch (phase) {
    case 'post-create': result = await runPostCreateHook(ctx); break
    case 'pre-remove': result = await runPreRemoveHook(ctx); break
    case 'impl-tab-pre-create': result = await runImplTabPreCreateHook(ctx); break
    case 'impl-tab-post-close': result = await runImplTabPostCloseHook(ctx); break
  }

  // 'skipped' = the script simply isn't on disk. That's the intended
  // default state — stay silent, don't pester the user.
  if (result.status === 'skipped')
    return

  if (result.status === 'ok') {
    logger.add({
      level: 'info',
      source: 'panel',
      message: `worktree ${phase} 钩子完成 #${ctx.issueNumber}`,
      details: `path=${result.scriptPath}\nstdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}`,
    })
    return
  }

  // Anything else (failed / timeout / enoent) — warn-level log + a
  // toast. ToastLevel only has 'info' | 'success' | 'error'; we use
  // 'info' to keep it non-blocking, matching the "doesn't affect main
  // flow" semantics. Detailed stdout/stderr stays in the log to avoid
  // spamming the toast surface.
  const label = {
    'post-create': '创建后',
    'pre-remove': '删除前',
    'impl-tab-pre-create': '实施 tab 创建前',
    'impl-tab-post-close': '实施 tab 关闭后',
  }[phase]
  logger.add({
    level: 'warn',
    source: 'panel',
    message: `worktree ${phase} 钩子失败 #${ctx.issueNumber}: ${result.status}`,
    details: [
      `path=${result.scriptPath ?? '(unresolved)'}`,
      result.exitCode !== undefined ? `exitCode=${result.exitCode}` : null,
      result.errorMessage ? `err=${result.errorMessage}` : null,
      result.stdout ? `stdout=${result.stdout}` : null,
      result.stderr ? `stderr=${result.stderr}` : null,
    ].filter((line): line is string => line !== null).join('\n'),
  })
  panel.postMessage({
    type: 'toast/show',
    id: makeNonce(),
    level: 'info',
    message: `worktree ${label}钩子失败 #${ctx.issueNumber}（不影响后续流程，详情见日志）`,
    dismissOnTimer: 5000,
  })
}

/**
 * 实施 cc tab 被关闭后异步触发 impl-tab-post-close 钩子。
 * 由 onDidCloseTerminal 同步回调里 fire-and-forget 调用，所以这里把整个
 * 错误 catch 进 log，不向上抛。需要从 state JSON 读 worktreePath / branch。
 */
export async function dispatchImplTabPostCloseAsync(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  try {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot)
      return
    const remote = await detectRepo(workspaceRoot)
    if (!remote)
      return
    const token = await getToken(panel.context, remote.host)
    if (!token)
      return
    const stateObj = await readStateJsonComment({
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      token,
      issueNumber,
    })
    const branch = typeof stateObj.branch === 'string' ? stateObj.branch : ''
    const wt = typeof stateObj.worktreePath === 'string' ? stateObj.worktreePath : ''
    if (!wt)
      return
    const absWorktree = path.isAbsolute(wt) ? wt : path.join(workspaceRoot, wt)
    const settings = getSettings(panel.context)
    await dispatchWorktreeHook(panel, 'impl-tab-post-close', {
      workspaceRoot,
      worktreePath: absWorktree,
      branch,
      issueNumber,
      mainBranch: settings.devBranch || 'main',
      customScriptPath: settings.implTabPostCloseScript,
    })
  }
  catch (err) {
    logger.add({
      level: 'warn',
      source: 'panel',
      message: `impl-tab-post-close 钩子调度失败 #${issueNumber}`,
      details: err instanceof Error ? err.message : String(err),
    })
  }
}
