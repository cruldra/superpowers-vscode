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

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[] }
  | { type: 'issues/error', message: string }
  | { type: 'auth/required', host: string, errorMessage?: string, canCancel?: boolean }
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

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | { type: 'auth/save', host: string, token: string }
  | { type: 'auth/edit-request' }
  | { type: 'issue/create', userRequest: string, images?: Array<{ mediaType: string, base64: string }> }
  | { type: 'toast/open-url', url: string }
