import { useState } from 'react'
import { KanbanBoard } from './components/KanbanBoard'
import { mockIssues } from './mock-data'
import type { Issue } from './types'

export function App() {
  const [issues, setIssues] = useState<Issue[]>(mockIssues)
  return (
    <div className="h-screen w-screen overflow-hidden bg-[var(--vscode-editor-background)]">
      <KanbanBoard issues={issues} onIssuesChange={setIssues} />
    </div>
  )
}
