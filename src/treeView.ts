import * as vscode from 'vscode'

export class SuperpowersTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (!element) {
      return Promise.resolve([
        new TreeItem('Superpowers', vscode.TreeItemCollapsibleState.None, 'superpowers.root'),
      ])
    }
    return Promise.resolve([])
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }
}

class TreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue?: string,
  ) {
    super(label, collapsibleState)
    this.iconPath = new vscode.ThemeIcon('rocket')
    this.tooltip = '点击打开 Superpowers Explorer'
    this.command = {
      command: 'superpowers.openPanel',
      title: 'Open Panel',
    }
  }
}
