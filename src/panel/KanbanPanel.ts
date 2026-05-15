import type {
  CancellationToken,
  ExtensionContext,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
} from 'vscode'
import type { Task } from '../types'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Uri, ViewColumn, window, workspace } from 'vscode'
import { scanTasks } from '../scanner'

export class KanbanPanelProvider implements WebviewViewProvider {
  static readonly viewType = 'superpowers.kanban'

  private view?: WebviewView

  constructor(private readonly context: ExtensionContext) {}

  async resolveWebviewView(
    view: WebviewView,
    _ctx: WebviewViewResolveContext,
    _token: CancellationToken,
  ): Promise<void> {
    this.view = view

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    }

    view.webview.html = this.buildHtml(view)

    view.webview.onDidReceiveMessage((msg: WebviewToExtension) => {
      this.handleMessage(msg).catch((err) => {
        window.showErrorMessage(`Superpowers: ${err}`)
      })
    })

    view.onDidDispose(() => {
      this.view = undefined
    })
  }

  async refresh(): Promise<void> {
    const tasks = await this.loadTasks()
    this.postMessage({ type: 'tasks/update', tasks })
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case 'tasks/request': {
        const tasks = await this.loadTasks()
        this.postMessage({ type: 'tasks/update', tasks })
        break
      }
      case 'task/open': {
        const doc = await workspace.openTextDocument(Uri.file(msg.path))
        await window.showTextDocument(doc, { viewColumn: ViewColumn.One, preview: false })
        break
      }
    }
  }

  private postMessage(msg: ExtensionToWebview): void {
    this.view?.webview.postMessage(msg)
  }

  private async loadTasks(): Promise<Task[]> {
    const folder = workspace.workspaceFolders?.[0]
    if (!folder)
      return []
    return scanTasks(folder.uri.fsPath)
  }

  private buildHtml(view: WebviewView): string {
    const distRoot = Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui')
    const indexPath = path.join(distRoot.fsPath, 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')

    const nonce = makeNonce()
    const cspSource = view.webview.cspSource

    // 重写 src 和 href 的相对路径为 webview URI
    html = html.replace(/(src|href)="(\/[^"]+|\.\/[^"]+|[^"/][^"]*)"/g, (_m, attr, p) => {
      const cleaned = p.replace(/^\.?\//, '')
      const uri = view.webview.asWebviewUri(Uri.joinPath(distRoot, cleaned))
      return `${attr}="${uri}"`
    })

    // 给所有 <script> 标签注入 nonce
    html = html.replace(/<script(\s[^>]*)?>/g, (m, attrs) => {
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)]
  return out
}
