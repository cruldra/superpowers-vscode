import { describe, expect, it } from 'vitest'
import { getPlanContextMenuVisibility, shouldAutoOpenPanel } from '../src/panelOpenInteraction'
import { markPlanContentAsCompleted, markPlanContentAsNeedsTesting } from '../src/planCompletion'

describe('shouldAutoOpenPanel', () => {
  it('在新的可见切换时返回 true', () => {
    expect(shouldAutoOpenPanel({
      isVisible: true,
      wasVisible: false,
      isAutoOpeningPanel: false,
    })).toBe(true)
  })

  it('视图已经可见时返回 false', () => {
    expect(shouldAutoOpenPanel({
      isVisible: true,
      wasVisible: true,
      isAutoOpeningPanel: false,
    })).toBe(false)
  })

  it('自动打开流程执行中返回 false', () => {
    expect(shouldAutoOpenPanel({
      isVisible: true,
      wasVisible: false,
      isAutoOpeningPanel: true,
    })).toBe(false)
  })

  it('视图不可见时返回 false', () => {
    expect(shouldAutoOpenPanel({
      isVisible: false,
      wasVisible: false,
      isAutoOpeningPanel: false,
    })).toBe(false)
  })
})

describe('markPlanContentAsCompleted', () => {
  it('只把未完成的 todo 标记成已完成', () => {
    const content = `# Demo Plan

- [ ] task 1
- [x] task 2
- [ ] task 3`

    expect(markPlanContentAsCompleted(content)).toBe(`# Demo Plan

- [x] task 1
- [x] task 2
- [x] task 3`)
  })

  it('不改动非 todo 内容', () => {
    const content = `# Demo Plan

说明文字

- [ ] task 1
普通文本`

    expect(markPlanContentAsCompleted(content)).toBe(`# Demo Plan

说明文字

- [x] task 1
普通文本`)
  })

  it('标记完成时移除需要测试标记', () => {
    const content = `# Demo Plan
<!-- superpowers:needs-testing -->

- [ ] task 1`

    expect(markPlanContentAsCompleted(content)).toBe(`# Demo Plan

- [x] task 1`)
  })
})

describe('markPlanContentAsNeedsTesting', () => {
  it('在标题后插入需要测试标记', () => {
    const content = `# Demo Plan

- [ ] task 1`

    expect(markPlanContentAsNeedsTesting(content)).toBe(`# Demo Plan
<!-- superpowers:needs-testing -->

- [ ] task 1`)
  })

  it('重复标记时不插入重复内容', () => {
    const content = `# Demo Plan
<!-- superpowers:needs-testing -->

- [ ] task 1`

    expect(markPlanContentAsNeedsTesting(content)).toBe(content)
  })

  it('从已完成切回需要测试时清除完成状态', () => {
    const content = `# Demo Plan

- [x] task 1
- [x] task 2`

    expect(markPlanContentAsNeedsTesting(content)).toBe(`# Demo Plan
<!-- superpowers:needs-testing -->

- [ ] task 1
- [ ] task 2`)
  })
})

describe('getPlanContextMenuVisibility', () => {
  it('默认状态显示两个动作', () => {
    expect(getPlanContextMenuVisibility('default')).toEqual({
      showNeedsTesting: true,
      showCompleted: true,
    })
  })

  it('需要测试状态隐藏对应动作', () => {
    expect(getPlanContextMenuVisibility('needsTesting')).toEqual({
      showNeedsTesting: false,
      showCompleted: true,
    })
  })

  it('已完成状态隐藏对应动作', () => {
    expect(getPlanContextMenuVisibility('completed')).toEqual({
      showNeedsTesting: true,
      showCompleted: false,
    })
  })
})
