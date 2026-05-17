import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { IssueCard } from './IssueCard'
import { KanbanColumn } from './KanbanColumn'
import type { Issue, IssueColumn } from '../types'
import { COLUMN_ORDER } from '../types'

interface KanbanBoardProps {
  issues: Issue[]
  onIssuesChange: (next: Issue[]) => void
  /** Renders the + button on the todo column when provided. */
  onCreateIssue?: () => void
  selectedId?: string | null
  onSelectIssue?: (id: string | null) => void
  /**
   * Called when a card moves to a new column via drag-and-drop, in addition
   * to the optimistic `onIssuesChange`. Currently only invoked for moves
   * targeting `done`; other column changes remain client-visual-only.
   */
  onColumnChange?: (issueNumber: number, toColumn: IssueColumn) => void
}

function isColumnId(id: string): id is IssueColumn {
  return (COLUMN_ORDER as string[]).includes(id)
}

/**
 * Organize todo-column issues into a forest ordered by prerequisite chains.
 *
 * Roots are issues whose `prerequisite` is empty or points outside the todo
 * column (cross-column pointers don't form parent/child here — they only
 * matter for locking in a later step). Children are issues whose
 * `prerequisite` points to another issue in the same todo column.
 *
 * Order: pre-order DFS. Root relative order follows the input array;
 * sibling order under each parent also follows input order. A visited Set
 * guards against pathological cycles (one issue can only have one parent,
 * so this is a forest in normal cases).
 */
function buildTodoTree(todoIssues: Issue[]): Array<{ issue: Issue, depth: number }> {
  const byNumber = new Map<number, Issue>()
  for (const issue of todoIssues)
    byNumber.set(issue.number, issue)

  // Group children by parent number, preserving input order.
  const childrenOf = new Map<number, Issue[]>()
  const roots: Issue[] = []
  for (const issue of todoIssues) {
    const parentNum = issue.prerequisite
    if (parentNum != null && byNumber.has(parentNum)) {
      const arr = childrenOf.get(parentNum) ?? []
      arr.push(issue)
      childrenOf.set(parentNum, arr)
    }
    else {
      roots.push(issue)
    }
  }

  const out: Array<{ issue: Issue, depth: number }> = []
  const visited = new Set<string>()
  function visit(issue: Issue, depth: number): void {
    if (visited.has(issue.id))
      return
    visited.add(issue.id)
    out.push({ issue, depth })
    const kids = childrenOf.get(issue.number)
    if (!kids)
      return
    for (const child of kids)
      visit(child, depth + 1)
  }
  for (const root of roots)
    visit(root, 0)
  return out
}

export function KanbanBoard({
  issues,
  onIssuesChange,
  onCreateIssue,
  selectedId,
  onSelectIssue,
  onColumnChange,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const issuesByColumn = useMemo(() => {
    const map: Record<IssueColumn, Issue[]> = {
      'todo': [],
      'in-progress': [],
      'review': [],
      'done': [],
    }
    for (const issue of issues)
      map[issue.column].push(issue)
    return map
  }, [issues])

  const activeIssue = activeId ? issues.find(i => i.id === activeId) ?? null : null

  // Map of issue id -> DOM node, used so keyboard navigation can scrollIntoView.
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>())

  useEffect(() => {
    if (!selectedId)
      return
    const node = cardRefs.current.get(selectedId)
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    setActiveId(null)
    if (!over)
      return

    const activeIdStr = String(active.id)
    const overIdStr = String(over.id)
    if (activeIdStr === overIdStr)
      return

    const activeIndex = issues.findIndex(i => i.id === activeIdStr)
    if (activeIndex < 0)
      return
    const activeItem = issues[activeIndex]

    // Dropped onto a column container
    if (isColumnId(overIdStr)) {
      if (activeItem.column === overIdStr)
        return
      const next = [...issues]
      next.splice(activeIndex, 1)
      next.push({ ...activeItem, column: overIdStr })
      onIssuesChange(next)
      if (overIdStr === 'done')
        onColumnChange?.(activeItem.number, overIdStr)
      return
    }

    // Dropped onto another card
    const overIndex = issues.findIndex(i => i.id === overIdStr)
    if (overIndex < 0)
      return
    const overItem = issues[overIndex]

    if (activeItem.column === overItem.column) {
      onIssuesChange(arrayMove(issues, activeIndex, overIndex))
      return
    }

    // Cross-column: drop activeItem at overItem's position in the new column
    const next = [...issues]
    next.splice(activeIndex, 1)
    const newOverIndex = next.findIndex(i => i.id === overIdStr)
    const insertAt = newOverIndex < 0 ? next.length : newOverIndex
    next.splice(insertAt, 0, { ...activeItem, column: overItem.column })
    onIssuesChange(next)
    if (overItem.column === 'done')
      onColumnChange?.(activeItem.number, overItem.column)
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid h-full grid-cols-4 gap-3 p-3">
        {COLUMN_ORDER.map((column) => {
          const columnIssues = issuesByColumn[column]
          // Todo column renders as a tree (prerequisite chains -> indented
          // children). Other columns stay flat. Keep `ids` aligned with the
          // visual order so dnd-kit keyboard nav / sortable indices match.
          const ordered: Array<{ issue: Issue, depth: number }>
            = column === 'todo'
              ? buildTodoTree(columnIssues)
              : columnIssues.map(issue => ({ issue, depth: 0 }))
          const ids = ordered.map(o => o.issue.id)
          return (
            <KanbanColumn
              key={column}
              column={column}
              issues={columnIssues}
              onCreate={column === 'todo' ? onCreateIssue : undefined}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {ordered.map(({ issue, depth }) => (
                  <IssueCard
                    key={issue.id}
                    ref={(node) => {
                      if (node)
                        cardRefs.current.set(issue.id, node)
                      else
                        cardRefs.current.delete(issue.id)
                    }}
                    issue={issue}
                    depth={depth}
                    selected={issue.id === selectedId}
                    onSelect={onSelectIssue}
                  />
                ))}
              </SortableContext>
            </KanbanColumn>
          )
        })}
      </div>

      <DragOverlay>
        {activeIssue ? <IssueCard issue={activeIssue} /> : null}
      </DragOverlay>
    </DndContext>
  )
}
