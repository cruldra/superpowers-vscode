import { describe, expect, it } from 'vitest'
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
  it('使用默认参数拼接 opencode run 命令', () => {
    expect(buildRunPlanCommand({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
      messageTemplate: DEFAULT_RUN_MESSAGE_TEMPLATE,
      model: DEFAULT_RUN_MODEL,
      agent: DEFAULT_RUN_AGENT,
    })).toBe("opencode run '实施 docs/superpowers/plans/demo.md' --model 'alibaba-coding-plan-cn/glm-5' --agent 'build'")
  })

  it('对包含单引号的参数做 shell 转义', () => {
    expect(buildRunPlanCommand({
      planPath: '/workspace/project/docs/superpowers/plans/demo.md',
      workspaceRoot: '/workspace/project',
      messageTemplate: "执行 $plan_relative_path 的 '阶段一'",
      model: 'custom-model',
      agent: 'builder',
    })).toBe(String.raw`opencode run '执行 docs/superpowers/plans/demo.md 的 '\''阶段一'\''' --model 'custom-model' --agent 'builder'`)
  })
})
