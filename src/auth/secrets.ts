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

/** YouTrack permanent tokens, keyed by host so they never collide with the
 * gitea token of the same host. */
export function youtrackTokenKey(host: string): string {
  return `youtrack-token:${host}`
}

export async function getYouTrackToken(ctx: ExtensionContext, host: string): Promise<string | undefined> {
  return ctx.secrets.get(youtrackTokenKey(host))
}

export async function setYouTrackToken(ctx: ExtensionContext, host: string, token: string): Promise<void> {
  await ctx.secrets.store(youtrackTokenKey(host), token)
}

export async function deleteYouTrackToken(ctx: ExtensionContext, host: string): Promise<void> {
  await ctx.secrets.delete(youtrackTokenKey(host))
}
