/**
 * Workspace 级「YouTrack 已导入工单集」持久化。
 *
 * 只把用户主动勾选导入的工单镜像到看板（不再加载即全量同步），落盘到
 * `<workspace>/.spx/youtrack-imported.json`。形状是
 * `Record<项目 shortName, idReadable[]>`，便于一个工作区配多个项目。
 * 文件不存在或解析失败时该项目返回空集；首次写入时按需 `mkdir -p .spx`。
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

function importsFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.spx', 'youtrack-imported.json')
}

/** 读取整个 `Record<project, idReadable[]>`。文件缺失/解析失败/形状不符均返回 `{}`。 */
async function readAll(workspaceRoot: string): Promise<Record<string, string[]>> {
  let raw: string
  try {
    raw = await fsp.readFile(importsFile(workspaceRoot), 'utf8')
  }
  catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object')
      return {}
    const out: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value))
        out[key] = value.filter((v): v is string => typeof v === 'string')
    }
    return out
  }
  catch {
    return {}
  }
}

/** 读取某项目已导入的 idReadable 列表。无记录返回 `[]`。 */
export async function readImportedIds(workspaceRoot: string, project: string): Promise<string[]> {
  const all = await readAll(workspaceRoot)
  return all[project] ?? []
}

/** 写入某项目的已导入 idReadable 列表（去重）。空列表则删除该 key。父目录按需创建。 */
export async function writeImportedIds(workspaceRoot: string, project: string, ids: string[]): Promise<void> {
  const all = await readAll(workspaceRoot)
  if (ids.length > 0)
    all[project] = [...new Set(ids)]
  else
    delete all[project]
  const dir = path.join(workspaceRoot, '.spx')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(importsFile(workspaceRoot), `${JSON.stringify(all, null, 2)}\n`, 'utf8')
}
