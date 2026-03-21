# Superpowers 面板首次点击打开交互实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户第一次点击左侧 `Superpowers` 图标时就直接在编辑区打开面板，并在打开后把左侧切回默认 `File Explorer`。

**Architecture:** 把交互拆成四层：`src/panelOpenInteraction.ts` 负责纯判定和流程函数；`src/panelOpenWiring.ts` 负责不依赖 `vscode` 的装配 seam，用来验证可见性桥接、初始可见处理和状态更新；`src/indexBindings.ts` 负责可测试的扩展入口绑定；`src/index.ts` 只做最薄的 VS Code API 适配。`superpowers.openPanel` 保持为纯通用入口，不承载切回 Explorer 的副作用。Explorer 切回采用 best-effort，不阻断主流程。

**Tech Stack:** TypeScript, VS Code Extension API, reactive-vscode, Vitest

---

## 文件结构

- Create: `src/panelOpenInteraction.ts`
  - 放纯函数和依赖注入接口
  - 不直接依赖 `vscode`
- Create: `src/panelOpenWiring.ts`
  - 放可测试的装配函数
  - 负责把可见性事件桥接到自动入口
  - 负责处理初始已可见场景
- Create: `src/indexBindings.ts`
  - 放可测试的扩展入口绑定函数
  - 负责把 TreeView、自动入口和初始检查连起来
- Modify: `src/index.ts`
  - 使用纯函数模块、装配 seam 和入口绑定函数接入真实 VS Code API
- Modify: `test/index.test.ts`
  - 复用现有测试文件，覆盖交互判定、装配和边界场景

---

## Task 1: 建立纯函数测试入口

**Files:**
- Modify: `test/index.test.ts`
- Create: `src/panelOpenInteraction.ts`

- [ ] **Step 1: 在 `test/index.test.ts` 写失败测试，先约束基础判定函数存在**

```typescript
import { describe, expect, it } from 'vitest'
import { shouldAutoOpenPanel } from '../src/panelOpenInteraction'

describe('shouldAutoOpenPanel', () => {
  it('在新的可见切换时返回 true', () => {
    expect(shouldAutoOpenPanel({
      isVisible: true,
      wasVisible: false,
      isAutoOpeningPanel: false,
      allowAutoOpen: true,
    })).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，提示 `../src/panelOpenInteraction` 或 `shouldAutoOpenPanel` 不存在

- [ ] **Step 3: 创建 `src/panelOpenInteraction.ts`，只写通过当前测试所需的最小实现**

```typescript
export interface AutoOpenDecisionInput {
  isVisible: boolean
  wasVisible: boolean
  isAutoOpeningPanel: boolean
  allowAutoOpen: boolean
}

export function shouldAutoOpenPanel(input: AutoOpenDecisionInput): boolean {
  return input.allowAutoOpen && input.isVisible && !input.wasVisible && !input.isAutoOpeningPanel
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/panelOpenInteraction.ts test/index.test.ts
git commit -m "✅ test(interaction): 建立自动打开判定入口"
```

---

## Task 2: 完成自动打开判定边界

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/panelOpenInteraction.ts`

- [ ] **Step 1: 写失败测试，约束 `allowAutoOpen` 为 `false` 时不自动打开**

```typescript
it('未授权自动打开时返回 false', () => {
  expect(shouldAutoOpenPanel({
    isVisible: true,
    wasVisible: false,
    isAutoOpeningPanel: false,
    allowAutoOpen: false,
  })).toBe(false)
})
```

- [ ] **Step 2: 写失败测试，约束“已可见时不重复自动打开”**

```typescript
it('视图已可见时返回 false', () => {
  expect(shouldAutoOpenPanel({
    isVisible: true,
    wasVisible: true,
    isAutoOpeningPanel: false,
    allowAutoOpen: true,
  })).toBe(false)
})
```

- [ ] **Step 3: 写失败测试，约束“自动流程执行中不再次自动打开”**

```typescript
it('自动流程执行中返回 false', () => {
  expect(shouldAutoOpenPanel({
    isVisible: true,
    wasVisible: false,
    isAutoOpeningPanel: true,
    allowAutoOpen: true,
  })).toBe(false)
})
```

- [ ] **Step 4: 写失败测试，约束“视图不可见时不自动打开”**

```typescript
it('视图不可见时返回 false', () => {
  expect(shouldAutoOpenPanel({
    isVisible: false,
    wasVisible: false,
    isAutoOpeningPanel: false,
    allowAutoOpen: true,
  })).toBe(false)
})
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，新增断言至少一项失败

- [ ] **Step 6: 只按测试需求完善 `shouldAutoOpenPanel()`**

```typescript
export function shouldAutoOpenPanel(input: AutoOpenDecisionInput): boolean {
  if (!input.allowAutoOpen)
    return false

  if (!input.isVisible)
    return false

  if (input.wasVisible)
    return false

  if (input.isAutoOpeningPanel)
    return false

  return true
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/panelOpenInteraction.ts test/index.test.ts
git commit -m "✅ test(interaction): 覆盖自动打开判定边界"
```

---

## Task 3: 锁定通用入口的无副作用契约和无 workspace 边界

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/panelOpenInteraction.ts`

- [ ] **Step 1: 写失败测试，约束通用入口只负责打开和刷新面板**

```typescript
import { vi } from 'vitest'
import { createOpenPanelHandler } from '../src/panelOpenInteraction'

it('通用 openPanel 入口不会切回 Explorer', async () => {
  const createOrShowPanel = vi.fn().mockReturnValue({ updateData: vi.fn() })
  const scanWorkspace = vi.fn().mockResolvedValue({ specs: [], plans: [] })
  const executeCommand = vi.fn()
  const openPanel = createOpenPanelHandler({
    createOrShowPanel,
    scanWorkspace,
    executeCommand,
  })

  await openPanel()

  expect(createOrShowPanel).toHaveBeenCalledOnce()
  expect(scanWorkspace).toHaveBeenCalledOnce()
  expect(executeCommand).not.toHaveBeenCalledWith('workbench.view.explorer')
})
```

- [ ] **Step 2: 写失败测试，约束无 workspace 数据时不会调用 `updateData`**

```typescript
it('无 workspace 数据时不会调用 updateData', async () => {
  const updateData = vi.fn()
  const openPanel = createOpenPanelHandler({
    createOrShowPanel: vi.fn().mockReturnValue({ updateData }),
    scanWorkspace: vi.fn().mockResolvedValue(undefined),
  })

  await openPanel()

  expect(updateData).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，提示 `createOpenPanelHandler` 不存在或新增断言失败

- [ ] **Step 4: 在 `src/panelOpenInteraction.ts` 中实现最小通用入口处理函数**

```typescript
export interface OpenPanelDeps<TData> {
  createOrShowPanel: () => { updateData: (data: TData) => void }
  scanWorkspace: () => Promise<TData | undefined>
  executeCommand?: (command: string) => Promise<unknown>
}

export function createOpenPanelHandler<TData>(deps: OpenPanelDeps<TData>) {
  return async function openPanel(): Promise<void> {
    const panel = deps.createOrShowPanel()
    const data = await deps.scanWorkspace()
    if (data !== undefined)
      panel.updateData(data)
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/panelOpenInteraction.ts test/index.test.ts
git commit -m "✅ test(interaction): 锁定通用入口契约与空数据边界"
```

---

## Task 4: 为自动入口补上主流程

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/panelOpenInteraction.ts`

- [ ] **Step 1: 写失败测试，约束自动入口会先打开面板再尝试切回 Explorer**

```typescript
import { createActivityBarAutoOpenHandler } from '../src/panelOpenInteraction'

it('自动入口在 openPanel 成功后尝试切回 Explorer', async () => {
  const calls: string[] = []
  const openFromActivityBar = createActivityBarAutoOpenHandler({
    openPanel: async () => { calls.push('openPanel') },
    executeCommand: async (command) => { calls.push(command) },
    getIsAutoOpeningPanel: () => false,
    setIsAutoOpeningPanel: () => {},
    logDebug: () => {},
  })

  await openFromActivityBar()

  expect(calls).toEqual(['openPanel', 'workbench.view.explorer'])
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，提示 `createActivityBarAutoOpenHandler` 不存在

- [ ] **Step 3: 在 `src/panelOpenInteraction.ts` 中实现最小自动入口流程**

```typescript
export interface ActivityBarAutoOpenDeps {
  openPanel: () => Promise<void>
  executeCommand: (command: string) => Promise<unknown>
  getIsAutoOpeningPanel: () => boolean
  setIsAutoOpeningPanel: (value: boolean) => void
  logDebug: (message: string, error: unknown) => void
}

export function createActivityBarAutoOpenHandler(deps: ActivityBarAutoOpenDeps) {
  return async function openPanelFromActivityBar(): Promise<void> {
    await deps.openPanel()
    await deps.executeCommand('workbench.view.explorer')
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/panelOpenInteraction.ts test/index.test.ts
git commit -m "✅ test(interaction): 补自动入口主流程"
```

---

## Task 5: 给自动入口补上防重入、异常清理和 best-effort 回退

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/panelOpenInteraction.ts`

- [ ] **Step 1: 写失败测试，约束自动流程执行中再次触发会被忽略**

```typescript
it('自动流程执行中再次触发会被忽略', async () => {
  const openPanel = vi.fn()
  const openFromActivityBar = createActivityBarAutoOpenHandler({
    openPanel,
    executeCommand: vi.fn(),
    getIsAutoOpeningPanel: () => true,
    setIsAutoOpeningPanel: vi.fn(),
    logDebug: vi.fn(),
  })

  await openFromActivityBar()

  expect(openPanel).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 写失败测试，约束自动入口异常后会清理防重入状态**

```typescript
it('自动入口在 openPanel 抛错后仍会清理防重入状态', async () => {
  const setIsAutoOpeningPanel = vi.fn()
  const openFromActivityBar = createActivityBarAutoOpenHandler({
    openPanel: vi.fn().mockRejectedValue(new Error('boom')),
    executeCommand: vi.fn(),
    getIsAutoOpeningPanel: () => false,
    setIsAutoOpeningPanel,
    logDebug: vi.fn(),
  })

  await expect(openFromActivityBar()).rejects.toThrow('boom')
  expect(setIsAutoOpeningPanel).toHaveBeenNthCalledWith(1, true)
  expect(setIsAutoOpeningPanel).toHaveBeenLastCalledWith(false)
})
```

- [ ] **Step 3: 写失败测试，约束切回 Explorer 失败时不影响主流程**

```typescript
it('切回 Explorer 失败时不影响主流程完成', async () => {
  const openFromActivityBar = createActivityBarAutoOpenHandler({
    openPanel: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockRejectedValue(new Error('no explorer')),
    getIsAutoOpeningPanel: () => false,
    setIsAutoOpeningPanel: vi.fn(),
    logDebug: vi.fn(),
  })

  await expect(openFromActivityBar()).resolves.toBeUndefined()
})
```

- [ ] **Step 4: 写失败测试，约束切回 Explorer 失败时会记录调试日志**

```typescript
it('切回 Explorer 失败时记录调试日志', async () => {
  const logDebug = vi.fn()
  const openFromActivityBar = createActivityBarAutoOpenHandler({
    openPanel: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockRejectedValue(new Error('no explorer')),
    getIsAutoOpeningPanel: () => false,
    setIsAutoOpeningPanel: vi.fn(),
    logDebug,
  })

  await openFromActivityBar()

  expect(logDebug).toHaveBeenCalledOnce()
})
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，新增断言至少一项失败

- [ ] **Step 6: 在 `src/panelOpenInteraction.ts` 中补上防重入、`try/finally` 和 best-effort 回退**

```typescript
export function createActivityBarAutoOpenHandler(deps: ActivityBarAutoOpenDeps) {
  return async function openPanelFromActivityBar(): Promise<void> {
    if (deps.getIsAutoOpeningPanel())
      return

    deps.setIsAutoOpeningPanel(true)
    try {
      await deps.openPanel()
      try {
        await deps.executeCommand('workbench.view.explorer')
      }
      catch (error) {
        deps.logDebug('Failed to switch back to explorer view', error)
      }
    }
    finally {
      deps.setIsAutoOpeningPanel(false)
    }
  }
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/panelOpenInteraction.ts test/index.test.ts
git commit -m "✅ test(interaction): 固定自动入口状态与降级行为"
```

---

## Task 6: 建立可测试的装配 seam，处理可见性桥接和初始可见

**Files:**
- Modify: `test/index.test.ts`
- Create: `src/panelOpenWiring.ts`

- [ ] **Step 1: 写失败测试，约束新的可见切换会触发自动入口**

```typescript
import { createPanelOpenWiring } from '../src/panelOpenWiring'

it('新的可见切换会触发自动入口', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: false,
  })

  await wiring.handleVisibilityChange(true)

  expect(openFromActivityBar).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: 写失败测试，约束程序化不允许自动打开时不会触发自动入口**

```typescript
it('不允许自动打开时不会触发自动入口', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => false,
    isInitiallyVisible: false,
  })

  await wiring.handleVisibilityChange(true)

  expect(openFromActivityBar).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: 写失败测试，约束初始已可见时会自动打开一次**

```typescript
it('初始已可见时会自动打开一次', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: true,
  })

  await wiring.runInitialAutoOpenIfNeeded()

  expect(openFromActivityBar).toHaveBeenCalledOnce()
})
```

- [ ] **Step 4: 写失败测试，约束初始已可见只处理一次**

```typescript
it('初始已可见只处理一次', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: true,
  })

  await wiring.runInitialAutoOpenIfNeeded()
  await wiring.runInitialAutoOpenIfNeeded()

  expect(openFromActivityBar).toHaveBeenCalledOnce()
})
```

- [ ] **Step 5: 写失败测试，约束初始已可见但不允许自动打开时不会触发自动入口**

```typescript
it('初始已可见但不允许自动打开时不会触发自动入口', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => false,
    isInitiallyVisible: true,
  })

  await wiring.runInitialAutoOpenIfNeeded()

  expect(openFromActivityBar).not.toHaveBeenCalled()
})
```

- [ ] **Step 6: 写失败测试，约束初始已可见但自动流程进行中时不会触发自动入口**

```typescript
it('初始已可见但自动流程进行中时不会触发自动入口', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => true,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: true,
  })

  await wiring.runInitialAutoOpenIfNeeded()

  expect(openFromActivityBar).not.toHaveBeenCalled()
})
```

- [ ] **Step 7: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，提示 `../src/panelOpenWiring` 或 `createPanelOpenWiring` 不存在

- [ ] **Step 8: 创建 `src/panelOpenWiring.ts`，只实现通过当前测试所需的最小逻辑**

```typescript
import { shouldAutoOpenPanel } from './panelOpenInteraction'

export interface PanelOpenWiringDeps {
  openFromActivityBar: () => Promise<void>
  getIsAutoOpeningPanel: () => boolean
  getAllowAutoOpen: () => boolean
  isInitiallyVisible: boolean
}

export function createPanelOpenWiring(deps: PanelOpenWiringDeps) {
  let wasVisible = deps.isInitiallyVisible
  let handledInitialVisible = false

  return {
    async runInitialAutoOpenIfNeeded(): Promise<void> {
      if (!deps.isInitiallyVisible || handledInitialVisible)
        return

      const shouldOpen = shouldAutoOpenPanel({
        isVisible: true,
        wasVisible: false,
        isAutoOpeningPanel: deps.getIsAutoOpeningPanel(),
        allowAutoOpen: deps.getAllowAutoOpen(),
      })

      handledInitialVisible = true
      if (!shouldOpen)
        return

      await deps.openFromActivityBar()
    },
    async handleVisibilityChange(isVisible: boolean): Promise<void> {
      const shouldOpen = shouldAutoOpenPanel({
        isVisible,
        wasVisible,
        isAutoOpeningPanel: deps.getIsAutoOpeningPanel(),
        allowAutoOpen: deps.getAllowAutoOpen(),
      })
      wasVisible = isVisible
      if (!shouldOpen)
        return

      await deps.openFromActivityBar()
    },
  }
}
```

- [ ] **Step 9: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add src/panelOpenInteraction.ts src/panelOpenWiring.ts test/index.test.ts
git commit -m "✅ test(wiring): 建立可见性桥接与初始可见装配层"
```

---

## Task 7: 锁定装配层的事件顺序和状态更新

**Files:**
- Modify: `test/index.test.ts`
- Modify: `src/panelOpenWiring.ts`

- [ ] **Step 1: 写失败测试，约束首次显示后第二次可见事件不会重复打开**

```typescript
it('首次显示后第二次可见事件不会重复打开', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: false,
  })

  await wiring.handleVisibilityChange(true)
  await wiring.handleVisibilityChange(true)

  expect(openFromActivityBar).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: 写失败测试，约束隐藏后再次显示会重新触发自动入口**

```typescript
it('隐藏后再次显示会重新触发自动入口', async () => {
  const openFromActivityBar = vi.fn()
  const wiring = createPanelOpenWiring({
    openFromActivityBar,
    getIsAutoOpeningPanel: () => false,
    getAllowAutoOpen: () => true,
    isInitiallyVisible: false,
  })

  await wiring.handleVisibilityChange(true)
  await wiring.handleVisibilityChange(false)
  await wiring.handleVisibilityChange(true)

  expect(openFromActivityBar).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，新增断言至少一项失败

- [ ] **Step 4: 只按测试需求调整 `src/panelOpenWiring.ts` 的状态更新顺序**

```typescript
const shouldOpen = shouldAutoOpenPanel(...)
wasVisible = isVisible
if (!shouldOpen)
  return

await deps.openFromActivityBar()
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/panelOpenWiring.ts test/index.test.ts
git commit -m "✅ test(wiring): 固定可见性事件顺序"
```

---

## Task 8: 建立可测试的扩展入口绑定 seam

**Files:**
- Modify: `test/index.test.ts`
- Create: `src/indexBindings.ts`

- [ ] **Step 1: 写失败测试，约束入口绑定会注册可见性监听并触发初始检查**

```typescript
import { createIndexBindings } from '../src/indexBindings'

it('入口绑定会注册可见性监听并触发初始检查', async () => {
  const onDidChangeVisibility = vi.fn()
  const handleVisibilityChange = vi.fn()
  const runInitialAutoOpenIfNeeded = vi.fn()
  const bindings = createIndexBindings({
    createTreeView: () => ({
      visible: false,
      onDidChangeVisibility,
    }),
    createWiring: () => ({
      handleVisibilityChange,
      runInitialAutoOpenIfNeeded,
    }),
  })

  bindings.register()

  expect(onDidChangeVisibility).toHaveBeenCalledOnce()
  expect(runInitialAutoOpenIfNeeded).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，提示 `../src/indexBindings` 或 `createIndexBindings` 不存在

- [ ] **Step 3: 写失败测试，约束入口绑定会把最新可见状态传给 wiring**

```typescript
it('入口绑定会把最新可见状态传给 wiring', async () => {
  let visibilityListener: (() => void) | undefined
  const treeView = {
    visible: false,
    onDidChangeVisibility: vi.fn((listener) => {
      visibilityListener = listener
    }),
  }
  const handleVisibilityChange = vi.fn()
  const bindings = createIndexBindings({
    createTreeView: () => treeView,
    createWiring: () => ({
      handleVisibilityChange,
      runInitialAutoOpenIfNeeded: vi.fn(),
    }),
  })

  bindings.register()
  treeView.visible = true
  await visibilityListener?.()

  expect(handleVisibilityChange).toHaveBeenCalledWith(true)
})
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `pnpm test test/index.test.ts`
Expected: FAIL，新增断言至少一项失败

- [ ] **Step 5: 创建 `src/indexBindings.ts`，只实现通过当前测试所需的最小逻辑**

```typescript
export interface IndexBindingTreeView {
  visible: boolean
  onDidChangeVisibility: (listener: () => void | Promise<void>) => unknown
}

export interface IndexBindingWiring {
  handleVisibilityChange: (isVisible: boolean) => Promise<void>
  runInitialAutoOpenIfNeeded: () => Promise<void>
}

export interface IndexBindingDeps {
  createTreeView: () => IndexBindingTreeView
  createWiring: (treeView: IndexBindingTreeView) => IndexBindingWiring
}

export function createIndexBindings(deps: IndexBindingDeps) {
  return {
    register() {
      const treeView = deps.createTreeView()
      const wiring = deps.createWiring(treeView)

      treeView.onDidChangeVisibility(() => wiring.handleVisibilityChange(treeView.visible))
      void wiring.runInitialAutoOpenIfNeeded()

      return { treeView, wiring }
    },
  }
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/indexBindings.ts test/index.test.ts
git commit -m "✅ test(bindings): 建立扩展入口绑定 seam"
```

---

## Task 9: 在真实入口接入装配层和绑定层

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 在 `src/index.ts` 引入纯函数模块、装配 seam 和入口绑定函数**

```typescript
import { createIndexBindings } from './indexBindings'
import {
  createActivityBarAutoOpenHandler,
  createOpenPanelHandler,
} from './panelOpenInteraction'
import { createPanelOpenWiring } from './panelOpenWiring'
```

- [ ] **Step 2: 抽出共享扫描函数，供通用入口复用**

```typescript
async function scanWorkspaceData() {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders?.length)
    return undefined

  return await scanner.scan(workspaceFolders[0].uri.fsPath)
}
```

- [ ] **Step 3: 用 `createOpenPanelHandler()` 装配 `superpowers.openPanel` 命令**

```typescript
const openPanel = createOpenPanelHandler({
  createOrShowPanel: () => SuperpowersPanel.createOrShow(extensionUri),
  scanWorkspace: scanWorkspaceData,
})

vscode.commands.registerCommand('superpowers.openPanel', openPanel)
```

- [ ] **Step 4: 用 `createActivityBarAutoOpenHandler()` 装配自动入口**

```typescript
let isAutoOpeningPanel = false
const allowAutoOpen = true

const openPanelFromActivityBar = createActivityBarAutoOpenHandler({
  openPanel,
  executeCommand: command => vscode.commands.executeCommand(command),
  getIsAutoOpeningPanel: () => isAutoOpeningPanel,
  setIsAutoOpeningPanel: (value) => { isAutoOpeningPanel = value },
  logDebug: (message, error) => console.debug(message, error),
})
```

- [ ] **Step 5: 用 `createIndexBindings()` 和 `createPanelOpenWiring()` 装配 TreeView**

```typescript
createIndexBindings({
  createTreeView: () => vscode.window.createTreeView('superpowers-explorer', {
    treeDataProvider,
    showCollapseAll: false,
  }),
  createWiring: treeView => createPanelOpenWiring({
    openFromActivityBar: openPanelFromActivityBar,
    getIsAutoOpeningPanel: () => isAutoOpeningPanel,
    getAllowAutoOpen: () => allowAutoOpen,
    isInitiallyVisible: treeView.visible,
  }),
}).register()
```

- [ ] **Step 6: 明确产品预期：无 workspace 时仍打开空面板，但不更新数据**

这个预期已经由 `createOpenPanelHandler()` 的空数据测试锁定，接线层不要额外拦截。

- [ ] **Step 7: 保留树节点兜底入口，不改命令名**

```typescript
vscode.commands.registerCommand('superpowers.root', () => {
  return vscode.commands.executeCommand('superpowers.openPanel')
})
```

- [ ] **Step 8: 运行测试，确认接入后纯函数、装配和绑定测试仍通过**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/index.ts
git commit -m "✨ feat(index): 接入面板首次点击自动打开流程"
```

---

## Task 10: 验证命令与完整回归

**Files:**
- Modify: `src/index.ts`
- Test: `test/index.test.ts`

- [ ] **Step 1: 在 Extension Host 中最小验证 `workbench.view.explorer` 命令不会阻断主流程**

手动触发一次自动入口，确认即使 Explorer 未按预期切回，也不会阻止编辑区面板出现。

- [ ] **Step 2: 运行新增测试文件**

Run: `pnpm test test/index.test.ts`
Expected: PASS

- [ ] **Step 3: 运行完整测试集**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: 运行类型检查**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 运行构建**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 6: 在 Extension Host 中手动验证真实交互**

手动检查：

- 关闭已有 `Superpowers Explorer` 面板
- 点击左侧 `Superpowers` 图标
- 确认编辑区立刻出现面板
- 确认左侧停在默认 `File Explorer`
- 再次点击左侧 `Superpowers` 图标，确认不会新开多个面板
- 关闭面板后再次点击，确认仍可重新打开
- 点击树节点兜底入口，确认仍可打开面板

---

## 完成检查

- [ ] 纯函数测试不依赖 `vscode` 运行时
- [ ] `superpowers.openPanel` 仍然是纯通用入口，不包含切回 Explorer 副作用
- [ ] 自动入口通过 `getAllowAutoOpen()` 显式控制是否允许自动打开
- [ ] 初始已可见场景只会自动打开一次
- [ ] 初始已可见场景也会经过自动打开判定，而不是绕过 `allowAutoOpen`
- [ ] 自动入口发生异常后会正确清理防重入状态
- [ ] 切回 Explorer 失败时不会影响面板成功打开
- [ ] 无 workspace 时会打开空面板，但不会调用 `updateData`
- [ ] 树节点兜底入口仍可正常打开面板
- [ ] `pnpm test` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] 手动交互验证通过
