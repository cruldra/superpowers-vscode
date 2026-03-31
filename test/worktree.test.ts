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

  it('会清理危险字符，避免污染分支名和后续 shell 命令', () => {
    expect(buildFeatureBranchName('2026-03-20-panel-"oops";rm -rf.md')).toBe('feature/panel-oops-rm-rf')
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
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toBe("if git worktree list --porcelain | grep -Fxq \"worktree /workspace/demo-project.worktrees/panel-open-interaction\"; then [ \"$(git -C '/workspace/demo-project.worktrees/panel-open-interaction' branch --show-current)\" = 'feature/panel-open-interaction' ]; elif git show-ref --verify --quiet refs/heads/feature/panel-open-interaction; then git worktree add '/workspace/demo-project.worktrees/panel-open-interaction' 'feature/panel-open-interaction'; else git worktree add '/workspace/demo-project.worktrees/panel-open-interaction' -b 'feature/panel-open-interaction'; fi && find '/workspace/demo-project' \\( -path '/workspace/demo-project.worktrees/panel-open-interaction' -o -path '/workspace/demo-project.worktrees/panel-open-interaction/*' \\) -prune -o -name '.env' -type f -exec sh -c 'for source_path do relative_path=${source_path#\"$1\"/}; target_path=\"$2/$relative_path\"; mkdir -p \"$(dirname \"$target_path\")\" && cp \"$source_path\" \"$target_path\"; done' sh '/workspace/demo-project' '/workspace/demo-project.worktrees/panel-open-interaction' {} + && cd '/workspace/demo-project.worktrees/panel-open-interaction' && opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'")
  })

  it('递归查找所有 .env 并按相对路径复制到目标 worktree', () => {
    expect(buildEnsureWorktreeCommands({
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toContain("find '/workspace/demo-project' \\\( -path '/workspace/demo-project.worktrees/panel-open-interaction' -o -path '/workspace/demo-project.worktrees/panel-open-interaction/*' \\\) -prune -o -name '.env' -type f -exec sh -c 'for source_path do relative_path=${source_path#\"$1\"/}; target_path=\"$2/$relative_path\"; mkdir -p \"$(dirname \"$target_path\")\" && cp \"$source_path\" \"$target_path\"; done' sh '/workspace/demo-project' '/workspace/demo-project.worktrees/panel-open-interaction' {} +")
  })

  it('为 find 的分组表达式保留可执行的空格分隔', () => {
    expect(buildEnsureWorktreeCommands({
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toContain("find '/workspace/demo-project' \\( -path '/workspace/demo-project.worktrees/panel-open-interaction' -o -path '/workspace/demo-project.worktrees/panel-open-interaction/*' \\) -prune")
  })

  it('重复运行同一个 Plan 时复用已有 worktree 而不是再次创建分支', () => {
    expect(buildEnsureWorktreeCommands({
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toContain("if git worktree list --porcelain | grep -Fxq \"worktree /workspace/demo-project.worktrees/panel-open-interaction\"; then [ \"$(git -C '/workspace/demo-project.worktrees/panel-open-interaction' branch --show-current)\" = 'feature/panel-open-interaction' ]; elif git show-ref --verify --quiet refs/heads/feature/panel-open-interaction; then git worktree add '/workspace/demo-project.worktrees/panel-open-interaction' 'feature/panel-open-interaction'; else git worktree add '/workspace/demo-project.worktrees/panel-open-interaction' -b 'feature/panel-open-interaction'; fi")
  })

  it('已有 worktree 时要求当前分支与目标分支一致', () => {
    expect(buildEnsureWorktreeCommands({
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toContain("[ \"$(git -C '/workspace/demo-project.worktrees/panel-open-interaction' branch --show-current)\" = 'feature/panel-open-interaction' ]")
  })

  it('已有 worktree 检测使用完整行匹配，避免命中相同前缀路径', () => {
    expect(buildEnsureWorktreeCommands({
      workspaceRoot: '/workspace/demo-project',
      branchName: 'feature/panel-open-interaction',
      worktreePath: '/workspace/demo-project.worktrees/panel-open-interaction',
      runCommand: "opencode run '实施 docs/superpowers/plans/demo.md' --model 'm' --agent 'build'",
    })).toContain('grep -Fxq')
  })
})
