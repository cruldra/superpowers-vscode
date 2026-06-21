import type { Issue, IssueColumn } from '../gitea/types'
import type { LogEntry } from '../logging/logger'
import type { ProfilesData } from '../profiles/store'
import type { ManagedSession } from '../sessions/managedStore'

export type { LogEntry } from '../logging/logger'
export type { ProfileRow, ProfilesData } from '../profiles/store'

/**
 * `managed-sessions/show` 的 payload 类型：在持久化的 ManagedSession 基础上
 * 附加 transient 字段 `tabOpen`（该会话的终端是否正开着）。
 * `tabOpen` 只在构造 show payload 时附加，不写进 .spx/session-names.json。
 */
export interface ManagedSessionShowItem extends ManagedSession {
  tabOpen?: boolean
}

export interface ManagedSessionsShowData {
  sessions: ManagedSessionShowItem[]
}

/** PR 提交的精简视图（webview 列表渲染用）。 */
export interface PrCommit {
  sha: string
  message: string
  authorName: string
  date: string
}

/** 提交内单个文件改动：status 取 added/modified/deleted/renamed/copied 等。 */
export interface PrCommitFile {
  path: string
  status: string
}

export interface ToastLink {
  label: string
  url: string
}

export type ToastLevel = 'info' | 'success' | 'error'

export type ExtensionToWebview
  = | { type: 'issues/loading' }
    | { type: 'issues/update', issues: Issue[], globalAutoReview: boolean, youtrackConfigured: boolean }
    | { type: 'issues/error', message: string }
    | { type: 'issue/patch', issueNumber: number, patch: { autoReview?: boolean, specFile?: string, planFile?: string, prDiffFile?: string, sessionId?: string, implementSessionId?: string, reviewSessionId?: string, testSessionId?: string, pr?: string, implementStatus?: 'running' | 'done' | 'failed', column?: IssueColumn, worktreePath?: string, prMerged?: boolean, prMergedAt?: string, branch?: string, color?: string, worktreeExists?: boolean, brainstormTabOpen?: boolean, implementTabOpen?: boolean, reviewTabOpen?: boolean, testTabOpen?: boolean, profilePath?: string, testProfilePath?: string } }
    | { type: 'issue/pr-diff-summary-done', issueNumber: number }
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
      worktreePostCreateScript: string
      worktreePreRemoveScript: string
      implTabPreCreateScript: string
      implTabPostCloseScript: string
      youtrackBaseUrl?: string
      youtrackProjectShortName?: string
      youtrackCloseCommand?: string
      youtrackTokenSaved?: boolean
    }
    | { type: 'youtrack/projects', projects: Array<{ id: string, name: string, shortName: string }>, error?: string }
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
    | { type: 'env-lock/status', locked: boolean, fileCount: number, failedCount?: number }
    | { type: 'issue/remove', issueNumber: number }
    | { type: 'profiles/show', data: ProfilesData }
    | { type: 'managed-sessions/show', data: ManagedSessionsShowData }
    | { type: 'pr-commits/show', issueNumber: number, commits: PrCommit[], confirmedCommits: string[], error?: string }
    | { type: 'pr-commit-files/show', issueNumber: number, sha: string, parentSha?: string, files: PrCommitFile[], confirmed: string[], error?: string }

export type WebviewToExtension
  = | { type: 'issues/refresh' }
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
      worktreePostCreateScript: string
      worktreePreRemoveScript: string
      implTabPreCreateScript: string
      implTabPostCloseScript: string
      youtrackBaseUrl: string
      youtrackProjectShortName: string
      youtrackCloseCommand: string
      youtrackToken: string
    }
    | { type: 'settings/edit-request' }
    | { type: 'youtrack/list-projects', baseUrl: string, token: string }
    | { type: 'youtrack/import' }
    | { type: 'issue/create', userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string }
    | { type: 'toast/open-url', url: string }
    | { type: 'session/resume', sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number }
    | { type: 'session/focus', issueNumber: number }
    | { type: 'session/resume-review', sessionId: string, issueNumber: number, cwd?: string }
    | { type: 'session/resume-test', sessionId: string, issueNumber: number, cwd?: string }
    | { type: 'session/start-test', issueNumber: number }
    | { type: 'editor/open-file', path: string }
    | { type: 'profiles/list' }
    | { type: 'issue/implement', issueNumber: number, planFile: string, profilePath?: string, sessionId?: string }
    | { type: 'issue/generate-pr-diff-summary', issueNumber: number }
    | { type: 'pr/open', pr: string }
    | { type: 'worktree/open', path: string }
    | { type: 'worktree/delete', issueNumber: number, path: string }
    | { type: 'git/merge-preview', issueNumber: number, branch: string }
    | { type: 'column/change', issueNumber: number, toColumn: IssueColumn, source?: 'gitea' | 'youtrack', externalId?: string }
    | { type: 'dependency/set', issueNumber: number, prerequisiteNumber: number }
    | { type: 'dependency/clear', issueNumber: number, prerequisiteNumber: number }
    | { type: 'issue/update-auto-review', issueNumber: number, value: boolean }
    | { type: 'issue/update-profile-path', issueNumber: number, profilePath: string }
    | { type: 'issue/update-test-profile-path', issueNumber: number, testProfilePath: string }
    | { type: 'logs/fetch' }
    | { type: 'logs/clear' }
    | { type: 'commit/run' }
    | { type: 'session/close-tab', issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test' }
    | { type: 'branch-sync/check' }
    | { type: 'branch-sync/run' }
    | { type: 'env-lock/check' }
    | { type: 'env-lock/toggle' }
    | { type: 'issue/delete', issueNumber: number }
    | { type: 'issue/close', issueNumber: number }
    | { type: 'brainstorm/start', issueNumber: number }
    | { type: 'profiles/get' }
    | { type: 'profiles/save', data: ProfilesData }
    | { type: 'profiles/open', value: string }
    | { type: 'managed-sessions/get' }
    | { type: 'managed-sessions/create', profilePath: string, name?: string, prompt?: string }
    | { type: 'managed-sessions/rename', sessionId: string, name: string }
    | { type: 'managed-sessions/resume', sessionId: string }
    | { type: 'managed-sessions/delete', sessionId: string }
    | { type: 'managed-sessions/close-tab', sessionId: string }
    | { type: 'pr-commits/get', issueNumber: number }
    | { type: 'pr-commit-files/get', issueNumber: number, sha: string }
    | { type: 'pr-commit-diff/open', issueNumber: number, sha: string, parentSha?: string, path: string, status: string }
    | { type: 'pr-review/set', issueNumber: number, sha: string, confirmed: string[] }
    | { type: 'pr-review/set-commits', issueNumber: number, confirmed: string[] }
