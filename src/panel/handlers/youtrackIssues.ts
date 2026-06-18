/**
 * Panel handlers for YouTrack-sourced cards.
 *
 * Kept separate from the gitea `issues.ts` handlers: these route workflow-state
 * writes to the issue's YouTrack comment (see `youtrack/stateComment.ts`) and
 * resolve the issue in YouTrack when its card lands in the 完成 column — the
 * only write-back the user asked for.
 */

import type { IssueColumn } from '../../gitea/types'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import type { YouTrackAuth } from '../../youtrack/api'
import { ThemeIcon, window, workspace } from 'vscode'
import { getYouTrackToken } from '../../auth/secrets'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { applyCommand, listIssues, listProjects, resolvedStateCommand } from '../../youtrack/api'
import { readImportedIds, writeImportedIds } from '../../youtrack/importStore'
import { youtrackHost } from '../../youtrack/issueLoader'
import { mergeStateComment } from '../../youtrack/stateComment'
import { makeNonce } from '../KanbanPanel'

function toast(panel: KanbanWebviewPanel, level: 'info' | 'success' | 'error', message: string): void {
  panel.postMessage({ type: 'toast/show', id: makeNonce(), level, message, dismissOnTimer: 6000 })
}

/** Resolve {baseUrl, token} from settings + SecretStorage, or null if YouTrack
 * isn't fully configured. */
async function resolveAuth(panel: KanbanWebviewPanel): Promise<YouTrackAuth | null> {
  const baseUrl = getSettings(panel.context).youtrackBaseUrl.trim()
  if (!baseUrl)
    return null
  const token = await getYouTrackToken(panel.context, youtrackHost(baseUrl))
  if (!token)
    return null
  return { baseUrl, token }
}

/**
 * Persist a column move for a YouTrack card, and resolve the issue in YouTrack
 * when it moves to 完成. Re-pulls the board afterwards rather than threading a
 * source-aware optimistic patch — correctness over precision for v1.
 */
export async function handleYouTrackColumnChange(panel: KanbanWebviewPanel, externalId: string, toColumn: IssueColumn): Promise<void> {
  const auth = await resolveAuth(panel)
  if (!auth) {
    toast(panel, 'error', '请先在设置里配置 YouTrack（Base URL + Token）')
    await panel.loadAndPush()
    return
  }
  try {
    await mergeStateComment(auth, externalId, { column: toColumn })
    if (toColumn === 'done')
      await closeYouTrackIssue(panel, auth, externalId)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({ level: 'error', source: 'youtrack', message: `${externalId} 列变更失败`, details: message })
    toast(panel, 'error', `YouTrack 更新失败：${message}`)
  }
  await panel.loadAndPush()
}

/** Resolve the issue in YouTrack. Uses the configured close command, else
 * auto-detects the project's `isResolved` state value. */
async function closeYouTrackIssue(panel: KanbanWebviewPanel, auth: YouTrackAuth, externalId: string): Promise<void> {
  const configured = getSettings(panel.context).youtrackCloseCommand.trim()
  const command = configured || (await resolvedStateCommand(auth, externalId))
  if (!command) {
    logger.add({ level: 'warn', source: 'youtrack', message: `${externalId} 无法确定关闭命令（未配置 youtrackCloseCommand 且未找到已解决状态值）` })
    toast(panel, 'info', `${externalId} 已移到完成，但未能自动关闭 YouTrack（请在设置里填「关闭命令」）`)
    return
  }
  await applyCommand(auth, externalId, command)
}

/** Populate the settings project dropdown from the in-form base URL + token
 * (lets the user pick a project before saving). */
export async function handleListProjects(panel: KanbanWebviewPanel, baseUrl: string, token: string): Promise<void> {
  const trimmedBase = baseUrl.trim()
  const trimmedToken = token.trim()
  if (!trimmedBase || !trimmedToken) {
    panel.postMessage({ type: 'youtrack/projects', projects: [], error: '请先填写 Base URL 和 Token' })
    return
  }
  try {
    const projects = await listProjects({ baseUrl: trimmedBase, token: trimmedToken })
    panel.postMessage({ type: 'youtrack/projects', projects })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({ type: 'youtrack/projects', projects: [], error: message })
  }
}

/**
 * 用原生 QuickPick 多选框让用户挑选要导入哪些 YouTrack 工单。
 *
 * 候选默认只显示待办（未解决）工单，框内有过滤按钮可切到「全部」。已导入的项
 * 默认勾选，因此取消勾选 = 移除导入。被待办过滤隐藏掉的已导入项始终保留，避免
 * 误删。确认后写回 importStore 并刷新看板。
 */
export async function handleYouTrackImport(panel: KanbanWebviewPanel): Promise<void> {
  const settings = getSettings(panel.context)
  const baseUrl = settings.youtrackBaseUrl.trim()
  const project = settings.youtrackProjectShortName.trim()
  if (!baseUrl || !project) {
    void window.showWarningMessage('请先在设置里配置 YouTrack Base URL / 项目 / Token')
    return
  }
  const token = await getYouTrackToken(panel.context, youtrackHost(baseUrl))
  if (!token) {
    void window.showWarningMessage('请先在设置里配置 YouTrack Base URL / 项目 / Token')
    return
  }
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showWarningMessage('请先打开一个工作区文件夹')
    return
  }

  let all
  try {
    all = await listIssues({ baseUrl, token }, project)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({ level: 'error', source: 'youtrack', message: '拉取 YouTrack 工单失败', details: message })
    void window.showErrorMessage(`拉取 YouTrack 工单失败：${message}`)
    return
  }

  const imported = new Set(await readImportedIds(workspaceRoot, project))

  const qp = window.createQuickPick()
  qp.canSelectMany = true
  qp.title = 'YouTrack 导入'
  qp.placeholder = '空格勾选要导入的工单，回车确认'

  // label 直接用 idReadable（项目内唯一），后续增删按 label 比对。
  let todoOnly = true
  const buildItems = (): Array<{ label: string, description: string }> =>
    (todoOnly ? all.filter(i => i.resolved == null) : all)
      .map(i => ({ label: i.idReadable, description: i.summary }))

  const filterButton = (): { iconPath: ThemeIcon, tooltip: string } => ({
    iconPath: new ThemeIcon(todoOnly ? 'filter' : 'filter-filled'),
    tooltip: todoOnly ? '当前：仅待办 / 点击显示全部' : '当前：全部 / 点击仅待办',
  })

  qp.items = buildItems()
  qp.selectedItems = qp.items.filter(it => imported.has(it.label))
  qp.buttons = [filterButton()]

  qp.onDidTriggerButton(() => {
    todoOnly = !todoOnly
    const keep = new Set(qp.selectedItems.map(s => s.label))
    qp.items = buildItems()
    // 切换时保住已勾选项，外加把已导入项继续勾上。
    qp.selectedItems = qp.items.filter(it => keep.has(it.label) || imported.has(it.label))
    qp.buttons = [filterButton()]
  })

  qp.onDidAccept(async () => {
    const visibleIds = new Set(qp.items.map(i => i.label))
    const picked = new Set(qp.selectedItems.map(i => i.label))
    // 只在「当前可见」范围内增删；被待办过滤隐藏的已导入项原样保留。
    const next = [...imported].filter(id => !visibleIds.has(id))
    for (const id of visibleIds) {
      if (picked.has(id))
        next.push(id)
    }
    qp.hide()
    await writeImportedIds(workspaceRoot, project, [...new Set(next)])
    await panel.loadAndPush()
    void window.showInformationMessage(`已导入 ${picked.size} 个 YouTrack 工单`)
  })

  qp.onDidHide(() => qp.dispose())
  qp.show()
}
