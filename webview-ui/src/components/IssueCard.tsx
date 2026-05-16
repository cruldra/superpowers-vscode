import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { Card } from './ui/card'
import type { Issue } from '../types'

interface IssueCardProps {
  issue: Issue
}

export function IssueCard({ issue }: IssueCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging }
    = useSortable({ id: issue.id, data: { column: issue.column } })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        'select-none px-3 py-2 text-xs',
        'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="truncate">
        <span className="font-mono opacity-60">
          #
          {issue.number}
        </span>
        {' '}
        <span>{issue.title}</span>
      </div>
    </Card>
  )
}
