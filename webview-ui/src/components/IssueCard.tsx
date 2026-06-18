import type { Ref } from 'react'
import { forwardRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Lock } from 'lucide-react'
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
  /** 锁定态：前置工单尚未完成。显示锁图标 + tooltip。 */
  locked?: boolean
  /** 锁定时关联的前置工单号，用于 tooltip 文案 "等待 #N 完成"。 */
  lockedPrerequisite?: number
}

export const IssueCard = forwardRef<HTMLDivElement, IssueCardProps>(
  ({ issue, selected, onSelect, depth = 0, locked, lockedPrerequisite }, ref) => {
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
          'relative select-none px-3 py-2 text-xs',
          'cursor-grab active:cursor-grabbing',
          locked && 'opacity-75',
          selected
          && 'ring-2 ring-[var(--vscode-focusBorder)] ring-offset-1 ring-offset-[var(--vscode-sideBar-background)]',
        )}
      >
        {locked
          ? (
              <span
                className="absolute right-1.5 top-1.5 grid place-items-center text-[var(--vscode-disabledForeground)]"
                title={lockedPrerequisite != null ? `等待 #${lockedPrerequisite} 完成` : '等待前置工单完成'}
                aria-label={lockedPrerequisite != null ? `等待 #${lockedPrerequisite} 完成` : '等待前置工单完成'}
              >
                <Lock className="size-3.5" />
              </span>
            )
          : null}
        <div className={cn('truncate', locked && 'pr-5')}>
          <span className="font-mono opacity-60">
            {issue.source === 'youtrack' ? issue.externalId : `#${issue.number}`}
          </span>
          {' '}
          <span>{issue.title}</span>
        </div>
      </Card>
    )
  },
)

IssueCard.displayName = 'IssueCard'
