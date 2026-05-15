import type { Phase, Task, TaskState } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SPEC_REGEX = /^(\d{4}-\d{2}-\d{2})-(.+)-design\.md$/
const PLAN_REGEX = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/

interface FileInfo {
  date: string
  topic: string
  filePath: string
  title: string
}

function extractTitle(filePath: string, fallback: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^# (.+)$/m)
    return match ? match[1].trim() : fallback
  }
  catch {
    return fallback
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir))
    return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'))
}

function parseSpecs(specsDir: string): FileInfo[] {
  return listMarkdownFiles(specsDir)
    .map((name) => {
      const m = name.match(SPEC_REGEX)
      if (!m)
        return null
      const filePath = path.join(specsDir, name)
      return {
        date: m[1],
        topic: m[2],
        filePath,
        title: extractTitle(filePath, m[2]),
      }
    })
    .filter((x): x is FileInfo => x !== null)
}

function parsePlans(plansDir: string): FileInfo[] {
  return listMarkdownFiles(plansDir)
    .map((name) => {
      // Plan 不能匹配 -design.md 后缀
      if (SPEC_REGEX.test(name))
        return null
      const m = name.match(PLAN_REGEX)
      if (!m)
        return null
      const filePath = path.join(plansDir, name)
      return {
        date: m[1],
        topic: m[2],
        filePath,
        title: extractTitle(filePath, m[2]),
      }
    })
    .filter((x): x is FileInfo => x !== null)
}

/**
 * 状态判定占位逻辑 —— 仅按文件存在性给一个默认状态。
 * TODO: 状态判定逻辑等下一轮迭代补充（来源可能是 frontmatter / workspace state / 手动点选）。
 */
function inferPhaseAndState(hasSpec: boolean, hasPlan: boolean): { phase: Phase, state: TaskState } {
  if (hasSpec && !hasPlan)
    return { phase: 'planning', state: 'write-plan' }
  return { phase: 'development', state: 'implement' }
}

export async function scanTasks(workspaceRoot: string): Promise<Task[]> {
  const specsDir = path.join(workspaceRoot, 'docs', 'superpowers', 'specs')
  const plansDir = path.join(workspaceRoot, 'docs', 'superpowers', 'plans')

  const specs = parseSpecs(specsDir)
  const plans = parsePlans(plansDir)

  const map = new Map<string, Task>()

  for (const s of specs) {
    const id = `${s.date}-${s.topic}`
    const { phase, state } = inferPhaseAndState(true, false)
    map.set(id, {
      id,
      title: s.title,
      date: s.date,
      topic: s.topic,
      specPath: s.filePath,
      phase,
      state,
    })
  }

  for (const p of plans) {
    const id = `${p.date}-${p.topic}`
    const existing = map.get(id)
    if (existing) {
      existing.planPath = p.filePath
      const { phase, state } = inferPhaseAndState(!!existing.specPath, true)
      existing.phase = phase
      existing.state = state
    }
    else {
      const { phase, state } = inferPhaseAndState(false, true)
      map.set(id, {
        id,
        title: p.title,
        date: p.date,
        topic: p.topic,
        planPath: p.filePath,
        phase,
        state,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date))
}
