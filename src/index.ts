import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { defineExtension } from 'reactive-vscode'
import * as vscode from 'vscode'
import { resolveExtensionUri } from './extensionRuntime'
import { extensionId } from './generated/meta'
import { shouldAutoOpenPanel } from './panelOpenInteraction'
import { markPlanContentAsCompleted, markPlanContentAsNeedsTesting, setPlanContentStatus } from './planCompletion'
import { buildRunPlanCommand, buildRunPlanUnitName, DEFAULT_RUN_AGENT, DEFAULT_RUN_MESSAGE_TEMPLATE, DEFAULT_RUN_MODEL } from './runPlan'
import { SuperpowersScanner } from './scanner'
import { SuperpowersTreeDataProvider } from './treeView'
import type { PlanFile, PlanTaskStatus, SuperpowersData } from './types'
import { buildEnsureWorktreeCommands, buildFeatureBranchName, buildWorktreePath, DEFAULT_WORKTREE_DIRECTORY_TEMPLATE, getFeatureNameFromBranchName, getProjectName } from './worktree'
import { SuperpowersPanel } from './webview/panel'

const execAsync = promisify(exec)
const TASK_STATUS_POLL_INTERVAL = 30_000

export interface PlanTaskRecord {
  planPath: string
  unitName: string
  taskStatus: PlanTaskStatus
}

export interface CreatePlanTaskRecordOptions {
  planPath: string
  workspaceRoot: string
}

export interface StartPlanTaskOptions extends CreatePlanTaskRecordOptions {
  command: string
  execCommand: (command: string, options: { cwd: string }) => Promise<{ stdout: string, stderr: string }>
}

export function createPlanTaskRecord(options: CreatePlanTaskRecordOptions): PlanTaskRecord {
  return {
    planPath: options.planPath,
    unitName: getPlanTaskUnitName(options),
    taskStatus: 'running',
  }
}

export function upsertPlanTaskRecord(records: PlanTaskRecord[], nextRecord: PlanTaskRecord): PlanTaskRecord[] {
  const nextRecords = records.filter(record => record.planPath !== nextRecord.planPath)
  nextRecords.push(nextRecord)
  return nextRecords
}

export function mergePlanTaskStatus(plans: PlanFile[], records: PlanTaskRecord[]): PlanFile[] {
  return plans.map((plan) => {
    const taskRecord = records.find(record => record.planPath === plan.path)
    return taskRecord ? { ...plan, taskStatus: taskRecord.taskStatus } : plan
  })
}

export function resolveTaskStatusFromSystemctlStatus(output: string, previousStatus?: PlanTaskStatus): PlanTaskStatus | undefined {
  if (output.includes('Active: active'))
    return 'running'

  const hasSuccessExit = output.includes('inactive (dead)') && (output.includes('status=0/SUCCESS') || output.includes('code=exited, status=0'))
  if (hasSuccessExit)
    return 'completed'

  const hasMissingUnit = output.includes('could not be found')
  if (hasMissingUnit && previousStatus === 'running')
    return 'completed'

  const hasFailure = output.includes('failed')
    || output.includes('Result: signal')
    || output.includes('code=killed')
    || /status=[1-9]\d*(?:\/|\))/.test(output)
  if (hasFailure)
    return 'failed'

  return previousStatus
}

export function getPlanTaskViewState(taskStatus?: PlanTaskStatus): 'running' | 'rerunnable' {
  return taskStatus === 'running' ? 'running' : 'rerunnable'
}

function getPlanTaskUnitName(options: CreatePlanTaskRecordOptions): string {
  return buildRunPlanUnitName({
    planPath: options.planPath,
    workspaceRoot: options.workspaceRoot,
  })
}

export async function startPlanTask(options: StartPlanTaskOptions): Promise<PlanTaskRecord> {
  const unitName = getPlanTaskUnitName(options)

  try {
    await options.execCommand(`systemctl --user reset-failed ${unitName}`, { cwd: options.workspaceRoot })
  }
  catch {
  }

  await options.execCommand(options.command, { cwd: options.workspaceRoot })

  return {
    planPath: options.planPath,
    unitName,
    taskStatus: 'running',
  }
}

export function mergePolledPlanTaskRecords(currentRecords: PlanTaskRecord[], polledRecords: PlanTaskRecord[]): PlanTaskRecord[] {
  const nextRecords = [...currentRecords]

  for (const polledRecord of polledRecords) {
    const index = nextRecords.findIndex(record => record.planPath === polledRecord.planPath)
    if (index >= 0)
      nextRecords[index] = polledRecord
  }

  return nextRecords
}

async function collectPanelData(scanner: SuperpowersScanner, workspaceRoot: string, planTaskRecords: PlanTaskRecord[]): Promise<SuperpowersData> {
  const data = await scanner.scan(workspaceRoot)
  return {
    ...data,
    plans: mergePlanTaskStatus(data.plans, planTaskRecords),
  }
}

async function refreshPanelData(scanner: SuperpowersScanner, workspaceRoot: string, planTaskRecords: PlanTaskRecord[]): Promise<void> {
  const data = await collectPanelData(scanner, workspaceRoot, planTaskRecords)
  if (SuperpowersPanel.currentPanel) {
    SuperpowersPanel.currentPanel.updateData(data)
  }
}

async function pollRunningPlanTasks(planTaskRecords: PlanTaskRecord[]): Promise<PlanTaskRecord[]> {
  const polledRecords = [...planTaskRecords]

  for (const [index, record] of planTaskRecords.entries()) {
    if (record.taskStatus !== 'running')
      continue

    try {
      const { stdout, stderr } = await execAsync(`systemctl --user status ${shellEscapeForDoubleQuotes(record.unitName)}`)
      const nextStatus = resolveTaskStatusFromSystemctlStatus(`${stdout}\n${stderr}`, record.taskStatus)
      if (nextStatus && nextStatus !== record.taskStatus) {
        polledRecords[index] = {
          ...record,
          taskStatus: nextStatus,
        }
      }
    }
    catch (error) {
      const commandError = error as { stdout?: string, stderr?: string }
      const nextStatus = resolveTaskStatusFromSystemctlStatus(`${commandError.stdout || ''}\n${commandError.stderr || ''}`, record.taskStatus)
      if (nextStatus && nextStatus !== record.taskStatus) {
        polledRecords[index] = {
          ...record,
          taskStatus: nextStatus,
        }
      }
    }
  }

  return polledRecords
}

function didPlanTaskRecordsChange(previousRecords: PlanTaskRecord[], nextRecords: PlanTaskRecord[]): boolean {
  if (previousRecords.length !== nextRecords.length)
    return true

  return previousRecords.some((record, index) => {
    const nextRecord = nextRecords[index]
    return !nextRecord || nextRecord.planPath !== record.planPath || nextRecord.unitName !== record.unitName || nextRecord.taskStatus !== record.taskStatus
  })
}

function shellEscapeForDoubleQuotes(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

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
  let planTaskRecords: PlanTaskRecord[] = []
  let pollTimer: NodeJS.Timeout | undefined
  let isPollingPlanTasks = false

  const openPanel = async (): Promise<void> => {
    const panel = SuperpowersPanel.createOrShow(extensionUri)

    // 扫描并更新数据
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {
      const data = await collectPanelData(scanner, workspaceFolders[0].uri.fsPath, planTaskRecords)
      panel.updateData(data)
    }
  }

  const ensureTaskStatusPoller = (): void => {
    if (pollTimer)
      return

    pollTimer = setInterval(async () => {
      if (isPollingPlanTasks)
        return

      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders || workspaceFolders.length === 0)
        return

      isPollingPlanTasks = true
      try {
        const currentRecords = planTaskRecords
        const polledRecords = await pollRunningPlanTasks(currentRecords)
        const nextRecords = mergePolledPlanTaskRecords(planTaskRecords, polledRecords)
        if (didPlanTaskRecordsChange(planTaskRecords, nextRecords)) {
          planTaskRecords = nextRecords
          await refreshPanelData(scanner, workspaceFolders[0].uri.fsPath, planTaskRecords)
        }
      }
      finally {
        isPollingPlanTasks = false
      }
    }, TASK_STATUS_POLL_INTERVAL)
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
      const data = await collectPanelData(scanner, workspaceFolders[0].uri.fsPath, planTaskRecords)
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
    const branchName = buildFeatureBranchName(path.basename(planPath))
    const featureName = getFeatureNameFromBranchName(branchName)
    const worktreePath = buildWorktreePath({
      workspaceRoot,
      projectName: getProjectName(workspaceRoot),
      featureName,
      template: worktreeDirectoryTemplate,
    })
    const runCommand = buildRunPlanCommand({
      planPath,
      workspaceRoot,
      worktreePath,
      messageTemplate,
      model,
      agent,
    })
    const command = buildEnsureWorktreeCommands({
      workspaceRoot,
      branchName,
      worktreePath,
      runCommand,
    })
    try {
      const taskRecord = await startPlanTask({
        command,
        planPath,
        workspaceRoot,
        execCommand: (nextCommand, options) => execAsync(nextCommand, options),
      })
      planTaskRecords = upsertPlanTaskRecord(planTaskRecords, taskRecord)
      ensureTaskStatusPoller()
      await refreshPanelData(scanner, workspaceRoot, planTaskRecords)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await vscode.window.showErrorMessage(`启动 Plan 失败: ${message}`)
    }
  })

  // TreeView 点击事件
  vscode.commands.registerCommand('superpowers.root', () => {
    vscode.commands.executeCommand('superpowers.openPanel')
  })

  return {
    dispose() {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    },
  }
})
