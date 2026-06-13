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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Issue, IssueColumn } from '../types'
import type { ToastItem } from '../components/ToastStack'
import type { LogEntry } from '../lib/messages'
import { compareIssuesInColumn } from '../lib/issueSort'
import { onMessage, postMessage } from '../lib/vscode'

export interface SettingsValues {
  host: string
  token: string
  webhookPort: number
  brainstormPrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
  devBranch: string
  autoBuildBranch: string
  worktreePostCreateScript: string
  worktreePreRemoveScript: string
  implTabPreCreateScript: string
  implTabPostCloseScript: string
  implementProfilePath: string
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
  devBranch: string
  autoBuildBranch: string
  worktreePostCreateScript: string
  worktreePreRemoveScript: string
  implTabPreCreateScript: string
  implTabPostCloseScript: string
  implementProfilePath: string
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
  startTestSession: (issueNumber: number) => void
  resumeTestSession: (sessionId: string, issueNumber: number, cwd?: string) => void
  focusSession: (issueNumber: number) => void
  openFile: (path: string) => void
  implement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  generatePrDiffSummary: (issueNumber: number) => void
  isPrDiffSummaryRunning: (issueNumber: number) => boolean
  openPr: (pr: string) => void
  openWorktree: (path: string) => void
  deleteWorktree: (issueNumber: number, path: string) => void
  /** 硬删 Gitea 工单及关联资源（worktree / PR / feature branch / cc tabs）。
   * 用户在详情面板顶部点垃圾桶按钮触发。扩展端做 modal confirm + 串行清理，
   * 全部成功后 push `issue/remove`，webview 将该 issue 从 issues 数组移除。 */
  deleteIssue: (issueNumber: number) => void
  /** 关闭 Gitea 工单，不清理本地会话、worktree、PR 或分支。 */
  closeIssue: (issueNumber: number) => void
  /** Dispose the matching session terminal tab. Extension reacts via
   * onDidCloseTerminal and clears `*TabOpen` so the X button disappears. */
  closeSessionTab: (issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test') => void
  /** Spawn a fresh "规划" cc tab for an existing issue whose sessionId is
   * still empty. The extension picks up profilePath from the issue's state
   * JSON, watches `~/.claude/projects/<encoded-workspaceRoot>` for the new
   * session jsonl, then writes the id back as `sessionId`. */
  startBrainstormSession: (issueNumber: number) => void
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
  /** Commits the remote auto-build branch is behind the remote dev branch
   * (per latest `branch-sync/status`). 0 ⇒ in sync ⇒ disable button. */
  branchSyncBehind: number
  /** True while a `branch-sync/run` request is in flight. The extension
   * doesn't echo a "running" state itself — we set this on click and clear
   * it when the next `branch-sync/status` arrives. */
  branchSyncRunning: boolean
  /** True when sync is structurally unavailable (same branch, missing
   * remote, fetch error, …). Disables the button regardless of behind. */
  branchSyncDisabled: boolean
  /** Tooltip text for the sync button (already includes branch names /
   * behind count / unavailable reason). */
  branchSyncTitle: string
  /** Trigger a fast-forward push from remote dev to remote auto-build. */
  runBranchSync: () => void
  /** Whether the workspace's `.env*` files are currently chmod-locked
   * according to `workspaceState`. Persisted per-workspace. */
  envLocked: boolean
  /** File count from the latest `env-lock/status`. 0 disables the toggle. */
  envFileCount: number
  /** True while a `env-lock/toggle` chmod batch is in flight. Cleared when
   * the next `env-lock/status` arrives. */
  envLockRunning: boolean
  /** Tooltip text for the env-lock button, pre-composed from lock state +
   * file count. */
  envLockTitle: string
  /** Flip the env-lock state: chmod all `.env*` files to 444 or 644. */
  toggleEnvLock: () => void
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
  const [branchSyncBehind, setBranchSyncBehind] = useState<number>(0)
  const [branchSyncRunning, setBranchSyncRunning] = useState<boolean>(false)
  const [branchSyncDisabled, setBranchSyncDisabled] = useState<boolean>(true)
  const [branchSyncTitle, setBranchSyncTitle] = useState<string>('正在检查分支同步状态…')
  const [envLocked, setEnvLocked] = useState<boolean>(false)
  const [envFileCount, setEnvFileCount] = useState<number>(0)
  const [envLockRunning, setEnvLockRunning] = useState<boolean>(false)
  const [envLockTitle, setEnvLockTitle] = useState<string>('正在检查 .env 锁定状态…')
  const prDiffSummaryRunningRef = useRef<Set<number>>(new Set())
  const [prDiffSummaryRunning, setPrDiffSummaryRunning] = useState<ReadonlySet<number>>(() => new Set())

  const clearPrDiffSummaryRunning = useCallback((issueNumber: number): void => {
    if (!prDiffSummaryRunningRef.current.delete(issueNumber))
      return
    setPrDiffSummaryRunning(new Set(prDiffSummaryRunningRef.current))
  }, [])

  const clearPendingSelect = useCallback((): void => {
    setPendingSelectId(null)
  }, [])

  const refresh = useCallback((): void => {
    setState({ status: 'loading' })
    postMessage({ type: 'issues/refresh' })
    // Re-poll branch-sync state on user refresh — branches may have moved
    // on the remote since the last check.
    postMessage({ type: 'branch-sync/check' })
    // Re-poll env-lock state so newly added .env files surface in the count.
    postMessage({ type: 'env-lock/check' })
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
      devBranch: values.devBranch,
      autoBuildBranch: values.autoBuildBranch,
      worktreePostCreateScript: values.worktreePostCreateScript,
      worktreePreRemoveScript: values.worktreePreRemoveScript,
      implTabPreCreateScript: values.implTabPreCreateScript,
      implTabPostCloseScript: values.implTabPostCloseScript,
      implementProfilePath: values.implementProfilePath,
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

  const startTestSession = useCallback((issueNumber: number): void => {
    postMessage({ type: 'session/start-test', issueNumber })
  }, [])

  const resumeTestSession = useCallback((sessionId: string, issueNumber: number, cwd?: string): void => {
    postMessage({ type: 'session/resume-test', sessionId, issueNumber, cwd })
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

  const generatePrDiffSummary = useCallback((issueNumber: number): void => {
    if (prDiffSummaryRunningRef.current.has(issueNumber))
      return
    prDiffSummaryRunningRef.current.add(issueNumber)
    setPrDiffSummaryRunning(new Set(prDiffSummaryRunningRef.current))
    postMessage({ type: 'issue/generate-pr-diff-summary', issueNumber })
  }, [])

  const isPrDiffSummaryRunning = useCallback((issueNumber: number): boolean => {
    return prDiffSummaryRunning.has(issueNumber)
  }, [prDiffSummaryRunning])

  const openPr = useCallback((pr: string): void => {
    postMessage({ type: 'pr/open', pr })
  }, [])

  const openWorktree = useCallback((path: string): void => {
    postMessage({ type: 'worktree/open', path })
  }, [])

  const deleteWorktree = useCallback((issueNumber: number, path: string): void => {
    postMessage({ type: 'worktree/delete', issueNumber, path })
  }, [])

  const deleteIssue = useCallback((issueNumber: number): void => {
    postMessage({ type: 'issue/delete', issueNumber })
  }, [])

  const closeIssue = useCallback((issueNumber: number): void => {
    postMessage({ type: 'issue/close', issueNumber })
  }, [])

  const closeSessionTab = useCallback(
    (issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' | 'test'): void => {
      postMessage({ type: 'session/close-tab', issueNumber, kind })
    },
    [],
  )

  const startBrainstormSession = useCallback((issueNumber: number): void => {
    postMessage({ type: 'brainstorm/start', issueNumber })
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

  const runBranchSync = useCallback((): void => {
    // Double-click guard. The next `branch-sync/status` message clears the
    // running flag — both on success and on failure.
    if (branchSyncRunning)
      return
    setBranchSyncRunning(true)
    postMessage({ type: 'branch-sync/run' })
  }, [branchSyncRunning])

  const toggleEnvLock = useCallback((): void => {
    // Double-click guard — the next `env-lock/status` clears the running flag.
    if (envLockRunning)
      return
    setEnvLockRunning(true)
    postMessage({ type: 'env-lock/toggle' })
  }, [envLockRunning])

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
          if (msg.patch.prDiffFile)
            clearPrDiffSummaryRunning(msg.issueNumber)
          break
        case 'issue/pr-diff-summary-done':
          clearPrDiffSummaryRunning(msg.issueNumber)
          break
        case 'issue/remove':
          // 工单被删除或关闭 — 从 open issues 数组移除。如果它是当前选中的，挑下一张
          // 同列的卡片（按该列排序取首张近邻：完成列按合并时间，其余按 number 降序）；同列没有则交给 App.tsx 的
          // 现有 effect（selectedId 失效 → setSelectedId(null)）兜底。
          setState((prev) => {
            if (prev.status !== 'ready')
              return prev
            const removed = prev.issues.find(i => i.number === msg.issueNumber)
            const remaining = prev.issues.filter(i => i.number !== msg.issueNumber)
            if (removed) {
              const sameCol = remaining
                .filter(i => i.column === removed.column)
                .sort((a, b) => compareIssuesInColumn(removed.column, a, b))
              const next = sameCol[0]
              if (next)
                setPendingSelectId(next.id)
            }
            return { status: 'ready', issues: remaining }
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
            devBranch: msg.devBranch,
            autoBuildBranch: msg.autoBuildBranch,
            worktreePostCreateScript: msg.worktreePostCreateScript,
            worktreePreRemoveScript: msg.worktreePreRemoveScript,
            implTabPreCreateScript: msg.implTabPreCreateScript,
            implTabPostCloseScript: msg.implTabPostCloseScript,
            implementProfilePath: msg.implementProfilePath,
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
        case 'branch-sync/status': {
          setBranchSyncBehind(msg.behind)
          setBranchSyncRunning(false)
          // Title + disabled derive purely from the status payload, so we
          // resolve them here once instead of recomputing in each render.
          if (msg.unavailable) {
            setBranchSyncDisabled(true)
            setBranchSyncTitle(msg.reason ?? '分支同步不可用')
          }
          else if (msg.behind <= 0) {
            setBranchSyncDisabled(true)
            setBranchSyncTitle(`${msg.devBranch} → ${msg.autoBuildBranch} 已同步`)
          }
          else {
            setBranchSyncDisabled(false)
            setBranchSyncTitle(
              `同步 ${msg.devBranch} → ${msg.autoBuildBranch}（落后 ${msg.behind} 个提交）`,
            )
          }
          break
        }
        case 'env-lock/status': {
          setEnvLocked(msg.locked)
          setEnvFileCount(msg.fileCount)
          setEnvLockRunning(false)
          // Title is fully derived from payload so consumers don't recompute.
          if (msg.fileCount === 0) {
            setEnvLockTitle('工作区无 .env 文件')
          }
          else if (msg.locked) {
            const suffix = msg.failedCount ? `（${msg.failedCount} 个失败）` : ''
            setEnvLockTitle(`已锁定 ${msg.fileCount} 个 .env 文件${suffix}，点击解锁`)
          }
          else {
            const suffix = msg.failedCount ? `（${msg.failedCount} 个失败）` : ''
            setEnvLockTitle(`点击锁定 ${msg.fileCount} 个 .env 文件${suffix}`)
          }
          break
        }
      }
    })
    postMessage({ type: 'issues/refresh' })
    postMessage({ type: 'profiles/list' })
    postMessage({ type: 'logs/fetch' })
    postMessage({ type: 'branch-sync/check' })
    postMessage({ type: 'env-lock/check' })
    return cleanup
  }, [clearPrDiffSummaryRunning])

  return { state, settings, globalAutoReview, toasts, profiles, setIssues, refresh, saveSettings, dismissSettings, requestEditAuth, createIssue, dismissToast, openUrl, resumeSession, resumeReviewSession, startTestSession, resumeTestSession, focusSession, openFile, implement, generatePrDiffSummary, isPrDiffSummaryRunning, openPr, openWorktree, deleteWorktree, deleteIssue, closeIssue, closeSessionTab, startBrainstormSession, changeColumn, setDependency, clearDependency, updateIssueAutoReview, logs, fetchLogs, clearLogs, pendingSelectId, clearPendingSelect, commitRunning, runCommit, hasChanges, branchSyncBehind, branchSyncRunning, branchSyncDisabled, branchSyncTitle, runBranchSync, envLocked, envFileCount, envLockRunning, envLockTitle, toggleEnvLock }
}
