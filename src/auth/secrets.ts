/**
 * Helpers around VS Code's SecretStorage for storing per-host Gitea personal
 * access tokens.
 *
 * Tokens are keyed by host so the user can connect to multiple Gitea instances
 * without the extension confusing their credentials.
 */

import type { ExtensionContext } from 'vscode'

export function tokenKey(host: string): string {
  return `gitea-token:${host}`
}

export async function getToken(ctx: ExtensionContext, host: string): Promise<string | undefined> {
  return ctx.secrets.get(tokenKey(host))
}

export async function setToken(ctx: ExtensionContext, host: string, token: string): Promise<void> {
  await ctx.secrets.store(tokenKey(host), token)
}

export async function deleteToken(ctx: ExtensionContext, host: string): Promise<void> {
  await ctx.secrets.delete(tokenKey(host))
}
