import { KanbanBoard } from './components/KanbanBoard'
import { useTasks } from './hooks/useTasks'

export function App() {
  const tasks = useTasks()
  return (
    <div className="h-screen w-screen overflow-hidden">
      <KanbanBoard tasks={tasks} />
    </div>
  )
}
