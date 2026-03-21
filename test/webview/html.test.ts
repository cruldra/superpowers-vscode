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
