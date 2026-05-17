/**
 * Mirror of `src/panel/messages.ts` for the webview side.
 *
 * Kept in sync manually; if the two ever diverge that's a step-3+ concern.
 */

import type { Issue } from '../types'

export interface ToastLink {
  label: string
  url: string
}

export type ToastLevel = 'info' | 'success' | 'error'

/**
 * Mirror of the extension-side LogEntry in src/logging/logger.ts.
 * Kept manually in sync — workspace boundaries prevent direct import.
 */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: number
  level: LogLevel
  source: string
  message: string
  details?: string
}

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[] }
  | { type: 'issues/error', message: string }
  | {
    type: 'settings/show'
    host: string
    errorMessage?: string
    canCancel?: boolean
    tokenSaved: boolean
    webhookPort: number
    createIssuePrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
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

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | {
    type: 'settings/save'
    host: string
    token: string
    webhookPort: number
    createIssuePrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
  }
  | { type: 'settings/edit-request' }
  | { type: 'issue/create', userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string }
  | { type: 'toast/open-url', url: string }
  | { type: 'session/resume', sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number }
  | { type: 'session/focus', sessionId: string }
  | { type: 'session/resume-review', sessionId: string, issueNumber: number }
  | { type: 'editor/open-file', path: string }
  | { type: 'session/load-files', sessionId: string, issueNumber: number }
  | { type: 'profiles/list' }
  | { type: 'issue/implement', issueNumber: number, planFile: string, profilePath?: string, sessionId?: string }
  | { type: 'pr/open', pr: string }
  | { type: 'logs/fetch' }
  | { type: 'logs/clear' }
