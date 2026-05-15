import type { Task } from '../types'
import { KanbanColumn } from './KanbanColumn'

interface Props {
  tasks: Task[]
}

export function KanbanBoard({ tasks }: Props) {
  const planning = tasks.filter(t => t.phase === 'planning')
  const development = tasks.filter(t => t.phase === 'development')

  return (
    <div className="h-full flex flex-col p-2 gap-2">
      <div className="flex-1 min-h-0 flex gap-2">
        <KanbanColumn title="规划阶段" icon="📋" tasks={planning} />
        <KanbanColumn title="开发阶段" icon="⚙️" tasks={development} />
      </div>
    </div>
  )
}
