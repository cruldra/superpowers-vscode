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
  /** Equals tea's `index` field for the issue. */
  number: number
  title: string
  column: IssueColumn
  /** Optional Claude Code session id stored alongside the column marker. */
  sessionId?: string
  state: 'open' | 'closed'
  body: string
  /** Issue author login (empty string if unknown). */
  author: string
  /** Assignee logins; empty array if none. */
  assignees: string[]
  /** Labels; empty array if none. */
  labels: Array<{ name: string, color: string }>
  /** Browser URL to the Gitea issue page. */
  htmlUrl: string
  /** ISO 8601 timestamp. */
  createdAt: string
}
