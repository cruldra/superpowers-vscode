/**
 * Lists Claude settings profiles from a hardcoded directory. Each `.json`
 * file there is treated as a profile whose `name` is its basename without
 * the extension and whose `path` is the absolute file path, suitable for
 * passing to `claude --settings <path>`.
 *
 * Failures (directory missing, unreadable, etc.) are swallowed — the
 * caller treats an empty list as "no profile selector".
 */

import { readdir } from 'node:fs/promises'
import * as path from 'node:path'

const PROFILES_DIR = '/home/cruldra/Sources/cruldra-profile/claude-config/profiles'

export interface ClaudeProfile {
  /** basename without .json */
  name: string
  /** absolute path */
  path: string
}

/**
 * List Claude settings profiles from the hardcoded directory. Returns an
 * empty array if the directory is missing or unreadable; does not throw.
 * Sorted alphabetically by name.
 */
export async function listClaudeProfiles(): Promise<ClaudeProfile[]> {
  try {
    const entries = await readdir(PROFILES_DIR)
    const profiles: ClaudeProfile[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json'))
        continue
      const name = entry.slice(0, -'.json'.length)
      profiles.push({ name, path: path.join(PROFILES_DIR, entry) })
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name))
    return profiles
  }
  catch {
    return []
  }
}
