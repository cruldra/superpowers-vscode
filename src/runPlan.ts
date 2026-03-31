import * as path from 'node:path'

export const DEFAULT_RUN_MESSAGE_TEMPLATE = '实施 $plan_relative_path'
export const DEFAULT_RUN_MODEL = 'alibaba-coding-plan-cn/glm-5'
export const DEFAULT_RUN_AGENT = 'build'

export interface BuildRunPlanCommandOptions {
  planPath: string
  workspaceRoot: string
  worktreePath: string
  messageTemplate: string
  model: string
  agent: string
}

export interface BuildRunPlanUnitNameOptions {
  planPath: string
  workspaceRoot: string
}

export function interpolateRunMessageTemplate(template: string, planRelativePath: string): string {
  return template
    .replaceAll('$plan_relative_path', planRelativePath)
    .replaceAll('${plan_relative_path}', planRelativePath)
}

export function buildRunPlanUnitName(options: BuildRunPlanUnitNameOptions): string {
  const normalizedPlanName = path.basename(options.planPath, '.md')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')

  return `opencode-plan-${normalizedPlanName || 'plan'}`
}

export function buildRunPlanCommand(options: BuildRunPlanCommandOptions): string {
  const planRelativePath = path.relative(options.workspaceRoot, options.planPath)
  const message = interpolateRunMessageTemplate(options.messageTemplate, planRelativePath)
  const unitName = buildRunPlanUnitName(options)
  const opencodeCommand = `opencode run ${shellEscape(message)} --model ${shellEscape(options.model)} --agent ${shellEscape(options.agent)}`

  return `systemd-run --user --unit=${unitName} --working-directory ${shellEscape(options.worktreePath)} zsh -c ${shellEscape(opencodeCommand)}`
}

function shellEscape(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}
