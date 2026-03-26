import * as path from 'node:path'

export const DEFAULT_RUN_MESSAGE_TEMPLATE = '实施 $plan_relative_path'
export const DEFAULT_RUN_MODEL = 'alibaba-coding-plan-cn/glm-5'
export const DEFAULT_RUN_AGENT = 'build'

export interface BuildRunPlanCommandOptions {
  planPath: string
  workspaceRoot: string
  messageTemplate: string
  model: string
  agent: string
}

export function interpolateRunMessageTemplate(template: string, planRelativePath: string): string {
  return template
    .replaceAll('$plan_relative_path', planRelativePath)
    .replaceAll('${plan_relative_path}', planRelativePath)
}

export function buildRunPlanCommand(options: BuildRunPlanCommandOptions): string {
  const planRelativePath = path.relative(options.workspaceRoot, options.planPath)
  const message = interpolateRunMessageTemplate(options.messageTemplate, planRelativePath)

  return `opencode run ${shellEscape(message)} --model ${shellEscape(options.model)} --agent ${shellEscape(options.agent)}`
}

function shellEscape(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}
