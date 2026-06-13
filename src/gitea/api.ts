/**
 * Fetch-based Gitea API client.
 *
 * Replaces the previous `tea` CLI shell-outs with direct REST calls over
 * Node 20+'s global `fetch`. All requests are authenticated with a personal
 * access token via the `Authorization: token <PAT>` header.
 *
 * Errors from non-2xx responses surface as `GiteaApiError` so callers can
 * distinguish 401 (token invalid) from other failure modes.
 */

import { logger } from '../logging/logger'

const PAGE_SIZE = 50

export interface GiteaUser {
  login: string
  id: number
}

export interface GiteaIssue {
  id: number
  number: number
  title: string
  state: 'open' | 'closed'
  comments: number
  created_at: string
  updated_at: string
  body: string
  html_url: string
  user: { login: string } | null
  assignees: Array<{ login: string }> | null
  labels: Array<{ name: string, color: string }> | null
}

export interface GiteaComment {
  id: number
  body: string
  issue_url: string
  created_at: string
  updated_at: string
}

export class GiteaApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'GiteaApiError'
    this.status = status
  }
}

function baseUrl(host: string): string {
  return `https://${host}/api/v1`
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `token ${token}`,
    'Accept': 'application/json',
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok)
    return
  const body = await res.text().catch(() => '')
  throw new GiteaApiError(res.status, body || res.statusText)
}

export async function getCurrentUser(opts: { host: string, token: string }): Promise<GiteaUser> {
  const res = await fetch(`${baseUrl(opts.host)}/user`, {
    headers: authHeaders(opts.token),
  })
  await ensureOk(res)
  return res.json() as Promise<GiteaUser>
}

/**
 * Fetches `/repos/{owner}/{repo}/issues` filtered by either `assigned_by` or
 * `created_by`, paginating until a short page is returned.
 */
export async function listIssuesByFilter(opts: {
  host: string
  token: string
  owner: string
  repo: string
  filter: 'assigned_by' | 'created_by'
  user: string
}): Promise<GiteaIssue[]> {
  const out: GiteaIssue[] = []
  let page = 1
  // Gitea returns a JSON array of issues; we accumulate until we see a short page.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL(`${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues`)
    url.searchParams.set('type', 'issues')
    url.searchParams.set('state', 'all')
    url.searchParams.set(opts.filter, opts.user)
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))

    const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
    await ensureOk(res)
    const batch = await res.json() as GiteaIssue[]
    if (!Array.isArray(batch) || batch.length === 0)
      break
    out.push(...batch)
    if (batch.length < PAGE_SIZE)
      break
    page += 1
  }
  return out
}

/**
 * Fetches the firehose `/repos/{owner}/{repo}/issues/comments` endpoint, which
 * returns every comment in the repo across all issues. Paginated until a short
 * page is returned.
 */
export async function listAllRepoComments(opts: {
  host: string
  token: string
  owner: string
  repo: string
}): Promise<GiteaComment[]> {
  const out: GiteaComment[] = []
  let page = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL(`${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/comments`)
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))

    const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
    await ensureOk(res)
    const batch = await res.json() as GiteaComment[]
    if (!Array.isArray(batch) || batch.length === 0)
      break
    out.push(...batch)
    if (batch.length < PAGE_SIZE)
      break
    page += 1
  }
  return out
}

/**
 * Fetches comments for a single issue via
 * `/repos/{owner}/{repo}/issues/{index}/comments`. Paginated until a short
 * page is returned. Used when we need the freshest view of one issue's
 * state-JSON comment (e.g. mutating the last comment in place).
 */
export async function listIssueComments(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
}): Promise<GiteaComment[]> {
  const out: GiteaComment[] = []
  let page = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL(
      `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}/comments`,
    )
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))

    const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
    await ensureOk(res)
    const batch = await res.json() as GiteaComment[]
    if (!Array.isArray(batch) || batch.length === 0)
      break
    out.push(...batch)
    if (batch.length < PAGE_SIZE)
      break
    page += 1
  }
  return out
}

export async function postIssueComment(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
  body: string
}): Promise<void> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}/comments`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(opts.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: opts.body }),
    },
  )
  await ensureOk(res)
}


export interface GiteaPullRequest {
  number: number
  merged: boolean
  state: string
  merged_at?: string | null
  html_url: string
  /**
   * PR description / body. Used by the webhook coordinator to reverse-lookup
   * the underlying issue number (`Closes #N`) when a comment fires on a PR.
   */
  body: string
}

/**
 * Fetches a single pull request by index via
 * `/repos/{owner}/{repo}/pulls/{index}`. Used by the kanban "done" drop
 * handler to verify a PR is merged before persisting `column='done'`.
 */
export async function getPullRequest(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
}): Promise<GiteaPullRequest> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/pulls/${opts.index}`,
    { headers: authHeaders(opts.token) },
  )
  await ensureOk(res)
  const data = await res.json() as {
    number?: unknown
    merged?: unknown
    state?: unknown
    merged_at?: unknown
    html_url?: unknown
    body?: unknown
  }
  return {
    number: typeof data.number === 'number' ? data.number : Number(data.number),
    merged: data.merged === true,
    state: typeof data.state === 'string' ? data.state : '',
    merged_at: typeof data.merged_at === 'string' ? data.merged_at : null,
    html_url: typeof data.html_url === 'string' ? data.html_url : '',
    body: typeof data.body === 'string' ? data.body : '',
  }
}

export async function getIssue(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
}): Promise<GiteaIssue | null> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}`,
    { headers: authHeaders(opts.token) },
  )
  if (res.status === 404)
    return null
  await ensureOk(res)
  return await res.json() as GiteaIssue
}

export async function getDependencies(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
}): Promise<Array<{ number: number }>> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}/dependencies`,
    { headers: authHeaders(opts.token) },
  )
  await ensureOk(res)
  const data = await res.json() as Array<{ number?: unknown }>
  if (!Array.isArray(data))
    return []
  return data
    .map((it) => {
      const n = typeof it?.number === 'number' ? it.number : Number(it?.number)
      return Number.isFinite(n) ? { number: n } : null
    })
    .filter((it): it is { number: number } => it !== null)
}

export async function addDependency(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
  dependencyIndex: number
}): Promise<void> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}/dependencies`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(opts.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ index: opts.dependencyIndex }),
    },
  )
  await ensureOk(res)
}

/**
 * Merge a pull request via gitea's `POST /repos/{owner}/{repo}/pulls/{index}/merge`.
 * Defaults to the plain "merge" strategy. Throws GiteaApiError on non-2xx.
 */
export async function mergePullRequest(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
  strategy?: 'merge' | 'rebase' | 'rebase-merge' | 'squash'
}): Promise<void> {
  const url = `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/pulls/${opts.index}/merge`
  const body = {
    Do: opts.strategy ?? 'merge',
    delete_branch_after_merge: false,
    force_merge: false,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(opts.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  await ensureOk(res)
}

export async function closeIssue(opts: {
  host: string
  token: string
  owner: string
  repo: string
  issueNumber: number
}): Promise<void> {
  const url = `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...authHeaders(opts.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'closed' }),
  })
  await ensureOk(res)
}

export async function deleteIssue(opts: {
  host: string
  token: string
  owner: string
  repo: string
  issueNumber: number
}): Promise<void> {
  const url = `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(opts.token),
  })
  await ensureOk(res)
}

export async function deleteBranch(opts: {
  host: string
  token: string
  owner: string
  repo: string
  branch: string
}): Promise<void> {
  const url = `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/branches/${encodeURIComponent(opts.branch)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(opts.token),
  })
  await ensureOk(res)
}

export async function removeDependency(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
  dependencyIndex: number
}): Promise<void> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/issues/${opts.index}/dependencies`,
    {
      method: 'DELETE',
      headers: {
        ...authHeaders(opts.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ index: opts.dependencyIndex }),
    },
  )
  await ensureOk(res)
}


// no longer auto-invoked by the implement flow; kept for future manual ops
export async function createWebhook(opts: {
  host: string
  token: string
  owner: string
  repo: string
  url: string
  branchFilter: string
}): Promise<{ id: number }> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/hooks`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(opts.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'gitea',
        active: true,
        events: ['pull_request'],
        branch_filter: opts.branchFilter,
        config: {
          url: opts.url,
          content_type: 'json',
        },
      }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.add({
      level: 'error',
      source: 'gitea',
      message: `createWebhook 失败 status=${res.status}`,
      details: (body || res.statusText).slice(0, 500),
    })
    throw new GiteaApiError(res.status, body || res.statusText)
  }
  const data = (await res.json()) as { id?: unknown }
  const id = typeof data.id === 'number' ? data.id : Number(data.id)
  if (!Number.isFinite(id)) {
    logger.add({
      level: 'error',
      source: 'gitea',
      message: 'createWebhook: 响应缺少 id',
    })
    throw new GiteaApiError(500, 'createWebhook: response missing id')
  }
  logger.add({
    level: 'info',
    source: 'gitea',
    message: `已创建 hookId=${id} url=${opts.url} branch_filter=${opts.branchFilter}`,
  })
  return { id }
}

// no longer auto-invoked by the implement flow; kept for future manual ops
export async function deleteWebhook(opts: {
  host: string
  token: string
  owner: string
  repo: string
  hookId: number
}): Promise<void> {
  const res = await fetch(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/hooks/${opts.hookId}`,
    {
      method: 'DELETE',
      headers: authHeaders(opts.token),
    },
  )
  if (res.status === 404) {
    logger.add({
      level: 'warn',
      source: 'gitea',
      message: `deleteWebhook hookId=${opts.hookId} 已不存在 (404)`,
    })
    return
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.add({
      level: 'error',
      source: 'gitea',
      message: `deleteWebhook hookId=${opts.hookId} 失败 status=${res.status}`,
      details: (body || res.statusText).slice(0, 500),
    })
    throw new GiteaApiError(res.status, body || res.statusText)
  }
  logger.add({
    level: 'info',
    source: 'gitea',
    message: `已删除 hookId=${opts.hookId}`,
  })
}

/** PR 提交的精简视图：列表渲染只需 sha / 首行消息 / 作者 / 时间。 */
export interface PrCommitDto {
  sha: string
  message: string
  authorName: string
  date: string
}

/** 单个提交内的一个文件改动：path 给 diff 用，status 决定徽标颜色。 */
export interface GitCommitFileDto {
  path: string
  status: string
}

/** 一个提交的详情：parentSha 用作 diff 左侧 ref，files 是改动清单。 */
export interface GitCommitDetailDto {
  sha: string
  parentSha: string | undefined
  files: GitCommitFileDto[]
}

/**
 * 列出某 PR 的提交。关掉 files/stat/verification 让响应尽量小，列表只用到
 * 顶层字段。message 取首行（完整消息留给 commit 详情页，这里只做概览）。
 */
export async function listPullRequestCommits(opts: {
  host: string
  token: string
  owner: string
  repo: string
  index: number
  limit?: number
}): Promise<PrCommitDto[]> {
  const url = new URL(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/pulls/${opts.index}/commits`,
  )
  url.searchParams.set('page', '1')
  url.searchParams.set('limit', String(opts.limit ?? 50))
  url.searchParams.set('files', 'false')
  url.searchParams.set('stat', 'false')
  url.searchParams.set('verification', 'false')

  const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
  await ensureOk(res)
  const data = await res.json() as Array<{
    sha?: unknown
    created?: unknown
    commit?: { message?: unknown, author?: { name?: unknown, date?: unknown } }
    author?: { login?: unknown } | null
  }>
  if (!Array.isArray(data))
    return []
  return data.map((c) => {
    const fullMessage = typeof c.commit?.message === 'string' ? c.commit.message : ''
    const message = fullMessage.split('\n', 1)[0] ?? ''
    const authorName = typeof c.commit?.author?.name === 'string' ? c.commit.author.name : ''
    const commitDate = typeof c.commit?.author?.date === 'string' ? c.commit.author.date : ''
    const created = typeof c.created === 'string' ? c.created : ''
    return {
      sha: typeof c.sha === 'string' ? c.sha : '',
      message,
      authorName,
      date: commitDate || created,
    }
  })
}

/**
 * 取单个提交详情，带文件清单。parentSha（首个父提交）作为 diff 左侧 ref；
 * 根提交无 parent 时为 undefined，调用方据此把左侧当空内容处理（呈现全新增）。
 */
export async function getGitCommit(opts: {
  host: string
  token: string
  owner: string
  repo: string
  sha: string
}): Promise<GitCommitDetailDto> {
  const url = new URL(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/git/commits/${opts.sha}`,
  )
  url.searchParams.set('files', 'true')
  url.searchParams.set('stat', 'false')
  url.searchParams.set('verification', 'false')

  const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
  await ensureOk(res)
  const data = await res.json() as {
    sha?: unknown
    parents?: Array<{ sha?: unknown }>
    files?: Array<{ filename?: unknown, status?: unknown }>
  }
  const parentSha = typeof data.parents?.[0]?.sha === 'string' ? data.parents[0].sha : undefined
  const files = Array.isArray(data.files)
    ? data.files.map(f => ({
        path: typeof f.filename === 'string' ? f.filename : '',
        status: typeof f.status === 'string' ? f.status : '',
      }))
    : []
  return {
    sha: typeof data.sha === 'string' ? data.sha : opts.sha,
    parentSha,
    files,
  }
}

/**
 * 取某 ref 下文件的原始内容，用作 diff 的一侧。
 *
 * 文件在该 ref 不存在（404）是预期情况：新增文件在父 ref 缺席、删除文件在子
 * ref 缺席。这类情况返回空串，让 diff 自然呈现新增/删除，而非报错。其它非 2xx
 * 同样兜底返回空串——diff 视图容不下错误对话框。
 */
export async function getRawFile(opts: {
  host: string
  token: string
  owner: string
  repo: string
  filepath: string
  ref: string
}): Promise<string> {
  // encodeURI 保留路径分隔符 `/`，只转义路径段里的特殊字符。
  const url = new URL(
    `${baseUrl(opts.host)}/repos/${opts.owner}/${opts.repo}/raw/${encodeURI(opts.filepath)}`,
  )
  url.searchParams.set('ref', opts.ref)

  const res = await fetch(url.toString(), { headers: authHeaders(opts.token) })
  if (!res.ok)
    return ''
  return res.text()
}
