export type IssueColumn = 'todo' | 'in-progress' | 'review' | 'done'

export interface Issue {
  id: string
  number: number
  title: string
  column: IssueColumn
  /** Optional Claude Code session id stored alongside the column marker in
   * the issue's state-JSON comment. Used to resume the conversation. */
  sessionId?: string
  /** Absolute path to the Claude settings profile used at creation; passed
   * as --settings on resume. */
  profilePath?: string
  /** Optional workspace-relative path to the spec file for this issue, as
   * surfaced from the Claude session transcript. Lives under
   * `docs/superpowers/specs/*.md`. */
  specFile?: string
  /** Optional workspace-relative path to the plan file for this issue, as
   * surfaced from the Claude session transcript. Lives under
   * `docs/superpowers/plans/*.md`. */
  planFile?: string
  /** Optional workspace-relative path to the generated PR diff summary. */
  prDiffFile?: string
  /** PR number associated with this issue (set after webhook fires). */
  pr?: string
  /** Whether the associated PR has been merged. */
  prMerged?: boolean
  /** PR 合并时间（ISO 8601，来自 merged_at）。完成列按它降序排序，未合并/查询失败为 undefined。不持久化进 state JSON。 */
  prMergedAt?: string
  /** Branch name created for implementation, e.g. `feature/<hash>`. */
  branch?: string
  /** Workspace-relative path to the implementation worktree. */
  worktreePath?: string
  /** Whether the worktree path still exists on disk; computed by the loader. */
  worktreeExists?: boolean
  /** Lifecycle of the implementation flow. */
  implementStatus?: 'running' | 'done' | 'failed'
  /** Session id of the implementation conversation (separate from
   * discussion-session `sessionId`). */
  implementSessionId?: string
  /** Backend-agnostic review session id (v1 stores a codex thread id). */
  reviewSessionId?: string
  /** Claude Code session id of the test conversation; manually started after
   * the PR is merged, resumable from the detail panel. */
  testSessionId?: string
  htmlUrl: string
  /** 前置任务 issue number (Gitea dependencies 取第一个) */
  prerequisite?: number
  /** Terminal/tab color id chosen on first session open, persisted in state JSON. */
  color?: string
  /** Per-issue override of the global `autoReview` setting. Undefined = follow
   * global setting; true/false = explicit override stored in state JSON. */
  autoReview?: boolean
  /** 三类会话 tab 是否当前在编辑器分组里打开（由 extension 通过 issue/patch 同步）。
   * 仅用于详情面板控制是否在三行会话 id 右侧显示 "关闭 tab" 按钮，不持久化到 state JSON。 */
  brainstormTabOpen?: boolean
  implementTabOpen?: boolean
  reviewTabOpen?: boolean
  testTabOpen?: boolean
}

export const COLUMN_ORDER: IssueColumn[] = ['todo', 'in-progress', 'review', 'done']

export const COLUMN_LABELS: Record<IssueColumn, string> = {
  'todo': '待办',
  'in-progress': '进行中',
  'review': '审查',
  'done': '完成',
}

/**
 * Mirror of the extension-side ManagedSession in src/sessions/managedStore.ts.
 * 从会话管理 tab 创建过的 cc 会话的本地记录。
 */
export interface ManagedSession {
  id: string
  name: string
  profilePath?: string
  createdAt: number
  /** Transient：该会话的终端 tab 是否正开着（仅 show payload 附带，不持久化）。 */
  tabOpen?: boolean
}

export interface ManagedSessionsData {
  sessions: ManagedSession[]
}
