/**
 * Subscribes to the extension host's issue stream.
 *
 * State machine:
 *   - setup   : token absent or invalid; show the settings form
 *   - loading : initial mount + any time the host pushes `issues/loading`
 *   - ready   : host pushed `issues/update`; carries the current list
 *   - error   : host pushed `issues/error`; carries the user-facing message
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
  webhookHost: string
  createIssuePrompt: string
  implementPlanPrompt: string
}

export type UseIssuesState =
  | {
    status: 'setup'
    host: string
    errorMessage?: string
    canCancel?: boolean
    webhookPort: number
    webhookHost: string
    createIssuePrompt: string
    implementPlanPrompt: string
  }
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
  toasts: ToastItem[]
  profiles: ClaudeProfile[]
  setIssues: (issues: Issue[]) => void
  refresh: () => void
  saveSettings: (values: SettingsValues) => void
  requestEditAuth: () => void
  createIssue: (userRequest: string, images?: Array<{ mediaType: string, base64: string }>, profilePath?: string) => void
  dismissToast: (id: string) => void
  openUrl: (url: string) => void
  resumeSession: (sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number) => void
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
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])

  const refresh = useCallback((): void => {
    setState({ status: 'loading' })
    postMessage({ type: 'issues/refresh' })
  }, [])

  const saveSettings = useCallback((values: SettingsValues): void => {
    setState({ status: 'loading' })
    postMessage({
      type: 'settings/save',
      host: values.host,
      token: values.token,
      webhookPort: values.webhookPort,
      webhookHost: values.webhookHost,
      createIssuePrompt: values.createIssuePrompt,
      implementPlanPrompt: values.implementPlanPrompt,
    })
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
          setState({
            status: 'setup',
            host: msg.host,
            errorMessage: msg.errorMessage,
            canCancel: msg.canCancel,
            webhookPort: msg.webhookPort,
            webhookHost: msg.webhookHost,
            createIssuePrompt: msg.createIssuePrompt,
            implementPlanPrompt: msg.implementPlanPrompt,
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

  return { state, toasts, profiles, setIssues, refresh, saveSettings, requestEditAuth, createIssue, dismissToast, openUrl, resumeSession, focusSession, openFile, loadSessionFiles, implement, openPr, logs, fetchLogs, clearLogs }
}
