import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_LABELS } from '../types'

interface KanbanColumnProps {
  column: IssueColumn
  issues: Issue[]
  children: ReactNode
  /** When provided, renders a + button in the header. Used for the todo column. */
  onCreate?: () => void
}

export function KanbanColumn({ column, issues, children, onCreate }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full min-h-0 flex-col rounded-lg p-2 transition-colors',
        'bg-[var(--vscode-sideBar-background)]',
        isOver && 'bg-black/10 dark:bg-white/10',
      )}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-medium text-[var(--vscode-foreground)] opacity-80">
          {COLUMN_LABELS[column]}
        </span>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">{issues.length}</Badge>
          {onCreate && (
            <button
              type="button"
              onClick={onCreate}
              aria-label="新建工单"
              className="grid size-5 place-items-center rounded text-[var(--vscode-foreground)] opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-1">
        {issues.length === 0
          ? (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--vscode-foreground)] border-opacity-20 p-4 text-xs text-muted-foreground opacity-60">
                拖到这里
              </div>
            )
          : (
              children
            )}
      </div>
    </div>
  )
}
