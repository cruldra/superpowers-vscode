/**
 * 「提交」tab 的扩展侧 handler：实时从 Gitea 读 PR 提交、提交内文件，并用
 * VS Code 原生 diff 比较改动前后。
 *
 * 数据全程实时拉取，不落任何 state JSON。文件内容通过一个
 * TextDocumentContentProvider（scheme `spx-gitea`）按需取 raw，使 diff 的两侧
 * 各自指向一个 ref 下的文件。
 */

import type { KanbanWebviewPanel } from '../KanbanPanel'
import { commands, Uri, window, workspace, type TextDocumentContentProvider } from 'vscode'
import { getToken } from '../../auth/secrets'
import { detectRepo } from '../../git/remote'
import { getGitCommit, getRawFile, listPullRequestCommits } from '../../gitea/api'
import { readStateJsonComment } from '../../gitea/stateJson'
import { readConfirmed, writeConfirmed } from '../../sessions/prReviewStore'

/** diff 文件内容走的虚拟文档 scheme。 */
const SPX_GITEA_SCHEME = 'spx-gitea'

/** provider 只需注册一次；模块级守卫避免重复注册同一 scheme 抛错。 */
let providerRegistered = false

/**
 * 解析当前工作区的 Gitea 仓库与 token。三者任一缺失返回 undefined，
 * 调用方据此走空态/错误分支。
 */
async function resolveRepoContext(panel: KanbanWebviewPanel): Promise<
  { host: string, owner: string, repo: string, token: string } | undefined
> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot)
    return undefined
  const remote = await detectRepo(workspaceRoot)
  if (!remote)
    return undefined
  const token = await getToken(panel.context, remote.host)
  if (!token)
    return undefined
  return { host: remote.host, owner: remote.owner, repo: remote.repo, token }
}

/**
 * 拉取工单对应 PR 的提交列表并推给 webview。无 PR 时回空列表（前端按空态处理，
 * 不算错误）；缺工作区/远程/token 同样回空列表。真出错才带 error。
 */
export async function handleGetPrCommits(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  try {
    const ctx = await resolveRepoContext(panel)
    if (!ctx) {
      panel.postMessage({ type: 'pr-commits/show', issueNumber, commits: [] })
      return
    }

    const stateObj = await readStateJsonComment({
      host: ctx.host,
      owner: ctx.owner,
      repo: ctx.repo,
      token: ctx.token,
      issueNumber,
    })
    const pr = typeof stateObj?.pr === 'string' && stateObj.pr.length > 0 ? stateObj.pr : undefined
    if (!pr) {
      panel.postMessage({ type: 'pr-commits/show', issueNumber, commits: [] })
      return
    }

    const commits = await listPullRequestCommits({
      host: ctx.host,
      owner: ctx.owner,
      repo: ctx.repo,
      token: ctx.token,
      index: Number(pr),
    })
    panel.postMessage({ type: 'pr-commits/show', issueNumber, commits })
  }
  catch (err) {
    panel.postMessage({
      type: 'pr-commits/show',
      issueNumber,
      commits: [],
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 取某提交的文件清单并推给 webview。parentSha 一并回传，供前端发起 diff 时
 * 作为左侧 ref。
 */
export async function handleGetPrCommitFiles(
  panel: KanbanWebviewPanel,
  issueNumber: number,
  sha: string,
): Promise<void> {
  try {
    const ctx = await resolveRepoContext(panel)
    if (!ctx) {
      panel.postMessage({ type: 'pr-commit-files/show', issueNumber, sha, files: [], confirmed: [] })
      return
    }

    const detail = await getGitCommit({
      host: ctx.host,
      owner: ctx.owner,
      repo: ctx.repo,
      token: ctx.token,
      sha,
    })
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    const confirmed = workspaceRoot
      ? await readConfirmed(workspaceRoot, issueNumber, sha)
      : []
    panel.postMessage({
      type: 'pr-commit-files/show',
      issueNumber,
      sha,
      parentSha: detail.parentSha,
      files: detail.files,
      confirmed,
    })
  }
  catch (err) {
    panel.postMessage({
      type: 'pr-commit-files/show',
      issueNumber,
      sha,
      files: [],
      confirmed: [],
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 持久化某提交里已确认（已审阅）的文件路径集合到 `.spx/pr-review-confirmed.json`。
 * 拿不到工作区根则静默跳过；写盘失败兜底打日志、不抛——确认态丢失不该中断 UI。
 */
export async function handleSetPrReviewConfirmed(
  panel: KanbanWebviewPanel,
  args: { issueNumber: number, sha: string, confirmed: string[] },
): Promise<void> {
  try {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot)
      return
    await writeConfirmed(workspaceRoot, args.issueNumber, args.sha, args.confirmed)
  }
  catch (err) {
    console.warn('handleSetPrReviewConfirmed 写盘失败', err)
  }
}

/**
 * 懒注册 raw 内容 provider（只一次）。闭包捕获 panel 以便取 token——diff 两侧的
 * 文档内容都经此 provider 按 uri 里的 ref 拉取。
 */
function ensureContentProvider(panel: KanbanWebviewPanel): void {
  if (providerRegistered)
    return
  providerRegistered = true

  const provider: TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: Uri): Promise<string> {
      const params = new URLSearchParams(uri.query)
      const host = params.get('host') ?? ''
      const owner = params.get('owner') ?? ''
      const repo = params.get('repo') ?? ''
      const ref = params.get('ref') ?? ''
      // uri.path 形如 `/src/foo.ts`：去掉前导斜杠并 decode 还原原始路径。
      const filepath = decodeURIComponent(uri.path.replace(/^\//, ''))
      if (!host || !owner || !repo)
        return ''
      const token = await getToken(panel.context, host)
      if (!token)
        return ''
      return getRawFile({ host, owner, repo, token, filepath, ref })
    },
  }

  const disposable = workspace.registerTextDocumentContentProvider(SPX_GITEA_SCHEME, provider)
  panel.context.subscriptions.push(disposable)
}

/** 把改动文件的一侧（某 ref 下内容）编码成 spx-gitea 虚拟文档 uri。 */
function buildSideUri(opts: {
  host: string
  owner: string
  repo: string
  ref: string
  path: string
}): Uri {
  const query = new URLSearchParams({
    host: opts.host,
    owner: opts.owner,
    repo: opts.repo,
    ref: opts.ref,
  }).toString()
  return Uri.from({ scheme: SPX_GITEA_SCHEME, path: `/${opts.path}`, query })
}

/**
 * 用 VS Code 原生 diff 比较一个文件在 parentSha → sha 之间的改动。
 *
 * 左侧 = parentSha 下内容，右侧 = sha 下内容。根提交无 parentSha 时左侧 ref 给
 * 空串，raw 取不到（404）→ 空内容，自然呈现全新增。删除文件右侧在 sha 下 404
 * → 空，呈现删除。
 */
export async function handleOpenPrCommitDiff(
  panel: KanbanWebviewPanel,
  args: { issueNumber: number, sha: string, parentSha?: string, path: string, status: string },
): Promise<void> {
  try {
    const ctx = await resolveRepoContext(panel)
    if (!ctx) {
      void window.showWarningMessage('当前工作区没有 Gitea 仓库或未配置 token')
      return
    }
    ensureContentProvider(panel)

    const leftUri = buildSideUri({
      host: ctx.host,
      owner: ctx.owner,
      repo: ctx.repo,
      ref: args.parentSha ?? '',
      path: args.path,
    })
    const rightUri = buildSideUri({
      host: ctx.host,
      owner: ctx.owner,
      repo: ctx.repo,
      ref: args.sha,
      path: args.path,
    })
    const title = `${args.path} (${(args.parentSha ?? '∅').slice(0, 7)} ↔ ${args.sha.slice(0, 7)})`
    await commands.executeCommand('vscode.diff', leftUri, rightUri, title)
  }
  catch (err) {
    void window.showErrorMessage(`打开 diff 失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
