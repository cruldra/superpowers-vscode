/**
 * Gitea issue types used by the extension host.
 *
 * Mirrors the shape declared in `webview-ui/src/types.ts`. The two packages
 * don't share types directly today; if these drift, that's a step-3 concern.
 */

export type IssueColumn = 'todo' | 'in-progress' | 'review' | 'done'

export interface Issue {
  /** Stable identifier: `${owner}/${repo}#${index}` */
  id: string
  /** Equals the Gitea issue number / tea's `index` field. */
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
  /** Whether the associated PR has been merged. Set when the user drags to
   * the 完成 列 (扩展代为合并) or when a `pull_request.closed` webhook arrives
   * with `merged === true`. Persisted in the state JSON. */
  prMerged?: boolean
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
  /** Backend-agnostic review session id (v1 stores a codex thread id). Set
   * the first time auto-review runs; reused for subsequent `synchronize`
   * webhook callbacks via `codex exec resume`. */
  reviewSessionId?: string
  /** Browser URL to the Gitea issue page (escape hatch button in the UI). */
  htmlUrl: string
  /** 前置任务 issue number (Gitea dependencies 取第一个) */
  prerequisite?: number
  /** Terminal/tab color id (a `terminal.ansi*` ThemeColor key) chosen the
   * first time a session is opened for this issue, persisted in the state
   * JSON so all subsequent sessions reuse the same tone. */
  color?: string
  /** Per-issue override of the global `autoReview` setting. When set, the
   * webhook coordinator uses this value instead of the global flag. Stored
   * in the issue's state-JSON comment so it survives reloads. */
  autoReview?: boolean
}
