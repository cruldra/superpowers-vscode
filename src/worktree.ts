import * as path from 'node:path'

export const DEFAULT_WORKTREE_DIRECTORY_TEMPLATE = '$project_root.worktrees/$feature_name'

export interface BuildWorktreePathOptions {
  workspaceRoot: string
  projectName: string
  featureName: string
  template: string
}

export interface BuildEnsureWorktreeCommandsOptions {
  workspaceRoot: string
  branchName: string
  worktreePath: string
  runCommand: string
}

export function buildFeatureBranchName(planFileName: string): string {
  const featureName = planFileName
    .replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

  return `feature/${featureName || 'plan'}`
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
  const quotedWorkspaceRoot = shellEscape(options.workspaceRoot)
  const quotedWorktreePath = shellEscape(options.worktreePath)
  const quotedBranchName = shellEscape(options.branchName)
  const quotedWorktreeGlob = shellEscape(`${options.worktreePath}/*`)
  const copyEnvCommand = `find ${quotedWorkspaceRoot} \\( -path ${quotedWorktreePath} -o -path ${quotedWorktreeGlob} \\) -prune -o -name '.env' -type f -exec sh -c 'for source_path do relative_path=\${source_path#"$1"/}; target_path="$2/$relative_path"; mkdir -p "$(dirname "$target_path")" && cp "$source_path" "$target_path"; done' sh ${quotedWorkspaceRoot} ${quotedWorktreePath} {} +`
  const ensureWorktreeCommand = `if git worktree list --porcelain | grep -Fxq "worktree ${options.worktreePath}"; then [ "$(git -C ${quotedWorktreePath} branch --show-current)" = ${quotedBranchName} ]; elif git show-ref --verify --quiet refs/heads/${options.branchName}; then git worktree add ${quotedWorktreePath} ${quotedBranchName}; else git worktree add ${quotedWorktreePath} -b ${quotedBranchName}; fi`

  return `${ensureWorktreeCommand} && ${copyEnvCommand} && cd ${quotedWorktreePath} && ${options.runCommand}`
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
