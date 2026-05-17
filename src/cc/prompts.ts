/**
 * Prompt templates for the two claude entry points (create-issue and
 * implement-plan). Defaults live in `src/settings/store.ts` (alongside the
 * other tunables); these helpers just read the persisted setting and run
 * placeholder substitution.
 *
 * Substitution is a plain global string replace of the placeholder text
 * (`{userRequest}` / `{planFile}`) — no template engine. If the user removes
 * the placeholder, substitution is a no-op and that's their bug.
 */

import type { ExtensionContext } from 'vscode'
import { getSettings } from '../settings/store'

export function getCreateIssuePrompt(ctx: ExtensionContext, vars: { userRequest: string }): string {
  const tpl = getSettings(ctx).createIssuePrompt
  return tpl.split('{userRequest}').join(vars.userRequest)
}

export function getImplementPlanPrompt(ctx: ExtensionContext, vars: { planFile: string }): string {
  const tpl = getSettings(ctx).implementPlanPrompt
  return tpl.split('{planFile}').join(vars.planFile)
}
