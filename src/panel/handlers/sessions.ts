import type { Terminal } from 'vscode'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { window, workspace } from 'vscode'
import { getToken } from '../../auth/secrets'
import { watchForNewCodexSession } from '../../cc/codexSessionWatcher'
import { getBrainstormContinuePrompt, getImplementPlanPrompt } from '../../cc/prompts'
import { projectsDirFor, watchForNewSession } from '../../cc/sessionWatcher'
import { detectRepo } from '../../git/remote'
import { createWorktree } from '../../git/worktree'
import { mergeStateJsonComment, readStateJsonComment } from '../../gitea/stateJson'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { webhookCoordinator } from '../../webhook/coordinator'
import { DEFAULT_PROFILE_PATH, makeNonce } from '../KanbanPanel'

export async function handleResumeSession(panel: KanbanWebviewPanel, sessionId: string, profilePath?: string, relCwd?: string, issueNumber?: number): Promise<void> {
  // kind 跟着 sessionRole 提前判定（原来散落在方法中部，提到入口是为了构造
  // resumeInFlight 锁 key）。relCwd 在则是实施 resume，否则视为规划/讨论。
  const sessionKind: 'implement' | 'brainstorm' = relCwd ? 'implement' : 'brainstorm'

  // In-flight 锁：防 impl-tab-pre-create 钩子 await（pgrep pycharm 最多 15s）
  // 期间用户重复点同一会话 id 触发重复 createTerminal。issueNumber 为空时
  // （legacy session）跳过锁，直接走原路径。
  const lockKey = issueNumber !== undefined ? `${issueNumber}:${sessionKind}` : undefined
  if (lockKey !== undefined) {
    if (panel.resumeInFlight.has(lockKey)) {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `resume #${issueNumber}/${sessionKind} 已在进行中，忽略重入`,
      })
      return
    }
    panel.resumeInFlight.add(lockKey)
  }

  try {
    // Server-side prerequisite gate. Webview already disables the entry
    // visually (see `isIssueLocked` in the kanban UI), but a user who
    // bypasses that — message tampering, editing Gitea directly, etc. —
    // would otherwise still get a session. Skip when `issueNumber` is
    // unknown (legacy sessions) so we don't gate flows that never had a
    // prerequisite concept.
    if (issueNumber !== undefined) {
      const lockCheck = await panel.resolveLockedReason(issueNumber)
      if (lockCheck.locked) {
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `拒绝打开会话 #${issueNumber}：前置 #${lockCheck.prerequisiteNumber} 未完成`,
        })
        await window.showWarningMessage(`等待前置工单 #${lockCheck.prerequisiteNumber} 完成`)
        return
      }
    }

    const existing = panel.terminals.get(sessionId)
    if (existing) {
      if (issueNumber !== undefined)
        panel.trackSessionTerminal(existing, issueNumber, sessionKind)
      existing.show(false)
      return
    }
    // 实施 resume 走工单级 profilePath > 默认 的优先级（同 handleImplement /
    // startConflictResolution）；头脑风暴 resume 保持现状，只看工单级 + 默认。
    const effectiveProfilePath
      = sessionKind === 'implement'
        ? panel.resolveImplementProfilePath(profilePath)
        : (profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH)
    // Reject paths containing single quotes — we shell-quote with single
    // quotes below, and embedded quotes would break out of the wrap. In
    // practice profile paths live under `/home/<user>/...` so this is a
    // defensive guard that should never fire.
    if (effectiveProfilePath.includes('\'')) {
      void window.showErrorMessage(
        `resume 失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
      )
      return
    }
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    // Implementation sessions live in a worktree; the caller can pass a
    // workspace-relative `relCwd` so `--resume` runs from the right place.
    // If the worktree has since been cleaned up (typical: drop card to
    // "完成" → auto `git worktree remove`), fall back to the workspace
    // root instead of pointing the terminal at a missing directory.
    let effectiveCwd: string | undefined = workspaceRoot
    let cwdFallback = false
    if (relCwd && workspaceRoot) {
      const resolved = path.join(workspaceRoot, relCwd)
      if (fs.existsSync(resolved)) {
        effectiveCwd = resolved
      }
      else {
        cwdFallback = true
        effectiveCwd = workspaceRoot
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `worktree 不存在，退回工作区根目录 (#${issueNumber ?? '?'}): ${relCwd}`,
        })
      }
    }
    // Open the terminal as an editor tab beside the kanban (not in the
    // bottom panel), so the user can see both side-by-side. `Beside` opens
    // in a new editor group when needed.
    // Name reflects which of the three session roles this is:
    //   relCwd present  → 实施 session (resumed inside the worktree)
    //   relCwd absent   → 规划 / discussion session (workspace root)
    // Fall back to the legacy id-suffixed name if we somehow lack issueNumber.
    const sessionRole = relCwd ? '实施' : '规划'
    // 注：sessionKind 已在方法入口处判定（用于 resumeInFlight 锁 key）。
    // 原来两条 trackSessionTerminal 路径都硬写 'brainstorm'，导致实施 resume
    // 后 terminalOrigin map 里 kind 错，onDidCloseTerminal 里的
    // `kind === 'implement'` 判断永远不命中，impl-tab-post-close 钩子（关
    // pycharm）不会执行。
    const terminalName = issueNumber !== undefined
      ? `issue-${issueNumber}-${sessionRole}`
      : `Claude · ${sessionId.slice(0, 8)}`
    // Scan live terminals before creating a new one — survives panel
    // reload / webview rebuild where `this.terminals` got wiped but the
    // tab is still open. Refresh the Map too so subsequent lookups (and
    // selection-change focus calls) keep working.
    const existingByName = panel.findExistingTerminal(terminalName)
    if (existingByName) {
      panel.terminals.set(sessionId, existingByName)
      if (issueNumber !== undefined)
        panel.trackSessionTerminal(existingByName, issueNumber, sessionKind)
      existingByName.show(false)
      return
    }
    // 实施 resume 走新建 terminal 路径时（且 worktree 还在）需触发
    // impl-tab-pre-create 钩子（启动 pycharm 等）。existingByName fast path
    // 不调钩子——pycharm 应该已经在跑，重复启会冲突；cwdFallback=true 时
    // worktree 已清理，pycharm 不该指向 workspace root；legacy session
    // (issueNumber === undefined) 钩子签名要 issueNumber，也跳过。
    if (sessionRole === '实施' && !cwdFallback && issueNumber !== undefined && workspaceRoot) {
      const settingsForHook = getSettings(panel.context)
      // 从 state JSON 读 branch；任何一步读不到就用空字符串（脚本里
      // BRANCH env 仍能传，只是为空），不阻塞 resume 主流程。
      let branchForHook = ''
      try {
        const remote = await detectRepo(workspaceRoot)
        if (remote) {
          const token = await getToken(panel.context, remote.host)
          if (token) {
            const stateObj = await readStateJsonComment({
              host: remote.host,
              owner: remote.owner,
              repo: remote.repo,
              token,
              issueNumber,
            })
            if (stateObj && typeof stateObj.branch === 'string')
              branchForHook = stateObj.branch
          }
        }
      }
      catch (err) {
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `resume #${issueNumber} 读 state JSON 失败，钩子 branch 用空字符串`,
          details: err instanceof Error ? err.message : String(err),
        })
      }
      await panel.dispatchWorktreeHook('impl-tab-pre-create', {
        workspaceRoot,
        worktreePath: effectiveCwd!,
        branch: branchForHook,
        issueNumber,
        mainBranch: settingsForHook.devBranch || 'main',
        customScriptPath: settingsForHook.implTabPreCreateScript,
      })
    }
    // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
    // `color` option — only the panel-view icon does. Force a `circle-filled`
    // codicon so the tab actually shows the issue color. Keep `color` too:
    // harmless in the editor tab, still useful if the same terminal ever
    // gets rendered in panel-view mode.
    const issueIcon = issueNumber !== undefined
      ? await panel.resolveIssueIcon(issueNumber)
      : undefined
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: panel.resolveTerminalLocation(false),
      ...(issueIcon ? { iconPath: issueIcon.iconUri, color: issueIcon.themeColor } : {}),
    })
    panel.terminals.set(sessionId, terminal)
    if (issueNumber !== undefined)
      panel.trackSessionTerminal(terminal, issueNumber, sessionKind)
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })
    // Worktree 已清理时给用户一个明确提示，避免他们误以为 cc 在原
    // worktree 路径里跑。toast 上 dismissOnTimer 5s 自动消失。
    if (cwdFallback) {
      panel.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'info',
        message: `工单 #${issueNumber ?? '?'} 的 worktree 已清理，会话将在工作区根目录恢复`,
        dismissOnTimer: 5000,
      })
    }
    const effortArg = sessionKind === 'implement' ? ' --effort high' : ''
    const cmd = `claude${effortArg} --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" --resume ${sessionId}`
    terminal.sendText(cmd)
  }
  finally {
    if (lockKey !== undefined)
      panel.resumeInFlight.delete(lockKey)
  }
}

export async function handleResumeReviewSession(panel: KanbanWebviewPanel, sessionId: string, issueNumber: number, relCwd?: string): Promise<void> {
  // In-flight 锁：审查会话虽然没有 pre-create 钩子，但 codex resume 启动
  // 仍有几秒延迟，期间用户重复点同一会话 id 仍会触发重复 createTerminal。
  // 防御性处理与 handleResumeSession 一致。
  const lockKey = `${issueNumber}:review`
  if (panel.resumeInFlight.has(lockKey)) {
    logger.add({
      level: 'info',
      source: 'panel',
      message: `resume #${issueNumber}/review 已在进行中，忽略重入`,
    })
    return
  }
  panel.resumeInFlight.add(lockKey)

  try {
    // Server-side prerequisite gate — consistent with handleResumeSession /
    // handleImplement. In practice review sessions imply the issue has
    // moved past todo (a worktree must exist), but enforcing here keeps
    // the contract uniform.
    const lockCheck = await panel.resolveLockedReason(issueNumber)
    if (lockCheck.locked) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `拒绝打开审查会话 #${issueNumber}：前置 #${lockCheck.prerequisiteNumber} 未完成`,
      })
      await window.showWarningMessage(`等待前置工单 #${lockCheck.prerequisiteNumber} 完成`)
      return
    }

    const existing = panel.reviewTerminals.get(sessionId)
    if (existing) {
      panel.trackSessionTerminal(existing, issueNumber, 'review')
      existing.show(false)
      return
    }
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!relCwd || !workspaceRoot) {
      void window.showErrorMessage(`审查会话无法恢复 #${issueNumber}：worktree 路径未记录`)
      return
    }
    const worktreeAbs = path.join(workspaceRoot, relCwd)
    if (!fs.existsSync(worktreeAbs)) {
      void window.showErrorMessage(`审查会话无法恢复 #${issueNumber}：worktree 不存在 ${worktreeAbs}`)
      return
    }
    // Scan live terminals before creating a new one — survives panel
    // reload / webview rebuild where `this.reviewTerminals` got wiped but
    // the tab is still open.
    const reviewTerminalName = `issue-${issueNumber}-审查`
    const existingByName = panel.findExistingTerminal(reviewTerminalName)
    if (existingByName) {
      panel.reviewTerminals.set(sessionId, existingByName)
      panel.trackSessionTerminal(existingByName, issueNumber, 'review')
      existingByName.show(false)
      return
    }
    // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
    // `color` option. Force a `circle-filled` codicon so the tab actually
    // shows the issue color; keep `color` too for panel-view fallback.
    const { themeColor, iconUri } = await panel.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: reviewTerminalName,
      cwd: worktreeAbs,
      location: panel.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    panel.reviewTerminals.set(sessionId, terminal)
    panel.trackSessionTerminal(terminal, issueNumber, 'review')
    terminal.show(false)
    terminal.sendText(`codex resume -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox ${sessionId}`)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建审查会话终端 #${issueNumber} cwd=${worktreeAbs}`,
    })
  }
  finally {
    panel.resumeInFlight.delete(lockKey)
  }
}

/**
 * Open (or re-use) the review terminal tab for an issue and send the codex
 * review command. Used by the webhook auto-review flow so the user can watch
 * codex work in real time instead of it running headless in the background.
 *
 * Re-use semantics: if a tab named `issue-${N}-审查` already exists (live, not
 * exited), codex TUI is already running inside; we just `show` the tab and
 * send a short follow-up message ("PR 更新了，再审一下") as the next user
 * input so codex handles it as a new round, reusing the existing session
 * context. We deliberately do NOT re-run the full
 * `codex --dangerously-bypass-... '/review\n<prompt>'` startup command on
 * reuse (it would be received as a long redundant user message, wasting
 * tokens) and we do NOT restart the codex session watcher (reuse doesn't
 * write a new rollout-*.jsonl, so the watcher would just idle until
 * timeout). We do NOT track the terminal in `reviewTerminals` (that map is
 * keyed by codex thread_id, which we don't have on this path).
 *
 * Returns true if the command was successfully dispatched, false if a
 * pre-condition failed (single-quote in prompt — only checked on the
 * new-terminal path since reuse sends a fixed string).
 */
export async function triggerAutoReviewTab(panel: KanbanWebviewPanel, opts: {
  issueNumber: number
  prNumber: string
  prompt: string
  /** workspace-relative or absolute path; if missing/invalid we fall back to workspaceRoot. */
  worktreePath: string
  workspaceRoot: string
}): Promise<boolean> {
  // Resolve cwd. If worktreePath is provided but doesn't exist on disk
  // (worktree was cleaned up after merge), fall back to workspaceRoot and
  // toast the user — same fallback as handleResumeSession. Only matters on
  // the new-terminal path (an existing terminal already has its cwd set).
  let effectiveCwd = opts.workspaceRoot
  let cwdFallback = false
  if (opts.worktreePath) {
    const abs = path.isAbsolute(opts.worktreePath)
      ? opts.worktreePath
      : path.join(opts.workspaceRoot, opts.worktreePath)
    if (fs.existsSync(abs))
      effectiveCwd = abs
    else
      cwdFallback = true
  }

  const terminalName = `issue-${opts.issueNumber}-审查`
  const existing = panel.findExistingTerminal(terminalName)
  const isReuse = !!existing

  // Pre-fetch the persisted reviewSessionId from issue state JSON so we
  // can pick the right branch below. Any failure (no remote / no token /
  // network blip) MUST NOT break the whole review trigger — fall through
  // with existingSessionId = undefined and we'll spin up a fresh codex.
  let existingSessionId: string | undefined
  try {
    const remote = await detectRepo(opts.workspaceRoot)
    if (remote) {
      const token = await getToken(panel.context, remote.host)
      if (token) {
        const state = await readStateJsonComment({
          host: remote.host,
          token,
          owner: remote.owner,
          repo: remote.repo,
          issueNumber: opts.issueNumber,
        })
        const sid = state?.reviewSessionId
        if (typeof sid === 'string' && sid.length > 0)
          existingSessionId = sid
      }
    }
  }
  catch (err) {
    logger.add({
      level: 'warn',
      source: 'review',
      message: `读取 reviewSessionId 失败，将走新建会话路径 (#${opts.issueNumber})`,
      details: err instanceof Error ? err.message : String(err),
    })
  }

  // Three-branch decision matrix:
  //   tab alive  / sid present or not  -> reuse: inject "再审" into the live TUI
  //   tab closed / sid present         -> resume: codex resume <sid> + inject "再审"
  //   tab closed / sid absent          -> new:    spin up fresh codex review session
  if (isReuse) {
    const terminal = existing!
    panel.trackSessionTerminal(terminal, opts.issueNumber, 'review')
    terminal.show(false)
    // codex TUI already running inside this tab; sending the full
    // startup command would be received as a long redundant user message.
    // Mirror the two-step submit pattern from injectIntoImplTerminal:
    // push the body first, then send a standalone \r 250ms later so codex
    // TUI registers it as Enter (single-shot \r packed with the body is
    // sometimes consumed as a newline, not a submit).
    const body = 'PR 更新了，再审一下'
    terminal.sendText(body, false)
    setTimeout(() => {
      terminal.sendText('\r', false)
    }, 250)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已发送"PR 更新了，再审一下"到复用的 #${opts.issueNumber}-审查 tab`,
    })
    return true
  }

  if (existingSessionId) {
    // --- resume path: tab was closed but we have a persisted thread_id,
    // so reuse the codex conversation instead of dropping its context.
    // Mirrors handleResumeReviewSession's terminal-creation pipeline
    // (icon / createTerminal / trackSessionTerminal / reviewTerminals.set
    // / show). No session watcher — `codex resume` does NOT write a new
    // rollout-*.jsonl, so there's nothing to capture. No cwdFallback
    // toast either — keep parity with the reuse branch.
    const { themeColor, iconUri } = await panel.resolveIssueIcon(opts.issueNumber)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: panel.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    panel.reviewTerminals.set(existingSessionId, terminal)
    panel.trackSessionTerminal(terminal, opts.issueNumber, 'review')
    terminal.show(false)
    terminal.sendText(`codex resume -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox ${existingSessionId}`)
    // codex resume rebuilds the conversation from the jsonl rollout
    // before the TUI accepts input — empirically much slower than the
    // 250ms gap the reuse path uses. 8s is a conservative guess that
    // covers a cold codex start without feeling laggy.
    const body = 'PR 更新了，再审一下'
    setTimeout(() => {
      terminal.sendText(body, false)
      setTimeout(() => {
        terminal.sendText('\r', false)
      }, 250)
    }, 8000)
    logger.add({
      level: 'info',
      source: 'review',
      message: `已 codex resume 审查会话 ${existingSessionId} 并注入再审消息 (#${opts.issueNumber})`,
    })
    return true
  }

  // --- new-terminal path: full codex startup + session watcher ---

  // codex command is shell-quoted with single quotes; reject prompts that
  // would break the quoting rather than try to escape (same posture as
  // handleImplement). Only relevant on the new-terminal path — the reuse
  // path sends a fixed string, not opts.prompt.
  if (opts.prompt.includes('\'')) {
    logger.add({
      level: 'error',
      source: 'webhook',
      message: `审查 prompt 含单引号，拒绝执行 #${opts.issueNumber}`,
    })
    return false
  }

  const { themeColor, iconUri } = await panel.resolveIssueIcon(opts.issueNumber)
  const terminal = window.createTerminal({
    name: terminalName,
    cwd: effectiveCwd,
    location: panel.resolveTerminalLocation(false),
    iconPath: iconUri,
    color: themeColor,
  })
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已创建审查终端 "${terminalName}" cwd=${effectiveCwd}`,
  })
  panel.trackSessionTerminal(terminal, opts.issueNumber, 'review')
  terminal.show(false)

  if (cwdFallback) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'info',
      message: `工单 #${opts.issueNumber} 的 worktree 已清理，审查将在工作区根目录跑`,
      dismissOnTimer: 5000,
    })
  }

  // Start the codex session watcher BEFORE sendText so we don't race the
  // rollout-*.jsonl creation. codex writes a new file under
  // ~/.codex/sessions/YYYY/MM/DD/ on every run; we extract thread_id from
  // its name and persist it as reviewSessionId so the detail panel's
  // resume button works after the user closes this tab.
  const codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions')
  const watcherPromise = watchForNewCodexSession({
    baseDir: codexSessionsRoot,
    timeoutMs: 120_000,
  })

  // Interactive TUI (`codex` without `exec`/`review` subcommands): keeps
  // the terminal alive after the run so users can follow up with codex,
  // mirroring how claude implementation/brainstorm sessions stay open.
  // 提示词模板自带 /review 前缀，不在这里再拼。
  const cmd = `codex -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox '${opts.prompt}'`
  terminal.sendText(cmd)
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已发送 codex review 命令到 #${opts.issueNumber}-审查 tab`,
  })

  // Fire-and-forget: when the watcher resolves with a thread_id, persist
  // it to state JSON + push an issue/patch so the webview shows the resume
  // button. Failures here don't break the review run itself.
  void watcherPromise.then(async (threadId) => {
    if (!threadId) {
      logger.add({
        level: 'warn',
        source: 'review',
        message: `审查会话监听超时 (#${opts.issueNumber})`,
      })
      return
    }
    logger.add({
      level: 'info',
      source: 'review',
      message: `已捕获审查会话 ${threadId} (#${opts.issueNumber})`,
    })
    try {
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!workspaceRoot)
        return
      const remote = await detectRepo(workspaceRoot)
      if (!remote)
        return
      const token = await getToken(panel.context, remote.host)
      if (!token)
        return
      await mergeStateJsonComment({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        issueNumber: opts.issueNumber,
        extra: { reviewSessionId: threadId },
      })
      panel.postMessage({
        type: 'issue/patch',
        issueNumber: opts.issueNumber,
        patch: { reviewSessionId: threadId },
      })
    }
    catch (err) {
      logger.add({
        level: 'warn',
        source: 'review',
        message: `持久化 reviewSessionId 失败 (#${opts.issueNumber})`,
        details: err instanceof Error ? err.message : String(err),
      })
    }
  }).catch((err) => {
    logger.add({
      level: 'warn',
      source: 'review',
      message: `审查 session watcher 异常 (#${opts.issueNumber})`,
      details: err instanceof Error ? err.message : String(err),
    })
  })

  return true
}

/**
 * Kick off the end-to-end "implement this plan" flow:
 *   1. Detect repo + token, compute a stable feature_name from the plan path.
 *   2. Move the issue to in-progress and stamp branch/worktreePath/status
 *      into the state-JSON comment.
 *   3. Confirm the always-on webhook coordinator is bound to the current
 *      port, then register a gitea webhook scoped to the feature branch
 *      and hand the bookkeeping to the coordinator.
 *   4. Spawn `claude` in an editor-tab terminal with a /goal prompt that
 *      tells cc to create the worktree, implement the plan, and emit
 *      `<request_review>$pr_no</request_review>` when done.
 *
 * The webhook coordinator (see src/webhook/coordinator.ts) receives the
 * resulting PR event, writes back the PR number, and deletes the gitea
 * hook — even if this panel has since been closed.
 */
export async function handleImplement(
  panel: KanbanWebviewPanel,
  issueNumber: number,
  planFile: string,
  profilePath?: string,
  _sessionId?: string,
): Promise<void> {
  // Server-side prerequisite gate — webview disables the implement
  // button when the prerequisite isn't done, but enforce here too so
  // tampered messages can't slip past.
  const lockCheck = await panel.resolveLockedReason(issueNumber)
  if (lockCheck.locked) {
    logger.add({
      level: 'warn',
      source: 'panel',
      message: `拒绝实施 #${issueNumber}：前置 #${lockCheck.prerequisiteNumber} 未完成`,
    })
    await window.showWarningMessage(`等待前置工单 #${lockCheck.prerequisiteNumber} 完成`)
    return
  }

  // Reuse an already-open 实施 terminal before doing anything else.
  // Re-clicking the implement button must not run `git worktree add`,
  // re-mkdir the claude projects dir, re-start the session watcher, or
  // re-send the prompt — those are first-time-only side effects, and
  // repeating them would crash on the existing worktree / clobber state.
  // Scanning live terminals (instead of just `this.implTerminals`)
  // survives panel reload / webview rebuild where the Map got wiped but
  // the tab is still alive.
  const implTerminalName = `issue-${issueNumber}-实施`
  const existingImpl = panel.findExistingTerminal(implTerminalName)
  if (existingImpl) {
    panel.implTerminals.set(issueNumber, existingImpl)
    panel.trackSessionTerminal(existingImpl, issueNumber, 'implement')
    existingImpl.show(false)
    logger.add({
      level: 'info',
      source: 'implement',
      message: `复用已有实施终端 #${issueNumber}，跳过 worktree 创建`,
    })
    return
  }

  logger.add({
    level: 'info',
    source: 'implement',
    message: `开始实施 #${issueNumber}`,
    details: `planFile=${planFile}`,
  })
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showErrorMessage('请先打开一个工作区文件夹')
    return
  }
  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    void window.showErrorMessage('当前工作区没有 Gitea 远程仓库')
    return
  }
  const token = await getToken(panel.context, remote.host)
  if (!token) {
    void window.showErrorMessage('请先完成 Gitea 配置')
    return
  }

  const feature = createHash('sha256').update(planFile).digest('hex').slice(0, 8)
  const branch = `feature/${feature}`
  const relativeWorktreePath = `.claude/worktrees/${feature}`
  const worktreePath = path.join(workspaceRoot, relativeWorktreePath)

  // Pre-flight: refuse if either the directory or the branch already
  // exists, since `git worktree add -b` would fail and we'd have to
  // unwind partial state.
  let worktreeExists = false
  try {
    await fsp.stat(worktreePath)
    worktreeExists = true
  }
  catch {
    // ENOENT — good.
  }
  let branchExists = false
  try {
    branchExists = await new Promise<boolean>((resolve) => {
      execFile(
        'git',
        ['-C', workspaceRoot, 'branch', '--list', branch],
        { timeout: 10_000 },
        (err, stdout) => {
          if (err) {
            resolve(false)
            return
          }
          resolve((stdout ?? '').trim().length > 0)
        },
      )
    })
  }
  catch {
    branchExists = false
  }
  if (worktreeExists || branchExists) {
    void window.showErrorMessage(
      `feature ${feature} 的 worktree 或分支已存在，请先清理`,
    )
    return
  }

  // 工单级 profilePath > 默认 fallback。工单的 profile 锁定可在工单详情面板里覆盖。
  const effectiveProfilePath = panel.resolveImplementProfilePath(profilePath)
  // Same guard as handleResumeSession — we wrap with single quotes and
  // embedded quotes would break out of the wrap. Defensive only.
  if (effectiveProfilePath.includes('\'')) {
    void window.showErrorMessage(
      `实施失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
    )
    return
  }

  const settings = getSettings(panel.context)
  const port = settings.webhookPort

  // The webhook coordinator is started at extension activation; just
  // ensure the port matches the current setting (no-op if unchanged). The
  // user must configure a single shared webhook in gitea pointing at
  // `<publicUrl>/webhook`; the extension no longer auto-creates per-issue
  // hooks, and PR→issue resolution happens via `Closes #N` in the PR body.
  try {
    await webhookCoordinator.ensurePort(port)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    void window.showErrorMessage(`webhook 服务启动失败: ${message}`)
    return
  }

  // Create the worktree before anything else, so a worktree-add failure
  // doesn't leave half-written state behind.
  try {
    await createWorktree({ workspaceRoot, worktreePath, branch })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'error',
      source: 'implement',
      message: 'git worktree add 失败',
      details: message,
    })
    void window.showErrorMessage(message)
    return
  }

  // Run the post-create lifecycle hook. Fire-and-await so subsequent
  // steps (mkdir projects dir, terminal spawn, cc launch) see whatever
  // setup the user script performed (e.g. .env copy). Failures are
  // logged + toasted but never block the implement flow.
  await panel.dispatchWorktreeHook('post-create', {
    workspaceRoot,
    worktreePath,
    branch,
    issueNumber,
    mainBranch: settings.devBranch || 'main',
    customScriptPath: settings.worktreePostCreateScript,
  })

  // Ensure the claude projects subdir exists *before* spawning the
  // terminal so the watcher can't miss the create event.
  const projDir = projectsDirFor(worktreePath)
  try {
    await fsp.mkdir(projDir, { recursive: true })
  }
  catch (err) {
    console.warn('[superpowers] failed to mkdir claude projects dir:', err)
  }

  // Kick off the watcher *before* spawning the terminal so we don't race.
  const watchPromise = watchForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

  // Merge into the latest state-JSON comment so we don't clobber spec/plan/
  // sessionId etc that earlier steps wrote.
  try {
    await mergeStateJsonComment({
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      token,
      issueNumber,
      extra: {
        column: 'in-progress',
        branch,
        worktreePath: relativeWorktreePath,
        implementStatus: 'running',
      },
    })
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: {
        column: 'in-progress',
        branch,
        worktreePath: relativeWorktreePath,
        implementStatus: 'running',
        worktreeExists: true,
      },
    })
  }
  catch (err) {
    // Non-fatal: terminal still spawns. Surface so the user knows the
    // comment didn't update.
    const message = err instanceof Error ? err.message : String(err)
    void window.showWarningMessage(`写入 state JSON 失败: ${message}`)
  }

  // Build the prompt. The extension already created the worktree, so cc
  // just implements the plan. `$pr_no` is left as-is for cc to fill in
  // via tool calls.
  const prompt = getImplementPlanPrompt(panel.context, { planFile, issueNumber })
  if (prompt.includes('\'')) {
    void window.showErrorMessage('实施失败：prompt 含单引号，拒绝执行')
    return
  }

  // 实施 cc tab 创建前钩子。tab 复用 fast path（顶部 findExistingTerminal
  // 命中）走早 return，不会执行到这里，刚好满足"复用不触发"语义。
  await panel.dispatchWorktreeHook('impl-tab-pre-create', {
    workspaceRoot,
    worktreePath,
    branch,
    issueNumber,
    mainBranch: settings.devBranch || 'main',
    customScriptPath: settings.implTabPreCreateScript,
  })

  // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
  // `color` option. Force a `circle-filled` codicon so the tab actually
  // shows the issue color; keep `color` too for panel-view fallback.
  const { themeColor, iconUri } = await panel.resolveIssueIcon(issueNumber)
  const terminal = window.createTerminal({
    name: `issue-${issueNumber}-实施`,
    cwd: worktreePath,
    location: panel.resolveTerminalLocation(false),
    iconPath: iconUri,
    color: themeColor,
  })
  terminal.show(false)
  // Track for the auto-review flow: synchronize callbacks call
  // `injectIntoImplTerminal(issueNumber, text)` to feed review feedback
  // back into the same running cc session.
  panel.implTerminals.set(issueNumber, terminal)
  panel.trackSessionTerminal(terminal, issueNumber, 'implement')
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已创建终端 "${terminal.name}"`,
  })
  const cmd = `claude --effort high --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
  terminal.sendText(cmd)
  logger.add({
    level: 'info',
    source: 'implement',
    message: `已发送 prompt 到终端 #${issueNumber}`,
  })

  // Wait in the background for the session jsonl to materialize; merge
  // the captured implementSessionId back into the state-JSON comment so
  // the user can resume from the detail panel later.
  watchPromise.then(async (sid) => {
    if (!sid) {
      logger.add({
        level: 'warn',
        source: 'implement',
        message: '实施会话监听超时 (120s)',
      })
      return
    }
    logger.add({
      level: 'info',
      source: 'implement',
      message: `已捕获实施会话 ${sid}`,
    })
    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { implementSessionId: sid },
      })
      panel.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { implementSessionId: sid },
      })
    }
    catch (err) {
      console.warn('[superpowers] failed to persist implementSessionId:', err)
    }
  }).catch((err) => {
    console.warn('[superpowers] session watch failed:', err)
  })

  void window.showInformationMessage(`已开始实施 #${issueNumber}`)
}

/**
 * Start a fresh "规划" (brainstorm continuation) cc tab for an existing
 * issue whose body has no sessionId yet. Used when the issue was created
 * outside the panel (e.g. user ran spx from another cc session, body
 * lacks the nonce marker so the webhook took the "external" branch and
 * didn't link a terminal). Click the Play button next to the empty
 * "头脑风暴会话 id" row to spawn a new cc session anchored to this issue.
 *
 * Differs from `handleImplement`:
 *   - No worktree / no feature branch (this is discussion, not coding).
 *   - cwd = workspaceRoot (not a worktree).
 *   - Watches the workspace-root `~/.claude/projects/...` dir for the new
 *     session jsonl and writes the captured id back as `sessionId`
 *     (not `implementSessionId`).
 */
export async function handleStartBrainstormSession(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  const terminalName = `issue-${issueNumber}-规划`
  const existing = panel.findExistingTerminal(terminalName)
  if (existing) {
    panel.trackSessionTerminal(existing, issueNumber, 'brainstorm')
    existing.show(false)
    logger.add({
      level: 'info',
      source: 'brainstorm',
      message: `复用已有规划终端 #${issueNumber}，跳过 cc 启动`,
    })
    return
  }

  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    void window.showErrorMessage('请先打开一个工作区文件夹')
    return
  }
  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    void window.showErrorMessage('当前工作区没有 Gitea 远程仓库')
    return
  }
  const token = await getToken(panel.context, remote.host)
  if (!token) {
    void window.showErrorMessage('请先完成 Gitea 配置')
    return
  }

  // Pull profilePath from the issue's state JSON so the new cc session
  // reuses whatever profile the user set when the issue was first created.
  // Tolerated: missing/unparseable comment falls back to DEFAULT_PROFILE_PATH.
  let profilePath: string | undefined
  try {
    const stateObj = await readStateJsonComment({
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      token,
      issueNumber,
    })
    if (stateObj && typeof stateObj.profilePath === 'string' && stateObj.profilePath.length > 0)
      profilePath = stateObj.profilePath
  }
  catch (err) {
    logger.add({
      level: 'warn',
      source: 'brainstorm',
      message: `读取 #${issueNumber} state JSON 失败，使用默认 profile`,
      details: err instanceof Error ? err.message : String(err),
    })
  }

  const effectiveProfilePath
    = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
  if (effectiveProfilePath.includes('\'')) {
    void window.showErrorMessage(
      `启动规划失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
    )
    return
  }

  const prompt = getBrainstormContinuePrompt(panel.context, { issueNumber })
  if (prompt.includes('\'')) {
    void window.showErrorMessage('启动规划失败：prompt 含单引号，拒绝执行')
    return
  }

  // Ensure the projects dir exists so the watcher can't miss the create
  // event. Workspace root (no worktree here).
  const projDir = projectsDirFor(workspaceRoot)
  try {
    await fsp.mkdir(projDir, { recursive: true })
  }
  catch (err) {
    console.warn('[superpowers] failed to mkdir claude projects dir:', err)
  }

  // Kick off the watcher before spawning the terminal so we don't race.
  const watchPromise = watchForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

  const { themeColor, iconUri } = await panel.resolveIssueIcon(issueNumber)
  const terminal = window.createTerminal({
    name: terminalName,
    cwd: workspaceRoot,
    location: panel.resolveTerminalLocation(false),
    iconPath: iconUri,
    color: themeColor,
  })
  panel.trackSessionTerminal(terminal, issueNumber, 'brainstorm')
  terminal.show(false)
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已创建终端 "${terminal.name}"`,
  })

  const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
  terminal.sendText(cmd)
  logger.add({
    level: 'info',
    source: 'brainstorm',
    message: `已发送规划 prompt 到终端 #${issueNumber}`,
  })

  // Fire-and-forget: when the session jsonl materializes, persist the id
  // as the issue's brainstorm `sessionId` so the X / Play button toggles
  // and the user can later resume via the existing UI.
  watchPromise.then(async (sid) => {
    if (!sid) {
      logger.add({
        level: 'warn',
        source: 'brainstorm',
        message: '规划会话监听超时 (120s)',
      })
      return
    }
    logger.add({
      level: 'info',
      source: 'brainstorm',
      message: `已捕获规划会话 ${sid}`,
    })
    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { sessionId: sid },
      })
      panel.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { sessionId: sid },
      })
    }
    catch (err) {
      console.warn('[superpowers] failed to persist brainstorm sessionId:', err)
    }
  }).catch((err) => {
    console.warn('[superpowers] brainstorm session watch failed:', err)
  })

  void window.showInformationMessage(`已启动 #${issueNumber} 规划会话`)
}

/**
 * 手动启动一个"测试"cc 会话：工单 PR 合并后，用户在详情面板点测试会话行的
 * 启动按钮，开一个 claude tab 让 cc 先了解代码、再告诉用户怎么测试。
 *
 * 与 handleStartBrainstormSession 的差异：
 *   - 首条 prompt 依赖 state JSON 里的 `pr`（合并的 PR 号）；没有 PR 直接 toast 拒绝。
 *   - cwd 优先用 worktree（存在时），否则退回 workspaceRoot——测试本质要读真实代码，
 *     与实施会话同 profile（走 resolveImplementProfilePath）。
 *   - 捕获到的 session id 写进 state JSON 的 `testSessionId`。
 *
 * in-flight 锁 key `${issueNumber}:test`，防 createTerminal 期间用户重复点击。
 */
export async function handleStartTestSession(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  const lockKey = `${issueNumber}:test`
  if (panel.resumeInFlight.has(lockKey)) {
    logger.add({
      level: 'info',
      source: 'panel',
      message: `start-test #${issueNumber} 已在进行中，忽略重入`,
    })
    return
  }
  panel.resumeInFlight.add(lockKey)

  try {
    const terminalName = `issue-${issueNumber}-测试`
    const existing = panel.findExistingTerminal(terminalName)
    if (existing) {
      panel.trackSessionTerminal(existing, issueNumber, 'test')
      existing.show(false)
      logger.add({
        level: 'info',
        source: 'panel',
        message: `复用已有测试终端 #${issueNumber}，跳过 cc 启动`,
      })
      return
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      void window.showErrorMessage('请先打开一个工作区文件夹')
      return
    }
    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      void window.showErrorMessage('当前工作区没有 Gitea 远程仓库')
      return
    }
    const token = await getToken(panel.context, remote.host)
    if (!token) {
      void window.showErrorMessage('请先完成 Gitea 配置')
      return
    }

    // 从 state JSON 读 pr / profilePath。pr 是测试会话的前提
    // （prompt 依赖 PR 号），读不到就 toast 拒绝。
    let pr: string | undefined
    let profilePath: string | undefined
    let worktreePathRel: string | undefined
    try {
      const stateObj = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
      if (stateObj) {
        if (typeof stateObj.pr === 'string' && stateObj.pr.length > 0)
          pr = stateObj.pr
        if (typeof stateObj.profilePath === 'string' && stateObj.profilePath.length > 0)
          profilePath = stateObj.profilePath
        if (typeof stateObj.worktreePath === 'string' && stateObj.worktreePath.length > 0)
          worktreePathRel = stateObj.worktreePath
      }
    }
    catch (err) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `读取 #${issueNumber} state JSON 失败，无法启动测试会话`,
        details: err instanceof Error ? err.message : String(err),
      })
    }

    if (!pr) {
      void window.showWarningMessage('该工单无已合并 PR，无法启动测试会话')
      return
    }

    // worktree 还在（PR 未合并/未清理）就进 worktree 测，已清理则回退主 worktree（main）。
    const effectiveCwd = await resolveTestSessionCwd(workspaceRoot, worktreePathRel)

    // 测试会话本质要读真实代码，走实施 profile 优先级。
    const effectiveProfilePath = panel.resolveImplementProfilePath(profilePath)
    if (effectiveProfilePath.includes('\'')) {
      void window.showErrorMessage(
        `启动测试失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
      )
      return
    }

    const prompt = `我已经合并了#${pr}号pr,你先通过tea熟悉本次pr改动的代码,然后，怎么在本地测试以确保改动符合预期?`
    if (prompt.includes('\'')) {
      void window.showErrorMessage('启动测试失败：prompt 含单引号，拒绝执行')
      return
    }

    // Ensure the projects dir exists so the watcher can't miss the create
    // event. cwd 决定 claude session jsonl 落在哪个 projects 子目录下。
    const projDir = projectsDirFor(effectiveCwd)
    try {
      await fsp.mkdir(projDir, { recursive: true })
    }
    catch (err) {
      console.warn('[superpowers] failed to mkdir claude projects dir:', err)
    }

    // Kick off the watcher before spawning the terminal so we don't race.
    const watchPromise = watchForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

    const { themeColor, iconUri } = await panel.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: panel.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    panel.trackSessionTerminal(terminal, issueNumber, 'test')
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })

    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
    terminal.sendText(cmd)
    logger.add({
      level: 'info',
      source: 'panel',
      message: `已发送测试 prompt 到终端 #${issueNumber}`,
    })

    // Fire-and-forget: when the session jsonl materializes, persist the id as
    // the issue's `testSessionId` so the X / resume button toggles.
    watchPromise.then(async (sid) => {
      if (!sid) {
        logger.add({
          level: 'warn',
          source: 'panel',
          message: '测试会话监听超时 (120s)',
        })
        return
      }
      logger.add({
        level: 'info',
        source: 'panel',
        message: `已捕获测试会话 ${sid}`,
      })
      try {
        await mergeStateJsonComment({
          host: remote.host,
          owner: remote.owner,
          repo: remote.repo,
          token,
          issueNumber,
          extra: { testSessionId: sid },
        })
        panel.postMessage({
          type: 'issue/patch',
          issueNumber,
          patch: { testSessionId: sid },
        })
      }
      catch (err) {
        console.warn('[superpowers] failed to persist testSessionId:', err)
      }
    }).catch((err) => {
      console.warn('[superpowers] test session watch failed:', err)
    })

    void window.showInformationMessage(`已启动 #${issueNumber} 测试会话`)
  }
  finally {
    panel.resumeInFlight.delete(lockKey)
  }
}

/**
 * 恢复一个已存在的测试 cc 会话：详情面板点测试会话行（testTabOpen=false 时）
 * 触发，照搬 handleResumeSession 的 implement 分支，但 kind='test'、终端名
 * `issue-${N}-测试`、命令 `claude ... --resume ${sessionId}`。
 *
 * cwd 优先用 worktree（relCwd 存在且在磁盘上），否则退回 workspaceRoot。
 * in-flight 锁 key `${issueNumber}:test`。
 */
export async function handleResumeTestSession(panel: KanbanWebviewPanel, sessionId: string, issueNumber: number, _relCwd?: string): Promise<void> {
  const lockKey = `${issueNumber}:test`
  if (panel.resumeInFlight.has(lockKey)) {
    logger.add({
      level: 'info',
      source: 'panel',
      message: `resume #${issueNumber}/test 已在进行中，忽略重入`,
    })
    return
  }
  panel.resumeInFlight.add(lockKey)

  try {
    // 与实施会话不同，profile 不影响 --resume（claude 从 jsonl 重建会话），
    // 但仍用实施 profile 保持一致。
    const effectiveProfilePath = panel.resolveImplementProfilePath(undefined)
    if (effectiveProfilePath.includes('\'')) {
      void window.showErrorMessage(
        `resume 失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
      )
      return
    }

    // claude 的 session jsonl 落在「cwd 派生的 projects 目录」下：start 时进了 worktree，
    // resume 也必须在 worktree 才找得到这条会话；worktree 已清理才回退主 worktree（main）。
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    let effectiveCwd = workspaceRoot
    if (workspaceRoot) {
      const remote = await detectRepo(workspaceRoot)
      const token = remote ? await getToken(panel.context, remote.host) : undefined
      if (remote && token) {
        try {
          const stateObj = await readStateJsonComment({
            host: remote.host,
            owner: remote.owner,
            repo: remote.repo,
            token,
            issueNumber,
          })
          const worktreePathRel = typeof stateObj?.worktreePath === 'string' ? stateObj.worktreePath : undefined
          effectiveCwd = await resolveTestSessionCwd(workspaceRoot, worktreePathRel)
        }
        catch (err) {
          logger.add({
            level: 'warn',
            source: 'panel',
            message: `读取 #${issueNumber} state JSON 失败，测试会话回退主 worktree 恢复`,
            details: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    const terminalName = `issue-${issueNumber}-测试`
    const existingByName = panel.findExistingTerminal(terminalName)
    if (existingByName) {
      panel.trackSessionTerminal(existingByName, issueNumber, 'test')
      existingByName.show(false)
      return
    }

    const { themeColor, iconUri } = await panel.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: panel.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    panel.trackSessionTerminal(terminal, issueNumber, 'test')
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建测试会话终端 #${issueNumber} cwd=${effectiveCwd}`,
    })

    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" --resume ${sessionId}`
    terminal.sendText(cmd)
  }
  finally {
    panel.resumeInFlight.delete(lockKey)
  }
}

/**
 * 当 done 列的 PR merge 因冲突失败时调用：在主 workspace 检出 feature 分支
 * 并 merge dev 让冲突落地到 working tree，然后启一个临时 cc 会话让 cc 解决
 * 冲突 + commit + push。这个临时会话**不**进 state JSON、不进任何 map，
 * 用户解决完后需要手动再拖一次完成列触发重试。
 *
 * 流程：
 *   1. 校验主 workspace working tree 干净（否则 checkout 会丢用户改动）
 *   2. fetch + checkout feature → fetch dev → merge origin/dev（冲突落地）
 *   3. 用 claude --effort high --dangerously-skip-permissions 启临时终端，
 *      给 cc 写死的解决指引。cc commit + push 后由用户重新拖到完成列触发重试。
 */
export async function startConflictResolution(panel: KanbanWebviewPanel, opts: {
  issueNumber: number
  prIndex: number
  workspaceRoot: string
  featureBranch: string
  worktreePath: string
  profilePath?: string
}): Promise<void> {
  const { issueNumber, prIndex, workspaceRoot, featureBranch, worktreePath, profilePath } = opts
  const settings = getSettings(panel.context)
  const devBranch = settings.devBranch || 'main'

  // worktreePath 在 state JSON 里通常是 workspace-relative；解析为绝对路径。
  const worktreeAbs = path.isAbsolute(worktreePath)
    ? worktreePath
    : path.join(workspaceRoot, worktreePath)

  // worktree 是实施阶段建好的，按理一直存在；被清理过算异常，拒绝继续。
  if (!fs.existsSync(worktreeAbs)) {
    logger.add({
      level: 'error',
      source: 'panel',
      message: `冲突解决：worktree 路径不存在 (issue #${issueNumber})`,
      details: worktreeAbs,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `worktree 路径不存在 (cleaned up?)：${worktreeAbs}。请重新进入实施流程。`,
      dismissOnTimer: 8000,
    })
    return
  }

  const runGit = (args: string[], timeoutMs = 30_000): Promise<{ ok: boolean, stdout: string, stderr: string }> => {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', worktreeAbs, ...args],
        { timeout: timeoutMs, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '' })
            return
          }
          resolve({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '' })
        },
      )
    })
  }

  // 1. working tree 干净检查 —— worktree 里通常 cc 实施完已 commit，理应干净。
  const statusResult = await runGit(['status', '--porcelain'], 10_000)
  if (!statusResult.ok) {
    const detail = statusResult.stderr.trim() || 'git status 执行失败'
    logger.add({
      level: 'error',
      source: 'panel',
      message: `冲突解决：检查工作区状态失败 (issue #${issueNumber})`,
      details: detail,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `检查工作区状态失败：${detail}`,
      dismissOnTimer: 6000,
    })
    return
  }
  if (statusResult.stdout.trim().length > 0) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `工作区有未提交改动，无法解决 PR #${prIndex} 冲突。请先提交或 stash。`,
      dismissOnTimer: 8000,
    })
    return
  }

  // 2. 直接在 worktree 里 fetch dev —— worktree 已经 checkout 在 feature 分支上，
  //    不需要 fetch feature / checkout feature（避免与实施 worktree 同分支占用冲突）。
  const fetchDev = await runGit(['fetch', 'origin', devBranch])
  if (!fetchDev.ok) {
    const detail = fetchDev.stderr.trim() || 'git fetch dev 失败'
    logger.add({
      level: 'error',
      source: 'panel',
      message: `冲突解决：fetch dev 分支失败 (issue #${issueNumber})`,
      details: detail,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `拉取 ${devBranch} 分支失败：${detail}`,
      dismissOnTimer: 6000,
    })
    return
  }

  // 3. merge dev — 退出码非零是预期（冲突），不当失败处理，working tree 已落地
  const mergeResult = await runGit(['merge', `origin/${devBranch}`])
  logger.add({
    level: 'info',
    source: 'panel',
    message: `冲突解决：已在 ${featureBranch} 上 merge origin/${devBranch}${mergeResult.ok ? '（无冲突？）' : '（冲突已落地）'} (issue #${issueNumber})`,
    details: mergeResult.stderr.trim() || mergeResult.stdout.trim(),
  })

  // 4. 启临时 cc 会话（不进 state json、不进任何 map），cwd 设为 worktree。
  const promptRaw = `当前 git 仓库正在 merge 一个分支但出现了冲突。你的工作目录已经在 worktree 内、分支已经是 ${featureBranch}。你的任务：

1. 跑 \`git status\` 查看冲突文件
2. 逐个解决冲突
3. \`git add\` 已解决的文件
4. \`git commit\`（保留默认 merge commit message 即可）
5. \`git push\`（当前目录已在 worktree 中、分支已经是 ${featureBranch}，直接 push 即可）

注意：
- 严禁合并 PR（用户会手动在 kanban 拖到"完成"列触发合并）
- 不要 push 到 ${devBranch}
- 解决完后告诉用户「冲突已解决，PR #${prIndex} 已更新，请再拖一次工单到完成列」`

  // 单引号 shell 转义：把每个 ' 转成 '\''
  const prompt = promptRaw.replace(/'/g, '\'\\\'\'')

  let terminal: Terminal
  try {
    terminal = window.createTerminal({
      name: `issue-${issueNumber}-冲突解决`,
      cwd: worktreeAbs,
      location: panel.resolveTerminalLocation(false),
    })
  }
  catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'error',
      source: 'panel',
      message: `冲突解决：创建终端失败 (issue #${issueNumber})`,
      details: detail,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `创建冲突解决终端失败：${detail}`,
      dismissOnTimer: 6000,
    })
    return
  }
  terminal.show(false)
  // 与 handleImplement 保持一致：走工单级 profilePath > 默认 fallback 的优先级，
  // 让冲突解决会话和实施会话用同一份 profile。
  const effectiveProfilePath = panel.resolveImplementProfilePath(profilePath)
  if (effectiveProfilePath.includes('\'')) {
    logger.add({
      level: 'error',
      source: 'panel',
      message: `冲突解决：profilePath 含单引号，拒绝执行 (issue #${issueNumber})`,
      details: effectiveProfilePath,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `冲突解决失败：profilePath 含单引号 (${effectiveProfilePath})`,
      dismissOnTimer: 6000,
    })
    return
  }
  const cmd = `claude --effort high --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
  terminal.sendText(cmd)

  logger.add({
    level: 'info',
    source: 'panel',
    message: `冲突解决：cc 会话已启动 (issue #${issueNumber}, PR #${prIndex}, branch ${featureBranch}, cwd ${worktreeAbs}, profile ${effectiveProfilePath})`,
  })
  panel.postMessage({
    type: 'toast/show',
    id: makeNonce(),
    level: 'info',
    message: `PR #${prIndex} 冲突，已在 worktree 内 merge，cc 会话正在解决冲突`,
    dismissOnTimer: 8000,
  })
}

/**
 * Pick the profile.json that the *implement-class* cc sessions
 * (handleImplement / handleResumeSession when sessionKind === 'implement' /
 * startConflictResolution) should launch with. Priority:
 *   1. The per-issue `profilePath` recorded in state JSON (preserves the
 *      brainstorm-time choice, overridable from the issue detail panel).
 *   2. The hard-coded `DEFAULT_PROFILE_PATH` fallback.
 *
 * Brainstorm sessions deliberately don't go through this helper — they
 * keep the legacy `profilePath || DEFAULT_PROFILE_PATH` so creators can
 * still pick a profile per issue at brainstorm time.
 */
export function resolveImplementProfilePath(_panel: KanbanWebviewPanel, issueLevelProfilePath: string | undefined): string {
  const issueLevel = issueLevelProfilePath?.trim()
  if (issueLevel)
    return issueLevel
  return DEFAULT_PROFILE_PATH
}

/**
 * 测试会话的工作目录：worktree 还在就用 worktree，已清理则回退主 worktree。
 *
 * @param workspaceRoot 主 worktree 绝对路径
 * @param worktreePathRel state JSON 里的 worktree 相对路径（可空）
 * @returns 实际用作终端 cwd 的绝对路径
 */
async function resolveTestSessionCwd(workspaceRoot: string, worktreePathRel?: string): Promise<string> {
  if (worktreePathRel) {
    const abs = path.join(workspaceRoot, worktreePathRel)
    try {
      await fsp.stat(abs)
      return abs
    }
    catch {
      // worktree 已清理，回退主 worktree
    }
  }
  return workspaceRoot
}
