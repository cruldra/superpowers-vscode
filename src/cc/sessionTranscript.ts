/**
 * Scans Claude Code session JSONL transcripts on disk for references to
 * spec/plan files under `docs/superpowers/`. Used by the kanban panel's
 * "load" action on the bottom detail panel — given an issue's `sessionId`,
 * we open the corresponding transcript and surface the *latest* spec/plan
 * file paths mentioned anywhere in the conversation.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'

/** Result of scanning a session transcript. Fields are independent. */
export interface SessionFileScan {
  /** Workspace-relative path to the latest spec file mentioned, if any. */
  specFile?: string
  /** Workspace-relative path to the latest plan file mentioned, if any. */
  planFile?: string
}

/** Hard cap on transcript file size we'll load into memory. */
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024

/** Pulls the workspace-relative `docs/superpowers/...` suffix off a match. */
function stripPrefix(match: string): string {
  const idx = match.indexOf('docs/superpowers/')
  return idx >= 0 ? match.slice(idx) : match
}

/**
 * Scan the Claude Code session JSONL at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` and return the *latest*
 * spec/plan file paths mentioned anywhere in the transcript. Paths matching
 * `docs/superpowers/specs/*.md` map to `specFile`; `.../plans/*.md` map to
 * `planFile`. Both fields are independent — only the latest match wins.
 *
 * Returns an empty object if the file doesn't exist or no matches are found.
 * Surfaces other errors (permission, oversize, malformed read) to the caller.
 */
export async function scanSessionFiles(opts: {
  workspaceRoot: string
  sessionId: string
}): Promise<SessionFileScan> {
  const { workspaceRoot, sessionId } = opts
  const encodedCwd = workspaceRoot.replace(/\//g, '-')
  const transcriptPath = path.join(
    homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${sessionId}.jsonl`,
  )

  let size: number
  try {
    const st = await stat(transcriptPath)
    size = st.size
  }
  catch (err) {
    // Missing file is the common case for never-resumed issues; swallow.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return {}
    throw err
  }

  if (size > MAX_TRANSCRIPT_BYTES) {
    // Bail safely on absurd-sized transcripts rather than blowing up memory.
    return {}
  }

  const raw = await readFile(transcriptPath, 'utf-8')

  const specRe = /docs\/superpowers\/specs\/[^\s"'\\]+\.md/g
  const planRe = /docs\/superpowers\/plans\/[^\s"'\\]+\.md/g

  const specMatches = raw.match(specRe)
  const planMatches = raw.match(planRe)

  const result: SessionFileScan = {}
  if (specMatches && specMatches.length > 0)
    result.specFile = stripPrefix(specMatches[specMatches.length - 1])
  if (planMatches && planMatches.length > 0)
    result.planFile = stripPrefix(planMatches[planMatches.length - 1])
  return result
}
