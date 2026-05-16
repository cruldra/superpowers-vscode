import type { Issue } from '../gitea/types'

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[] }
  | { type: 'issues/error', message: string }
  | { type: 'auth/required', host: string, errorMessage?: string, canCancel?: boolean }

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | { type: 'auth/save', host: string, token: string }
  | { type: 'auth/edit-request' }
