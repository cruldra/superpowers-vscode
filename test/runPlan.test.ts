import { describe, expect, it } from 'vitest'
import * as runPlan from '../src/runPlan'
import {
  buildRunPlanCommand,
  DEFAULT_RUN_AGENT,
  DEFAULT_RUN_MESSAGE_TEMPLATE,
  DEFAULT_RUN_MODEL,
  interpolateRunMessageTemplate,
} from '../src/runPlan'

describe('interpolateRunMessageTemplate', () => {
  it('用相对路径替换 $plan_relative_path 变量', () => {
    expect(interpolateRunMessageTemplate('实施 $plan_relative_path', 'docs/superpowers/plans/demo.md')).toBe('实施 docs/superpowers/plans/demo.md')
  })

  it('支持 ${plan_relative_path} 变量写法', () => {
    expect(interpolateRunMessageTemplate('执行 ${plan_relative_path}', 'docs/superpowers/plans/demo.md')).toBe('执行 docs/superpowers/plans/demo.md')
  })
})

describe('buildRunPlanCommand', () => {
  it('生成以 opencode- 开头且稳定的 unit 名', () => {
    expect(runPlan.buildRunPlanUnitName).toBeTypeOf('function')

    const first = runPlan.buildRunPlanUnitName?.({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
    })
    const second = runPlan.buildRunPlanUnitName?.({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
    })

    expect(first).toMatch(/^opencode-plan-[a-z0-9-]+$/)
    expect(first).toBe(second)
  })

  it('unit 名使用计划文件名，去掉日期前缀和 md 后缀', () => {
    const unitName = runPlan.buildRunPlanUnitName?.({
      planPath: '/workspace/project/docs/superpowers/plans/2026-03-31-redis-lock-management.md',
      workspaceRoot: '/workspace/project',
    })

    expect(unitName).toBe('opencode-plan-redis-lock-management')
  })

  it('不同 planPath 必须生成不同的 unit 名', () => {
    const first = runPlan.buildRunPlanUnitName?.({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
    })
    const second = runPlan.buildRunPlanUnitName?.({
      planPath: '/workspace/project/docs/superpowers/plans/demo-md',
      workspaceRoot: '/workspace/project',
    })

    expect(first).not.toBe(second)
  })

  it('使用默认参数拼接 opencode run 命令', () => {
    const command = buildRunPlanCommand({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
      worktreePath: '/workspace/project.worktrees/demo',
      messageTemplate: DEFAULT_RUN_MESSAGE_TEMPLATE,
      model: DEFAULT_RUN_MODEL,
      agent: DEFAULT_RUN_AGENT,
    })

    expect(command).toContain('systemd-run --user --unit=opencode-')
    expect(command).toContain(" --working-directory '/workspace/project.worktrees/demo' ")
    expect(command).toContain("zsh -c 'opencode run ")
    expect(command).toContain('实施 docs/superpowers/plans/demo.md')
    expect(command).toContain(String.raw`--model '\''alibaba-coding-plan-cn/glm-5'\'' --agent '\''build'\'''`)
  })

  it('对包含单引号的参数做 shell 转义', () => {
    const command = buildRunPlanCommand({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
      worktreePath: '/workspace/project.worktrees/demo',
      messageTemplate: "执行 $plan_relative_path 的 '阶段一'",
      model: 'custom-model',
      agent: 'builder',
    })

    expect(command).toContain('systemd-run --user --unit=opencode-')
    expect(command).toContain(" --working-directory '/workspace/project.worktrees/demo' ")
    expect(command).toContain(' zsh -c ')
    expect(command).toContain('opencode run')
    expect(command).toContain('执行 docs/superpowers/plans/demo.md 的 ')
    expect(command).toContain('阶段一')
    expect(command).toContain(String.raw`'\''`)
    expect(command).toContain(String.raw`--model '\''custom-model'\'' --agent '\''builder'\'''`)
  })
})
