import type { Issue } from '../gitea/types'

export interface ToastLink {
  label: string
  url: string
}

export type ToastLevel = 'info' | 'success' | 'error'

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[] }
  | { type: 'issues/error', message: string }
  | {
    type: 'settings/show'
    host: string
    errorMessage?: string
    canCancel?: boolean
    webhookPort: number
    webhookHost: string
    createIssuePrompt: string
    implementPlanPrompt: string
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

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | {
    type: 'settings/save'
    host: string
    token: string
    webhookPort: number
    webhookHost: string
    createIssuePrompt: string
    implementPlanPrompt: string
  }
  | { type: 'settings/edit-request' }
  | { type: 'issue/create', userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string }
  | { type: 'toast/open-url', url: string }
  | { type: 'session/resume', sessionId: string, profilePath?: string, cwd?: string }
  | { type: 'session/focus', sessionId: string }
  | { type: 'editor/open-file', path: string }
  | { type: 'session/load-files', sessionId: string, issueNumber: number }
  | { type: 'profiles/list' }
  | { type: 'issue/implement', issueNumber: number, planFile: string, profilePath?: string, sessionId?: string }
  | { type: 'pr/open', pr: string }
