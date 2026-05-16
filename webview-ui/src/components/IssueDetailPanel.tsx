import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Issue } from '../types'

interface IssueDetailPanelProps {
  issue: Issue | null
  onOpenInBrowser: (url: string) => void
}

/**
 * Format an ISO timestamp into a short human-readable relative string.
 *
 * Returns "刚刚", "Nm ago", "Nh ago", "Nd ago", or the calendar date for
 * anything older than 30 days.
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts))
    return ''
  const diffMs = Date.now() - ts
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60)
    return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60)
    return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24)
    return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay <= 30)
    return `${diffDay}d ago`
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function IssueDetailPanel({ issue, onOpenInBrowser }: IssueDetailPanelProps) {
  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center border-t border-[var(--vscode-panel-border)] p-3 text-xs opacity-60">
        按方向键或点击卡片查看详情
      </div>
    )
  }

  const stateClass
    = issue.state === 'open'
      ? 'border-state-green/60 bg-state-green/10 text-state-green'
      : 'border-state-purple/60 bg-state-purple/10 text-state-purple'

  return (
    <div className="flex h-full flex-col border-t border-[var(--vscode-panel-border)] p-3 overflow-y-auto">
      <div className="mb-2 flex items-center gap-3">
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

      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs opacity-90">
        <span className={cn('rounded border px-1.5 py-0.5', stateClass)}>
          {issue.state}
        </span>
        {issue.author && (
          <span className="opacity-80">
            @
            {issue.author}
          </span>
        )}
        {issue.assignees.length > 0 && (
          <span className="opacity-80">
            指派:
            {' '}
            {issue.assignees.map(a => `@${a}`).join(', ')}
          </span>
        )}
        <span className="opacity-70">{formatRelative(issue.createdAt)}</span>
        {issue.labels.map(label => (
          <span
            key={label.name}
            className="rounded px-1.5 py-0.5 text-white"
            style={{ backgroundColor: `#${label.color}` }}
          >
            {label.name}
          </span>
        ))}
      </div>

      <hr className="my-2 border-[var(--vscode-panel-border)]" />

      <pre className="whitespace-pre-wrap font-mono text-xs">
        {issue.body || '（无正文）'}
      </pre>
    </div>
  )
}
