import { describe, expect, it } from 'vitest'
import {
  buildEnsureWorktreeCommands,
  buildFeatureBranchName,
  buildWorktreePath,
  DEFAULT_WORKTREE_DIRECTORY_TEMPLATE,
} from '../src/worktree'

describe('buildFeatureBranchName', () => {
  it('把 plan 文件名转成 feature 分支名', () => {
    expect(buildFeatureBranchName('2026-03-20-panel-open-interaction.md')).toBe('feature/panel-open-interaction')
  })
})

describe('buildWorktreePath', () => {
  it('使用默认模板生成同级 worktree 目录', () => {
    expect(buildWorktreePath({
      workspaceRoot: '/workspace/demo-project',
      projectName: 'demo-project',
      featureName: 'panel-open-interaction',
      template: DEFAULT_WORKTREE_DIRECTORY_TEMPLATE,
    })).toBe('/workspace/demo-project.worktrees/panel-open-interaction')
  })

  it('支持自定义模板变量', () => {
    expect(buildWorktreePath({
      workspaceRoot: '/workspace/demo-project',
      projectName: 'demo-project',
      featureName: 'panel-open-interaction',
      template: '/tmp/$project_name/$feature_name',
    })).toBe('/tmp/demo-project/panel-open-interaction')
  })
})

describe('buildEnsureWorktreeCommands', () => {
  it('先创建 feature worktree 再进入目录执行 opencode run', () => {
    expect(buildEnsureWorktreeCommands({
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toBe("git worktree add '/workspace/demo-project.worktrees/panel-open-interaction' -b 'feature/panel-open-interaction' && cd '/workspace/demo-project.worktrees/panel-open-interaction' && opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'")
  })
})
