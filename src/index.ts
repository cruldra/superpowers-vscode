import * as fs from 'node:fs'
import { defineExtension } from 'reactive-vscode'
import * as vscode from 'vscode'
import { resolveExtensionUri } from './extensionRuntime'
import { extensionId } from './generated/meta'
import { shouldAutoOpenPanel } from './panelOpenInteraction'
import { markPlanContentAsCompleted, markPlanContentAsNeedsTesting, setPlanContentStatus } from './planCompletion'
import { SuperpowersScanner } from './scanner'
import { SuperpowersTreeDataProvider } from './treeView'
import { SuperpowersPanel } from './webview/panel'

export const { activate, deactivate } = defineExtension(() => {
  const scanner = new SuperpowersScanner()
  const treeDataProvider = new SuperpowersTreeDataProvider()
  const extensionUri = resolveExtensionUri({
    extensionId,
    getExtension: id => vscode.extensions.getExtension(id),
  })
  let isAutoOpeningPanel = false

  // 注册 TreeView
  const treeView = vscode.window.createTreeView('superpowers-explorer', {
    treeDataProvider,
    showCollapseAll: false,
  })
  let wasTreeViewVisible = treeView.visible

  const openPanel = async (): Promise<void> => {
    const panel = SuperpowersPanel.createOrShow(extensionUri)

    // 扫描并更新数据
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const data = await scanner.scan(workspaceFolders[0].uri.fsPath)
      panel.updateData(data)
    }
  }

  const openPanelFromActivityBar = async (): Promise<void> => {
    if (isAutoOpeningPanel)
      return

    isAutoOpeningPanel = true
    try {
      await openPanel()
      try {
        await vscode.commands.executeCommand('workbench.view.explorer')
      }
      catch (error) {
        console.debug('切回 File Explorer 失败', error)
      }
    }
    finally {
      isAutoOpeningPanel = false
    }
  }

  treeView.onDidChangeVisibility(async () => {
    const isVisible = treeView.visible
    const shouldAutoOpen = shouldAutoOpenPanel({
      isVisible,
      wasVisible: wasTreeViewVisible,
      isAutoOpeningPanel,
    })
    wasTreeViewVisible = isVisible

    if (!shouldAutoOpen)
      return

    await openPanelFromActivityBar()
  })

  // 注册命令
  vscode.commands.registerCommand('superpowers.openPanel', async () => {
    await openPanel()
  })

  vscode.commands.registerCommand('superpowers.refresh', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const data = await scanner.scan(workspaceFolders[0].uri.fsPath)
      if (SuperpowersPanel.currentPanel) {
        SuperpowersPanel.currentPanel.updateData(data)
      }
    }
    treeDataProvider.refresh()
  })

  vscode.commands.registerCommand('superpowers.completePlan', async (planPath?: string) => {
    if (!planPath)
      return

    const content = fs.readFileSync(planPath, 'utf-8')
    const updatedContent = markPlanContentAsCompleted(content)

    if (updatedContent === content)
      return

    fs.writeFileSync(planPath, updatedContent, 'utf-8')
    await vscode.commands.executeCommand('superpowers.refresh')
  })

  vscode.commands.registerCommand('superpowers.markPlanNeedsTesting', async (planPath?: string) => {
    if (!planPath)
      return

    const content = fs.readFileSync(planPath, 'utf-8')
    const updatedContent = markPlanContentAsNeedsTesting(content)

    if (updatedContent === content)
      return

    fs.writeFileSync(planPath, updatedContent, 'utf-8')
    await vscode.commands.executeCommand('superpowers.refresh')
  })

  vscode.commands.registerCommand('superpowers.setPlanStatus', async (planPath?: string, status?: string) => {
    if (!planPath || !status)
      return

    const validStatuses = ['completed', 'needsTesting', 'default']
    if (!validStatuses.includes(status))
      return

    const content = fs.readFileSync(planPath, 'utf-8')
    const updatedContent = setPlanContentStatus(content, status as 'completed' | 'needsTesting' | 'default')

    if (updatedContent === content)
      return

    fs.writeFileSync(planPath, updatedContent, 'utf-8')
    await vscode.commands.executeCommand('superpowers.refresh')
  })

  // TreeView 点击事件
  vscode.commands.registerCommand('superpowers.root', () => {
    vscode.commands.executeCommand('superpowers.openPanel')
  })
})
