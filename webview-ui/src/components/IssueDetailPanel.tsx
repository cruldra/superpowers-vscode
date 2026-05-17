import { useMemo } from 'react'
import { ExternalLink, Play, Terminal, Trash2 } from 'lucide-react'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_LABELS, COLUMN_ORDER } from '../types'
import type { PropertyGroup } from './property-grid'
import { PropertyGrid } from './property-grid'

interface IssueDetailPanelProps {
  issue: Issue | null
  onOpenInBrowser: (url: string) => void
  onResumeSession: (sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number) => void
  /** Open a new terminal that runs `codex resume <id>` for the auto-review
   * conversation associated with this issue. */
  onResumeReviewSession: (sessionId: string, issueNumber: number, cwd?: string) => void
  /** Open a workspace-relative file in the editor. */
  onOpenFile: (path: string) => void
  /** Scan the Claude session transcript for `sessionId` and merge any
   * discovered spec/plan paths into the issue's state-JSON comment. */
  onLoadFiles: (sessionId: string | undefined, issueNumber: number) => void
  /** Kick off the end-to-end implementation flow for the given plan file. */
  onImplement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  /** Open the gitea PR page in the browser. */
  onOpenPr: (pr: string) => void
  /** Open the workspace-relative worktree path in a new VS Code window. */
  onOpenWorktree: (path: string) => void
  /** Delete the worktree (`git worktree remove`) and clear it from state. */
  onDeleteWorktree: (issueNumber: number, path: string) => void
  /** Open the in-webview log modal. */
  onOpenLogs: () => void
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
  onResumeReviewSession,
  onOpenFile,
  onLoadFiles,
  onImplement,
  onOpenPr,
  onOpenWorktree,
  onDeleteWorktree,
  onOpenLogs,
}: IssueDetailPanelProps) {
  const schema = useMemo<PropertyGroup[]>(
    () => [
      {
        id: 'state',
        label: 'state JSON',
        actions: (
          <button
            type="button"
            onClick={onOpenLogs}
            title="查看扩展日志"
            aria-label="查看扩展日志"
            className="grid size-5 place-items-center rounded opacity-60 hover:opacity-100"
          >
            <Terminal className="size-3.5" />
          </button>
        ),
        properties: [
          {
            key: 'column',
            label: '状态',
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
            label: '头脑风暴会话id',
            type: 'action',
            description: '点击在新终端运行 claude --resume <id> 恢复对话',
            actionIcon: <Terminal className="size-3.5" />,
            onAction: (v) => {
              if (typeof v === 'string' && v.length > 0)
                onResumeSession(v, issue?.profilePath, undefined, issue?.number)
            },
          },
          // 实施 / 审查 会话依赖 worktree；worktree 被清掉（典型场景：拖到
          // 完成 列后扩展自动 worktree remove）后 resume 会失败，所以从
          // action 降级为只读 string，只留 id 文本。
          issue?.worktreeExists
            ? {
                key: 'implementSessionId',
                label: '实施会话id',
                type: 'action',
                description: '点击在新终端运行 claude --resume <id> 恢复实施对话（cwd 为 worktree）',
                actionIcon: <Terminal className="size-3.5" />,
                onAction: (v) => {
                  if (typeof v === 'string' && v.length > 0)
                    onResumeSession(v, issue?.profilePath, issue?.worktreePath, issue?.number)
                },
              }
            : {
                key: 'implementSessionId',
                label: '实施会话id',
                type: 'string',
                readOnly: true,
                description: 'worktree 已清理，无法 resume；仅保留 id 文本',
              },
          issue?.worktreeExists
            ? {
                key: 'reviewSessionId',
                label: '审查会话id',
                type: 'action',
                description: '点击在新终端运行 codex resume <id> 查看审查会话（cwd 优先用 worktree）',
                actionIcon: <Terminal className="size-3.5" />,
                onAction: (v) => {
                  if (typeof v === 'string' && v.length > 0 && issue)
                    onResumeReviewSession(v, issue.number, issue?.worktreePath)
                },
              }
            : {
                key: 'reviewSessionId',
                label: '审查会话id',
                type: 'string',
                readOnly: true,
                description: 'worktree 已清理，无法 resume；仅保留 id 文本',
              },
          {
            key: 'profilePath',
            label: '配置文件',
            type: 'string',
            readOnly: true,
            description: '创建工单时使用的 Claude 配置文件；resume 时会自动带上',
          },
          {
            key: 'specFile',
            label: '规格文件',
            type: 'file-link',
            description: '点击文件名在编辑器打开；点击右侧按钮重新扫描会话',
            onOpen: (p: string) => onOpenFile(p),
            onReload: () => {
              if (!issue)
                return
              if (!issue.sessionId) {
                // eslint-disable-next-line no-console
                console.warn('[superpowers] cannot load spec/plan: issue has no sessionId')
                return
              }
              onLoadFiles(issue.sessionId, issue.number)
            },
          },
          {
            key: 'planFile',
            label: '计划文件',
            type: 'file-link',
            description: '点击文件名在编辑器打开；点击重载按钮重新扫描会话；点击实施按钮启动实施流程',
            onOpen: (p: string) => onOpenFile(p),
            onReload: () => {
              if (!issue)
                return
              if (!issue.sessionId) {
                // eslint-disable-next-line no-console
                console.warn('[superpowers] cannot load spec/plan: issue has no sessionId')
                return
              }
              onLoadFiles(issue.sessionId, issue.number)
            },
            // Hide the "实施" button entirely when there's no plan file.
            secondaryActionIcon: issue?.planFile
              ? <Play className="size-3.5" />
              : undefined,
            secondaryActionTitle: '实施此计划',
            // Disable while running or already done. The user can still click
            // when status === 'failed' or never been run. Re-clicking while
            // 'running' is blocked at the UI to avoid registering duplicate
            // webhooks. To retry after a perceived failure with status still
            // 'running', edit the state-JSON comment manually for now.
            secondaryDisabled:
              !issue?.planFile
              || issue?.implementStatus === 'running'
              || issue?.implementStatus === 'done',
            onSecondaryAction: () => {
              if (!issue?.planFile)
                return
              onImplement(issue.number, issue.planFile, issue.profilePath, issue.sessionId)
            },
          },
          {
            key: 'pr',
            label: '合并请求',
            type: 'pr-link',
            description: '点击在浏览器打开关联的 PR',
            onAction: (v) => {
              if (typeof v === 'string' && v.length > 0)
                onOpenPr(v)
            },
          },
          {
            key: 'branch',
            label: '分支',
            type: 'string',
            readOnly: true,
            description: '实施流程创建的分支名',
          },
          issue?.worktreeExists
            ? {
                key: 'worktreePath',
                label: '工作树',
                type: 'file-link',
                description: '点击文件名在新 VS Code 窗口打开；点击垃圾桶删除 worktree',
                onOpen: (p: string) => onOpenWorktree(p),
                onSecondaryAction: () => issue && onDeleteWorktree(issue.number, issue.worktreePath ?? ''),
                secondaryActionIcon: <Trash2 className="size-3.5" />,
                secondaryActionTitle: '删除 worktree',
              }
            : {
                key: 'worktreePath',
                label: '工作树',
                type: 'string',
                readOnly: true,
                description: '实施流程创建的 git worktree 路径（workspace 相对）',
              },
        ],
      },
    ],
    [onResumeSession, onResumeReviewSession, onOpenFile, onLoadFiles, onImplement, onOpenPr, onOpenWorktree, onDeleteWorktree, onOpenLogs, issue],
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
    implementSessionId: issue.implementSessionId ?? null,
    reviewSessionId: issue.reviewSessionId ?? null,
    profilePath: issue.profilePath ?? null,
    specFile: issue.specFile ?? null,
    planFile: issue.planFile ?? null,
    pr: issue.pr ?? null,
    branch: issue.branch ?? null,
    worktreePath: issue.worktreePath ?? null,
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
