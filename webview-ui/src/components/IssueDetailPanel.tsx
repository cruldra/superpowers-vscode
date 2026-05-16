import { ExternalLink, Terminal } from 'lucide-react'
import type { Issue } from '../types'
import { COLUMN_LABELS } from '../types'

interface IssueDetailPanelProps {
  issue: Issue | null
  onOpenInBrowser: (url: string) => void
  onResumeSession: (sessionId: string) => void
}

/**
 * Bottom row of the kanban. Shows the fields of the issue's state-JSON
 * comment (currently `column` + `sessionId`). Gitea metadata like author,
 * assignees, labels, body is intentionally NOT rendered — the kanban
 * already implies the column, and the state JSON is the source of truth
 * for our own data.
 */
export function IssueDetailPanel({ issue, onOpenInBrowser, onResumeSession }: IssueDetailPanelProps) {
  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center border-t border-[var(--vscode-panel-border)] p-3 text-xs opacity-60">
        按方向键或点击卡片查看详情
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto border-t border-[var(--vscode-panel-border)] p-3">
      <div className="flex items-center gap-3">
        <h3 className="flex-1 truncate text-sm font-medium">
          <span className="font-mono opacity-60">
            #
            {issue.number}
          </span>
          {' '}
          {issue.title}
        </h3>
        <button
          type="button"
          onClick={() => onOpenInBrowser(issue.htmlUrl)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--vscode-panel-border)] px-2 py-1 text-xs hover:bg-black/10 dark:hover:bg-white/10"
        >
          <ExternalLink className="size-3.5" />
          在 Gitea 打开
        </button>
      </div>

      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="opacity-60">column</dt>
        <dd>
          <span className="rounded border border-[var(--vscode-panel-border)] bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/5">
            {issue.column}
          </span>
          <span className="ml-2 opacity-60">{COLUMN_LABELS[issue.column]}</span>
        </dd>

        <dt className="opacity-60">sessionId</dt>
        <dd>
          {issue.sessionId
            ? (
                <button
                  type="button"
                  onClick={() => onResumeSession(issue.sessionId!)}
                  title={`claude --resume ${issue.sessionId}`}
                  className="inline-flex items-center gap-1 font-mono text-[var(--vscode-textLink-foreground)] underline hover:text-[var(--vscode-textLink-activeForeground)]"
                >
                  <Terminal className="size-3" />
                  {issue.sessionId}
                </button>
              )
            : <span className="opacity-50">—</span>}
        </dd>
      </dl>

      {issue.sessionId && (
        <p className="text-xs opacity-50">
          点击 sessionId 或按 Enter，在新终端运行
          {' '}
          <code className="font-mono">claude --resume</code>
          {' '}
          恢复对话。
        </p>
      )}
    </div>
  )
}
