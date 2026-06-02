/**
 * Workspace 级「项目 Claude 会话管理器」持久化。
 *
 * 只记录从会话管理 tab 创建过的 cc 会话（不扫 ~/.claude/projects），
 * 落盘到 `<workspace>/.spx/session-names.json`。文件不存在或解析失败时
 * 返回空列表 `{ sessions: [] }`，首次 `writeManagedSessions` 时按需
 * `mkdir -p .spx` 再写入。
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface ManagedSession {
  id: string
  name: string
  profilePath?: string
  createdAt: number
}

export interface ManagedSessionsData {
  sessions: ManagedSession[]
}

function sessionsFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.spx', 'session-names.json')
}

/**
 * 读取工作区受管理的 Claude 会话列表。文件不存在或 JSON 解析失败时返回空列表。
 */
export async function readManagedSessions(workspaceRoot: string): Promise<ManagedSessionsData> {
  const file = sessionsFile(workspaceRoot)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  }
  catch {
    return { sessions: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ManagedSessionsData>
    const sessions: ManagedSession[] = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map((s) => {
            const id = typeof s?.id === 'string' ? s.id : ''
            const name = typeof s?.name === 'string' ? s.name : ''
            const profilePath = typeof s?.profilePath === 'string' ? s.profilePath : undefined
            const createdAt = typeof s?.createdAt === 'number' ? s.createdAt : 0
            return { id, name, profilePath, createdAt }
          })
          .filter(s => s.id !== '')
      : []
    return { sessions }
  }
  catch {
    return { sessions: [] }
  }
}

/**
 * 写入工作区受管理的 Claude 会话列表。父目录不存在会自动创建。
 */
export async function writeManagedSessions(workspaceRoot: string, data: ManagedSessionsData): Promise<void> {
  const dir = path.join(workspaceRoot, '.spx')
  await fsp.mkdir(dir, { recursive: true })
  const file = sessionsFile(workspaceRoot)
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
