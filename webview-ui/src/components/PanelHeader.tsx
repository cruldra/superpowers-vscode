import { GitCommit, Loader2, RefreshCw, Settings } from 'lucide-react'

interface Props {
  onRefresh: () => void
  onEditAuth: () => void
  commitRunning: boolean
  onCommit: () => void
}

export function PanelHeader({ onRefresh, onEditAuth, commitRunning, onCommit }: Props) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-[var(--vscode-panel-border)] px-2">
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
