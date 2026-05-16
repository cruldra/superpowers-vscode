import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_LABELS } from '../types'

interface KanbanColumnProps {
  column: IssueColumn
  issues: Issue[]
  children: ReactNode
}

export function KanbanColumn({ column, issues, children }: KanbanColumnProps) {
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
        <Badge variant="outline">{issues.length}</Badge>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
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
