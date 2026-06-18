/**
 * Prompt templates for the two claude entry points (brainstorm and
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

export function getBrainstormPrompt(
  ctx: ExtensionContext,
  vars: { userRequest: string, nonce: string, imagePaths?: string[] },
): string {
  const tpl = getSettings(ctx).brainstormPrompt
  let out = tpl
    .split('{userRequest}')
    .join(vars.userRequest)
    .split('{nonce}')
    .join(vars.nonce)
  if (vars.imagePaths && vars.imagePaths.length > 0) {
    const lines = vars.imagePaths.map(p => `- ${p}`).join('\n')
    out += `\n\n参考图片（请用 Read 工具查看）：\n${lines}`
  }
  return out
}

export function getBrainstormContinuePrompt(ctx: ExtensionContext, vars: { issueNumber: number, issueRef?: string }): string {
  const tpl = getSettings(ctx).brainstormContinuePrompt
  // For youtrack cards the board number is synthetic; substitute the readable
  // id (e.g. LXF-12) so the cc agent references the real issue (readable via
  // `opencli yt issues show <id>`), not a non-existent gitea number.
  return tpl.split('{issueNumber}').join(vars.issueRef ?? String(vars.issueNumber))
}

export function getImplementPlanPrompt(ctx: ExtensionContext, vars: { planFile: string, issueNumber: number, issueRef?: string }): string {
  const tpl = getSettings(ctx).implementPlanPrompt
  return tpl
    .split('{planFile}')
    .join(vars.planFile)
    .split('{issueNumber}')
    .join(vars.issueRef ?? String(vars.issueNumber))
}

export function getReviewPrompt(ctx: ExtensionContext, vars: { prNumber: string }): string {
  const tpl = getSettings(ctx).reviewPrompt
  return tpl.split('{prNumber}').join(vars.prNumber)
}
