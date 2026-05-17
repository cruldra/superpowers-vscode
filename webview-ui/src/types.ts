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
  /** PR number associated with this issue (set after webhook fires). */
  pr?: string
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
  htmlUrl: string
  /** 前置任务 issue number (Gitea dependencies 取第一个) */
  prerequisite?: number
  /** Terminal/tab color id chosen on first session open, persisted in state JSON. */
  color?: string
}

export const COLUMN_ORDER: IssueColumn[] = ['todo', 'in-progress', 'review', 'done']

export const COLUMN_LABELS: Record<IssueColumn, string> = {
  'todo': '待办',
  'in-progress': '进行中',
  'review': '审查',
  'done': '完成',
}
