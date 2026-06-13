import type { Issue, IssueColumn } from '../types'

/**
 * 看板每一列的卡片排序。
 *
 * `done` 列按 PR 合并时间（merged_at）降序，最近合并的在最前；缺合并时间的
 * 工单排在有时间的之后，按工单号降序兜底。其余列一律按工单号降序。
 */
export function compareIssuesInColumn(col: IssueColumn, a: Issue, b: Issue): number {
  if (col === 'done') {
    const am = a.prMergedAt
    const bm = b.prMergedAt
    if (am && bm && am !== bm)
      return bm.localeCompare(am)
    if (am && !bm)
      return -1
    if (bm && !am)
      return 1
  }
  return b.number - a.number
}
