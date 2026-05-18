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
import { isIssueLocked } from '../lib/dependencies'
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
  /**
   * Called when a drag gesture establishes a new prerequisite relationship
   * (drop onto another todo card's middle 1/3) or moves to a sibling whose
   * parent differs from the active card's current parent.
   */
  onDependencySet?: (issueNumber: number, prerequisiteNumber: number) => void
  /**
   * Called when a drag gesture clears an existing prerequisite (e.g. drop
   * onto the todo column's empty area, or onto a sibling at root level).
   */
  onDependencyClear?: (issueNumber: number, prerequisiteNumber: number) => void
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
  onDependencySet,
  onDependencyClear,
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
    // Sort each column by issue.number descending so newer issues stay on top.
    // For the todo column this is the input order into `buildTodoTree`, which
    // pushes roots in input order — keeping the descending sort here makes
    // the visible roots match number order too.
    for (const col of Object.keys(map) as IssueColumn[])
      map[col].sort((a, b) => b.number - a.number)
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

  /**
   * Classify the drop position relative to the `over` card. Middle 1/3
   * means nest (set prerequisite); the upper/lower 2/3 means sibling reorder.
   * The 1/3-2/3 split is intentionally wider than 1/4-1/2-1/4 because the
   * sortable strategy reflows during drag, so the user needs more room.
   */
  function detectDropZone(event: DragEndEvent): 'middle' | 'edge' {
    const activeRect = event.active.rect.current.translated
    const overRect = event.over?.rect
    if (!activeRect || !overRect)
      return 'edge'
    const activeCenterY = (activeRect.top + activeRect.bottom) / 2
    const overHeight = overRect.height
    const middleStart = overRect.top + overHeight * 0.33
    const middleEnd = overRect.top + overHeight * 0.67
    return activeCenterY >= middleStart && activeCenterY <= middleEnd ? 'middle' : 'edge'
  }

  /**
   * Walks up the prerequisite chain from `target`, returning true if
   * `maybeAncestor` appears anywhere on the way. Uses a visited set so a
   * pre-existing cycle in the data doesn't spin forever.
   */
  function isDescendant(maybeAncestor: number, target: number, all: Issue[]): boolean {
    const visited = new Set<number>()
    let current: Issue | undefined = all.find(i => i.number === target)
    while (current && current.prerequisite != null) {
      if (visited.has(current.number))
        return false
      visited.add(current.number)
      if (current.prerequisite === maybeAncestor)
        return true
      current = all.find(i => i.number === current!.prerequisite)
    }
    return false
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

    // Lock check: a todo card whose prerequisite is still unfinished must
    // stay in the todo column. Resolve target column from either the over
    // column id or the over card's column.
    const prereqIssue = activeItem.prerequisite != null
      ? issues.find(i => i.number === activeItem.prerequisite)
      : undefined
    const isLocked = !!prereqIssue && prereqIssue.column !== 'done'
    if (isLocked && activeItem.column === 'todo') {
      const overItemForLock = isColumnId(overIdStr)
        ? undefined
        : issues.find(i => i.id === overIdStr)
      const targetColumn: IssueColumn | undefined = isColumnId(overIdStr)
        ? overIdStr
        : overItemForLock?.column
      if (targetColumn && targetColumn !== 'todo')
        return
    }

    // Dropped onto a column container
    if (isColumnId(overIdStr)) {
      // Drop onto the todo column's empty area while the card is already in
      // todo → clear prerequisite (move to root level, append at column end).
      if (overIdStr === 'todo' && activeItem.column === 'todo' && activeItem.prerequisite != null) {
        const prevPrereq = activeItem.prerequisite
        const next = [...issues]
        next.splice(activeIndex, 1)
        next.push({ ...activeItem, prerequisite: undefined })
        onIssuesChange(next)
        onDependencyClear?.(activeItem.number, prevPrereq)
        return
      }
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

    // Cross-column or non-todo-to-non-todo: keep the existing semantics.
    if (activeItem.column !== 'todo' || overItem.column !== 'todo') {
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
      return
    }

    // Both in todo: distinguish nest (middle 1/3) vs sibling reorder (edge).
    const zone = detectDropZone(event)
    if (zone === 'middle') {
      // Don't allow nesting onto our own descendant (would form a cycle).
      if (isDescendant(activeItem.number, overItem.number, issues))
        return
      // Already nested under this same parent → nothing to do.
      if (activeItem.prerequisite === overItem.number)
        return
      const next = [...issues]
      next.splice(activeIndex, 1)
      const newOverIndex = next.findIndex(i => i.id === overIdStr)
      const insertAt = newOverIndex < 0 ? next.length : newOverIndex + 1
      next.splice(insertAt, 0, { ...activeItem, prerequisite: overItem.number })
      onIssuesChange(next)
      onDependencySet?.(activeItem.number, overItem.number)
      return
    }

    // edge: sibling reorder. Inherit the over card's prerequisite as parent.
    const newParent = overItem.prerequisite
    if (newParent === activeItem.prerequisite) {
      // Same parent (including both undefined): pure reorder.
      onIssuesChange(arrayMove(issues, activeIndex, overIndex))
      return
    }
    // Cycle guard: refuse to set the new parent if it would put active under
    // its own descendant. Still reorder visually.
    const cycle = newParent != null && isDescendant(activeItem.number, newParent, issues)
    if (cycle) {
      onIssuesChange(arrayMove(issues, activeIndex, overIndex))
      return
    }
    const next = [...issues]
    next.splice(activeIndex, 1)
    const newOverIndex = next.findIndex(i => i.id === overIdStr)
    const insertAt = newOverIndex < 0 ? next.length : newOverIndex
    next.splice(insertAt, 0, { ...activeItem, prerequisite: newParent })
    onIssuesChange(next)
    if (newParent == null)
      onDependencyClear?.(activeItem.number, activeItem.prerequisite!)
    else
      onDependencySet?.(activeItem.number, newParent)
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
                {ordered.map(({ issue, depth }) => {
                  const { locked, prerequisiteNumber } = isIssueLocked(issue, issues)
                  return (
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
                      locked={locked}
                      lockedPrerequisite={prerequisiteNumber}
                    />
                  )
                })}
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
