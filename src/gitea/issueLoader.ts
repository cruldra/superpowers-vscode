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

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { GiteaComment, GiteaIssue } from './api'
import type { Issue, IssueColumn } from './types'
import {
  getCurrentUser,
  getDependencies,
  getIssue,
  getPullRequest,
  listAllRepoComments,
  listIssueComments,
  listIssuesByFilter,
  postIssueComment,
} from './api'

const COLUMN_IDS: readonly IssueColumn[] = ['todo', 'in-progress', 'review', 'done']

/**
 * 过滤 specFile / planFile 字段里的垃圾值：
 * 真实路径必须包含 `/` 且以 `.md` 结尾。`...`、`…` 这类是 cc
 * 在 brainstorm 阶段写 issue body 时塞进去的占位说明文，webhook
 * 历史版本正则太宽松会把它们写进 state JSON，这里读出时兜底清掉。
 */
export function isValidSpxFilePath(v: unknown): v is string {
  return typeof v === 'string'
    && v.length > 0
    && v.includes('/')
    && v.endsWith('.md')
    && v !== '...'
    && v !== '…'
}

function isValidPrDiffFilePath(v: unknown): v is string {
  return typeof v === 'string'
    && /^docs\/pr-diff\/[^\s]+\.md$/.test(v)
}

function isIssueColumn(value: unknown): value is IssueColumn {
  return typeof value === 'string' && (COLUMN_IDS as readonly string[]).includes(value)
}

function defaultColumnForState(state: string): IssueColumn {
  return state === 'open' ? 'todo' : 'done'
}

/**
 * Scans comments from the tail for the most recent JSON state payload like
 * `{ "column": "todo", ... }`, skipping ordinary text/JSON comments that lack
 * a `column` field so they can't shadow the real state. Returns
 * `{ column: null }` if no valid payload is present.
 */
function parseColumnFromComments(comments: GiteaComment[]): {
  column: IssueColumn | null
  sessionId?: string
  profilePath?: string
  specFile?: string
  planFile?: string
  prDiffFile?: string
  pr?: string
  prMerged?: boolean
  branch?: string
  worktreePath?: string
  implementStatus?: 'running' | 'done' | 'failed'
  implementSessionId?: string
  reviewSessionId?: string
  testSessionId?: string
  color?: string
  autoReview?: boolean
} {
  if (comments.length === 0)
    return { column: null }
  // 从尾往前找第一条「parse 成功 && 是 object && 含 column」的 comment。
  // 中途插入的普通文本/JSON 内容评论不带 column，被跳过——否则它们会
  // 顶替真正的 state comment，导致整张卡片的列与元数据全部丢失。
  let parsed: unknown
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = (comments[i].body ?? '').trim()
    if (!body)
      continue
    let candidate: unknown
    try {
      candidate = JSON.parse(body)
    }
    catch {
      continue
    }
    if (candidate && typeof candidate === 'object' && 'column' in candidate) {
      parsed = candidate
      break
    }
  }
  if (parsed && typeof parsed === 'object' && 'column' in parsed) {
    const obj = parsed as {
      column: unknown
      sessionId?: unknown
      profilePath?: unknown
      specFile?: unknown
      planFile?: unknown
      prDiffFile?: unknown
      pr?: unknown
      prMerged?: unknown
      branch?: unknown
      worktreePath?: unknown
      implementStatus?: unknown
      implementSessionId?: unknown
      reviewSessionId?: unknown
      testSessionId?: unknown
      color?: unknown
      autoReview?: unknown
    }
    if (isIssueColumn(obj.column)) {
      const sessionId = typeof obj.sessionId === 'string' && obj.sessionId.length > 0
        ? obj.sessionId
        : undefined
      const profilePath = typeof obj.profilePath === 'string' && obj.profilePath.length > 0
        ? obj.profilePath
        : undefined
      const specFile = isValidSpxFilePath(obj.specFile) ? obj.specFile : undefined
      const planFile = isValidSpxFilePath(obj.planFile) ? obj.planFile : undefined
      const prDiffFile = isValidPrDiffFilePath(obj.prDiffFile) ? obj.prDiffFile : undefined
      const pr = typeof obj.pr === 'string' && obj.pr.length > 0
        ? obj.pr
        : undefined
      const prMerged = typeof obj.prMerged === 'boolean' ? obj.prMerged : undefined
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
      const reviewSessionId = typeof obj.reviewSessionId === 'string' && obj.reviewSessionId.length > 0
        ? obj.reviewSessionId
        : undefined
      const testSessionId = typeof obj.testSessionId === 'string' && obj.testSessionId.length > 0
        ? obj.testSessionId
        : undefined
      const color = typeof obj.color === 'string' && obj.color.length > 0
        ? obj.color
        : undefined
      const autoReview = typeof obj.autoReview === 'boolean' ? obj.autoReview : undefined
      return {
        column: obj.column,
        sessionId,
        profilePath,
        specFile,
        planFile,
        prDiffFile,
        pr,
        prMerged,
        branch,
        worktreePath,
        implementStatus,
        implementSessionId,
        reviewSessionId,
        testSessionId,
        color,
        autoReview,
      }
    }
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

/**
 * Builds an `Issue` from a Gitea issue plus its comment bucket.
 *
 * Encapsulates the per-issue parsing and side-effects (seeding a default
 * state comment when none exists, statting the worktree path) so it can be
 * reused by both the full loader and `loadSingleIssue`.
 */
/**
 * Resolves the live merged state for a PR by querying gitea. Returns the
 * boolean on success and `undefined` on any failure (network, 404, non-numeric
 * index, etc.) so callers can fall back to whatever they had cached.
 */
/**
 * Resolves the live PR status by querying gitea. Returns `{ merged, mergedAt }`
 * on success and `{}` on any failure (no pr, non-numeric index, network, 404,
 * parse error) so callers can fall back to whatever they had cached. `mergedAt`
 * is the PR's `merged_at` (ISO 8601) and powers the 完成 列's merge-time sort.
 */
async function fetchPrStatus(opts: {
  host: string
  token: string
  owner: string
  repo: string
  pr: string | undefined
}): Promise<{ merged?: boolean, mergedAt?: string }> {
  const { host, token, owner, repo, pr } = opts
  if (!pr)
    return {}
  const index = Number.parseInt(pr, 10)
  if (!Number.isFinite(index) || index <= 0)
    return {}
  try {
    const data = await getPullRequest({ host, token, owner, repo, index })
    return { merged: data.merged === true, mergedAt: data.merged_at ?? undefined }
  }
  catch {
    return {}
  }
}

async function buildIssue(opts: {
  host: string
  token: string
  owner: string
  repo: string
  workspaceRoot?: string
  issue: GiteaIssue
  comments: GiteaComment[]
  prerequisite: number | undefined
  /** 实时 PR merged 状态（由 loader 并发查询后传入）；undefined 表示查询失败或无 PR，回退 state JSON。 */
  liveMerged?: boolean
  /** PR 的 merged_at（来自 PR API），仅用于完成列排序；查询失败/无 PR 为 undefined。 */
  liveMergedAt?: string
}): Promise<Issue> {
  const { host, token, owner, repo, workspaceRoot, issue, comments, prerequisite, liveMerged, liveMergedAt } = opts
  const id = `${owner}/${repo}#${issue.number}`
  const {
    column: fromComment,
    sessionId,
    profilePath,
    specFile,
    planFile,
    prDiffFile,
    pr,
    prMerged: persistedMerged,
    branch,
    worktreePath,
    implementStatus,
    implementSessionId,
    reviewSessionId,
    testSessionId,
    color,
    autoReview,
  } = parseColumnFromComments(comments)
  // 优先用 PR API 实时结果；失败时退回 state JSON 持久化值。
  const prMerged = liveMerged !== undefined ? liveMerged : persistedMerged
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

  // Synchronously stat the worktree path so the UI can render it as a
  // live link vs. plain text. A single existsSync per issue is cheap and
  // avoids racing with the rest of the async pipeline.
  let worktreeExists: boolean | undefined
  if (worktreePath && workspaceRoot) {
    try {
      worktreeExists = fs.existsSync(path.join(workspaceRoot, worktreePath))
    }
    catch {
      worktreeExists = false
    }
  }

  return {
    id,
    number: issue.number,
    title: issue.title,
    column,
    ...(sessionId ? { sessionId } : {}),
    ...(profilePath ? { profilePath } : {}),
    ...(specFile ? { specFile } : {}),
    ...(planFile ? { planFile } : {}),
    ...(prDiffFile ? { prDiffFile } : {}),
    ...(pr ? { pr } : {}),
    ...(prMerged !== undefined ? { prMerged } : {}),
    ...(liveMergedAt ? { prMergedAt: liveMergedAt } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(worktreeExists !== undefined ? { worktreeExists } : {}),
    ...(implementStatus ? { implementStatus } : {}),
    ...(implementSessionId ? { implementSessionId } : {}),
    ...(reviewSessionId ? { reviewSessionId } : {}),
    ...(testSessionId ? { testSessionId } : {}),
    ...(prerequisite !== undefined ? { prerequisite } : {}),
    ...(color ? { color } : {}),
    ...(autoReview !== undefined ? { autoReview } : {}),
    htmlUrl: issue.html_url,
  }
}

export async function loadIssues(opts: {
  host: string
  token: string
  owner: string
  repo: string
  /** Absolute workspace root used to resolve `worktreeExists` against disk. */
  workspaceRoot?: string
}): Promise<Issue[]> {
  const { host, token, owner, repo, workspaceRoot } = opts

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

  // Concurrently fetch each issue's dependencies + live PR merged state.
  // Per product rule we keep at most one prerequisite — the first entry in
  // the array (Gitea orders by creation time). Failures (412 dependencies
  // disabled, network, etc.) are silently swallowed so one bad issue can't
  // take down the whole loader. PR merged 查询同样以失败兜底 undefined。
  const [prerequisites, liveMergedList] = await Promise.all([
    Promise.all(merged.map(async (issue) => {
      try {
        const deps = await getDependencies({ host, token, owner, repo, index: issue.number })
        return deps.length > 0 ? deps[0].number : undefined
      }
      catch {
        return undefined
      }
    })),
    Promise.all(merged.map(async (issue) => {
      const bucket = buckets.get(issue.number) ?? []
      const { pr } = parseColumnFromComments(bucket)
      return fetchPrStatus({ host, token, owner, repo, pr })
    })),
  ])

  const resolved: Issue[] = []
  for (let i = 0; i < merged.length; i++) {
    const issue = merged[i]
    const prerequisite = prerequisites[i]
    const { merged: liveMerged, mergedAt: liveMergedAt } = liveMergedList[i] ?? {}
    const bucket = buckets.get(issue.number) ?? []
    resolved.push(await buildIssue({
      host,
      token,
      owner,
      repo,
      workspaceRoot,
      issue,
      comments: bucket,
      prerequisite,
      liveMerged,
      liveMergedAt,
    }))
  }

  return resolved
}

/**
 * Loads a single issue by number, resolving its column / state metadata the
 * same way `loadIssues` does. Returns `null` if Gitea reports the issue
 * does not exist (404). Used by the incremental "issue created" path so the
 * webview can append one card without rerendering the whole board.
 */
export async function loadSingleIssue(opts: {
  host: string
  token: string
  owner: string
  repo: string
  workspaceRoot?: string
  issueNumber: number
}): Promise<Issue | null> {
  const { host, token, owner, repo, workspaceRoot, issueNumber } = opts

  const issue = await getIssue({ host, token, owner, repo, index: issueNumber })
  if (!issue)
    return null

  const [comments, prerequisite] = await Promise.all([
    listIssueComments({ host, token, owner, repo, index: issueNumber }),
    (async () => {
      try {
        const deps = await getDependencies({ host, token, owner, repo, index: issueNumber })
        return deps.length > 0 ? deps[0].number : undefined
      }
      catch {
        return undefined
      }
    })(),
  ])

  // 解析 state JSON 拿到 pr 字段后实时查 merged 状态；失败 fallback undefined。
  const { pr } = parseColumnFromComments(comments)
  const { merged: liveMerged, mergedAt: liveMergedAt } = await fetchPrStatus({ host, token, owner, repo, pr })

  return buildIssue({
    host,
    token,
    owner,
    repo,
    workspaceRoot,
    issue,
    comments,
    prerequisite,
    liveMerged,
    liveMergedAt,
  })
}
