import type { Issue, IssueColumn } from '../gitea/types'
import type { LogEntry } from '../logging/logger'

export type { LogEntry } from '../logging/logger'

export interface ToastLink {
  label: string
  url: string
}

export type ToastLevel = 'info' | 'success' | 'error'

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[], globalAutoReview: boolean }
  | { type: 'issues/error', message: string }
  | { type: 'issue/patch', issueNumber: number, patch: { autoReview?: boolean, specFile?: string, planFile?: string, implementSessionId?: string, reviewSessionId?: string, pr?: string, implementStatus?: 'running' | 'done' | 'failed', column?: IssueColumn, worktreePath?: string, prMerged?: boolean, branch?: string, color?: string, worktreeExists?: boolean, brainstormTabOpen?: boolean, implementTabOpen?: boolean, reviewTabOpen?: boolean } }
  | { type: 'issue/append', issue: Issue, select?: boolean }
  | { type: 'issue/select-by-number', issueNumber: number }
  | {
    type: 'settings/show'
    host: string
    errorMessage?: string
    canCancel?: boolean
    tokenSaved: boolean
    webhookPort: number
    brainstormPrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
    devBranch: string
    autoBuildBranch: string
  }
  | {
    type: 'toast/show'
    id: string
    level: ToastLevel
    message: string
    spinner?: boolean
    link?: ToastLink
    dismissOnTimer?: number
  }
  | { type: 'toast/dismiss', id: string }
  | { type: 'profiles/update', profiles: Array<{ name: string, path: string }> }
  | { type: 'logs/snapshot', entries: LogEntry[] }
  | { type: 'logs/append', entry: LogEntry }
  | { type: 'logs/cleared' }
  | { type: 'commit/state', running: boolean }
  | { type: 'commit/has-changes', value: boolean }
  | {
    type: 'branch-sync/status'
    behind: number
    devBranch: string
    autoBuildBranch: string
    unavailable?: boolean
    reason?: string
  }

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | {
    type: 'settings/save'
    host: string
    token: string
    webhookPort: number
    brainstormPrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
    devBranch: string
    autoBuildBranch: string
  }
  | { type: 'settings/edit-request' }
  | { type: 'issue/create', userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string }
  | { type: 'toast/open-url', url: string }
  | { type: 'session/resume', sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number }
  | { type: 'session/focus', issueNumber: number }
  | { type: 'session/resume-review', sessionId: string, issueNumber: number, cwd?: string }
  | { type: 'editor/open-file', path: string }
  | { type: 'profiles/list' }
  | { type: 'issue/implement', issueNumber: number, planFile: string, profilePath?: string, sessionId?: string }
  | { type: 'pr/open', pr: string }
  | { type: 'worktree/open', path: string }
  | { type: 'worktree/delete', issueNumber: number, path: string }
  | { type: 'column/change', issueNumber: number, toColumn: IssueColumn }
  | { type: 'dependency/set', issueNumber: number, prerequisiteNumber: number }
  | { type: 'dependency/clear', issueNumber: number, prerequisiteNumber: number }
  | { type: 'issue/update-auto-review', issueNumber: number, value: boolean }
  | { type: 'logs/fetch' }
  | { type: 'logs/clear' }
  | { type: 'commit/run' }
  | { type: 'session/close-tab', issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' }
  | { type: 'branch-sync/check' }
  | { type: 'branch-sync/run' }
