import type { PlanFile, SpecFile, SuperpowersData } from './types'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isPlanContentMarkedAsNeedsTesting } from './planCompletion'

export class SuperpowersScanner {
  private readonly specsDir = 'docs/superpowers/specs'
  private readonly plansDir = 'docs/superpowers/plans'

  async scan(workspaceRoot: string): Promise<SuperpowersData> {
    const [specs, plans] = await Promise.all([
      this.scanSpecs(path.join(workspaceRoot, this.specsDir)),
      this.scanPlans(path.join(workspaceRoot, this.plansDir)),
    ])

    return { specs, plans }
  }

  private async scanSpecs(dirPath: string): Promise<SpecFile[]> {
    if (!fs.existsSync(dirPath)) {
      return []
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'))
    const results: SpecFile[] = []

    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const date = this.parseDateFromFilename(file)
      const parsed = this.parseSpec(content, file)

      results.push({
        name: file.replace('.md', ''),
        date,
        title: parsed.title,
        path: filePath,
      })
    }

    return results.sort((a, b) => b.date.localeCompare(a.date))
  }

  private async scanPlans(dirPath: string): Promise<PlanFile[]> {
    if (!fs.existsSync(dirPath)) {
      return []
    }

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'))
    const results: PlanFile[] = []

    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const date = this.parseDateFromFilename(file)
      const parsed = this.parsePlan(content, file)

      results.push({
        name: file.replace('.md', ''),
        date,
        title: parsed.title,
        path: filePath,
        status: parsed.status,
        progress: parsed.progress,
      })
    }

    return results.sort((a, b) => b.date.localeCompare(a.date))
  }

  parseSpec(content: string, fileName: string): { title: string } {
    const titleMatch = content.match(/^# (.+)$/m)
    return {
      title: titleMatch ? titleMatch[1] : fileName.replace('.md', ''),
    }
  }

  parsePlan(content: string, fileName: string): { title: string, status: PlanFile['status'], progress: { completed: number, total: number } } {
    const titleMatch = content.match(/^# (.+)$/m)
    const completed = (content.match(/^- \[x\]/gim) || []).length
    const total = (content.match(/^- \[[ x]\]/gim) || []).length
    const isCompleted = total > 0 && completed === total
    const isNeedsTesting = isPlanContentMarkedAsNeedsTesting(content)

    return {
      title: titleMatch ? titleMatch[1] : fileName.replace('.md', ''),
      status: isCompleted ? 'completed' : (isNeedsTesting ? 'needsTesting' : 'default'),
      progress: { completed, total },
    }
  }

  parseDateFromFilename(filename: string): string {
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/)
    return dateMatch ? dateMatch[1] : ''
  }
}
