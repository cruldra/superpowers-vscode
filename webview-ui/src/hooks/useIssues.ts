/**
 * Subscribes to the extension host's issue stream.
 *
 * State machine (`UseIssuesState`):
 *   - loading : initial mount + any time the host pushes `issues/loading`
 *   - ready   : host pushed `issues/update`; carries the current list
 *   - error   : host pushed `issues/error`; carries the user-facing message
 *
 * Settings UI is a separate overlay (`settings: SettingsOverlayState | null`)
 * that floats above the kanban, mirroring how LogModal / NewIssueModal
 * coexist with the board state. When `canCancel === false` the kanban is
 * still mounted underneath, so the user sees a placeholder rather than the
 * usual "加载中…".
 *
 * `setIssues` is exposed so the Kanban board can reorder cards locally
 * after a drag. Persisting drag moves back to Gitea is step 3+.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Issue } from '../types'
import type { ToastItem } from '../components/ToastStack'
import type { LogEntry } from '../lib/messages'
import { onMessage, postMessage } from '../lib/vscode'

export interface SettingsValues {
  host: string
  token: string
  webhookPort: number
  webhookPublicUrl: string
  createIssuePrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
}

export interface SettingsOverlayState {
  host: string
  errorMessage?: string
  canCancel: boolean
  webhookPort: number
  webhookPublicUrl: string
  createIssuePrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
}

export type UseIssuesState =
  | { status: 'loading' }
  | { status: 'ready', issues: Issue[] }
  | { status: 'error', message: string }

/** Mirror of the extension-side ClaudeProfile in src/cc/profiles.ts. */
export interface ClaudeProfile {
  name: string
  path: string
}

export interface UseIssuesResult {
  state: UseIssuesState
  settings: SettingsOverlayState | null
  toasts: ToastItem[]
  profiles: ClaudeProfile[]
  setIssues: (issues: Issue[]) => void
  refresh: () => void
  saveSettings: (values: SettingsValues) => void
  dismissSettings: () => void
  requestEditAuth: () => void
  createIssue: (userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string) => void
  dismissToast: (id: string) => void
  openUrl: (url: string) => void
  resumeSession: (sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number) => void
  resumeReviewSession: (sessionId: string, issueNumber: number) => void
  focusSession: (sessionId: string) => void
  openFile: (path: string) => void
  loadSessionFiles: (sessionId: string | undefined, issueNumber: number) => void
  implement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  openPr: (pr: string) => void
  logs: LogEntry[]
  fetchLogs: () => void
  clearLogs: () => void
}

export function useIssues(): UseIssuesResult {
  const [state, setState] = useState<UseIssuesState>({ status: 'loading' })
  const [settings, setSettings] = useState<SettingsOverlayState | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])

  const refresh = useCallback((): void => {
    setState({ status: 'loading' })
    postMessage({ type: 'issues/refresh' })
  }, [])

  const saveSettings = useCallback((values: SettingsValues): void => {
    // Optimistically close the modal; extension will re-post `settings/show`
    // with an errorMessage if save fails server-side.
    setSettings(null)
    postMessage({
      type: 'settings/save',
      host: values.host,
      token: values.token,
      webhookPort: values.webhookPort,
      webhookPublicUrl: values.webhookPublicUrl,
      createIssuePrompt: values.createIssuePrompt,
      implementPlanPrompt: values.implementPlanPrompt,
      autoReview: values.autoReview,
      reviewPrompt: values.reviewPrompt,
    })
  }, [])

  const dismissSettings = useCallback((): void => {
    setSettings(null)
  }, [])

  const requestEditAuth = useCallback((): void => {
    postMessage({ type: 'settings/edit-request' })
  }, [])

  const createIssue = useCallback((
    userRequest: string,
    images?: Array<{ mediaType: string, base64: string }>,
    profilePath?: string,
  ): void => {
    postMessage({ type: 'issue/create', userRequest, images, profilePath })
  }, [])

  const dismissToast = useCallback((id: string): void => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const openUrl = useCallback((url: string): void => {
    postMessage({ type: 'toast/open-url', url })
  }, [])

  const resumeSession = useCallback((
    sessionId: string,
    profilePath?: string,
    cwd?: string,
    issueNumber?: number,
  ): void => {
    postMessage({ type: 'session/resume', sessionId, profilePath, cwd, issueNumber })
  }, [])

  const focusSession = useCallback((sessionId: string): void => {
    postMessage({ type: 'session/focus', sessionId })
  }, [])

  const resumeReviewSession = useCallback((sessionId: string, issueNumber: number): void => {
    postMessage({ type: 'session/resume-review', sessionId, issueNumber })
  }, [])

  const openFile = useCallback((path: string): void => {
    postMessage({ type: 'editor/open-file', path })
  }, [])

  const loadSessionFiles = useCallback((sessionId: string | undefined, issueNumber: number): void => {
    if (!sessionId) {
      // eslint-disable-next-line no-console
      console.warn('[superpowers] loadSessionFiles called without sessionId')
      return
    }
    postMessage({ type: 'session/load-files', sessionId, issueNumber })
  }, [])

  const implement = useCallback((
    issueNumber: number,
    planFile: string,
    profilePath?: string,
    sessionId?: string,
  ): void => {
    postMessage({ type: 'issue/implement', issueNumber, planFile, profilePath, sessionId })
  }, [])

  const openPr = useCallback((pr: string): void => {
    postMessage({ type: 'pr/open', pr })
  }, [])

  const fetchLogs = useCallback((): void => {
    postMessage({ type: 'logs/fetch' })
  }, [])

  const clearLogs = useCallback((): void => {
    postMessage({ type: 'logs/clear' })
  }, [])

  const setIssues = useCallback((issues: Issue[]): void => {
    setState(prev => prev.status === 'ready' ? { status: 'ready', issues } : prev)
  }, [])

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      switch (msg.type) {
        case 'issues/loading':
          setState({ status: 'loading' })
          break
        case 'issues/update':
          setState({ status: 'ready', issues: msg.issues })
          break
        case 'issues/error':
          setState({ status: 'error', message: msg.message })
          break
        case 'settings/show':
          // Open (or re-open) the overlay. Kanban state is preserved
          // underneath — when `canCancel === false` and we're still loading,
          // App.tsx renders a "请先完成设置" placeholder rather than the
          // usual spinner text.
          setSettings({
            host: msg.host,
            errorMessage: msg.errorMessage,
            canCancel: msg.canCancel === true,
            webhookPort: msg.webhookPort,
            webhookPublicUrl: msg.webhookPublicUrl,
            createIssuePrompt: msg.createIssuePrompt,
            implementPlanPrompt: msg.implementPlanPrompt,
            autoReview: msg.autoReview,
            reviewPrompt: msg.reviewPrompt,
          })
          break
        case 'toast/show': {
          const toast: ToastItem = {
            id: msg.id,
            level: msg.level,
            message: msg.message,
            spinner: msg.spinner,
            link: msg.link,
            dismissOnTimer: msg.dismissOnTimer,
          }
          setToasts(prev => {
            const existing = prev.findIndex(t => t.id === toast.id)
            if (existing >= 0) {
              const next = [...prev]
              next[existing] = toast
              return next
            }
            return [...prev, toast]
          })
          break
        }
        case 'toast/dismiss':
          setToasts(prev => prev.filter(t => t.id !== msg.id))
          break
        case 'profiles/update':
          setProfiles(msg.profiles)
          break
        case 'logs/snapshot':
          setLogs(msg.entries)
          break
        case 'logs/append':
          setLogs(prev => [...prev, msg.entry].slice(-500))
          break
        case 'logs/cleared':
          setLogs([])
          break
      }
    })
    postMessage({ type: 'issues/refresh' })
    postMessage({ type: 'profiles/list' })
    postMessage({ type: 'logs/fetch' })
    return cleanup
  }, [])

  return { state, settings, toasts, profiles, setIssues, refresh, saveSettings, dismissSettings, requestEditAuth, createIssue, dismissToast, openUrl, resumeSession, resumeReviewSession, focusSession, openFile, loadSessionFiles, implement, openPr, logs, fetchLogs, clearLogs }
}
