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
import type { Issue, IssueColumn } from '../types'
import type { ToastItem } from '../components/ToastStack'
import type { LogEntry } from '../lib/messages'
import { onMessage, postMessage } from '../lib/vscode'

export interface SettingsValues {
  host: string
  token: string
  webhookPort: number
  brainstormPrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
}

export interface SettingsOverlayState {
  host: string
  errorMessage?: string
  canCancel: boolean
  tokenSaved: boolean
  webhookPort: number
  brainstormPrompt: string
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
  /** Latest known global `autoReview` value pushed alongside `issues/update`.
   * Used by the detail panel to display the fallback value when an issue has
   * no per-issue override. */
  globalAutoReview: boolean
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
  resumeReviewSession: (sessionId: string, issueNumber: number, cwd?: string) => void
  focusSession: (issueNumber: number) => void
  openFile: (path: string) => void
  implement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  openPr: (pr: string) => void
  openWorktree: (path: string) => void
  deleteWorktree: (issueNumber: number, path: string) => void
  changeColumn: (issueNumber: number, toColumn: IssueColumn) => void
  setDependency: (issueNumber: number, prerequisiteNumber: number) => void
  clearDependency: (issueNumber: number, prerequisiteNumber: number) => void
  updateIssueAutoReview: (issueNumber: number, value: boolean) => void
  logs: LogEntry[]
  fetchLogs: () => void
  clearLogs: () => void
  /** True while the "提交当前代码" claude -p run is in flight. Used to
   * disable the toolbar button and swap its icon to a spinner. */
  commitRunning: boolean
  /** Trigger a background `claude -p "提交下代码"` run in the workspace
   * root, gated by `commitRunning`. The extension responds with
   * `commit/state` messages and a `toast/show` on completion. */
  runCommit: () => void
  /** Whether the workspace git working tree currently has any uncommitted
   * changes (working tree / index / untracked). Pushed by the extension via
   * `commit/has-changes` and used by `PanelHeader` to skip rendering the
   * commit button when the tree is clean. Defaults to `false` until the
   * extension reports its first observation. */
  hasChanges: boolean
  /** ID of an issue that should be auto-selected after an `issue/append`
   * with `select: true` (i.e. user-initiated webhook creation). Consumers
   * read this in a `useEffect`, apply the selection, then call
   * `clearPendingSelect()` to reset. */
  pendingSelectId: string | null
  clearPendingSelect: () => void
}

export function useIssues(): UseIssuesResult {
  const [state, setState] = useState<UseIssuesState>({ status: 'loading' })
  const [settings, setSettings] = useState<SettingsOverlayState | null>(null)
  const [globalAutoReview, setGlobalAutoReview] = useState<boolean>(true)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null)
  const [commitRunning, setCommitRunning] = useState<boolean>(false)
  const [hasChanges, setHasChanges] = useState<boolean>(false)

  const clearPendingSelect = useCallback((): void => {
    setPendingSelectId(null)
  }, [])

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
      brainstormPrompt: values.brainstormPrompt,
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

  const focusSession = useCallback((issueNumber: number): void => {
    postMessage({ type: 'session/focus', issueNumber })
  }, [])

  const resumeReviewSession = useCallback((sessionId: string, issueNumber: number, cwd?: string): void => {
    postMessage({ type: 'session/resume-review', sessionId, issueNumber, cwd })
  }, [])

  const openFile = useCallback((path: string): void => {
    postMessage({ type: 'editor/open-file', path })
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

  const openWorktree = useCallback((path: string): void => {
    postMessage({ type: 'worktree/open', path })
  }, [])

  const deleteWorktree = useCallback((issueNumber: number, path: string): void => {
    postMessage({ type: 'worktree/delete', issueNumber, path })
  }, [])

  const changeColumn = useCallback((issueNumber: number, toColumn: IssueColumn): void => {
    postMessage({ type: 'column/change', issueNumber, toColumn })
  }, [])

  const setDependency = useCallback((issueNumber: number, prerequisiteNumber: number): void => {
    postMessage({ type: 'dependency/set', issueNumber, prerequisiteNumber })
  }, [])

  const clearDependency = useCallback((issueNumber: number, prerequisiteNumber: number): void => {
    postMessage({ type: 'dependency/clear', issueNumber, prerequisiteNumber })
  }, [])

  const updateIssueAutoReview = useCallback((issueNumber: number, value: boolean): void => {
    // Optimistically update local state so the toggle reflects immediately
    // and the issues list / detail panel are not remounted by a full reload.
    // On failure, the extension posts `issue/patch` to roll us back.
    setState((prev) => {
      if (prev.status !== 'ready')
        return prev
      return {
        status: 'ready',
        issues: prev.issues.map(i =>
          i.number === issueNumber ? { ...i, autoReview: value } : i,
        ),
      }
    })
    postMessage({ type: 'issue/update-auto-review', issueNumber, value })
  }, [])

  const fetchLogs = useCallback((): void => {
    postMessage({ type: 'logs/fetch' })
  }, [])

  const clearLogs = useCallback((): void => {
    postMessage({ type: 'logs/clear' })
  }, [])

  const runCommit = useCallback((): void => {
    // The extension also guards via its own commitRunning flag, but we
    // short-circuit the round-trip here so rapid double-clicks don't even
    // hit the wire.
    if (commitRunning)
      return
    postMessage({ type: 'commit/run' })
  }, [commitRunning])

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
          setGlobalAutoReview(msg.globalAutoReview)
          break
        case 'issues/error':
          setState({ status: 'error', message: msg.message })
          break
        case 'issue/patch':
          setState((prev) => {
            if (prev.status !== 'ready')
              return prev
            return {
              status: 'ready',
              issues: prev.issues.map(i =>
                i.number === msg.issueNumber ? { ...i, ...msg.patch } : i,
              ),
            }
          })
          break
        case 'issue/append':
          setState((prev) => {
            if (prev.status !== 'ready')
              return prev
            const exists = prev.issues.some(i => i.number === msg.issue.number)
            return {
              status: 'ready',
              issues: exists
                ? prev.issues.map(i => i.number === msg.issue.number ? msg.issue : i)
                : [...prev.issues, msg.issue],
            }
          })
          if (msg.select)
            setPendingSelectId(msg.issue.id)
          break
        case 'issue/select-by-number':
          // 反向选中：column 2 切换终端 tab → 在 ready issues 里按 number 找到
          // 对应工单的 id，复用 pendingSelectId 机制让 App.tsx 切换 selectedId。
          setState((prev) => {
            if (prev.status !== 'ready')
              return prev
            const issue = prev.issues.find(i => i.number === msg.issueNumber)
            if (issue)
              setPendingSelectId(issue.id)
            return prev
          })
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
            tokenSaved: msg.tokenSaved,
            webhookPort: msg.webhookPort,
            brainstormPrompt: msg.brainstormPrompt,
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
          setToasts((prev) => {
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
        case 'commit/state':
          setCommitRunning(msg.running)
          break
        case 'commit/has-changes':
          setHasChanges(msg.value)
          break
      }
    })
    postMessage({ type: 'issues/refresh' })
    postMessage({ type: 'profiles/list' })
    postMessage({ type: 'logs/fetch' })
    return cleanup
  }, [])

  return { state, settings, globalAutoReview, toasts, profiles, setIssues, refresh, saveSettings, dismissSettings, requestEditAuth, createIssue, dismissToast, openUrl, resumeSession, resumeReviewSession, focusSession, openFile, implement, openPr, openWorktree, deleteWorktree, changeColumn, setDependency, clearDependency, updateIssueAutoReview, logs, fetchLogs, clearLogs, pendingSelectId, clearPendingSelect, commitRunning, runCommit, hasChanges }
}
