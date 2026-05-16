import { KanbanBoard } from './components/KanbanBoard'
import { PanelHeader } from './components/PanelHeader'
import { SetupForm } from './components/SetupForm'
import { useIssues } from './hooks/useIssues'

export function App() {
  const { state, setIssues, refresh, saveAuth, requestEditAuth } = useIssues()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--vscode-editor-background)]">
      {state.status === 'setup' && (
        <SetupForm
          host={state.host}
          errorMessage={state.errorMessage}
          onSubmit={saveAuth}
          onCancel={state.canCancel ? refresh : undefined}
        />
      )}

      {state.status === 'loading' && (
        <div className="flex h-full w-full items-center justify-center text-sm opacity-70">
          加载中…
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <PanelHeader onRefresh={refresh} onEditAuth={requestEditAuth} />
          <div className="flex-1 overflow-hidden">
            <KanbanBoard issues={state.issues} onIssuesChange={setIssues} />
          </div>
        </>
      )}

      {state.status === 'error' && (
        <>
          <PanelHeader onRefresh={refresh} onEditAuth={requestEditAuth} />
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
    </div>
  )
}
