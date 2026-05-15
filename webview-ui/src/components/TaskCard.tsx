import type { Task, TaskState } from '../types'
import { postMessage } from '../lib/vscode'

const STATE_COLORS: Record<TaskState, string> = {
  'write-spec': 'border-blue-500 text-blue-400',
  'write-plan': 'border-blue-500 text-blue-400',
  'spec-review': 'border-yellow-500 text-yellow-400',
  'plan-review': 'border-yellow-500 text-yellow-400',
  'create-worktree': 'border-violet-500 text-violet-400',
  'implement': 'border-violet-500 text-violet-400',
  'review': 'border-orange-500 text-orange-400',
  'fix': 'border-red-500 text-red-400',
  'review-passed': 'border-green-500 text-green-400',
  'merge-cleanup': 'border-green-500 text-green-400',
}

const STATE_LABELS: Record<TaskState, string> = {
  'write-spec': '● 写 spec',
  'write-plan': '● 写 plan',
  'spec-review': '● spec 审查',
  'plan-review': '● plan 审查',
  'create-worktree': '● 建 worktree',
  'implement': '● 实施',
  'review': '● review',
  'fix': '● 修复',
  'review-passed': '● 审查通过',
  'merge-cleanup': '● 合并清理',
}

interface Props {
  task: Task
}

export function TaskCard({ task }: Props) {
  const colors = STATE_COLORS[task.state]
  const label = STATE_LABELS[task.state]

  const onOpen = (): void => {
    const target = task.planPath ?? task.specPath
    if (target)
      postMessage({ type: 'task/open', path: target })
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left rounded-md border-l-[3px] bg-slate-800 hover:bg-slate-700 transition-colors p-3 cursor-pointer ${colors.split(' ')[0]}`}
    >
      <div className="text-sm font-semibold text-slate-100 truncate" title={task.title}>
        {task.title}
      </div>
      <div className={`text-xs mt-1 ${colors.split(' ')[1]}`}>
        {label}
      </div>
    </button>
  )
}
