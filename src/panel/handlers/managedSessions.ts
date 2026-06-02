import type { KanbanWebviewPanel } from '../KanbanPanel'
import { promises as fsp } from 'node:fs'
import { window, workspace } from 'vscode'
import { pollForNewSession, projectsDirFor } from '../../cc/sessionWatcher'
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
 * 读取受管理会话列表，给每条附加 transient 字段 `tabOpen`
 * （= panel.managedTerminals 里有该 id 的存活终端），再推全量列表给 webview。
 *
 * `tabOpen` 只在构造 show payload 时附加，不写进 .spx/session-names.json。
 */
export async function pushManagedSessions(panel: KanbanWebviewPanel): Promise<void> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({ type: 'managed-sessions/show', data: { sessions: [] } })
    return
  }
  const data = await readManagedSessions(workspaceRoot)
  panel.postMessage({
    type: 'managed-sessions/show',
    data: {
      sessions: data.sessions.map(s => ({ ...s, tabOpen: panel.managedTerminals.has(s.id) })),
    },
  })
}

/**
 * 从列表关闭一个受管理会话的终端 tab（不删 store 记录）。
 * dispose 会触发 onDidCloseTerminal，由它清理 managedTerminals 并重推列表。
 */
export function handleManagedSessionsCloseTab(panel: KanbanWebviewPanel, sessionId: string): void {
  panel.managedTerminals.get(sessionId)?.dispose()
}

/**
 * 推送全量受管理会话列表给 webview。
 */
export async function handleManagedSessionsGet(panel: KanbanWebviewPanel): Promise<void> {
  await pushManagedSessions(panel)
}

/**
 * 从会话管理 tab 创建一个新的 cc 会话：
 *   - cwd 用项目根（workspaceRoot，非 worktree）。
 *   - 启动命令照搬头脑风暴风格（claude --dangerously-skip-permissions --settings
 *     '<profilePath>' --system-prompt="$(serena prompts ...)"），prompt 非空时
 *     再追加 ' <prompt>'。
 *   - 用 pollForNewSession 捕获新 sessionId（共享 projects 目录用轮询更可靠），
 *     落进 .spx/session-names.json 后推全量列表。
 */
export async function handleManagedSessionsCreate(panel: KanbanWebviewPanel, profilePath: string, name?: string, prompt?: string): Promise<void> {
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

  const trimmedName = (name ?? '').trim()
  if (trimmedName.includes('\'')) {
    void window.showErrorMessage('创建会话失败：会话名字含单引号，拒绝执行')
    return
  }

  const trimmedPrompt = (prompt ?? '').trim()
  if (trimmedPrompt.includes('\'')) {
    void window.showErrorMessage('创建会话失败：首个提示词含单引号，拒绝执行')
    return
  }

  // 首个提示词：填了 prompt 用 prompt；否则填了 name 用 /rename <name>；否则交互式无提示词。
  let effectivePrompt = ''
  if (trimmedPrompt)
    effectivePrompt = trimmedPrompt
  else if (trimmedName)
    effectivePrompt = `/rename ${trimmedName}`

  // 项目根的 claude projects 子目录；先 mkdir 让 watcher 不会错过 create 事件。
  const projDir = projectsDirFor(workspaceRoot)
  try {
    await fsp.mkdir(projDir, { recursive: true })
  }
  catch (err) {
    console.warn('[superpowers] failed to mkdir claude projects dir:', err)
  }

  // managed 会话的 projects 目录是繁忙共享目录，fs.watch 会漏 rename；改用轮询 diff。
  const watchPromise = pollForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

  // 终端名：用户填了会话名字就用它，否则用默认 cc-会话。
  // （VS Code 终端创建后不能改名，所以只在 createTerminal 时设定。）
  const terminal = window.createTerminal({
    name: trimmedName || 'cc-会话',
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
  if (effectivePrompt)
    cmd += ` '${effectivePrompt}'`
  terminal.sendText(cmd)
  logger.add({
    level: 'info',
    source: 'panel',
    message: '已从会话管理 tab 启动 cc 会话',
  })

  void window.showInformationMessage('已创建 cc 会话')

  // Fire-and-forget：会话 jsonl 出现后写进 store、登记终端并推全量列表。
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
        name: trimmedName || defaultSessionName(sid, trimmedPrompt || undefined),
        profilePath: effectiveProfilePath,
        createdAt: Date.now(),
      })
      await writeManagedSessions(workspaceRoot, data)
      // 捕获到 sid 后登记终端，再推 show，让列表的 tabOpen 立即为 true。
      panel.managedTerminals.set(sid, terminal)
      await pushManagedSessions(panel)
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
  await pushManagedSessions(panel)
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

    // 已有该会话的存活终端，直接聚焦、不再开新的（防重复）。
    const existing = panel.managedTerminals.get(sessionId)
    if (existing) {
      existing.show(false)
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

    // 终端名用 store 里记录的会话名（缺省回落到 cc-会话）。
    const terminal = window.createTerminal({
      name: target?.name?.trim() || 'cc-会话',
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

    // 登记终端并推 show，让列表的 tabOpen 立即为 true。
    panel.managedTerminals.set(sessionId, terminal)
    await pushManagedSessions(panel)
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
  // 删除前先关掉该会话的终端 tab。
  panel.managedTerminals.get(sessionId)?.dispose()
  const data = await readManagedSessions(workspaceRoot)
  const next = { sessions: data.sessions.filter(s => s.id !== sessionId) }
  await writeManagedSessions(workspaceRoot, next)
  panel.managedTerminals.delete(sessionId)
  await pushManagedSessions(panel)
}
