import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PlanFile } from '../src/types'
import { describe, expect, it, vi } from 'vitest'
import { getPlanContextMenuVisibility, shouldAutoOpenPanel } from '../src/panelOpenInteraction'
import { markPlanContentAsCompleted, markPlanContentAsNeedsTesting } from '../src/planCompletion'
import { buildRunPlanUnitName } from '../src/runPlan'

vi.mock('vscode', () => ({
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  extensions: {
    getExtension: vi.fn(),
  },
  window: {
    activeTextEditor: undefined,
    createTreeView: vi.fn(),
    createTerminal: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(),
  },
}))

vi.mock('reactive-vscode', () => ({
  defineExtension: vi.fn(() => ({
    activate: vi.fn(),
    deactivate: vi.fn(),
  })),
}))

vi.mock('../src/extensionRuntime', () => ({
  resolveExtensionUri: vi.fn(),
}))

vi.mock('../src/generated/meta', () => ({
  extensionId: 'test.extension',
}))

vi.mock('../src/scanner', () => ({
  SuperpowersScanner: class {
    scan = vi.fn(async () => ({ specs: [], plans: [] }))
  },
}))

vi.mock('../src/treeView', () => ({
  SuperpowersTreeDataProvider: class {
    refresh = vi.fn()
  },
}))

vi.mock('../src/worktree', () => ({
  buildEnsureWorktreeCommands: vi.fn(() => 'mock-worktree-command'),
  buildFeatureBranchName: vi.fn(() => 'feature/demo'),
  buildWorktreePath: vi.fn(() => '/workspace/project.worktrees/demo'),
  DEFAULT_WORKTREE_DIRECTORY_TEMPLATE: '$project_root.worktrees/$feature_name',
  getFeatureNameFromBranchName: vi.fn(() => 'demo'),
  getProjectName: vi.fn(() => 'project'),
}))

vi.mock('../src/webview/panel', () => ({
  SuperpowersPanel: {
    currentPanel: undefined,
    createOrShow: vi.fn(() => ({
      updateData: vi.fn(),
    })),
  },
}))

import {
  createPlanTaskRecord,
  getPlanTaskViewState,
  mergePolledPlanTaskRecords,
  mergePlanTaskStatus,
  resolveTaskStatusFromSystemctlStatus,
  startPlanTask,
  upsertPlanTaskRecord,
} from '../src/index'

function createPlanFile(overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    name: 'demo',
    date: '2026-03-31',
    title: 'Demo Plan',
    path: '/workspace/project/docs/superpowers/plans/demo.md',
    status: 'default',
    progress: {
      completed: 0,
      total: 3,
    },
    ...overrides,
  }
}

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

describe('plan task status model', () => {
  it('同一个 Plan 使用 planPath 作为键，并通过稳定 unitName 映射到 systemd unit', () => {
    const workspaceRoot = '/workspace/project'
    const planPath = '/workspace/project/docs/superpowers/plans/demo.md'

    const first = createPlanTaskRecord({ planPath, workspaceRoot })
    const second = createPlanTaskRecord({ planPath, workspaceRoot })
    const records = upsertPlanTaskRecord([
      first,
      {
        planPath: '/workspace/project/docs/superpowers/plans/other.md',
        unitName: 'opencode-other',
        taskStatus: 'running',
      },
    ], {
      planPath,
      unitName: 'opencode-replaced',
      taskStatus: 'failed',
    })

    expect(first.unitName).toBe(buildRunPlanUnitName({ planPath, workspaceRoot }))
    expect(second.unitName).toBe(first.unitName)
    expect(records).toHaveLength(2)
    expect(records.find((record: { planPath: string }) => record.planPath === planPath)).toEqual({
      planPath,
      unitName: 'opencode-replaced',
      taskStatus: 'failed',
    })
  })

  it('后台启动成功后立即标记为运行中，并允许多个 Plan 并行运行', () => {
    const workspaceRoot = '/workspace/project'
    const firstPlan = createPlanFile()
    const secondPlan = createPlanFile({
      name: 'other',
      title: 'Other Plan',
      path: '/workspace/project/docs/superpowers/plans/other.md',
    })

    const firstRunning = upsertPlanTaskRecord([], createPlanTaskRecord({
      planPath: firstPlan.path,
      workspaceRoot,
    }))
    const bothRunning = upsertPlanTaskRecord(firstRunning, createPlanTaskRecord({
      planPath: secondPlan.path,
      workspaceRoot,
    }))
    const mergedPlans = mergePlanTaskStatus([firstPlan, secondPlan], bothRunning)

    expect(mergedPlans.map((plan: PlanFile) => ({ path: plan.path, taskStatus: plan.taskStatus }))).toEqual([
      { path: firstPlan.path, taskStatus: 'running' },
      { path: secondPlan.path, taskStatus: 'running' },
    ])
    expect(getPlanTaskViewState(mergedPlans[0].taskStatus)).toBe('running')
    expect(getPlanTaskViewState(undefined)).toBe('rerunnable')
  })

  it('轮询结果分别映射为运行中、已完成、失败和可重新运行', () => {
    expect(resolveTaskStatusFromSystemctlStatus('Active: active (running)', undefined)).toBe('running')
    expect(resolveTaskStatusFromSystemctlStatus('Active: inactive (dead)\nMain PID: 1 (code=exited, status=0/SUCCESS)', 'running')).toBe('completed')
    expect(resolveTaskStatusFromSystemctlStatus('Active: failed (Result: exit-code)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('Main PID: 1 (code=exited, status=2/INVALIDARGUMENT)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('Main PID: 1 (code=exited, status=2)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('ExecStart=/usr/bin/sh -c exit 1 (code=exited, status=1)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('Active: inactive (Result: signal)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('Main PID: 1 (code=killed, signal=TERM)', 'running')).toBe('failed')
    expect(resolveTaskStatusFromSystemctlStatus('Unit opencode-demo.service could not be found.', 'running')).toBe('completed')
    expect(resolveTaskStatusFromSystemctlStatus('some unknown status output', 'running')).toBe('running')
    expect(resolveTaskStatusFromSystemctlStatus('some unknown status output', undefined)).toBeUndefined()
    expect(getPlanTaskViewState(resolveTaskStatusFromSystemctlStatus('some unknown status output', undefined))).toBe('rerunnable')
    expect(getPlanTaskViewState(resolveTaskStatusFromSystemctlStatus('Unit opencode-demo.service could not be found.', 'running'))).toBe('rerunnable')
    expect(getPlanTaskViewState(resolveTaskStatusFromSystemctlStatus('some unknown status output', 'running'))).toBe('running')
  })

  it('后台命令执行成功后才创建运行中任务记录', async () => {
    const execCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))

    const taskRecord = await startPlanTask({
      command: 'mock-worktree-command',
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
      execCommand,
    })

    const unitName = buildRunPlanUnitName({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
    })

    expect(execCommand).toHaveBeenNthCalledWith(1, `systemctl --user reset-failed ${unitName}`, { cwd: '/workspace/project' })
    expect(execCommand).toHaveBeenCalledWith('mock-worktree-command', { cwd: '/workspace/project' })
    expect(taskRecord).toEqual({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      unitName,
      taskStatus: 'running',
    })
  })

  it('轮询结果回写时保留轮询期间新增的任务记录', () => {
    const currentRecords = [
      {
        planPath: '/workspace/project/docs/superpowers/plans/demo.md',
        unitName: 'opencode-demo',
        taskStatus: 'running' as const,
      },
      {
        planPath: '/workspace/project/docs/superpowers/plans/other.md',
        unitName: 'opencode-other',
        taskStatus: 'running' as const,
      },
    ]
    const polledRecords = [
      {
        planPath: '/workspace/project/docs/superpowers/plans/demo.md',
        unitName: 'opencode-demo',
        taskStatus: 'completed' as const,
      },
    ]

    expect(mergePolledPlanTaskRecords(currentRecords, polledRecords)).toEqual([
      {
        planPath: '/workspace/project/docs/superpowers/plans/demo.md',
        unitName: 'opencode-demo',
        taskStatus: 'completed',
      },
      {
        planPath: '/workspace/project/docs/superpowers/plans/other.md',
        unitName: 'opencode-other',
        taskStatus: 'running',
      },
    ])
  })
})

describe('package.json configuration', () => {
  it('不再声明 superpowers.opencodePath 配置项', () => {
    const packageJsonPath = path.resolve(__dirname, '../package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))

    expect(packageJson.contributes.configuration.properties['superpowers.opencodePath']).toBeUndefined()
  })
})
