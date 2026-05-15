import type { ExtensionContext } from 'vscode'
import { commands, window, workspace } from 'vscode'
import { KanbanPanelProvider } from './panel/KanbanPanel'

let provider: KanbanPanelProvider | undefined

export function activate(context: ExtensionContext): void {
  provider = new KanbanPanelProvider(context)

  context.subscriptions.push(
    window.registerWebviewViewProvider(KanbanPanelProvider.viewType, provider),
    commands.registerCommand('superpowers.refresh', () => provider?.refresh()),
  )

  // 监听 specs/plans 文件变化，自动刷新
  const watcher = workspace.createFileSystemWatcher(
    '**/docs/superpowers/{specs,plans}/*.md',
  )
  const onChange = (): void => {
    provider?.refresh()
  }
  watcher.onDidCreate(onChange)
  watcher.onDidChange(onChange)
  watcher.onDidDelete(onChange)
  context.subscriptions.push(watcher)
}

export function deactivate(): void {
  provider = undefined
}
