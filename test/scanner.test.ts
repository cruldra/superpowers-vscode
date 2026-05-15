import type { Task } from '../src/types'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanTasks } from '../src/scanner'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'superpowers-test-'))
  mkdirSync(join(workspace, 'docs', 'superpowers', 'specs'), { recursive: true })
  mkdirSync(join(workspace, 'docs', 'superpowers', 'plans'), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function writeSpec(name: string, content: string) {
  writeFileSync(join(workspace, 'docs', 'superpowers', 'specs', name), content)
}

function writePlan(name: string, content: string) {
  writeFileSync(join(workspace, 'docs', 'superpowers', 'plans', name), content)
}

describe('scanTasks', () => {
  it('returns empty array when no files exist', async () => {
    const result = await scanTasks(workspace)
    expect(result).toEqual([])
  })

  it('returns empty array when docs/superpowers does not exist', async () => {
    rmSync(join(workspace, 'docs'), { recursive: true })
    const result = await scanTasks(workspace)
    expect(result).toEqual([])
  })

  it('pairs spec and plan with same date+topic into one task', async () => {
    writeSpec('2026-05-15-rewrite-design.md', '# Rewrite Design\nbody')
    writePlan('2026-05-15-rewrite.md', '# Rewrite Plan\nbody')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject<Partial<Task>>({
      id: '2026-05-15-rewrite',
      date: '2026-05-15',
      topic: 'rewrite',
      title: 'Rewrite Design',
      phase: 'development',
      state: 'implement',
    })
    expect(result[0].specPath).toContain('2026-05-15-rewrite-design.md')
    expect(result[0].planPath).toContain('2026-05-15-rewrite.md')
  })

  it('creates planning-phase task when only spec exists', async () => {
    writeSpec('2026-05-10-foo-design.md', '# Foo Design')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].phase).toBe('planning')
    expect(result[0].state).toBe('write-plan')
    expect(result[0].planPath).toBeUndefined()
    expect(result[0].title).toBe('Foo Design')
  })

  it('creates development-phase task when only plan exists', async () => {
    writePlan('2026-05-11-bar.md', '# Bar Plan')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].phase).toBe('development')
    expect(result[0].state).toBe('implement')
    expect(result[0].specPath).toBeUndefined()
    expect(result[0].title).toBe('Bar Plan')
  })

  it('falls back to topic when no H1 in markdown', async () => {
    writeSpec('2026-05-12-baz-design.md', 'no heading here')
    const result = await scanTasks(workspace)
    expect(result[0].title).toBe('baz')
  })

  it('sorts tasks by date descending', async () => {
    writeSpec('2026-05-10-a-design.md', '# A')
    writeSpec('2026-05-15-b-design.md', '# B')
    writeSpec('2026-05-12-c-design.md', '# C')
    const result = await scanTasks(workspace)
    expect(result.map(t => t.id)).toEqual([
      '2026-05-15-b',
      '2026-05-12-c',
      '2026-05-10-a',
    ])
  })

  it('ignores files that do not match naming convention', async () => {
    writeSpec('not-dated.md', '# Bad')
    writePlan('readme.md', '# Bad')
    writeSpec('2026-13-99-bad-design.md', '# Bad') // invalid date passes regex but is logically odd; convention check is only by shape
    writePlan('2026-05-15-good.md', '# Good')
    const result = await scanTasks(workspace)
    expect(result.map(t => t.id)).toContain('2026-05-15-good')
    expect(result.find(t => t.id.includes('not-dated'))).toBeUndefined()
    expect(result.find(t => t.id.includes('readme'))).toBeUndefined()
  })

  it('handles topic with multiple hyphens correctly', async () => {
    writeSpec('2026-05-15-react-shadcn-rewrite-design.md', '# X')
    writePlan('2026-05-15-react-shadcn-rewrite.md', '# Y')
    const result = await scanTasks(workspace)
    expect(result).toHaveLength(1)
    expect(result[0].topic).toBe('react-shadcn-rewrite')
    expect(result[0].id).toBe('2026-05-15-react-shadcn-rewrite')
  })
})
