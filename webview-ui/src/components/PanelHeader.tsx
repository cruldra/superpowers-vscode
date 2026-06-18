import { GitCommit, GitMerge, ListPlus, Loader2, Lock, RefreshCw, Settings, Unlock } from 'lucide-react'

interface Props {
  onRefresh: () => void
  onEditAuth: () => void
  commitRunning: boolean
  /** Whether the workspace git working tree has uncommitted changes. The
   * commit button is only rendered when this is true (or `commitRunning` is
   * true — we keep it visible mid-run so the spinner stays on screen even
   * if `cc` clears the tree before finishing). */
  hasChanges: boolean
  onCommit: () => void
  /** Commits the remote auto-build branch is behind the remote dev branch.
   * Combined with `branchSyncDisabled` to compute the button's disabled
   * state. */
  branchSyncBehind: number
  branchSyncRunning: boolean
  /** True when sync is structurally unavailable (same-branch / fetch fail
   * / not a repo / …). Disables the button regardless of `branchSyncBehind`. */
  branchSyncDisabled: boolean
  /** Hover tooltip, already includes branch names + behind count or the
   * unavailable reason. */
  branchSyncTitle: string
  onSyncBranch: () => void
  /** Whether the workspace's `.env*` files are currently chmod-locked (444).
   * Icon flips between Lock and Unlock based on this. */
  envLocked: boolean
  /** Number of `.env*` files discovered in the workspace at the last scan.
   * The button is disabled when 0 — nothing to lock. */
  envFileCount: number
  /** True while a chmod batch is in flight; disables the button to avoid
   * duplicate toggles. */
  envLockRunning: boolean
  /** Hover tooltip, already includes file count + current lock state. */
  envLockTitle: string
  onToggleEnvLock: () => void
  /** Whether YouTrack is configured. The「导入 YouTrack 工单」button is only
   * rendered when true. */
  youtrackConfigured: boolean
  /** Open the native multi-select dialog to pick which YouTrack issues to
   * mirror onto the board. */
  onImportYouTrack: () => void
}

export function PanelHeader({
  onRefresh,
  onEditAuth,
  commitRunning,
  hasChanges,
  onCommit,
  branchSyncBehind,
  branchSyncRunning,
  branchSyncDisabled,
  branchSyncTitle,
  onSyncBranch,
  envLocked,
  envFileCount,
  envLockRunning,
  envLockTitle,
  onToggleEnvLock,
  youtrackConfigured,
  onImportYouTrack,
}: Props) {
  const showCommit = hasChanges || commitRunning
  // Sync button is *always* rendered so the user can see status (vs the
  // commit button which auto-hides on a clean tree). Disabled when nothing
  // to push, unavailable, or already syncing.
  const syncDisabled = branchSyncRunning || branchSyncDisabled || branchSyncBehind <= 0
  // Env-lock button is always visible; disabled while a chmod batch is in
  // flight or when the workspace has no .env files to act on.
  const envLockDisabled = envLockRunning || envFileCount === 0
  return (
    <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-[var(--vscode-panel-border)] px-2">
      <button
        type="button"
        onClick={onSyncBranch}
        disabled={syncDisabled}
        title={branchSyncTitle}
        aria-label={branchSyncTitle}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {branchSyncRunning
          ? <Loader2 size={14} className="animate-spin" />
          : <GitMerge size={14} />}
      </button>
      <button
        type="button"
        onClick={onToggleEnvLock}
        disabled={envLockDisabled}
        title={envLockTitle}
        aria-label={envLockTitle}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {envLockRunning
          ? <Loader2 size={14} className="animate-spin" />
          : envLocked
            ? <Lock size={14} />
            : <Unlock size={14} />}
      </button>
      {showCommit && (
        <button
          type="button"
          onClick={onCommit}
          disabled={commitRunning}
          title="提交代码"
          aria-label="提交代码"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {commitRunning
            ? <Loader2 size={14} className="animate-spin" />
            : <GitCommit size={14} />}
        </button>
      )}
      {youtrackConfigured && (
        <button
          type="button"
          onClick={onImportYouTrack}
          title="导入 YouTrack 工单"
          aria-label="导入 YouTrack 工单"
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)]"
        >
          <ListPlus size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={onRefresh}
        title="刷新"
        aria-label="刷新"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)]"
      >
        <RefreshCw size={14} />
      </button>
      <button
        type="button"
        onClick={onEditAuth}
        title="重新配置 Gitea Token"
        aria-label="重新配置 Gitea Token"
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--vscode-toolbar-hoverBackground)]"
      >
        <Settings size={14} />
      </button>
    </div>
  )
}
