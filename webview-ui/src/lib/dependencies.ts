import type { Issue } from '../types'

/**
 * 计算一个 issue 是否处于"锁定"状态（其前置工单尚未完成）。
 *
 * 锁定条件（全部满足）：
 * 1. `issue.prerequisite !== undefined`
 * 2. 在 `allIssues` 中能找到对应的前置工单
 * 3. 前置工单的 `column !== 'done'`
 *
 * @param issue 待检查的工单
 * @param allIssues 当前所有工单（用于查找前置工单状态）
 * @returns 锁定状态及前置工单号（用于 tooltip 文案）
 */
export function isIssueLocked(
  issue: Issue,
  allIssues: Issue[],
): { locked: boolean, prerequisiteNumber?: number } {
  if (issue.prerequisite === undefined)
    return { locked: false }
  const prereq = allIssues.find(i => i.number === issue.prerequisite)
  if (!prereq)
    return { locked: false }
  return {
    locked: prereq.column !== 'done',
    prerequisiteNumber: issue.prerequisite,
  }
}
