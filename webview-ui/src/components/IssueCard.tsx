import type { Ref } from 'react'
import { forwardRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { Card } from './ui/card'
import type { Issue } from '../types'

interface IssueCardProps {
  issue: Issue
  selected?: boolean
  onSelect?: (id: string) => void
  /** Visual nesting level for prerequisite-chain rendering in the todo column.
   * Each level adds 16px of left margin. Defaults to 0 (flat). */
  depth?: number
}

export const IssueCard = forwardRef<HTMLDivElement, IssueCardProps>(
  ({ issue, selected, onSelect, depth = 0 }, ref) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging }
      = useSortable({ id: issue.id, data: { column: issue.column } })

    const style: React.CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.4 : 1,
      marginLeft: depth * 16,
    }

    // Merge dnd-kit's ref with the forwarded ref so the parent can scrollIntoView.
    function setRefs(node: HTMLDivElement | null): void {
      setNodeRef(node)
      if (typeof ref === 'function')
        ref(node)
      else if (ref)
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    }

    return (
      <Card
        ref={setRefs as unknown as Ref<HTMLDivElement>}
        style={style}
        {...attributes}
        {...listeners}
        onClick={() => onSelect?.(issue.id)}
        className={cn(
          'select-none px-3 py-2 text-xs',
          'cursor-grab active:cursor-grabbing',
          selected
          && 'ring-2 ring-[var(--vscode-focusBorder)] ring-offset-1 ring-offset-[var(--vscode-sideBar-background)]',
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
  },
)

IssueCard.displayName = 'IssueCard'
