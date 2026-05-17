/**
 * Non-secret extension settings persisted in `globalState`.
 *
 * Token stays in `context.secrets` (see `src/auth/secrets.ts`); everything
 * else (webhook port, public URL prefix, prompt templates) lives here under
 * a single JSON blob keyed by `SETTINGS_KEY`.
 *
 * Empty-string values for prompts are treated as "use the default" so the
 * form can save user input verbatim and still fall back when the user clears
 * a field.
 */

import type { ExtensionContext } from 'vscode'

export const DEFAULT_CREATE_ISSUE_PROMPT = '/goal 我现在有这样一个需求 {userRequest}, 你用tea命令先帮我建好gitea工单, 具体细节等下再讨论, 以 <gitea_issue_no>编号</gitea_issue_no> 形式输出创建好的工单编号'

export const DEFAULT_IMPLEMENT_PLAN_PROMPT = '/goal 使用子代理全程绿灯实施 @{planFile}，完成后输出 <request_review>$pr_no</request_review>'

export const DEFAULT_WEBHOOK_PORT = 17421

export interface Settings {
  /** Local HTTP port for receiving gitea webhook callbacks. */
  webhookPort: number
  /** Public URL prefix registered with gitea (e.g. via frp/Caddy). Gitea
   * rejects raw IPs, so a domain prefix is effectively required to trigger
   * the implement flow. The local server still listens on `webhookPort`. */
  webhookPublicUrl: string
  /** Prompt template for the create-issue flow. `{userRequest}` placeholder. */
  createIssuePrompt: string
  /** Prompt template for the implement-plan flow. `{planFile}` placeholder. */
  implementPlanPrompt: string
}

export const SETTINGS_KEY = 'superpowers.settings'

function defaults(): Settings {
  return {
    webhookPort: DEFAULT_WEBHOOK_PORT,
    webhookPublicUrl: '',
    createIssuePrompt: DEFAULT_CREATE_ISSUE_PROMPT,
    implementPlanPrompt: DEFAULT_IMPLEMENT_PLAN_PROMPT,
  }
}

export function getSettings(ctx: ExtensionContext): Settings {
  const stored = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const base = defaults()

  const webhookPort = typeof stored.webhookPort === 'number' && Number.isInteger(stored.webhookPort)
    && stored.webhookPort >= 1 && stored.webhookPort <= 65535
    ? stored.webhookPort
    : base.webhookPort

  const webhookPublicUrl = typeof stored.webhookPublicUrl === 'string' ? stored.webhookPublicUrl : base.webhookPublicUrl
  const createIssuePrompt = typeof stored.createIssuePrompt === 'string' && stored.createIssuePrompt.length > 0
    ? stored.createIssuePrompt
    : base.createIssuePrompt
  const implementPlanPrompt = typeof stored.implementPlanPrompt === 'string' && stored.implementPlanPrompt.length > 0
    ? stored.implementPlanPrompt
    : base.implementPlanPrompt

  return {
    webhookPort,
    webhookPublicUrl,
    createIssuePrompt,
    implementPlanPrompt,
  }
}

export async function saveSettings(ctx: ExtensionContext, next: Partial<Settings>): Promise<void> {
  const current = ctx.globalState.get<Partial<Settings>>(SETTINGS_KEY) ?? {}
  const merged: Partial<Settings> = { ...current, ...next }
  await ctx.globalState.update(SETTINGS_KEY, merged)
}
