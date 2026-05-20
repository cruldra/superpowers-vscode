/**
 * .env file lock / unlock helpers.
 *
 * Recursively scans the main workspace folder for `.env*` files (skipping
 * `node_modules`, `.git`, `.claude`) and chmods them to 0o444 (locked) or
 * 0o644 (unlocked) in bulk. Backs the toolbar Lock toggle in `PanelHeader`.
 *
 * No persistent watcher — re-scan happens on every toggle, so newly created
 * `.env` files are only picked up the next time the user clicks the button.
 */

import { promises as fsp } from 'node:fs'
import { RelativePattern, workspace } from 'vscode'

const ENV_PATTERN = '**/.env*'
const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/.claude/**}'

/** Scan the workspace folder rooted at `workspaceRoot` for all `.env*`
 * files, skipping `node_modules`, `.git`, and `.claude`. Returns absolute
 * fs paths. Empty array if the workspace folder isn't currently open. */
export async function findEnvFiles(workspaceRoot: string): Promise<string[]> {
  const folder = workspace.workspaceFolders?.find(f => f.uri.fsPath === workspaceRoot)
  if (!folder)
    return []
  const include = new RelativePattern(folder, ENV_PATTERN)
  const uris = await workspace.findFiles(include, EXCLUDE_PATTERN)
  return uris.map(u => u.fsPath)
}

export interface EnvLockResult {
  total: number
  ok: string[]
  failed: { path: string, reason: string }[]
}

async function chmodAll(workspaceRoot: string, mode: number): Promise<EnvLockResult> {
  const files = await findEnvFiles(workspaceRoot)
  const result: EnvLockResult = { total: files.length, ok: [], failed: [] }
  for (const f of files) {
    try {
      await fsp.chmod(f, mode)
      result.ok.push(f)
    }
    catch (err) {
      result.failed.push({ path: f, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

/** Set every `.env*` file in the workspace to 0o444 (read-only). */
export async function lockEnvFiles(workspaceRoot: string): Promise<EnvLockResult> {
  return chmodAll(workspaceRoot, 0o444)
}

/** Restore every `.env*` file in the workspace to 0o644 (read-write). */
export async function unlockEnvFiles(workspaceRoot: string): Promise<EnvLockResult> {
  return chmodAll(workspaceRoot, 0o644)
}
