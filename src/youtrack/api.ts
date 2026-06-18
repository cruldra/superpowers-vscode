/**
 * Fetch-based YouTrack REST client.
 *
 * Mirrors the role of `src/gitea/api.ts` for the second issue source. All
 * requests authenticate with a YouTrack permanent token via
 * `Authorization: Bearer <token>`. Non-2xx responses surface as
 * `YouTrackApiError` so callers can distinguish 401 (token invalid) from other
 * failures, matching the Gitea client's contract.
 */

export class YouTrackApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'YouTrackApiError'
    this.status = status
  }
}

export interface YouTrackProject {
  id: string
  name: string
  shortName: string
}

export interface YouTrackAttachment {
  name: string
  /** Absolute URL (baseUrl + the relative, pre-signed path YouTrack returns). */
  url: string
}

export interface YouTrackComment {
  id: string
  text: string
}

export interface YouTrackIssue {
  idReadable: string
  summary: string
  description: string
  /** Resolve timestamp in ms, or null when the issue is unresolved/open. */
  resolved: number | null
  attachments: YouTrackAttachment[]
  comments: YouTrackComment[]
}

/** Strip trailing slashes so we can append `/api/...` uniformly. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  }
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok)
    return
  const body = await res.text().catch(() => '')
  throw new YouTrackApiError(res.status, body || res.statusText)
}

export interface YouTrackAuth {
  baseUrl: string
  token: string
}

/** Browser URL to an issue's page — the detail-panel "在 YouTrack 打开" target. */
export function issueHtmlUrl(baseUrl: string, idReadable: string): string {
  return `${normalizeBase(baseUrl)}/issue/${idReadable}`
}

/** Lists projects the token can see — feeds the settings project dropdown. */
export async function listProjects(auth: YouTrackAuth): Promise<YouTrackProject[]> {
  const url = new URL(`${normalizeBase(auth.baseUrl)}/api/admin/projects`)
  url.searchParams.set('fields', 'id,name,shortName')
  url.searchParams.set('$top', '500')
  const res = await fetch(url.toString(), { headers: authHeaders(auth.token) })
  await ensureOk(res)
  const data = await res.json() as Array<{ id?: unknown, name?: unknown, shortName?: unknown }>
  if (!Array.isArray(data))
    return []
  return data
    .map(p => ({
      id: typeof p.id === 'string' ? p.id : '',
      name: typeof p.name === 'string' ? p.name : '',
      shortName: typeof p.shortName === 'string' ? p.shortName : '',
    }))
    .filter(p => p.shortName)
}

const ISSUE_FIELDS = [
  'idReadable',
  'summary',
  'description',
  'resolved',
  'attachments(name,url)',
  'comments(id,text)',
].join(',')

/**
 * Lists all issues in a project (newest first). Single page of up to 500 —
 * ponytail: no pagination, the panel tracks a personal project, not a 10k-issue
 * firehose. Upgrade to `$skip`/`$top` paging if a project ever outgrows it.
 */
export async function listIssues(auth: YouTrackAuth, projectShortName: string): Promise<YouTrackIssue[]> {
  const url = new URL(`${normalizeBase(auth.baseUrl)}/api/issues`)
  url.searchParams.set('query', `project: ${projectShortName}`)
  url.searchParams.set('fields', ISSUE_FIELDS)
  url.searchParams.set('$top', '500')
  const res = await fetch(url.toString(), { headers: authHeaders(auth.token) })
  await ensureOk(res)
  const data = await res.json() as unknown
  if (!Array.isArray(data))
    return []
  const base = normalizeBase(auth.baseUrl)
  return data.map((raw) => {
    const it = raw as Record<string, unknown>
    const attachments = Array.isArray(it.attachments)
      ? (it.attachments as Array<Record<string, unknown>>).map(a => ({
          name: typeof a.name === 'string' ? a.name : '',
          url: typeof a.url === 'string' ? (a.url.startsWith('http') ? a.url : base + a.url) : '',
        })).filter(a => a.url)
      : []
    const comments = Array.isArray(it.comments)
      ? (it.comments as Array<Record<string, unknown>>).map(c => ({
          id: typeof c.id === 'string' ? c.id : '',
          text: typeof c.text === 'string' ? c.text : '',
        }))
      : []
    return {
      idReadable: typeof it.idReadable === 'string' ? it.idReadable : '',
      summary: typeof it.summary === 'string' ? it.summary : '',
      description: typeof it.description === 'string' ? it.description : '',
      resolved: typeof it.resolved === 'number' ? it.resolved : null,
      attachments,
      comments,
    }
  }).filter(it => it.idReadable)
}

/** Fresh read of one issue's comments — used right before mutating state. */
export async function listComments(auth: YouTrackAuth, issueId: string): Promise<YouTrackComment[]> {
  const url = new URL(`${normalizeBase(auth.baseUrl)}/api/issues/${issueId}/comments`)
  url.searchParams.set('fields', 'id,text')
  url.searchParams.set('$top', '500')
  const res = await fetch(url.toString(), { headers: authHeaders(auth.token) })
  await ensureOk(res)
  const data = await res.json() as Array<{ id?: unknown, text?: unknown }>
  if (!Array.isArray(data))
    return []
  return data.map(c => ({
    id: typeof c.id === 'string' ? c.id : '',
    text: typeof c.text === 'string' ? c.text : '',
  }))
}

export async function addComment(auth: YouTrackAuth, issueId: string, text: string): Promise<void> {
  const url = new URL(`${normalizeBase(auth.baseUrl)}/api/issues/${issueId}/comments`)
  url.searchParams.set('fields', 'id')
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { ...authHeaders(auth.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  await ensureOk(res)
}

/**
 * Applies a YouTrack command (e.g. `State Fixed`) to one issue via the commands
 * API. Used to resolve the issue when its card lands in the 完成 column.
 */
export async function applyCommand(auth: YouTrackAuth, issueId: string, command: string): Promise<void> {
  const url = `${normalizeBase(auth.baseUrl)}/api/commands`
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(auth.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: command, issues: [{ idReadable: issueId }] }),
  })
  await ensureOk(res)
}

/**
 * Derives a "resolve this issue" command by inspecting its State-type custom
 * field: finds the field's bundle element flagged `isResolved` and returns
 * `<FieldName> <ResolvedValue>`. Returns null when the issue has no resolvable
 * state field (caller then logs and skips). Lets close-sync work without the
 * user hard-coding a command for their project's state naming.
 */
export async function resolvedStateCommand(auth: YouTrackAuth, issueId: string): Promise<string | null> {
  const url = new URL(`${normalizeBase(auth.baseUrl)}/api/issues/${issueId}`)
  url.searchParams.set(
    'fields',
    'customFields(name,$type,projectCustomField(field(name),bundle(values(name,isResolved))))',
  )
  const res = await fetch(url.toString(), { headers: authHeaders(auth.token) })
  await ensureOk(res)
  const data = await res.json() as { customFields?: Array<Record<string, any>> }
  const fields = Array.isArray(data.customFields) ? data.customFields : []
  for (const f of fields) {
    if (typeof f?.$type === 'string' && f.$type.includes('State')) {
      const fieldName = f?.projectCustomField?.field?.name ?? f?.name
      const values = f?.projectCustomField?.bundle?.values
      if (typeof fieldName === 'string' && Array.isArray(values)) {
        const resolvedValue = values.find((v: any) => v?.isResolved === true)
        if (resolvedValue && typeof resolvedValue.name === 'string')
          return `${fieldName} ${resolvedValue.name}`
      }
    }
  }
  return null
}
