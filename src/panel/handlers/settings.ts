import type { ProfilesData } from '../../profiles/store'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { commands, env, Uri, workspace } from 'vscode'
import { getToken, setToken } from '../../auth/secrets'
import { listClaudeProfiles } from '../../cc/profiles'
import { detectRepo } from '../../git/remote'
import { logger } from '../../logging/logger'
import { readProfiles, writeProfiles } from '../../profiles/store'
import { getSettings, saveSettings } from '../../settings/store'
import { webhookCoordinator } from '../../webhook/coordinator'
import { makeNonce } from '../KanbanPanel'

export async function handleSettingsSave(panel: KanbanWebviewPanel, payload: {
  host: string
  token: string
  webhookPort: number
  brainstormPrompt: string
  implementPlanPrompt: string
  autoReview: boolean
  reviewPrompt: string
  devBranch: string
  autoBuildBranch: string
  worktreePostCreateScript: string
  worktreePreRemoveScript: string
  implTabPreCreateScript: string
  implTabPostCloseScript: string
  implementProfilePath: string
}): Promise<void> {
  const trimmedHost = payload.host.trim()
  const trimmedToken = payload.token.trim()
  const trimmedDevBranch = payload.devBranch.trim()
  const trimmedAutoBuildBranch = payload.autoBuildBranch.trim()
  // Hook script paths: keep '' meaningful (= "use default
  // .spx/*.sh"). Just strip whitespace.
  const trimmedPostCreate = payload.worktreePostCreateScript.trim()
  const trimmedPreRemove = payload.worktreePreRemoveScript.trim()
  const trimmedImplPre = payload.implTabPreCreateScript.trim()
  const trimmedImplPost = payload.implTabPostCloseScript.trim()
  // implementProfilePath: '' is meaningful (= "fall back to per-issue
  // profilePath then DEFAULT_PROFILE_PATH"). Just strip whitespace so a
  // stray space can't make the resolver think it's set.
  const trimmedImplProfile = payload.implementProfilePath.trim()
  const prev = getSettings(panel.context)
  // Capture the previous token *for this host* before overwriting it, so
  // we can decide below whether the kanban needs a re-fetch. (Only host
  // and token affect the issue list — port/url-prefix/prompts don't.)
  const oldToken = trimmedHost ? await getToken(panel.context, trimmedHost) : undefined
  // Empty token + existing saved token = user wants to keep the existing
  // one (placeholder semantics in the modal). Skip rewriting and skip the
  // kanban refresh since auth didn't change.
  const keepExisting = trimmedToken === '' && !!oldToken
  if (!trimmedHost || (!trimmedToken && !keepExisting)) {
    panel.postMessage({
      type: 'settings/show',
      host: trimmedHost,
      errorMessage: 'Host 和 Token 都不能为空',
      tokenSaved: !!oldToken,
      webhookPort: payload.webhookPort,
      brainstormPrompt: payload.brainstormPrompt || prev.brainstormPrompt,
      implementPlanPrompt: payload.implementPlanPrompt || prev.implementPlanPrompt,
      autoReview: payload.autoReview,
      reviewPrompt: payload.reviewPrompt || prev.reviewPrompt,
      devBranch: trimmedDevBranch || prev.devBranch,
      autoBuildBranch: trimmedAutoBuildBranch,
      worktreePostCreateScript: trimmedPostCreate,
      worktreePreRemoveScript: trimmedPreRemove,
      implTabPreCreateScript: trimmedImplPre,
      implTabPostCloseScript: trimmedImplPost,
      implementProfilePath: trimmedImplProfile,
    })
    return
  }
  await saveSettings(panel.context, {
    webhookPort: payload.webhookPort,
    brainstormPrompt: payload.brainstormPrompt,
    implementPlanPrompt: payload.implementPlanPrompt,
    autoReview: payload.autoReview,
    reviewPrompt: payload.reviewPrompt,
    // Persist trimmed values; '' is meaningful for autoBuildBranch
    // ("follow devBranch"), so don't coerce — getSettings handles the
    // fallback at read time.
    devBranch: trimmedDevBranch,
    autoBuildBranch: trimmedAutoBuildBranch,
    worktreePostCreateScript: trimmedPostCreate,
    worktreePreRemoveScript: trimmedPreRemove,
    implTabPreCreateScript: trimmedImplPre,
    implTabPostCloseScript: trimmedImplPost,
    implementProfilePath: trimmedImplProfile,
  })
  if (!keepExisting)
    await setToken(panel.context, trimmedHost, trimmedToken)
  // Honor a port change without requiring a window reload. Restart the
  // listener and emit a log entry when the port actually changed so the
  // user can see it in the log modal.
  const newPort = getSettings(panel.context).webhookPort
  if (newPort !== prev.webhookPort) {
    logger.add({
      level: 'info',
      source: 'webhook',
      message: `端口配置变更，重启监听 :${newPort}`,
    })
  }
  try {
    await webhookCoordinator.ensurePort(newPort)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'warn',
      source: 'webhook',
      message: 'ensurePort 失败',
      details: message,
    })
  }
  // Only re-fetch issues when the credential that gates the kanban
  // actually changed. Saves a round-trip + visible loading flash when the
  // user just tweaked prompts or webhook settings. `keepExisting` already
  // guarantees no auth change.
  if (!keepExisting && oldToken !== trimmedToken)
    await panel.loadAndPush()
  // Branch-sync inputs may have changed — refresh the toolbar button.
  void panel.handleBranchSyncCheck()
}

export async function handleEditSettingsRequest(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  let host = ''
  if (workspaceRoot) {
    const remote = await detectRepo(workspaceRoot)
    if (remote)
      host = remote.host
  }
  const s = getSettings(panel.context)
  const tok = host ? await getToken(panel.context, host) : undefined
  const tokenSaved = !!tok && tok.length > 0
  // User clicked the gear themselves — let them back out without saving.
  panel.postMessage({
    type: 'settings/show',
    host,
    canCancel: true,
    tokenSaved,
    webhookPort: s.webhookPort,
    brainstormPrompt: s.brainstormPrompt,
    implementPlanPrompt: s.implementPlanPrompt,
    autoReview: s.autoReview,
    reviewPrompt: s.reviewPrompt,
    devBranch: s.devBranch,
    autoBuildBranch: s.autoBuildBranch,
    worktreePostCreateScript: s.worktreePostCreateScript,
    worktreePreRemoveScript: s.worktreePreRemoveScript,
    implTabPreCreateScript: s.implTabPreCreateScript,
    implTabPostCloseScript: s.implTabPostCloseScript,
    implementProfilePath: s.implementProfilePath,
  })
}

/** Forces the open panel (if any) into the setup-auth state. */
export function requestEditAuth(panel: KanbanWebviewPanel): void {
  void handleEditSettingsRequest(panel)
}

/**
 * 工作区 profile 表读取入口：webview mount 时 / 切换到 Profile tab 时拉数据。
 * 文件不存在直接返回默认结构 `{ profiles: ['dev', 'prod'], rows: [] }`，
 * 不会物理创建文件。
 */
export async function handleProfilesGet(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先打开一个工作区文件夹',
      dismissOnTimer: 5000,
    })
    return
  }
  try {
    const data = await readProfiles(workspaceRoot)
    panel.postMessage({ type: 'profiles/show', data })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `读取 profiles.json 失败: ${message}`,
      dismissOnTimer: 6000,
    })
  }
}

/**
 * Read profiles from the hardcoded directory and push the list to the
 * webview. Failures are swallowed and surfaced as an empty list so the
 * modal simply hides its profile selector.
 */
export async function handleProfilesList(panel: KanbanWebviewPanel): Promise<void> {
  try {
    const profiles = await listClaudeProfiles()
    panel.postMessage({ type: 'profiles/update', profiles })
  }
  catch {
    panel.postMessage({ type: 'profiles/update', profiles: [] })
  }
}

/**
 * 智能打开 profile 单元格里的 value。
 *
 * - http(s):// / git@host:owner/repo → 外部浏览器（git@ 先转 https）
 * - 其他 → 当作路径处理，`~` 展开为 home，相对路径以 workspaceRoot 为基
 *   - 是目录 → revealFileInOS
 *   - 是文件 → vscode.open
 *   - 不存在 → toast 报错
 */
export async function handleProfilesOpen(panel: KanbanWebviewPanel, value: string): Promise<void> {
  const trimmed = value.trim()
  if (!trimmed) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '无法打开：值为空',
      dismissOnTimer: 5000,
    })
    return
  }

  // URL 分支：http(s) 直开；git@ 先转 https
  if (/^(?:https?:\/\/|git@)/i.test(trimmed)) {
    let url = trimmed
    const gitSshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(trimmed)
    if (gitSshMatch) {
      const host = gitSshMatch[1]
      const repoPath = gitSshMatch[2].replace(/\.git$/i, '')
      url = `https://${host}/${repoPath}`
    }
    else if (/^https?:\/\//i.test(trimmed)) {
      url = trimmed.replace(/\.git$/i, '')
    }
    try {
      await env.openExternal(Uri.parse(url))
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      panel.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `打开链接失败: ${message}`,
        dismissOnTimer: 6000,
      })
    }
    return
  }

  // 路径分支：~ 展开、相对路径补 workspaceRoot
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  let abs: string
  if (trimmed.startsWith('~')) {
    abs = path.join(os.homedir(), trimmed.slice(1))
  }
  else if (path.isAbsolute(trimmed)) {
    abs = trimmed
  }
  else {
    if (!workspaceRoot) {
      panel.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '无法解析相对路径：未打开工作区',
        dismissOnTimer: 5000,
      })
      return
    }
    abs = path.join(workspaceRoot, trimmed)
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  }
  catch {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `无法打开：路径不存在 / 不是 URL（${abs}）`,
      dismissOnTimer: 6000,
    })
    return
  }

  try {
    if (stat.isDirectory()) {
      await commands.executeCommand('revealFileInOS', Uri.file(abs))
    }
    else if (stat.isFile()) {
      await commands.executeCommand('vscode.open', Uri.file(abs))
    }
    else {
      panel.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `无法打开：既不是文件也不是目录（${abs}）`,
        dismissOnTimer: 6000,
      })
    }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `打开失败: ${message}`,
      dismissOnTimer: 6000,
    })
  }
}

/**
 * 工作区 profile 表写入入口。webview 已经 optimistic 更新，
 * 成功不回消息；失败弹 toast。
 */
export async function handleProfilesSave(panel: KanbanWebviewPanel, data: ProfilesData): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先打开一个工作区文件夹',
      dismissOnTimer: 5000,
    })
    return
  }
  try {
    await writeProfiles(workspaceRoot, data)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `写入 profiles.json 失败: ${message}`,
      dismissOnTimer: 6000,
    })
  }
}
