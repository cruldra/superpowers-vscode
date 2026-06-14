/**
 * Workspace 级「PR 审查已确认文件」持久化。
 *
 * 落盘到 `<workspace>/.spx/pr-review-confirmed.json`，形状
 * `Record<string, string[]>`：key = `${issueNumber}:${sha}`，value = 该提交里
 * 已确认（已审阅）的文件完整路径数组。目录不单独记录——目录是否确认靠「其下
 * 可见文件是否全已确认」推导。文件不存在或解析失败时按空处理。
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

type ConfirmedMap = Record<string, string[]>

function confirmedFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.spx', 'pr-review-confirmed.json')
}

function makeKey(issueNumber: number, sha: string): string {
  return `${issueNumber}:${sha}`
}

/** 读出整个映射；文件不存在或解析失败返回空对象。 */
async function readMap(workspaceRoot: string): Promise<ConfirmedMap> {
  const file = confirmedFile(workspaceRoot)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  }
  catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    const out: ConfirmedMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value))
        out[key] = value.filter((p): p is string => typeof p === 'string')
    }
    return out
  }
  catch {
    return {}
  }
}

/**
 * 读取某 (issueNumber, sha) 下已确认的文件路径数组。文件缺失、解析失败或无该
 * key 时返回 `[]`。
 */
export async function readConfirmed(
  workspaceRoot: string,
  issueNumber: number,
  sha: string,
): Promise<string[]> {
  const map = await readMap(workspaceRoot)
  return map[makeKey(issueNumber, sha)] ?? []
}

/**
 * 写入某 (issueNumber, sha) 下已确认的文件路径数组。空数组则删除该 key；非空则
 * 设值。父目录不存在会自动创建。
 */
export async function writeConfirmed(
  workspaceRoot: string,
  issueNumber: number,
  sha: string,
  paths: string[],
): Promise<void> {
  const map = await readMap(workspaceRoot)
  const key = makeKey(issueNumber, sha)
  if (paths.length > 0)
    map[key] = paths
  else
    delete map[key]
  const dir = path.join(workspaceRoot, '.spx')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(confirmedFile(workspaceRoot), `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}

/**
 * 读取某工单已确认（已审阅）的提交 sha 数组。key = `${issueNumber}:commits`
 * （`commits` 非合法 sha，不与文件确认的 `${issueNumber}:${sha}` key 冲突）。
 * 文件缺失、解析失败或无该 key 时返回 `[]`。
 */
export async function readConfirmedCommits(
  workspaceRoot: string,
  issueNumber: number,
): Promise<string[]> {
  const map = await readMap(workspaceRoot)
  return map[`${issueNumber}:commits`] ?? []
}

/**
 * 写入某工单已确认的提交 sha 数组。空数组则删除该 key；非空则设值。父目录不存在
 * 会自动创建。
 */
export async function writeConfirmedCommits(
  workspaceRoot: string,
  issueNumber: number,
  shas: string[],
): Promise<void> {
  const map = await readMap(workspaceRoot)
  const key = `${issueNumber}:commits`
  if (shas.length > 0)
    map[key] = shas
  else
    delete map[key]
  const dir = path.join(workspaceRoot, '.spx')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(confirmedFile(workspaceRoot), `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}
