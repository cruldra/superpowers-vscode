/**
 * Subscribes to the extension host's issue stream.
 *
 * State machine:
 *   - setup   : token absent or invalid; show the auth form
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
import { onMessage, postMessage } from '../lib/vscode'

export type UseIssuesState =
  | { status: 'setup', host: string, errorMessage?: string, canCancel?: boolean }
  | { status: 'loading' }
  | { status: 'ready', issues: Issue[] }
  | { status: 'error', message: string }

export interface UseIssuesResult {
  state: UseIssuesState
  toasts: ToastItem[]
  setIssues: (issues: Issue[]) => void
  refresh: () => void
  saveAuth: (host: string, token: string) => void
  requestEditAuth: () => void
  createIssue: (userRequest: string) => void
  dismissToast: (id: string) => void
  openUrl: (url: string) => void
}

export function useIssues(): UseIssuesResult {
  const [state, setState] = useState<UseIssuesState>({ status: 'loading' })
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const refresh = useCallback((): void => {
    setState({ status: 'loading' })
    postMessage({ type: 'issues/refresh' })
  }, [])

  const saveAuth = useCallback((host: string, token: string): void => {
    setState({ status: 'loading' })
    postMessage({ type: 'auth/save', host, token })
  }, [])

  const requestEditAuth = useCallback((): void => {
    postMessage({ type: 'auth/edit-request' })
  }, [])

  const createIssue = useCallback((userRequest: string): void => {
    postMessage({ type: 'issue/create', userRequest })
  }, [])

  const dismissToast = useCallback((id: string): void => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const openUrl = useCallback((url: string): void => {
    postMessage({ type: 'toast/open-url', url })
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
        case 'auth/required':
          setState({ status: 'setup', host: msg.host, errorMessage: msg.errorMessage, canCancel: msg.canCancel })
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
      }
    })
    postMessage({ type: 'issues/refresh' })
    return cleanup
  }, [])

  return { state, toasts, setIssues, refresh, saveAuth, requestEditAuth, createIssue, dismissToast, openUrl }
}
