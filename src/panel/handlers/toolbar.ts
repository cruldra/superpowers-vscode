import type { Uri } from 'vscode'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import { extensions, workspace } from 'vscode'
import { listClaudeProfiles } from '../../cc/profiles'
import { spawnClaude } from '../../cc/spawnClaude'
import { findEnvFiles, lockEnvFiles, unlockEnvFiles } from '../../files/envLock'
import { checkBranchSync, runBranchSync } from '../../git/branchSync'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { makeNonce } from '../KanbanPanel'

/**
 * Minimal structural typing for the bits of the built-in `vscode.git`
 * extension API we consume to observe working-tree state.
 * Reference: microsoft/vscode → extensions/git/src/api/git.d.ts
 */
interface GitExtensionApiRepositoryStateChange {
  (listener: () => unknown): { dispose: () => void }
}

interface GitExtensionApiRepositoryState {
  readonly workingTreeChanges: ReadonlyArray<{ uri: Uri }>
  readonly indexChanges: ReadonlyArray<{ uri: Uri }>
  readonly untrackedChanges?: ReadonlyArray<{ uri: Uri }>
  readonly onDidChange: GitExtensionApiRepositoryStateChange
}

interface GitExtensionApiRepository {
  readonly rootUri: Uri
  readonly state: GitExtensionApiRepositoryState
}

interface GitExtensionApi {
  readonly repositories: ReadonlyArray<GitExtensionApiRepository>
}

interface GitExtensionExports {
  getAPI: (version: 1) => GitExtensionApi
}

export async function handleCommitRun(panel: KanbanWebviewPanel): Promise<void> {
  if (panel.commitRunning)
    return

  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先打开一个工作区文件夹',
      dismissOnTimer: 5000,
    })
    return
  }

  const profiles = await listClaudeProfiles()
  const deepseek = profiles.find(p => p.name === 'deepseek')
  if (!deepseek) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '未找到 deepseek profile，请在 /home/cruldra/Sources/cruldra-profile/claude-config/profiles/ 下创建 deepseek.json',
      dismissOnTimer: 8000,
    })
    return
  }

  panel.commitRunning = true
  panel.postMessage({ type: 'commit/state', running: true })

  try {
    // claude -p 提交流程可能跑得比较久（要 git add / 编 commit message / git
    // commit），所以给一个比较宽松的超时（30 min）。
    await spawnClaude({
      prompt: '提交下代码',
      cwd: workspaceRoot,
      profilePath: deepseek.path,
      timeoutMs: 30 * 60 * 1000,
      bare: true,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: '提交完成',
      dismissOnTimer: 5000,
    })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `提交失败: ${msg}`,
      dismissOnTimer: 8000,
    })
  }
  finally {
    panel.commitRunning = false
    panel.postMessage({ type: 'commit/state', running: false })
  }
}

export async function handleBranchSyncCheck(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  const s = getSettings(panel.context)
  const devBranch = s.devBranch
  // Empty string in storage means "follow devBranch" — resolve to
  // devBranch so the check naturally hits the "same branch" disabled
  // branch.
  const autoBuildBranch = s.autoBuildBranch.length > 0 ? s.autoBuildBranch : devBranch

  if (!workspaceRoot) {
    panel.postMessage({
      type: 'branch-sync/status',
      behind: 0,
      devBranch,
      autoBuildBranch,
      unavailable: true,
      reason: '请先打开一个工作区文件夹',
    })
    return
  }

  const status = await checkBranchSync({ workspaceRoot, devBranch, autoBuildBranch })
  panel.postMessage({ type: 'branch-sync/status', ...status })
}

export async function handleBranchSyncRun(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  const s = getSettings(panel.context)
  const devBranch = s.devBranch
  const autoBuildBranch = s.autoBuildBranch.length > 0 ? s.autoBuildBranch : devBranch

  if (!workspaceRoot) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先打开一个工作区文件夹',
      dismissOnTimer: 5000,
    })
    void handleBranchSyncCheck(panel)
    return
  }

  if (devBranch === autoBuildBranch) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'info',
      message: '开发分支与自动化构建分支相同，无需同步',
      dismissOnTimer: 5000,
    })
    void handleBranchSyncCheck(panel)
    return
  }

  try {
    await runBranchSync({ workspaceRoot, devBranch, autoBuildBranch })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: `已同步 ${devBranch} → ${autoBuildBranch}`,
      dismissOnTimer: 5000,
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `分支同步失败：${message}`,
      dismissOnTimer: 8000,
    })
  }
  finally {
    // Re-emit status regardless of success/failure so the button reflects
    // the new behind count (0 on success, unchanged on failure).
    void handleBranchSyncCheck(panel)
  }
}

export async function handleEnvLockCheck(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  // 用底层 get 不传默认值，能区分"从未设过"(undefined) 和"用户主动选 false"。
  const stored = panel.context.workspaceState.get<boolean>('envLocked')
  if (!workspaceRoot) {
    // 无工作区时无文件可锁，UI 默认显示锁定状态但 fileCount=0 等价于无操作。
    panel.postMessage({ type: 'env-lock/status', locked: stored ?? true, fileCount: 0 })
    return
  }

  if (stored === undefined) {
    // 首次启动：默认锁定 + 真正 chmod 0o444 + 持久化，避免 UI 与 fs 不一致。
    const result = await lockEnvFiles(workspaceRoot)
    await panel.context.workspaceState.update('envLocked', true)
    if (result.total === 0) {
      logger.add({
        level: 'info',
        source: 'panel',
        message: '首次启动：工作区无 .env 文件，跳过自动锁定',
      })
    }
    else if (result.failed.length === 0) {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `首次启动自动锁定 ${result.ok.length} 个 .env 文件`,
      })
    }
    else {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `首次启动自动锁定：成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`,
      })
    }
    panel.postMessage({
      type: 'env-lock/status',
      locked: true,
      fileCount: result.total,
      failedCount: result.failed.length > 0 ? result.failed.length : undefined,
    })
    return
  }

  const files = await findEnvFiles(workspaceRoot)
  panel.postMessage({ type: 'env-lock/status', locked: stored, fileCount: files.length })
}

export async function handleEnvLockToggle(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先打开一个工作区文件夹',
      dismissOnTimer: 5000,
    })
    void handleEnvLockCheck(panel)
    return
  }

  const prevLocked = panel.context.workspaceState.get<boolean>('envLocked', false)
  const nextLocked = !prevLocked
  const result = nextLocked
    ? await lockEnvFiles(workspaceRoot)
    : await unlockEnvFiles(workspaceRoot)

  await panel.context.workspaceState.update('envLocked', nextLocked)

  if (result.total === 0) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'info',
      message: '工作区无 .env 文件',
      dismissOnTimer: 5000,
    })
  }
  else if (result.failed.length === 0) {
    const verb = nextLocked ? '锁定' : '解锁'
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: `已${verb} ${result.ok.length} 个 .env 文件`,
      dismissOnTimer: 4000,
    })
  }
  else {
    const verb = nextLocked ? '锁定' : '解锁'
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `${verb}完成：成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`,
      dismissOnTimer: 8000,
    })
  }

  panel.postMessage({
    type: 'env-lock/status',
    locked: nextLocked,
    fileCount: result.total,
    failedCount: result.failed.length > 0 ? result.failed.length : undefined,
  })
}

export function updateHasChanges(panel: KanbanWebviewPanel, value: boolean): void {
  if (panel.hasGitChanges === value)
    return
  panel.hasGitChanges = value
  panel.postMessage({ type: 'commit/has-changes', value })
}

export function setupGitWatcher(panel: KanbanWebviewPanel): void {
  const wsRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!wsRoot)
    return

  const gitExt = extensions.getExtension<GitExtensionExports>('vscode.git')
  if (!gitExt) {
    logger.add({
      level: 'warn',
      source: 'panel',
      message: 'vscode.git 扩展未找到，提交按钮将持续显示',
    })
    // Fallback: keep the button visible so users can at least trigger
    // commits manually even though we can't observe state.
    updateHasChanges(panel, true)
    return
  }

  const activation = gitExt.isActive
    ? Promise.resolve(gitExt.exports)
    : Promise.resolve(gitExt.activate())

  void activation.then((exports) => {
    const api = exports.getAPI(1)
    const findRepo = (): GitExtensionApiRepository | undefined =>
      api.repositories.find(r => r.rootUri.fsPath === wsRoot)

    const updateState = (): void => {
      const repo = findRepo()
      if (!repo) {
        updateHasChanges(panel, false)
        return
      }
      const total
        = repo.state.workingTreeChanges.length
          + repo.state.indexChanges.length
          + (repo.state.untrackedChanges?.length ?? 0)
      updateHasChanges(panel, total > 0)
    }

    const subscribe = (repo: GitExtensionApiRepository): void => {
      panel.gitStateDisposable = repo.state.onDidChange(updateState)
    }

    updateState()
    const repo = findRepo()
    if (repo) {
      subscribe(repo)
      return
    }
    // vscode.git activation can resolve before its `repositories` array
    // has populated for the freshly opened workspace. Retry once after a
    // short delay; if still missing we just leave the button hidden.
    setTimeout(() => {
      const retried = findRepo()
      if (retried)
        subscribe(retried)
      updateState()
    }, 1000)
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'warn',
      source: 'panel',
      message: '激活 vscode.git 扩展失败，提交按钮将持续显示',
      details: msg,
    })
    updateHasChanges(panel, true)
  })
}
