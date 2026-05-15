import type {
  Event,
  ExtensionContext,
  TreeDataProvider,
  TreeItem,
} from 'vscode'
import { EventEmitter, commands, window, workspace } from 'vscode'
import { KanbanWebviewPanel } from './panel/KanbanPanel'

/**
 * 侧边栏 TreeView：永远没有 item，靠 package.json 的 viewsWelcome 渲染
 * "Open Kanban Board" 按钮。注册它的唯一目的是消除 "no data provider" 错误。
 */
class EmptyTreeProvider implements TreeDataProvider<never> {
  private readonly _onDidChangeTreeData = new EventEmitter<void>()
  readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event

  getTreeItem(): TreeItem {
    throw new Error('unreachable')
  }

  getChildren(): never[] {
    return []
  }
}

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    window.registerTreeDataProvider('superpowers.kanban', new EmptyTreeProvider()),
    commands.registerCommand('superpowers.openKanban', () => {
      KanbanWebviewPanel.createOrShow(context)
    }),
    commands.registerCommand('superpowers.refresh', () => {
      KanbanWebviewPanel.refresh()
    }),
  )

  // 监听 specs/plans 文件变化，自动刷新已打开的 panel
  const watcher = workspace.createFileSystemWatcher(
    '**/docs/superpowers/{specs,plans}/*.md',
  )
  const onChange = (): void => {
    KanbanWebviewPanel.refresh()
  }
  watcher.onDidCreate(onChange)
  watcher.onDidChange(onChange)
  watcher.onDidDelete(onChange)
  context.subscriptions.push(watcher)
}

export function deactivate(): void {}
