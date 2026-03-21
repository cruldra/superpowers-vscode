import type { SuperpowersData } from '../types'
import * as vscode from 'vscode'
import { getSuperpowersPanelHtmlContent } from './html'

export class SuperpowersPanel {
  public static currentPanel: SuperpowersPanel | undefined
  private readonly _panel: vscode.WebviewPanel
  private readonly _extensionUri: vscode.Uri
  private _disposables: vscode.Disposable[] = []

  public static createOrShow(extensionUri: vscode.Uri): SuperpowersPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined

    if (SuperpowersPanel.currentPanel) {
      SuperpowersPanel.currentPanel._panel.reveal(column)
      return SuperpowersPanel.currentPanel
    }

    const panel = vscode.window.createWebviewPanel(
      'superpowersExplorer',
      'Superpowers Explorer',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    )

    SuperpowersPanel.currentPanel = new SuperpowersPanel(panel, extensionUri)
    return SuperpowersPanel.currentPanel
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel
    this._extensionUri = extensionUri

    this._panel.webview.html = getSuperpowersPanelHtmlContent()

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables,
    )
  }

  public updateData(data: SuperpowersData): void {
    this._panel.webview.postMessage({ type: 'updateData', data })
  }

  private _handleMessage(message: any): void {
    switch (message.command) {
      case 'openFile':
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path))
        break
      case 'markPlanNeedsTesting':
        vscode.commands.executeCommand('superpowers.markPlanNeedsTesting', message.path)
        break
      case 'completePlan':
        vscode.commands.executeCommand('superpowers.completePlan', message.path)
        break
      case 'setPlanStatus':
        vscode.commands.executeCommand('superpowers.setPlanStatus', message.path, message.status)
        break
      case 'refresh':
        vscode.commands.executeCommand('superpowers.refresh')
        break
    }
  }

  public dispose(): void {
    SuperpowersPanel.currentPanel = undefined

    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
