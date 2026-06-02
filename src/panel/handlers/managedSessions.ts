import type { KanbanWebviewPanel } from '../KanbanPanel'
import { promises as fsp } from 'node:fs'
import { window, workspace } from 'vscode'
import { projectsDirFor, watchForNewSession } from '../../cc/sessionWatcher'
import { logger } from '../../logging/logger'
import { readManagedSessions, writeManagedSessions } from '../../sessions/managedStore'
import { DEFAULT_PROFILE_PATH } from '../KanbanPanel'

/** 默认会话名：有 prompt 取前 20 字符，否则用短 id（前 8 位）。 */
function defaultSessionName(sessionId: string, prompt?: string): string {
  const trimmed = (prompt ?? '').trim()
  if (trimmed)
    return trimmed.slice(0, 20)
  return `会话 ${sessionId.slice(0, 8)}`
}

/**
 * 推送全量受管理会话列表给 webview。
 */
export async function handleManagedSessionsGet(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({ type: 'managed-sessions/show', data: { sessions: [] } })
    return
  }
  const data = await readManagedSessions(workspaceRoot)
  panel.postMessage({ type: 'managed-sessions/show', data })
}

/**
 * 从会话管理 tab 创建一个新的 cc 会话：
 *   - cwd 用项目根（workspaceRoot，非 worktree）。
 *   - 启动命令照搬头脑风暴风格（claude --dangerously-skip-permissions --settings
 *     '<profilePath>' --system-prompt="$(serena prompts ...)"），prompt 非空时
 *     再追加 ' <prompt>'。
 *   - 用 watchForNewSession 捕获新 sessionId，落进 .spx/session-names.json 后
 *     推全量列表。
 */
export async function handleManagedSessionsCreate(panel: KanbanWebviewPanel, profilePath: string, prompt?: string): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showErrorMessage('请先打开一个工作区文件夹')
    return
  }

  const effectiveProfilePath
    = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
  // 单引号会破坏下面的 shell 单引号包裹，防御性拒绝（与现有 handler 一致）。
  if (effectiveProfilePath.includes('\'')) {
    void window.showErrorMessage(
      `创建会话失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
    )
    return
  }

  const trimmedPrompt = (prompt ?? '').trim()
  if (trimmedPrompt.includes('\'')) {
    void window.showErrorMessage('创建会话失败：首个提示词含单引号，拒绝执行')
    return
  }

  // 项目根的 claude projects 子目录；先 mkdir 让 watcher 不会错过 create 事件。
  const projDir = projectsDirFor(workspaceRoot)
  try {
    await fsp.mkdir(projDir, { recursive: true })
  }
  catch (err) {
    console.warn('[superpowers] failed to mkdir claude projects dir:', err)
  }

  // 先起 watcher 再 sendText，避免与 rollout-*.jsonl 创建竞争。
  const watchPromise = watchForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

  // 友好的终端名，避免与 issue 终端 `issue-N-xxx` 命名冲突。
  const terminal = window.createTerminal({
    name: 'cc-会话',
    cwd: workspaceRoot,
    location: panel.resolveTerminalLocation(false),
  })
  terminal.show(false)
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已创建终端 "${terminal.name}"`,
  })

  let cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)"`
  if (trimmedPrompt)
    cmd += ` '${trimmedPrompt}'`
  terminal.sendText(cmd)
  logger.add({
    level: 'info',
    source: 'panel',
    message: '已从会话管理 tab 启动 cc 会话',
  })

  void window.showInformationMessage('已创建 cc 会话')

  // Fire-and-forget：会话 jsonl 出现后写进 store 并推全量列表。
  watchPromise.then(async (sid) => {
    if (!sid) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: '会话管理：cc 会话监听超时 (120s)',
      })
      return
    }
    logger.add({
      level: 'info',
      source: 'panel',
      message: `会话管理：已捕获 cc 会话 ${sid}`,
    })
    try {
      const data = await readManagedSessions(workspaceRoot)
      data.sessions.push({
        id: sid,
        name: defaultSessionName(sid, trimmedPrompt || undefined),
        profilePath: effectiveProfilePath,
        createdAt: Date.now(),
      })
      await writeManagedSessions(workspaceRoot, data)
      panel.postMessage({ type: 'managed-sessions/show', data })
    }
    catch (err) {
      console.warn('[superpowers] failed to persist managed session:', err)
    }
  }).catch((err) => {
    console.warn('[superpowers] managed session watch failed:', err)
  })
}

/**
 * 重命名一个受管理会话（仅改本地记录的显示名）。
 */
export async function handleManagedSessionsRename(panel: KanbanWebviewPanel, sessionId: string, name: string): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot)
    return
  const trimmed = name.trim()
  if (!trimmed)
    return
  const data = await readManagedSessions(workspaceRoot)
  const target = data.sessions.find(s => s.id === sessionId)
  if (!target)
    return
  target.name = trimmed
  await writeManagedSessions(workspaceRoot, data)
  panel.postMessage({ type: 'managed-sessions/show', data })
}

/**
 * 恢复一个受管理会话：在新终端 tab 里跑 `claude ... --resume <id>`，
 * cwd = workspaceRoot。in-flight 锁防止重复点击重复 createTerminal。
 */
export async function handleManagedSessionsResume(panel: KanbanWebviewPanel, sessionId: string): Promise<void> {
  const lockKey = `managed:${sessionId}`
  if (panel.resumeInFlight.has(lockKey)) {
    logger.add({
      level: 'info',
      source: 'panel',
      message: `managed resume ${sessionId} 已在进行中，忽略重入`,
    })
    return
  }
  panel.resumeInFlight.add(lockKey)

  try {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      void window.showErrorMessage('请先打开一个工作区文件夹')
      return
    }

    const data = await readManagedSessions(workspaceRoot)
    const target = data.sessions.find(s => s.id === sessionId)

    const effectiveProfilePath
      = target?.profilePath && target.profilePath.trim() !== '' ? target.profilePath : DEFAULT_PROFILE_PATH
    if (effectiveProfilePath.includes('\'')) {
      void window.showErrorMessage(
        `resume 失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
      )
      return
    }

    const terminal = window.createTerminal({
      name: 'cc-会话',
      cwd: workspaceRoot,
      location: panel.resolveTerminalLocation(false),
    })
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}" (resume ${sessionId})`,
    })

    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" --resume ${sessionId}`
    terminal.sendText(cmd)
  }
  finally {
    panel.resumeInFlight.delete(lockKey)
  }
}

/**
 * 从列表移除一个受管理会话（仅删本地记录，不删 jsonl）。
 */
export async function handleManagedSessionsDelete(panel: KanbanWebviewPanel, sessionId: string): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot)
    return
  const data = await readManagedSessions(workspaceRoot)
  const next = { sessions: data.sessions.filter(s => s.id !== sessionId) }
  await writeManagedSessions(workspaceRoot, next)
  panel.postMessage({ type: 'managed-sessions/show', data: next })
}
