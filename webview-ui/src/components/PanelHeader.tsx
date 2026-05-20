import { GitCommit, GitMerge, Loader2, RefreshCw, Settings } from 'lucide-react'

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
}: Props) {
  const showCommit = hasChanges || commitRunning
  // Sync button is *always* rendered so the user can see status (vs the
  // commit button which auto-hides on a clean tree). Disabled when nothing
  // to push, unavailable, or already syncing.
  const syncDisabled = branchSyncRunning || branchSyncDisabled || branchSyncBehind <= 0
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
