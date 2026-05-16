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
import { onMessage, postMessage } from '../lib/vscode'

export type UseIssuesState =
  | { status: 'setup', host: string, errorMessage?: string, canCancel?: boolean }
  | { status: 'loading' }
  | { status: 'ready', issues: Issue[] }
  | { status: 'error', message: string }

export interface UseIssuesResult {
  state: UseIssuesState
  setIssues: (issues: Issue[]) => void
  refresh: () => void
  saveAuth: (host: string, token: string) => void
  requestEditAuth: () => void
}

export function useIssues(): UseIssuesResult {
  const [state, setState] = useState<UseIssuesState>({ status: 'loading' })

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
      }
    })
    // Kick off an initial load.
    postMessage({ type: 'issues/refresh' })
    return cleanup
  }, [])

  return { state, setIssues, refresh, saveAuth, requestEditAuth }
}
