import * as path from 'node:path'

export const DEFAULT_WORKTREE_DIRECTORY_TEMPLATE = '$project_root.worktrees/$feature_name'

export interface BuildWorktreePathOptions {
  workspaceRoot: string
  projectName: string
  featureName: string
  template: string
}

export interface BuildEnsureWorktreeCommandsOptions {
  branchName: string
  worktreePath: string
  runCommand: string
}

export function buildFeatureBranchName(planFileName: string): string {
  const featureName = planFileName
    .replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')

  return `feature/${featureName}`
}

export function buildWorktreePath(options: BuildWorktreePathOptions): string {
  return options.template
    .replaceAll('$project_root', options.workspaceRoot)
    .replaceAll('${project_root}', options.workspaceRoot)
    .replaceAll('$project_name', options.projectName)
    .replaceAll('${project_name}', options.projectName)
    .replaceAll('$feature_name', options.featureName)
    .replaceAll('${feature_name}', options.featureName)
}

export function buildEnsureWorktreeCommands(options: BuildEnsureWorktreeCommandsOptions): string {
  const quotedWorktreePath = shellEscape(options.worktreePath)
  const quotedBranchName = shellEscape(options.branchName)

  return `git worktree add ${quotedWorktreePath} -b ${quotedBranchName} && cd ${quotedWorktreePath} && ${options.runCommand}`
}

export function getFeatureNameFromBranchName(branchName: string): string {
  return branchName.replace(/^feature\//, '')
}

export function getProjectName(workspaceRoot: string): string {
  return path.basename(workspaceRoot)
}

function shellEscape(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}
