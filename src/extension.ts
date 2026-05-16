import type {
  Event,
  ExtensionContext,
  TreeDataProvider,
  TreeItem,
} from 'vscode'
import { EventEmitter, commands, window } from 'vscode'
import { KanbanWebviewPanel } from './panel/KanbanPanel'

/**
 * 侧边栏 TreeView 永远没有 item —— 它存在的唯一目的是接住活动栏图标
 * 点击事件，触发"开 Kanban panel + 切回 File Explorer"的自动跳转。
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
  const treeView = window.createTreeView('superpowers.kanban', {
    treeDataProvider: new EmptyTreeProvider(),
    showCollapseAll: false,
  })

  let wasVisible = treeView.visible
  let isAutoOpening = false

  const autoOpenPanelFromActivityBar = async (): Promise<void> => {
    if (isAutoOpening)
      return
    isAutoOpening = true
    try {
      KanbanWebviewPanel.createOrShow(context)
      // 立刻把 sidebar 切回 File Explorer，让 superpowers 的空 sidebar 一闪而过
      try {
        await commands.executeCommand('workbench.view.explorer')
      }
      catch {
        // 不存在 explorer 视图时静默忽略
      }
    }
    finally {
      isAutoOpening = false
    }
  }

  treeView.onDidChangeVisibility(async (e) => {
    const isVisible = e.visible
    // 仅当从不可见变可见（即用户点击了活动栏图标）时触发
    if (isVisible && !wasVisible && !isAutoOpening)
      await autoOpenPanelFromActivityBar()
    wasVisible = isVisible
  })

  context.subscriptions.push(
    treeView,
    commands.registerCommand('superpowers.openKanban', () => {
      KanbanWebviewPanel.createOrShow(context)
    }),
    commands.registerCommand('superpowers.refresh', () => {
      KanbanWebviewPanel.refresh()
    }),
    commands.registerCommand('superpowers.setGiteaToken', () => {
      KanbanWebviewPanel.createOrShow(context)
      KanbanWebviewPanel.requestEditAuth()
    }),
  )
}

export function deactivate(): void {}
