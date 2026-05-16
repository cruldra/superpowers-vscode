/**
 * Mirror of `src/panel/messages.ts` for the webview side.
 *
 * Kept in sync manually; if the two ever diverge that's a step-3+ concern.
 */

import type { Issue } from '../types'

export type ExtensionToWebview =
  | { type: 'issues/loading' }
  | { type: 'issues/update', issues: Issue[] }
  | { type: 'issues/error', message: string }
  | { type: 'auth/required', host: string, errorMessage?: string, canCancel?: boolean }

export type WebviewToExtension =
  | { type: 'issues/refresh' }
  | { type: 'auth/save', host: string, token: string }
  | { type: 'auth/edit-request' }
