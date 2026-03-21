import { describe, expect, it } from 'vitest'
import { SuperpowersScanner } from '../src/scanner'

describe('superpowersScanner', () => {
  const scanner = new SuperpowersScanner()

  describe('parseSpec', () => {
    it('从内容中提取 H1 标题', () => {
      const content = '# 测试标题\n\n这是内容'
      const result = scanner.parseSpec(content, 'test-file')
      expect(result.title).toBe('测试标题')
    })

    it('无标题时使用文件名', () => {
      const content = '无标题内容'
      const result = scanner.parseSpec(content, 'test-file')
      expect(result.title).toBe('test-file')
    })
  })

  describe('parsePlan', () => {
    it('计算任务进度', () => {
      const content = `# 计划

- [x] 任务1
- [x] 任务2
- [ ] 任务3
- [ ] 任务4`
      const result = scanner.parsePlan(content, 'test-plan')
      expect(result.progress.completed).toBe(2)
      expect(result.progress.total).toBe(4)
    })

    it('无任务时进度为零', () => {
      const content = '# 计划\n\n无任务'
      const result = scanner.parsePlan(content, 'test-plan')
      expect(result.progress.completed).toBe(0)
      expect(result.progress.total).toBe(0)
    })

    it('识别需要测试状态', () => {
      const content = `# 计划
<!-- superpowers:needs-testing -->

- [ ] 任务1`
      const result = scanner.parsePlan(content, 'test-plan')
      expect(result.status).toBe('needsTesting')
    })
  })

  describe('parseDateFromFilename', () => {
    it('从文件名提取日期', () => {
      expect(scanner.parseDateFromFilename('2026-03-19-test-design.md')).toBe('2026-03-19')
      expect(scanner.parseDateFromFilename('2026-03-18-test.md')).toBe('2026-03-18')
    })

    it('无效日期返回空字符串', () => {
      expect(scanner.parseDateFromFilename('test.md')).toBe('')
    })
  })
})
