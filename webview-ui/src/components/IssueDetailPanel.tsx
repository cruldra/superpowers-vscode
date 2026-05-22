import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { ExternalLink, Play, Terminal, Trash2, X } from 'lucide-react'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_LABELS, COLUMN_ORDER } from '../types'
import { isIssueLocked } from '../lib/dependencies'
import type { PropertyGroup } from './property-grid'
import { PropertyGrid } from './property-grid'

interface IssueDetailPanelProps {
  issue: Issue | null
  /** 当前所有 issues，用于解析前置依赖锁定态。 */
  allIssues: Issue[]
  /** 全局 autoReview 当前值；用于工单未显式设置 autoReview 时的回退展示。 */
  globalAutoReview: boolean
  onOpenInBrowser: (url: string) => void
  onResumeSession: (sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number) => void
  /** Open a new terminal that runs `codex resume <id>` for the auto-review
   * conversation associated with this issue. */
  onResumeReviewSession: (sessionId: string, issueNumber: number, cwd?: string) => void
  /** Open a workspace-relative file in the editor. */
  onOpenFile: (path: string) => void
  /** Kick off the end-to-end implementation flow for the given plan file. */
  onImplement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  /** Open the gitea PR page in the browser. */
  onOpenPr: (pr: string) => void
  /** Open the workspace-relative worktree path in a new VS Code window. */
  onOpenWorktree: (path: string) => void
  /** Delete the worktree (`git worktree remove`) and clear it from state. */
  onDeleteWorktree: (issueNumber: number, path: string) => void
  /** 硬删整个工单 + 关联资源（worktree / PR / feature branch / cc tabs）。
   * 顶部垃圾桶按钮触发，扩展端做 modal confirm，可选。 */
  onDeleteIssue?: (issueNumber: number) => void
  /** Close the matching session terminal tab. The extension watches
   * onDidCloseTerminal and clears the corresponding `*TabOpen` flag, which
   * makes the X button vanish on its own. */
  onCloseSessionTab: (issueNumber: number, kind: 'brainstorm' | 'implement' | 'review') => void
  /** Spawn a fresh "规划" cc tab for an issue whose sessionId is still empty
   * (created out-of-band via spx without webhook linking). Bound to the Play
   * button next to the "头脑风暴会话 id" row. */
  onStartBrainstormSession: (issueNumber: number) => void
  /** Persist a per-issue `autoReview` override into the state JSON. */
  onUpdateAutoReview: (issueNumber: number, value: boolean) => void
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
  allIssues,
  globalAutoReview,
  onOpenInBrowser,
  onResumeSession,
  onResumeReviewSession,
  onOpenFile,
  onImplement,
  onOpenPr,
  onOpenWorktree,
  onDeleteWorktree,
  onDeleteIssue,
  onCloseSessionTab,
  onStartBrainstormSession,
  onUpdateAutoReview,
  onOpenLogs,
}: IssueDetailPanelProps) {
  // 前置工单未完成 → 锁定。锁定时禁用"实施"等启动新工作的动作按钮，
  // 但已存在的会话恢复链接保持可用（属于用户已操作过的入口）。
  const { locked, prerequisiteNumber } = issue
    ? isIssueLocked(issue, allIssues)
    : { locked: false, prerequisiteNumber: undefined as number | undefined }
  const lockTitle = locked && prerequisiteNumber != null
    ? `等待 #${prerequisiteNumber} 完成`
    : undefined

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
          (() => {
            // 头脑风暴会话 id 行有三种状态：
            //  1. sessionId 已存在 + brainstormTabOpen=true → 显示 id + X 关闭 tab
            //  2. sessionId 已存在 + brainstormTabOpen=false → 显示 id（无右侧按钮）
            //  3. sessionId 为空 + column !== 'done' → 显示 Play 按钮（启动一个新规划 cc tab）
            //  4. sessionId 为空 + column === 'done' → 占位 —，不显示按钮
            const hasSession = !!(issue?.sessionId && issue.sessionId.length > 0)
            const canStart = !hasSession && issue?.column !== 'done'
            let secondaryActionIcon: ReactNode | undefined
            let secondaryActionTitle: string | undefined
            let onSecondaryAction: (() => void) | undefined
            if (hasSession && issue?.brainstormTabOpen) {
              secondaryActionIcon = <X className="size-3.5" />
              secondaryActionTitle = '关闭头脑风暴 tab'
              onSecondaryAction = () => {
                if (issue)
                  onCloseSessionTab(issue.number, 'brainstorm')
              }
            }
            else if (canStart) {
              secondaryActionIcon = <Play className="size-3.5" />
              secondaryActionTitle = '启动头脑风暴会话'
              onSecondaryAction = () => {
                if (issue)
                  onStartBrainstormSession(issue.number)
              }
            }
            return {
              key: 'sessionId',
              label: '头脑风暴会话id',
              type: 'action' as const,
              description: hasSession
                ? '点击在新终端运行 claude --resume <id> 恢复对话'
                : '工单尚未关联 cc 会话；点击右侧 ▶ 启动一个新的规划 cc tab',
              actionIcon: <Terminal className="size-3.5" />,
              onAction: (v: unknown) => {
                if (typeof v === 'string' && v.length > 0)
                  onResumeSession(v, issue?.profilePath, undefined, issue?.number)
              },
              secondaryActionIcon,
              secondaryActionTitle,
              onSecondaryAction,
            }
          })(),
          // 实施会话即使 worktree 已被清掉也保留可点击的 resume 入口：
          // extension 端 handleResumeSession 会在 worktree 路径不存在时退回
          // 工作区根目录，并通过 toast 告知用户；description 在两种状态下
          // 给出不同的提示文案。
          {
            key: 'implementSessionId',
            label: '实施会话id',
            type: 'action',
            description: issue?.worktreeExists
              ? '点击在新终端运行 claude --resume <id> 恢复实施对话（cwd 为 worktree）'
              : 'worktree 已清理，将在工作区根目录恢复（cc 可能提示原 cwd 不存在）',
            actionIcon: <Terminal className="size-3.5" />,
            onAction: (v) => {
              if (typeof v === 'string' && v.length > 0)
                onResumeSession(v, issue?.profilePath, issue?.worktreePath, issue?.number)
            },
            secondaryActionIcon: issue?.implementTabOpen
              ? <X className="size-3.5" />
              : undefined,
            secondaryActionTitle: '关闭实施 tab',
            onSecondaryAction: () => {
              if (issue)
                onCloseSessionTab(issue.number, 'implement')
            },
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
                secondaryActionIcon: issue?.reviewTabOpen
                  ? <X className="size-3.5" />
                  : undefined,
                secondaryActionTitle: '关闭审查 tab',
                onSecondaryAction: () => {
                  if (issue)
                    onCloseSessionTab(issue.number, 'review')
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
            key: 'autoReview',
            label: '自动审查',
            type: 'boolean',
            description: `打开新 PR 时是否自动启动 codex 审查；未设置时跟随全局（当前全局：${globalAutoReview ? '开' : '关'}）`,
          },
          {
            key: 'color',
            label: '颜色',
            type: 'theme-color',
            readOnly: true,
            description: '首次开会话时随机分配的终端颜色（VS Code ThemeColor），用于该工单所有会话的终端 tab 着色',
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
            description: '点击文件名在编辑器打开；cc 通过 issue body 的 <!-- spx:spec=路径 --> 注释实时同步',
            onOpen: (p: string) => onOpenFile(p),
          },
          {
            key: 'planFile',
            label: '计划文件',
            type: 'file-link',
            description: '点击文件名在编辑器打开；点击实施按钮启动实施流程；cc 通过 issue body 的 <!-- spx:plan=路径 --> 注释实时同步',
            onOpen: (p: string) => onOpenFile(p),
            // Hide the "实施" button entirely when there's no plan file.
            secondaryActionIcon: issue?.planFile
              ? <Play className="size-3.5" />
              : undefined,
            secondaryActionTitle: locked ? lockTitle : '实施此计划',
            // Disable while running or already done. The user can still click
            // when status === 'failed' or never been run. Re-clicking while
            // 'running' is blocked at the UI to avoid registering duplicate
            // webhooks. To retry after a perceived failure with status still
            // 'running', edit the state-JSON comment manually for now.
            // 锁定态（前置工单未完成）同样禁止启动实施。
            secondaryDisabled:
              !issue?.planFile
              || issue?.implementStatus === 'running'
              || issue?.implementStatus === 'done'
              || locked,
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
            description: '点击在浏览器打开关联的 PR；已合并时编号后追加 "(已合并)" 标识',
            onAction: (v) => {
              if (typeof v !== 'string' || v.length === 0)
                return
              // value 形如 "65" 或 "65(已合并)"；剥掉合并后缀只把纯编号传出去。
              const pr = v.replace(/\(已合并\)\s*$/, '')
              if (pr.length > 0)
                onOpenPr(pr)
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
    [onResumeSession, onResumeReviewSession, onOpenFile, onImplement, onOpenPr, onOpenWorktree, onDeleteWorktree, onCloseSessionTab, onStartBrainstormSession, onOpenLogs, issue, locked, lockTitle, globalAutoReview],
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
    autoReview: issue.autoReview ?? globalAutoReview,
    color: issue.color ?? null,
    profilePath: issue.profilePath ?? null,
    specFile: issue.specFile ?? null,
    planFile: issue.planFile ?? null,
    pr: issue.pr
      ? `${issue.pr}${issue.prMerged ? '(已合并)' : ''}`
      : null,
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
          {locked && prerequisiteNumber != null
            ? (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded border border-[var(--vscode-panel-border)] px-1.5 py-0.5 align-middle text-[10px] font-normal text-[var(--vscode-disabledForeground)]"
                  title={lockTitle}
                >
                  等待 #
                  {prerequisiteNumber}
                  {' '}
                  完成
                </span>
              )
            : null}
        </h3>
        <button
          type="button"
          onClick={() => onOpenInBrowser(issue.htmlUrl)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--vscode-panel-border)] px-2 py-1 text-xs hover:bg-black/10 dark:hover:bg-white/10"
        >
          <ExternalLink className="size-3.5" />
          在 Gitea 打开
        </button>
        <button
          type="button"
          onClick={() => issue && onDeleteIssue?.(issue.number)}
          title="删除工单（不可撤销）"
          aria-label="删除工单"
          className="inline-flex shrink-0 items-center justify-center rounded border border-[var(--vscode-panel-border)] p-1 text-xs text-[var(--vscode-foreground)] hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-500"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <PropertyGrid
          schema={schema}
          data={data}
          hideToolbar
          fillHeight
          onChange={(key, value) => {
            if (key === 'autoReview' && issue && typeof value === 'boolean')
              onUpdateAutoReview(issue.number, value)
          }}
        />
      </div>
    </div>
  )
}
