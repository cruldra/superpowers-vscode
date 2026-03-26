import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineExtension } from 'reactive-vscode'
import * as vscode from 'vscode'
import { resolveExtensionUri } from './extensionRuntime'
import { extensionId } from './generated/meta'
import { shouldAutoOpenPanel } from './panelOpenInteraction'
import { markPlanContentAsCompleted, markPlanContentAsNeedsTesting, setPlanContentStatus } from './planCompletion'
import { buildRunPlanCommand, DEFAULT_RUN_AGENT, DEFAULT_RUN_MESSAGE_TEMPLATE, DEFAULT_RUN_MODEL } from './runPlan'
import { SuperpowersScanner } from './scanner'
import { SuperpowersTreeDataProvider } from './treeView'
import { buildEnsureWorktreeCommands, buildFeatureBranchName, buildWorktreePath, DEFAULT_WORKTREE_DIRECTORY_TEMPLATE, getFeatureNameFromBranchName, getProjectName } from './worktree'
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

  vscode.commands.registerCommand('superpowers.deleteFile', async (filePath?: string, type?: string) => {
    if (!filePath || !type)
      return

    // 解析文件名以查找对应的spec和plan
    const fileName = path.basename(filePath, '.md')
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0)
      return

    const workspaceRoot = workspaceFolders[0].uri.fsPath
    const specsDir = path.join(workspaceRoot, 'docs/superpowers/specs')
    const plansDir = path.join(workspaceRoot, 'docs/superpowers/plans')

    // 确认删除
    const confirm = await vscode.window.showWarningMessage(
      `确定要删除 ${type === 'spec' ? 'Spec' : 'Plan'} "${fileName}" 及其关联文件吗？`,
      '删除',
      '取消',
    )

    if (confirm !== '删除')
      return

    // 删除spec和plan
    const specPath = path.join(specsDir, `${fileName}.md`)
    const planPath = path.join(plansDir, `${fileName}.md`)

    if (fs.existsSync(specPath)) {
      fs.unlinkSync(specPath)
    }
    if (fs.existsSync(planPath)) {
      fs.unlinkSync(planPath)
    }

    await vscode.commands.executeCommand('superpowers.refresh')
  })

  vscode.commands.registerCommand('superpowers.runPlan', async (planPath?: string) => {
    if (!planPath)
      return

    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
      await vscode.window.showErrorMessage('运行 Plan 需要先打开一个工作区')
      return
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath
    const runConfig = vscode.workspace.getConfiguration('superpowers')
    const messageTemplate = runConfig.get<string>('runMessage', DEFAULT_RUN_MESSAGE_TEMPLATE)
    const model = runConfig.get<string>('runModel', DEFAULT_RUN_MODEL)
    const agent = runConfig.get<string>('runAgent', DEFAULT_RUN_AGENT)
    const worktreeDirectoryTemplate = runConfig.get<string>('worktreeDirectory', DEFAULT_WORKTREE_DIRECTORY_TEMPLATE)
    const runCommand = buildRunPlanCommand({
      planPath,
      workspaceRoot,
      messageTemplate,
      model,
      agent,
    })
    const branchName = buildFeatureBranchName(path.basename(planPath))
    const featureName = getFeatureNameFromBranchName(branchName)
    const worktreePath = buildWorktreePath({
      workspaceRoot,
      projectName: getProjectName(workspaceRoot),
      featureName,
      template: worktreeDirectoryTemplate,
    })
    const command = buildEnsureWorktreeCommands({
      branchName,
      worktreePath,
      runCommand,
    })

    // 新开终端先创建 worktree，再进入隔离目录执行命令。
    const terminal = vscode.window.createTerminal({
      name: `Superpowers Run: ${path.basename(planPath)}`,
      cwd: workspaceRoot,
    })
    terminal.show(true)
    terminal.sendText(command, true)
  })

  // TreeView 点击事件
  vscode.commands.registerCommand('superpowers.root', () => {
    vscode.commands.executeCommand('superpowers.openPanel')
  })
})
