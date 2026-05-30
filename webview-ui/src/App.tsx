import { useEffect, useMemo, useState } from 'react'
import { BottomTabs } from './components/BottomTabs'
import { KanbanBoard } from './components/KanbanBoard'
import { LogModal } from './components/LogModal'
import type { PastedImage } from './components/NewIssueModal'
import { NewIssueModal } from './components/NewIssueModal'
import { PanelHeader } from './components/PanelHeader'
import { SettingsModal } from './components/SettingsModal'
import { ToastStack } from './components/ToastStack'
import { useIssues } from './hooks/useIssues'
import { useProfiles } from './hooks/useProfiles'
import type { Issue } from './types'
import { COLUMN_ORDER } from './types'

export function App() {
  const {
    state,
    settings,
    globalAutoReview,
    toasts,
    profiles,
    setIssues,
    refresh,
    saveSettings,
    dismissSettings,
    requestEditAuth,
    createIssue,
    dismissToast,
    openUrl,
    resumeSession,
    resumeReviewSession,
    focusSession,
    openFile,
    implement,
    openPr,
    openWorktree,
    deleteWorktree,
    deleteIssue,
    closeIssue,
    closeSessionTab,
    startBrainstormSession,
    changeColumn,
    setDependency,
    clearDependency,
    updateIssueAutoReview,
    logs,
    clearLogs,
    pendingSelectId,
    clearPendingSelect,
    commitRunning,
    runCommit,
    hasChanges,
    branchSyncBehind,
    branchSyncRunning,
    branchSyncDisabled,
    branchSyncTitle,
    runBranchSync,
    envLocked,
    envFileCount,
    envLockRunning,
    envLockTitle,
    toggleEnvLock,
  } = useIssues()
  const { profiles: profileData, saveProfiles, openProfileValue } = useProfiles()
  const [showNewIssueModal, setShowNewIssueModal] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  function handleSubmitNewIssue(userRequest: string, images: PastedImage[], profilePath?: string): void {
    const payload = images.map(({ mediaType, base64 }) => ({ mediaType, base64 }))
    createIssue(userRequest, payload.length > 0 ? payload : undefined, profilePath)
    setShowNewIssueModal(false)
  }

  // Drop selectedId if it's no longer present after issues refresh.
  const readyIssues = state.status === 'ready' ? state.issues : null
  useEffect(() => {
    if (!readyIssues)
      return
    if (selectedId && !readyIssues.some(i => i.id === selectedId))
      setSelectedId(null)
  }, [readyIssues, selectedId])

  // Auto-select issues that arrive via webhook in response to user-initiated
  // creation (issue/append with select: true). User-initiated, so we
  // intentionally override any current arrow-key selection.
  useEffect(() => {
    if (!pendingSelectId)
      return
    if (!readyIssues)
      return
    if (!readyIssues.some(i => i.id === pendingSelectId))
      return
    setSelectedId(pendingSelectId)
    clearPendingSelect()
  }, [pendingSelectId, readyIssues, clearPendingSelect])

  // Issues partitioned by column, in COLUMN_ORDER. Used for arrow navigation.
  // Each column is sorted by issue number descending so newer issues appear on top.
  const ordered = useMemo<Issue[][]>(() => {
    if (!readyIssues)
      return []
    return COLUMN_ORDER.map(col =>
      readyIssues.filter(i => i.column === col).sort((a, b) => b.number - a.number),
    )
  }, [readyIssues])

  // Resolved selected issue (or null) for the detail panel.
  const selectedIssue = useMemo<Issue | null>(() => {
    if (!readyIssues || !selectedId)
      return null
    return readyIssues.find(i => i.id === selectedId) ?? null
  }, [readyIssues, selectedId])

  // Auto-focus the terminal tab whenever the selected card has a session.
  // 优先 implementSessionId（实施终端），没有再回退到 sessionId（规划/头脑风暴终端）；
  // 依赖里加入 implementSessionId，让"先有规划、后有实施"的场景能正确切换。
  useEffect(() => {
    if (!selectedIssue)
      return
    if (selectedIssue.implementSessionId || selectedIssue.sessionId)
      focusSession(selectedIssue.number)
  }, [selectedIssue?.implementSessionId, selectedIssue?.sessionId, selectedIssue?.number, focusSession])

  // Global keyboard navigation. Skipped whenever an overlay (new-issue, logs,
  // settings) is showing, so its inputs receive arrow/Enter without
  // interference.
  const settingsOpen = settings !== null
  useEffect(() => {
    if (state.status !== 'ready')
      return
    if (showNewIssueModal)
      return
    if (showLogs)
      return
    if (settingsOpen)
      return

    function onKeyDown(e: KeyboardEvent): void {
      // Skip when typing in form fields.
      const active = document.activeElement
      const tag = active?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
        return
      // Editable elements (e.g. contenteditable divs).
      if (active && (active as HTMLElement).isContentEditable)
        return

      if (e.key === 'Escape') {
        if (selectedId !== null) {
          e.preventDefault()
          setSelectedId(null)
        }
        return
      }

      if (e.key === 'Enter') {
        const sid = selectedIssue?.implementSessionId || selectedIssue?.sessionId
        if (sid) {
          e.preventDefault()
          const isImpl = !!selectedIssue?.implementSessionId
          const cwd = isImpl ? selectedIssue?.worktreePath : undefined
          resumeSession(sid, selectedIssue?.profilePath, cwd, selectedIssue?.number)
        }
        return
      }

      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')
        return

      // Locate current selection within `ordered`.
      let colIdx = -1
      let rowIdx = -1
      if (selectedId) {
        for (let c = 0; c < ordered.length; c++) {
          const r = ordered[c].findIndex(i => i.id === selectedId)
          if (r >= 0) {
            colIdx = c
            rowIdx = r
            break
          }
        }
      }

      // No current selection: pick the first card in the first non-empty
      // column (typically todo[0]).
      if (colIdx < 0) {
        for (let c = 0; c < ordered.length; c++) {
          if (ordered[c].length > 0) {
            e.preventDefault()
            setSelectedId(ordered[c][0].id)
            return
          }
        }
        return
      }

      if (e.key === 'ArrowUp') {
        if (rowIdx > 0) {
          e.preventDefault()
          setSelectedId(ordered[colIdx][rowIdx - 1].id)
        }
        return
      }

      if (e.key === 'ArrowDown') {
        if (rowIdx < ordered[colIdx].length - 1) {
          e.preventDefault()
          setSelectedId(ordered[colIdx][rowIdx + 1].id)
        }
        return
      }

      // Horizontal navigation: keep rowIdx, clamp to target column length - 1.
      // Skip empty columns entirely.
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      let target = colIdx + dir
      while (target >= 0 && target < ordered.length && ordered[target].length === 0)
        target += dir
      if (target < 0 || target >= ordered.length)
        return
      e.preventDefault()
      const clampedRow = Math.min(rowIdx, ordered[target].length - 1)
      setSelectedId(ordered[target][clampedRow].id)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.status, showNewIssueModal, showLogs, settingsOpen, ordered, selectedId, selectedIssue, resumeSession])

  // When the user is being forced into first-time setup, the kanban behind
  // the modal has nothing meaningful to show — replace the spinner with a
  // muted hint so it doesn't look like things are still loading.
  const blockedBySetup = settings !== null && !settings.canCancel && state.status === 'loading'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--vscode-editor-background)]">
      {state.status === 'loading' && (
        <>
          <PanelHeader
            onRefresh={refresh}
            onEditAuth={requestEditAuth}
            commitRunning={commitRunning}
            hasChanges={hasChanges}
            onCommit={runCommit}
            branchSyncBehind={branchSyncBehind}
            branchSyncRunning={branchSyncRunning}
            branchSyncDisabled={branchSyncDisabled}
            branchSyncTitle={branchSyncTitle}
            envLocked={envLocked}
            envFileCount={envFileCount}
            envLockRunning={envLockRunning}
            envLockTitle={envLockTitle}
            onToggleEnvLock={toggleEnvLock}
            onSyncBranch={runBranchSync}
          />
          <div className="flex h-full w-full items-center justify-center text-sm opacity-70">
            {blockedBySetup ? '请先完成设置' : '加载中…'}
          </div>
        </>
      )}

      {state.status === 'ready' && (
        <>
          <PanelHeader
            onRefresh={refresh}
            onEditAuth={requestEditAuth}
            commitRunning={commitRunning}
            hasChanges={hasChanges}
            onCommit={runCommit}
            branchSyncBehind={branchSyncBehind}
            branchSyncRunning={branchSyncRunning}
            branchSyncDisabled={branchSyncDisabled}
            branchSyncTitle={branchSyncTitle}
            envLocked={envLocked}
            envFileCount={envFileCount}
            envLockRunning={envLockRunning}
            envLockTitle={envLockTitle}
            onToggleEnvLock={toggleEnvLock}
            onSyncBranch={runBranchSync}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <KanbanBoard
                issues={state.issues}
                onIssuesChange={setIssues}
                onCreateIssue={() => setShowNewIssueModal(true)}
                selectedId={selectedId}
                onSelectIssue={setSelectedId}
                onColumnChange={changeColumn}
                onDependencySet={setDependency}
                onDependencyClear={clearDependency}
              />
            </div>
            <div className="h-[40vh] shrink-0">
              <BottomTabs
                issue={selectedIssue}
                allIssues={state.issues}
                globalAutoReview={globalAutoReview}
                onOpenInBrowser={openUrl}
                onResumeSession={resumeSession}
                onResumeReviewSession={resumeReviewSession}
                onOpenFile={openFile}
                onImplement={implement}
                onOpenPr={openPr}
                onOpenWorktree={openWorktree}
                onDeleteWorktree={deleteWorktree}
                onDeleteIssue={deleteIssue}
                onCloseIssue={closeIssue}
                onCloseSessionTab={closeSessionTab}
                onStartBrainstormSession={startBrainstormSession}
                onUpdateAutoReview={updateIssueAutoReview}
                onOpenLogs={() => setShowLogs(true)}
                profileData={profileData}
                onProfileSave={saveProfiles}
                onProfileOpen={openProfileValue}
              />
            </div>
          </div>
        </>
      )}

      {state.status === 'error' && (
        <>
          <PanelHeader
            onRefresh={refresh}
            onEditAuth={requestEditAuth}
            commitRunning={commitRunning}
            hasChanges={hasChanges}
            onCommit={runCommit}
            branchSyncBehind={branchSyncBehind}
            branchSyncRunning={branchSyncRunning}
            branchSyncDisabled={branchSyncDisabled}
            branchSyncTitle={branchSyncTitle}
            envLocked={envLocked}
            envFileCount={envFileCount}
            envLockRunning={envLockRunning}
            envLockTitle={envLockTitle}
            onToggleEnvLock={toggleEnvLock}
            onSyncBranch={runBranchSync}
          />
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-md border border-state-red/40 bg-state-red/10 p-4 text-sm">
              <div className="mb-3 font-medium text-state-red">无法加载 issues</div>
              <div className="mb-4 whitespace-pre-wrap opacity-90">{state.message}</div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded border border-state-red/60 px-3 py-1 text-xs hover:bg-state-red/20"
                >
                  重试
                </button>
                <button
                  type="button"
                  onClick={requestEditAuth}
                  className="text-xs text-[var(--vscode-textLink-foreground)] underline"
                >
                  重新配置
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <NewIssueModal
        open={showNewIssueModal}
        onCancel={() => setShowNewIssueModal(false)}
        onSubmit={handleSubmitNewIssue}
        profiles={profiles}
        defaultProfileName="offical"
      />
      <LogModal
        open={showLogs}
        entries={logs}
        onClose={() => setShowLogs(false)}
        onClear={clearLogs}
      />
      <SettingsModal
        open={settings !== null}
        host={settings?.host ?? ''}
        errorMessage={settings?.errorMessage}
        canCancel={settings?.canCancel}
        initialTokenSaved={settings?.tokenSaved ?? false}
        initialWebhookPort={settings?.webhookPort ?? 17421}
        initialBrainstormPrompt={settings?.brainstormPrompt ?? ''}
        initialImplementPlanPrompt={settings?.implementPlanPrompt ?? ''}
        initialAutoReview={settings?.autoReview ?? true}
        initialReviewPrompt={settings?.reviewPrompt ?? ''}
        initialDevBranch={settings?.devBranch ?? 'main'}
        initialAutoBuildBranch={settings?.autoBuildBranch ?? ''}
        initialWorktreePostCreateScript={settings?.worktreePostCreateScript ?? ''}
        initialWorktreePreRemoveScript={settings?.worktreePreRemoveScript ?? ''}
        initialImplTabPreCreateScript={settings?.implTabPreCreateScript ?? ''}
        initialImplTabPostCloseScript={settings?.implTabPostCloseScript ?? ''}
        initialImplementProfilePath={settings?.implementProfilePath ?? ''}
        profiles={profiles}
        onSubmit={saveSettings}
        onCancel={settings?.canCancel ? dismissSettings : undefined}
      />
      <ToastStack toasts={toasts} onDismiss={dismissToast} onOpenUrl={openUrl} />
    </div>
  )
}
