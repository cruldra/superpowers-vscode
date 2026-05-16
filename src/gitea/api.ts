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
