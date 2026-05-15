import type { Task } from '../types'
import { TaskCard } from './TaskCard'

interface Props {
  title: string
  icon: string
  tasks: Task[]
}

export function KanbanColumn({ title, icon, tasks }: Props) {
  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-md bg-slate-900 border border-slate-700 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between bg-slate-800">
        <span className="text-xs uppercase tracking-wide text-slate-300 font-semibold">
          {icon}
          {' '}
          {title}
        </span>
        <span className="text-xs text-slate-400">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1">
        {tasks.length === 0
          ? <div className="text-xs text-slate-500 text-center py-4">No tasks</div>
          : tasks.map(t => <TaskCard key={t.id} task={t} />)}
      </div>
    </div>
  )
}
