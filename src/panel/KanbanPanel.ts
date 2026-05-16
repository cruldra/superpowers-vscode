import type {
  ExtensionContext,
  WebviewPanel,
} from 'vscode'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { env, Uri, ViewColumn, window, workspace } from 'vscode'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import { deleteToken, getToken, setToken } from '../auth/secrets'
import { createIssueViaClaude } from '../cc/createIssueFlow'
import { detectRepo } from '../git/remote'
import { GiteaApiError } from '../gitea/api'
import { loadIssues } from '../gitea/issueLoader'

export class KanbanWebviewPanel {
  static readonly viewType = 'superpowers.kanbanPanel'

  private static current: KanbanWebviewPanel | undefined

  private readonly panel: WebviewPanel
  private readonly disposables: { dispose: () => void }[] = []

  private constructor(private readonly context: ExtensionContext, panel: WebviewPanel) {
    this.panel = panel

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    }

    this.panel.webview.html = this.buildHtml()

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg: WebviewToExtension) => this.handleMessage(msg)),
    )
  }

  static createOrShow(context: ExtensionContext): void {
    if (KanbanWebviewPanel.current) {
      KanbanWebviewPanel.current.panel.reveal(ViewColumn.Active)
      return
    }
    const panel = window.createWebviewPanel(
      KanbanWebviewPanel.viewType,
      'Superpowers Kanban',
      ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          Uri.joinPath(context.extensionUri, 'dist', 'webview-ui'),
        ],
      },
    )
    KanbanWebviewPanel.current = new KanbanWebviewPanel(context, panel)
  }

  /** Triggers a fresh load on the currently open panel, if any. */
  static refresh(): void {
    KanbanWebviewPanel.current?.loadAndPush().catch(() => {})
  }

  private handleMessage(msg: WebviewToExtension): void {
    if (msg.type === 'issues/refresh') {
      void this.loadAndPush()
      return
    }
    if (msg.type === 'auth/save') {
      void this.handleAuthSave(msg.host, msg.token)
      return
    }
    if (msg.type === 'auth/edit-request') {
      void this.handleEditAuthRequest()
      return
    }
    if (msg.type === 'issue/create') {
      void this.handleIssueCreate(msg.userRequest, msg.images)
      return
    }
    if (msg.type === 'toast/open-url') {
      void env.openExternal(Uri.parse(msg.url))
    }
  }

  private async loadAndPush(): Promise<void> {
    this.postMessage({ type: 'issues/loading' })

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    // eslint-disable-next-line no-console
    console.log('[superpowers/panel] loadAndPush workspaceRoot=', workspaceRoot)
    if (!workspaceRoot) {
      this.postMessage({
        type: 'issues/error',
        message: '请先打开一个工作区文件夹',
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'issues/error',
        message: '当前工作区没有 Gitea 远程仓库',
      })
      return
    }

    const { host, owner, repo } = remote
    const token = await getToken(this.context, host)
    if (!token) {
      this.postMessage({ type: 'auth/required', host })
      return
    }

    try {
      const issues = await loadIssues({ host, token, owner, repo })
      this.postMessage({ type: 'issues/update', issues })
    }
    catch (err) {
      if (err instanceof GiteaApiError && err.status === 401) {
        await deleteToken(this.context, host)
        this.postMessage({
          type: 'auth/required',
          host,
          errorMessage: 'Token 无效或已过期，请重新填写',
        })
        return
      }
      const baseMessage = err instanceof Error ? err.message : String(err)
      const message = `${baseMessage}\n\n[debug] host=${host} owner=${owner} repo=${repo}`
      this.postMessage({ type: 'issues/error', message })
    }
  }

  private async handleAuthSave(host: string, token: string): Promise<void> {
    const trimmedHost = host.trim()
    const trimmedToken = token.trim()
    if (!trimmedHost || !trimmedToken) {
      this.postMessage({
        type: 'auth/required',
        host: trimmedHost,
        errorMessage: 'Host 和 Token 都不能为空',
      })
      return
    }
    await setToken(this.context, trimmedHost, trimmedToken)
    await this.loadAndPush()
  }

  private async handleEditAuthRequest(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    let host = ''
    if (workspaceRoot) {
      const remote = await detectRepo(workspaceRoot)
      if (remote)
        host = remote.host
    }
    // User clicked the gear themselves — let them back out without saving.
    this.postMessage({ type: 'auth/required', host, canCancel: true })
  }

  private async handleIssueCreate(
    userRequest: string,
    images?: Array<{ mediaType: string, base64: string }>,
  ): Promise<void> {
    const trimmed = userRequest.trim()
    if (!trimmed) {
      // Webview already disables the submit button when empty, but be defensive.
      return
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    // The webview emits `toast/show` with the same id twice — first an
    // info-level spinner toast, then a success/error toast — so the UI
    // updates in place rather than stacking two distinct cards.
    await createIssueViaClaude({
      ctx: this.context,
      workspaceRoot,
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      token,
      userRequest: trimmed,
      images,
      onProgress: (event) => {
        if (event.kind === 'started') {
          this.postMessage({
            type: 'toast/show',
            id: event.toastId,
            level: 'info',
            message: '正在创建工单…',
            spinner: true,
          })
          return
        }
        if (event.kind === 'success') {
          this.postMessage({
            type: 'toast/show',
            id: event.toastId,
            level: 'success',
            message: `#${event.issueNumber} 已创建`,
            link: { label: '查看', url: event.issueUrl },
            dismissOnTimer: 8000,
          })
          // Refresh kanban so the new card shows up in 待办.
          void this.loadAndPush()
          return
        }
        // failed
        this.postMessage({
          type: 'toast/show',
          id: event.toastId,
          level: 'error',
          message: event.message,
          dismissOnTimer: 10000,
        })
      },
    })
  }

  /** Forces the open panel (if any) into the setup-auth state. */
  static requestEditAuth(): void {
    void KanbanWebviewPanel.current?.handleEditAuthRequest()
  }

  private postMessage(msg: ExtensionToWebview): void {
    void this.panel.webview.postMessage(msg)
  }

  private dispose(): void {
    KanbanWebviewPanel.current = undefined
    while (this.disposables.length) {
      const d = this.disposables.pop()
      d?.dispose()
    }
    this.panel.dispose()
  }

  private buildHtml(): string {
    const distRoot = Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui')
    const indexPath = path.join(distRoot.fsPath, 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')

    const nonce = makeNonce()
    const cspSource = this.panel.webview.cspSource

    // 重写 src 和 href 的相对路径为 webview URI
    html = html.replace(/(src|href)="(\/[^"]+|\.\/[^"]+|[^"/][^"]*)"/g, (_m, attr, p) => {
      const cleaned = p.replace(/^\.?\//, '')
      const uri = this.panel.webview.asWebviewUri(Uri.joinPath(distRoot, cleaned))
      return `${attr}="${uri}"`
    })

    // 给所有 <script> 标签注入 nonce
    html = html.replace(/<script(\s[^>]*)?>/g, (_m, attrs) => {
      const a = attrs ?? ''
      return `<script nonce="${nonce}"${a}>`
    })

    // 注入 CSP
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`
    html = html.replace(
      /<head>/,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )

    return html
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64').replace(/[+/=]/g, '')
}
