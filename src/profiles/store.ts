/**
 * Workspace 级 profiles 表持久化。
 *
 * 单个工作区一张表，落盘到 `<workspace>/.spx/profiles.json`。
 * 文件不存在或解析失败时返回默认 `{ profiles: ['dev', 'prod'], rows: [] }`，
 * 首次 `writeProfiles` 时按需 `mkdir -p .spx` 再写入。
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface ProfileRow {
  key: string
  values: Record<string, string>
}

export interface ProfilesData {
  profiles: string[]
  rows: ProfileRow[]
}

const DEFAULT_DATA: ProfilesData = {
  profiles: ['dev', 'prod'],
  rows: [],
}

function profilesFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.spx', 'profiles.json')
}

/**
 * 读取工作区 profiles 表。文件不存在或 JSON 解析失败时返回默认值。
 */
export async function readProfiles(workspaceRoot: string): Promise<ProfilesData> {
  const file = profilesFile(workspaceRoot)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  }
  catch {
    return { profiles: [...DEFAULT_DATA.profiles], rows: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProfilesData>
    const profiles = Array.isArray(parsed.profiles) && parsed.profiles.length > 0
      ? parsed.profiles.map(String)
      : [...DEFAULT_DATA.profiles]
    const rows: ProfileRow[] = Array.isArray(parsed.rows)
      ? parsed.rows.map((r) => {
          const key = typeof r?.key === 'string' ? r.key : ''
          const valuesObj = r?.values && typeof r.values === 'object' ? r.values : {}
          const values: Record<string, string> = {}
          for (const [k, v] of Object.entries(valuesObj))
            values[k] = typeof v === 'string' ? v : String(v ?? '')
          return { key, values }
        })
      : []
    return { profiles, rows }
  }
  catch {
    return { profiles: [...DEFAULT_DATA.profiles], rows: [] }
  }
}

/**
 * 写入工作区 profiles 表。父目录不存在会自动创建。
 */
export async function writeProfiles(workspaceRoot: string, data: ProfilesData): Promise<void> {
  const dir = path.join(workspaceRoot, '.spx')
  await fsp.mkdir(dir, { recursive: true })
  const file = profilesFile(workspaceRoot)
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
