import { describe, expect, it } from 'vitest'
import { getSuperpowersPanelHtmlContent } from '../../src/webview/html'

describe('getSuperpowersPanelHtmlContent', () => {
  it('包含 Tab 切换元素', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="tab"')
    expect(html).toContain('data-tab="specs"')
    expect(html).toContain('data-tab="plans"')
  })

  it('包含表格结构', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="data-table"')
    expect(html).toContain('id="specs-body"')
    expect(html).toContain('id="plans-body"')
  })

  it('包含状态下拉菜单', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('class="status-dropdown"')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('data-status="needsTesting"')
    expect(html).toContain('data-status="default"')
  })

  it('Plans 操作列包含运行按钮', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('>运行</')
    expect(html).toContain("command: 'runPlan'")
  })

  it('任务状态与文档状态分离渲染，使用独立任务状态文案', () => {
    const html = getSuperpowersPanelHtmlContent()

    expect(html).toContain('function getTaskStatusText')
    expect(html).toContain("case 'running': return '运行中'")
    expect(html).toContain("case 'completed': return '已完成'")
    expect(html).toContain("case 'failed': return '失败'")
    expect(html).toContain('plan.taskStatus')
  })

  it('根据 taskStatus 控制运行按钮显隐', () => {
    const html = getSuperpowersPanelHtmlContent()

    expect(html).toContain("plan.taskStatus === 'running'")
    expect(html).toContain("const runActionHtml = plan.taskStatus === 'running'")
    expect(html).toContain("'<span class=\"action\" onclick=\"runPlan(\\'' + plan.path + '\\')\">运行</span> '")
  })

  it('包含 switchTab 函数', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('function switchTab')
  })

  it('包含状态徽章样式', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).toContain('.status-badge.completed')
    expect(html).toContain('.status-badge.needsTesting')
    expect(html).toContain('.status-badge.default')
  })

  it('不包含旧的右键菜单代码', () => {
    const html = getSuperpowersPanelHtmlContent()
    expect(html).not.toContain('context-menu')
    expect(html).not.toContain('contextmenu')
  })
})
