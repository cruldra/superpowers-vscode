import { useMemo } from 'react'
import { ExternalLink, Terminal } from 'lucide-react'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_LABELS, COLUMN_ORDER } from '../types'
import type { PropertyGroup } from './property-grid'
import { PropertyGrid } from './property-grid'

interface IssueDetailPanelProps {
  issue: Issue | null
  onOpenInBrowser: (url: string) => void
  onResumeSession: (sessionId: string) => void
}

/**
 * 底部详情面板：以 PropertyGrid 形式展示当前选中 issue 的 state JSON。
 *
 * 顶部一行是 #编号/标题 + 「在 Gitea 打开」按钮；下面是 PropertyGrid
 * 渲染的 state JSON 字段（当前为 column + sessionId）。sessionId 是
 * 一个 action 类型字段，点击或选中卡按 Enter 都会触发
 * `claude --resume <id>` 在新终端中恢复对话。
 */
export function IssueDetailPanel({
  issue,
  onOpenInBrowser,
  onResumeSession,
}: IssueDetailPanelProps) {
  const schema = useMemo<PropertyGroup[]>(
    () => [
      {
        id: 'state',
        label: 'state JSON',
        properties: [
          {
            key: 'column',
            label: 'column',
            type: 'select',
            readOnly: true,
            description: '工单所在的看板列；写入 issue 最后一条 JSON 评论的 column 字段',
            options: COLUMN_ORDER.map((c: IssueColumn) => ({
              label: `${c}（${COLUMN_LABELS[c]}）`,
              value: c,
            })),
          },
          {
            key: 'sessionId',
            label: 'sessionId',
            type: 'action',
            description: '点击在新终端运行 claude --resume <id> 恢复对话',
            actionIcon: <Terminal className="size-3.5" />,
            onAction: (v) => {
              if (typeof v === 'string' && v.length > 0)
                onResumeSession(v)
            },
          },
        ],
      },
    ],
    [onResumeSession],
  )

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center border-t border-[var(--vscode-panel-border)] p-3 text-xs opacity-60">
        按方向键或点击卡片查看详情
      </div>
    )
  }

  const data: Record<string, unknown> = {
    column: issue.column,
    sessionId: issue.sessionId ?? null,
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 border-t border-[var(--vscode-panel-border)] p-3">
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

      <div className="min-h-0 flex-1">
        <PropertyGrid schema={schema} data={data} hideToolbar fillHeight />
      </div>
    </div>
  )
}
