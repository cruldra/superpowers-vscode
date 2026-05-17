/**
 * Loads issues from the workspace's Gitea repository using the fetch-based
 * `api.ts` client and resolves each issue's Kanban column from a JSON
 * state-comment convention.
 *
 * Flow:
 *   1. Kick off `/user` and the repo-wide comments firehose concurrently.
 *      Once `/user` resolves we know `login`, so fire both issue-filter
 *      queries (`assigned_by`, `created_by`) in parallel with the still-
 *      pending comments fetch.
 *   2. Merge the two issue lists by `number`.
 *   3. Group comments by issue number (parsed from each comment's `issue_url`).
 *   4. For each merged issue, inspect the literal last comment for
 *      `{ "column": "<id>" }`. If it parses cleanly, use that column.
 *      Otherwise compute a default from `issue.state` and persist it by
 *      posting a JSON comment. POST failures are logged and ignored — we
 *      still display the issue in the computed column.
 */

import type { GiteaComment, GiteaIssue } from './api'
import type { Issue, IssueColumn } from './types'
import {
  getCurrentUser,
  listAllRepoComments,
  listIssuesByFilter,
  postIssueComment,
} from './api'

const COLUMN_IDS: readonly IssueColumn[] = ['todo', 'in-progress', 'review', 'done']

function isIssueColumn(value: unknown): value is IssueColumn {
  return typeof value === 'string' && (COLUMN_IDS as readonly string[]).includes(value)
}

function defaultColumnForState(state: string): IssueColumn {
  return state === 'open' ? 'todo' : 'done'
}

/**
 * Inspects the literal last comment for a JSON state payload like
 * `{ "column": "todo" }`. Returns null if no valid payload is present.
 */
function parseColumnFromComments(comments: GiteaComment[]): {
  column: IssueColumn | null
  sessionId?: string
  profilePath?: string
  specFile?: string
  planFile?: string
  pr?: string
  branch?: string
  worktreePath?: string
  implementStatus?: 'running' | 'done' | 'failed'
  implementSessionId?: string
} {
  if (comments.length === 0)
    return { column: null }
  const last = comments[comments.length - 1]
  const body = (last.body ?? '').trim()
  if (!body)
    return { column: null }
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object' && 'column' in parsed) {
      const obj = parsed as {
        column: unknown
        sessionId?: unknown
        profilePath?: unknown
        specFile?: unknown
        planFile?: unknown
        pr?: unknown
        branch?: unknown
        worktreePath?: unknown
        implementStatus?: unknown
        implementSessionId?: unknown
      }
      if (isIssueColumn(obj.column)) {
        const sessionId = typeof obj.sessionId === 'string' && obj.sessionId.length > 0
          ? obj.sessionId
          : undefined
        const profilePath = typeof obj.profilePath === 'string' && obj.profilePath.length > 0
          ? obj.profilePath
          : undefined
        const specFile = typeof obj.specFile === 'string' && obj.specFile.length > 0
          ? obj.specFile
          : undefined
        const planFile = typeof obj.planFile === 'string' && obj.planFile.length > 0
          ? obj.planFile
          : undefined
        const pr = typeof obj.pr === 'string' && obj.pr.length > 0
          ? obj.pr
          : undefined
        const branch = typeof obj.branch === 'string' && obj.branch.length > 0
          ? obj.branch
          : undefined
        const worktreePath = typeof obj.worktreePath === 'string' && obj.worktreePath.length > 0
          ? obj.worktreePath
          : undefined
        const implementStatus = obj.implementStatus === 'running'
          || obj.implementStatus === 'done'
          || obj.implementStatus === 'failed'
          ? obj.implementStatus
          : undefined
        const implementSessionId = typeof obj.implementSessionId === 'string' && obj.implementSessionId.length > 0
          ? obj.implementSessionId
          : undefined
        return {
          column: obj.column,
          sessionId,
          profilePath,
          specFile,
          planFile,
          pr,
          branch,
          worktreePath,
          implementStatus,
          implementSessionId,
        }
      }
    }
  }
  catch {
    // Non-JSON last comment is the common case; fall through to the default.
  }
  return { column: null }
}

/** Extracts the issue index from a comment's `issue_url`, e.g. `.../issues/42`. */
function indexFromIssueUrl(issueUrl: string): number | undefined {
  if (!issueUrl)
    return undefined
  const segments = issueUrl.split('/')
  const last = segments[segments.length - 1]
  const n = Number(last)
  return Number.isFinite(n) ? n : undefined
}

/** Merges issue lists by `number`, preferring the first occurrence. */
function mergeIssues(...lists: GiteaIssue[][]): GiteaIssue[] {
  const map = new Map<number, GiteaIssue>()
  for (const list of lists) {
    for (const issue of list) {
      if (!map.has(issue.number))
        map.set(issue.number, issue)
    }
  }
  return [...map.values()]
}

/**
 * Groups repo-wide comments by issue number, ordered ascending by creation time.
 * Comments whose `issue_url` cannot be parsed are dropped.
 */
function groupCommentsByIssue(comments: GiteaComment[]): Map<number, GiteaComment[]> {
  const buckets = new Map<number, GiteaComment[]>()
  for (const c of comments) {
    const idx = indexFromIssueUrl(c.issue_url)
    if (idx === undefined)
      continue
    const bucket = buckets.get(idx)
    if (bucket)
      bucket.push(c)
    else
      buckets.set(idx, [c])
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }
  return buckets
}

export async function loadIssues(opts: {
  host: string
  token: string
  owner: string
  repo: string
}): Promise<Issue[]> {
  const { host, token, owner, repo } = opts

  // `/user` validates the token and gives us the login. The repo-wide
  // comments firehose doesn't need the login, so we kick it off in parallel.
  // The two issue-filter calls need `user.login` and run together after.
  const userPromise = getCurrentUser({ host, token })
  const commentsPromise = listAllRepoComments({ host, token, owner, repo })

  const user = await userPromise

  const [assigned, created, allComments] = await Promise.all([
    listIssuesByFilter({ host, token, owner, repo, filter: 'assigned_by', user: user.login }),
    listIssuesByFilter({ host, token, owner, repo, filter: 'created_by', user: user.login }),
    commentsPromise,
  ])

  const merged = mergeIssues(assigned, created)
  const buckets = groupCommentsByIssue(allComments)

  const resolved: Issue[] = []
  for (const issue of merged) {
    const id = `${owner}/${repo}#${issue.number}`
    const bucket = buckets.get(issue.number) ?? []
    const {
      column: fromComment,
      sessionId,
      profilePath,
      specFile,
      planFile,
      pr,
      branch,
      worktreePath,
      implementStatus,
      implementSessionId,
    } = parseColumnFromComments(bucket)
    let column: IssueColumn
    if (fromComment) {
      column = fromComment
    }
    else {
      column = defaultColumnForState(issue.state)
      // Persist the default so future pulls are cheap; failures are
      // non-fatal — we still display the issue in the computed column.
      try {
        await postIssueComment({
          host,
          token,
          owner,
          repo,
          index: issue.number,
          body: JSON.stringify({ column }),
        })
      }
      catch (postErr) {
        // eslint-disable-next-line no-console
        console.warn(`[superpowers] failed to seed state comment on ${id}:`, postErr)
      }
    }

    resolved.push({
      id,
      number: issue.number,
      title: issue.title,
      column,
      ...(sessionId ? { sessionId } : {}),
      ...(profilePath ? { profilePath } : {}),
      ...(specFile ? { specFile } : {}),
      ...(planFile ? { planFile } : {}),
      ...(pr ? { pr } : {}),
      ...(branch ? { branch } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(implementStatus ? { implementStatus } : {}),
      ...(implementSessionId ? { implementSessionId } : {}),
      htmlUrl: issue.html_url,
    })
  }

  return resolved
}
