import type {
  ExtensionContext,
  Terminal,
  TerminalEditorLocationOptions,
  WebviewPanel,
} from 'vscode'
import type { IssueColumn } from '../gitea/types'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { commands, env, TabInputTerminal, ThemeColor, Uri, ViewColumn, window, workspace } from 'vscode'
import { deleteToken, getToken, setToken } from '../auth/secrets'
import { listClaudeProfiles } from '../cc/profiles'
import { getCreateIssuePrompt, getImplementPlanPrompt } from '../cc/prompts'
import { scanSessionFiles } from '../cc/sessionTranscript'
import { projectsDirFor, watchForNewSession } from '../cc/sessionWatcher'
import { detectRepo } from '../git/remote'
import { createWorktree } from '../git/worktree'
import {
  addDependency,
  getPullRequest,
  GiteaApiError,
  listIssueComments,
  postIssueComment,
  removeDependency,
} from '../gitea/api'
import { loadIssues } from '../gitea/issueLoader'
import { mergeStateJsonComment, readStateJsonComment } from '../gitea/stateJson'
import { logger } from '../logging/logger'
import { getSettings, saveSettings } from '../settings/store'
import { webhookCoordinator } from '../webhook/coordinator'
import { PALETTE, pickRandomIssueColor, resolveIssueColor, themeColorIdToIconUri } from './issueColor'

const DEFAULT_PROFILE_PATH = '/home/cruldra/Sources/cruldra-profile/claude-config/profiles/offical.json'

export class KanbanWebviewPanel {
  static readonly viewType = 'superpowers.kanbanPanel'

  private static current: KanbanWebviewPanel | undefined

  private readonly panel: WebviewPanel
  private readonly disposables: { dispose: () => void }[] = []
  /**
   * sessionId → its dedicated terminal in the editor area. Populated when the
   * user presses Enter on a card; entry is removed when the terminal is
   * closed (so a re-resume spawns a fresh tab). Letting selection changes
   * `terminal.show(true)` an existing entry is what gives the user "switch
   * card → switch terminal tab" behaviour.
   */
  private readonly terminals = new Map<string, Terminal>()
  /**
   * issueNumber → its implementation cc terminal (the one spawned by
   * `handleImplement`). Used by the auto-review flow to `sendText` review
   * feedback back into the running implementation conversation. Kept
   * separate from `terminals` because at spawn time we don't yet have a
   * sessionId, and even later the impl session id lives in a different
   * field of the state JSON.
   */
  private readonly implTerminals = new Map<number, Terminal>()

  /**
   * codex review terminals keyed by review session id (codex thread_id).
   * Lets `handleResumeReviewSession` reuse an existing tab instead of
   * spawning a fresh one on every click.
   */
  private readonly reviewTerminals = new Map<string, Terminal>()

  /**
   * Tracks in-flight "create issue" runs keyed by the nonce embedded in the
   * cc prompt. Populated synchronously in `handleIssueCreate` before the
   * terminal is shown; the session watcher fills in `sessionId` once cc
   * starts writing its jsonl. The webhook coordinator drains entries via
   * `takePendingIssueCreation` when the corresponding `issues opened`
   * payload arrives, then merges the column / sessionId / profilePath /
   * color into the state-JSON comment and cleans up the inbox tmpdir.
   */
  private readonly pendingIssueCreations = new Map<string, {
    sessionId?: string
    profilePath?: string
    /** Palette id (e.g. `terminal.ansiBlue`) — same shape stored in state JSON. */
    color: string
    workspaceRoot: string
    inboxDir: string
    terminalName: string
    createdAt: number
  }>()

  private constructor(private readonly context: ExtensionContext, panel: WebviewPanel) {
    this.panel = panel

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    }

    this.panel.webview.html = this.buildHtml()

    // Let the always-on webhook coordinator know who to refresh + toast for.
    webhookCoordinator.setActivePanel(this)

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg: WebviewToExtension) => this.handleMessage(msg)),
      // Forward every new log entry to the webview so the log modal stays
      // live without polling.
      logger.onEntry(entry => this.postMessage({ type: 'logs/append', entry })),
      // Drop tracked terminals when the user closes them, so the next Enter
      // on that card spawns a fresh tab instead of trying to .show() a dead
      // handle.
      window.onDidCloseTerminal((closed) => {
        for (const [sid, t] of this.terminals) {
          if (t === closed) {
            this.terminals.delete(sid)
            break
          }
        }
        for (const [n, t] of this.implTerminals) {
          if (t === closed) {
            this.implTerminals.delete(n)
            break
          }
        }
        for (const [sid, t] of this.reviewTerminals) {
          if (t === closed) {
            this.reviewTerminals.delete(sid)
            break
          }
        }
      }),
    )
  }

  static createOrShow(context: ExtensionContext): void {
    if (KanbanWebviewPanel.current) {
      KanbanWebviewPanel.current.panel.reveal(ViewColumn.Active)
      return
    }
    const panel = window.createWebviewPanel(
      KanbanWebviewPanel.viewType,
      'Superpowers Kanban',
      ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          Uri.joinPath(context.extensionUri, 'dist', 'webview-ui'),
        ],
      },
    )
    KanbanWebviewPanel.current = new KanbanWebviewPanel(context, panel)
  }

  /** Triggers a fresh load on the currently open panel, if any. */
  static refresh(): void {
    KanbanWebviewPanel.current?.loadAndPush().catch(() => {})
  }

  private handleMessage(msg: WebviewToExtension): void {
    if (msg.type === 'issues/refresh') {
      void this.loadAndPush()
      return
    }
    if (msg.type === 'settings/save') {
      void this.handleSettingsSave(msg)
      return
    }
    if (msg.type === 'settings/edit-request') {
      void this.handleEditSettingsRequest()
      return
    }
    if (msg.type === 'issue/create') {
      void this.handleIssueCreate(msg.userRequest, msg.images, msg.profilePath)
      return
    }
    if (msg.type === 'profiles/list') {
      void this.handleProfilesList()
      return
    }
    if (msg.type === 'toast/open-url') {
      void env.openExternal(Uri.parse(msg.url))
      return
    }
    if (msg.type === 'session/resume') {
      void this.handleResumeSession(msg.sessionId, msg.profilePath, msg.cwd, msg.issueNumber)
      return
    }
    if (msg.type === 'session/focus') {
      this.handleSessionFocus(msg.sessionId)
      return
    }
    if (msg.type === 'session/resume-review') {
      void this.handleResumeReviewSession(msg.sessionId, msg.issueNumber, msg.cwd)
      return
    }
    if (msg.type === 'editor/open-file') {
      void this.handleOpenFile(msg.path)
      return
    }
    if (msg.type === 'session/load-files') {
      void this.handleLoadFiles(msg.sessionId, msg.issueNumber)
      return
    }
    if (msg.type === 'issue/implement') {
      void this.handleImplement(msg.issueNumber, msg.planFile, msg.profilePath, msg.sessionId)
      return
    }
    if (msg.type === 'pr/open') {
      void this.handleOpenPr(msg.pr)
      return
    }
    if (msg.type === 'worktree/open') {
      void this.handleOpenWorktree(msg.path)
      return
    }
    if (msg.type === 'worktree/delete') {
      void this.handleDeleteWorktree(msg.issueNumber, msg.path)
      return
    }
    if (msg.type === 'column/change') {
      void this.handleColumnChange(msg.issueNumber, msg.toColumn)
      return
    }
    if (msg.type === 'dependency/set') {
      void this.handleSetDependency(msg.issueNumber, msg.prerequisiteNumber)
      return
    }
    if (msg.type === 'dependency/clear') {
      void this.handleClearDependency(msg.issueNumber, msg.prerequisiteNumber)
      return
    }
    if (msg.type === 'issue/update-auto-review') {
      void this.handleUpdateAutoReview(msg.issueNumber, msg.value)
      return
    }
    if (msg.type === 'logs/fetch') {
      this.postMessage({ type: 'logs/snapshot', entries: logger.snapshot() })
      return
    }
    if (msg.type === 'logs/clear') {
      logger.clear()
      this.postMessage({ type: 'logs/cleared' })
    }
  }

  private resolveTerminalLocation(preserveFocus: boolean): TerminalEditorLocationOptions {
    // Look for any tab belonging to a terminal we already manage; reuse its
    // column so the new terminal stacks as a tab in the same group. This
    // runs synchronously at spawn time — by now the existing terminal's
    // tab is definitely in tabGroups.all (no async race).
    //
    // We track terminals across multiple Maps (sessionId-keyed for cc
    // resumes, issueNumber-keyed for impl spawns); iterate ALL of them.
    const tracked: Terminal[] = [
      ...this.terminals.values(),
      ...this.implTerminals.values(),
      ...this.reviewTerminals.values(),
    ]
    for (const existing of tracked) {
      for (const group of window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof TabInputTerminal && tab.label.startsWith(existing.name)) {
            logger.add({
              level: 'info',
              source: 'terminal',
              message: `复用列 ${group.viewColumn}`,
              details: `匹配到现有终端 "${existing.name}" 的 tab "${tab.label}"`,
            })
            return { viewColumn: group.viewColumn, preserveFocus }
          }
        }
      }
    }
    logger.add({
      level: 'info',
      source: 'terminal',
      message: '未找到已存在的终端 tab，使用 Beside',
      details: `terminals.size=${this.terminals.size}, implTerminals.size=${this.implTerminals.size}, tabGroups.all.length=${window.tabGroups.all.length}`,
    })
    return { viewColumn: ViewColumn.Beside, preserveFocus }
  }

  /**
   * Resolve the ThemeColor to use for an issue's terminal/tab. Reads the
   * stored color from the issue's state JSON; if absent or invalid, picks a
   * random palette entry and asynchronously persists it back so future
   * sessions reuse the same tone.
   *
   * Always returns a ThemeColor (never undefined) — caller is expected to
   * only call this once it has a usable workspace + Gitea remote + token.
   * Persistence failures are logged and swallowed.
   */
  private async resolveIssueIcon(issueNumber: number): Promise<{ themeColor: ThemeColor, iconUri: Uri }> {
    // Helper: produce both representations from a palette id.
    const pack = (id: string) => ({
      themeColor: new ThemeColor(id),
      iconUri: themeColorIdToIconUri(id),
    })
    // Deterministic fallback when we can't talk to gitea (no workspace, no
    // remote, no token). Matches what `issueTerminalColor(issueNumber)` would
    // pick so the icon is still stable across sessions.
    const fallbackId = PALETTE[((issueNumber % PALETTE.length) + PALETTE.length) % PALETTE.length]

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot)
      return pack(fallbackId)
    const remote = await detectRepo(workspaceRoot)
    if (!remote)
      return pack(fallbackId)
    const token = await getToken(this.context, remote.host)
    if (!token)
      return pack(fallbackId)

    let stored: string | undefined
    try {
      const state = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
      if (typeof state.color === 'string' && state.color.length > 0)
        stored = state.color
    }
    catch (err) {
      console.warn('[superpowers] failed to read state JSON for color:', err)
    }

    const { id, isNew } = resolveIssueColor(stored)
    if (isNew) {
      // Fire-and-forget: don't block terminal creation on the network round
      // trip. Failures are non-fatal — the next session just picks again.
      void mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { color: id },
      })
        .then(() => {
          void this.loadAndPush()
        })
        .catch((err) => {
          console.warn('[superpowers] failed to persist issue color:', err)
        })
    }
    return pack(id)
  }

  private async handleResumeSession(sessionId: string, profilePath?: string, relCwd?: string, issueNumber?: number): Promise<void> {
    // Server-side prerequisite gate. Webview already disables the entry
    // visually (see `isIssueLocked` in the kanban UI), but a user who
    // bypasses that — message tampering, editing Gitea directly, etc. —
    // would otherwise still get a session. Skip when `issueNumber` is
    // unknown (legacy sessions) so we don't gate flows that never had a
    // prerequisite concept.
    if (issueNumber !== undefined) {
      const lockCheck = await this.resolveLockedReason(issueNumber)
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

    const existing = this.terminals.get(sessionId)
    if (existing) {
      existing.show(false)
      return
    }
    const effectiveProfilePath
      = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
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
    const effectiveCwd = relCwd && workspaceRoot
      ? path.join(workspaceRoot, relCwd)
      : workspaceRoot
    // Open the terminal as an editor tab beside the kanban (not in the
    // bottom panel), so the user can see both side-by-side. `Beside` opens
    // in a new editor group when needed.
    // Name reflects which of the three session roles this is:
    //   relCwd present  → 实施 session (resumed inside the worktree)
    //   relCwd absent   → 规划 / discussion session (workspace root)
    // Fall back to the legacy id-suffixed name if we somehow lack issueNumber.
    const sessionRole = relCwd ? '实施' : '规划'
    const terminalName = issueNumber !== undefined
      ? `issue-${issueNumber}-${sessionRole}`
      : `Claude · ${sessionId.slice(0, 8)}`
    // Scan live terminals before creating a new one — survives panel
    // reload / webview rebuild where `this.terminals` got wiped but the
    // tab is still open. Refresh the Map too so subsequent lookups (and
    // selection-change focus calls) keep working.
    const existingByName = this.findExistingTerminal(terminalName)
    if (existingByName) {
      this.terminals.set(sessionId, existingByName)
      existingByName.show(false)
      return
    }
    // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
    // `color` option — only the panel-view icon does. Force a `circle-filled`
    // codicon so the tab actually shows the issue color. Keep `color` too:
    // harmless in the editor tab, still useful if the same terminal ever
    // gets rendered in panel-view mode.
    const issueIcon = issueNumber !== undefined
      ? await this.resolveIssueIcon(issueNumber)
      : undefined
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: this.resolveTerminalLocation(false),
      ...(issueIcon ? { iconPath: issueIcon.iconUri, color: issueIcon.themeColor } : {}),
    })
    this.terminals.set(sessionId, terminal)
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })
    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --resume ${sessionId}`
    terminal.sendText(cmd)
  }

  /**
   * Inject review feedback into the implementation terminal for `issueNumber`.
   * Called from the webhook coordinator's auto-review path. Returns `true`
   * when a terminal was found and `sendText` was called; `false` otherwise
   * (so the caller can log a warning).
   *
   * Falls back to looking up by terminal name when the in-memory map miss
   * happens — e.g. after a window reload, the impl terminal might still be
   * present in `window.terminals` but absent from `this.implTerminals`.
   */
  injectIntoImplTerminal(issueNumber: number, text: string, isFirstReview: boolean): boolean {
    let terminal = this.implTerminals.get(issueNumber)
    if (!terminal) {
      // Match by prefix — shell OSC title escapes can append a git branch
      // suffix to terminal.name (e.g. "issue-48-实施 5f56026c").
      const wantedPrefix = `issue-${issueNumber}-实施`
      for (const t of window.terminals) {
        if (t.name.startsWith(wantedPrefix)) {
          terminal = t
          this.implTerminals.set(issueNumber, t)
          break
        }
      }
    }
    if (!terminal)
      return false
    // cc 的 TUI 在 raw 模式下，LF (\n) 只算输入框内的换行，CR (\r)
    // 才会被识别为 Enter（提交消息）。VS Code 的 sendText(..., true)
    // 在 Linux 上追加的是 LF，所以这里手动末尾接一个 \r、addNewLine
    // 设 false。
    //
    // 「合并到 main」这句仅首次审查带——synchronize 触发的复审表示 cc
    // 已经在迭代了，重复发会让它把未完工的改动合进 main。
    const suffix = isFirstReview ? '\n如果确认没问题就合并到main分支但暂时不要清理工作区' : ''
    const payload = `\n[审查反馈]\n${text}${suffix}\r`
    terminal.sendText(payload, false)
    return true
  }

  /**
   * Scan `vscode.window.terminals` for an existing terminal whose name
   * matches `expectedName`. Matches exact, or `startsWith(expectedName + ' ')`
   * so a shell that appended a git branch suffix (e.g. "issue-48-实施
   * 5f56026c") still counts. Skips terminals whose process already exited
   * (`exitStatus !== undefined`) — those are zombie tabs and shouldn't block
   * a fresh spawn.
   *
   * Why this exists: every session entry (`handleResumeSession`,
   * `handleResumeReviewSession`, `handleImplement`) used to dedupe via its
   * own in-memory Map (sessionId → Terminal). Panel reload / webview rebuild
   * wipes those Maps, but the terminal stays alive in `window.terminals`,
   * so re-clicking the link spawned a duplicate tab. Scanning the live
   * terminal list survives reloads and prevents cross-map blind spots.
   */
  private findExistingTerminal(expectedName: string): Terminal | undefined {
    return window.terminals.find(
      t =>
        t.exitStatus === undefined
        && (t.name === expectedName || t.name.startsWith(`${expectedName} `)),
    )
  }

  private async handleResumeReviewSession(sessionId: string, issueNumber: number, relCwd?: string): Promise<void> {
    // Server-side prerequisite gate — consistent with handleResumeSession /
    // handleImplement. In practice review sessions imply the issue has
    // moved past todo (a worktree must exist), but enforcing here keeps
    // the contract uniform.
    const lockCheck = await this.resolveLockedReason(issueNumber)
    if (lockCheck.locked) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `拒绝打开审查会话 #${issueNumber}：前置 #${lockCheck.prerequisiteNumber} 未完成`,
      })
      await window.showWarningMessage(`等待前置工单 #${lockCheck.prerequisiteNumber} 完成`)
      return
    }

    const existing = this.reviewTerminals.get(sessionId)
    if (existing) {
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
    const existingByName = this.findExistingTerminal(reviewTerminalName)
    if (existingByName) {
      this.reviewTerminals.set(sessionId, existingByName)
      existingByName.show(false)
      return
    }
    // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
    // `color` option. Force a `circle-filled` codicon so the tab actually
    // shows the issue color; keep `color` too for panel-view fallback.
    const { themeColor, iconUri } = await this.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: reviewTerminalName,
      cwd: worktreeAbs,
      location: this.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    this.reviewTerminals.set(sessionId, terminal)
    terminal.show(false)
    terminal.sendText(`codex resume --dangerously-bypass-approvals-and-sandbox ${sessionId}`)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建审查会话终端 #${issueNumber} cwd=${worktreeAbs}`,
    })
  }

  /**
   * Focus an already-open terminal for `sessionId` without stealing focus
   * from the kanban. Called when the webview's selection changes via arrow
   * keys / clicks — if there's no terminal for this session yet, this is a
   * no-op (user has to press Enter to spawn one).
   */
  private handleSessionFocus(sessionId: string): void {
    const existing = this.terminals.get(sessionId)
    if (!existing)
      return
    existing.show(true)
  }

  /**
   * Resolve a workspace-relative path against the current workspace root and
   * open it in VS Code. Markdown files (`.md`) are opened in the rendered
   * preview via `markdown.showPreview`; other file types fall back to
   * `vscode.open`. Surfaces failures as an error toast (e.g. file deleted on
   * disk after we recorded its path).
   */
  private async handleOpenFile(relPath: string): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }
    const abs = path.join(workspaceRoot, relPath)
    const isMarkdown = abs.toLowerCase().endsWith('.md')
    try {
      if (isMarkdown) {
        await commands.executeCommand('markdown.showPreview', Uri.file(abs))
      }
      else {
        await commands.executeCommand('vscode.open', Uri.file(abs))
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `打开文件失败: ${message}`,
        dismissOnTimer: 6000,
      })
    }
  }

  /**
   * Scan the Claude Code session transcript for `sessionId` to find the
   * latest spec/plan file references, then merge them into the issue's
   * state-JSON last comment by posting an updated comment. Refreshes the
   * kanban afterwards so the new fields show up in the detail panel.
   *
   * Re-fetches the issue's comments fresh from Gitea rather than relying on
   * webview state, since the webview's copy is loaded once per refresh and
   * may be stale.
   */
  private async handleLoadFiles(sessionId: string, issueNumber: number): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    const toastId = makeNonce()
    this.postMessage({
      type: 'toast/show',
      id: toastId,
      level: 'info',
      message: '正在扫描 spec/plan…',
      spinner: true,
    })

    try {
      const scan = await scanSessionFiles({ workspaceRoot, sessionId })

      if (!scan.specFile && !scan.planFile) {
        this.postMessage({
          type: 'toast/show',
          id: toastId,
          level: 'error',
          message: '未在会话中找到 docs/superpowers 文件',
          dismissOnTimer: 6000,
        })
        return
      }

      // Re-fetch this issue's comments so we mutate the freshest state JSON.
      const comments = await listIssueComments({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: issueNumber,
      })

      let currentState: Record<string, unknown> = {}
      if (comments.length > 0) {
        const lastBody = (comments[comments.length - 1].body ?? '').trim()
        if (lastBody) {
          try {
            const parsed = JSON.parse(lastBody) as unknown
            if (parsed && typeof parsed === 'object')
              currentState = parsed as Record<string, unknown>
          }
          catch {
            // Last comment wasn't JSON; start fresh.
          }
        }
      }

      const merged: Record<string, unknown> = { ...currentState }
      if (scan.specFile)
        merged.specFile = scan.specFile
      if (scan.planFile)
        merged.planFile = scan.planFile

      await postIssueComment({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: issueNumber,
        body: JSON.stringify(merged),
      })

      this.postMessage({
        type: 'toast/show',
        id: toastId,
        level: 'success',
        message: '已写入 spec/plan 引用',
        dismissOnTimer: 5000,
      })

      void this.loadAndPush()
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: toastId,
        level: 'error',
        message: `扫描失败: ${message}`,
        dismissOnTimer: 8000,
      })
    }
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
  private async handleImplement(
    issueNumber: number,
    planFile: string,
    profilePath?: string,
    _sessionId?: string,
  ): Promise<void> {
    // Server-side prerequisite gate — webview disables the implement
    // button when the prerequisite isn't done, but enforce here too so
    // tampered messages can't slip past.
    const lockCheck = await this.resolveLockedReason(issueNumber)
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
    const existingImpl = this.findExistingTerminal(implTerminalName)
    if (existingImpl) {
      this.implTerminals.set(issueNumber, existingImpl)
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
    const token = await getToken(this.context, remote.host)
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

    const effectiveProfilePath
      = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
    // Same guard as handleResumeSession — we wrap with single quotes and
    // embedded quotes would break out of the wrap. Defensive only.
    if (effectiveProfilePath.includes('\'')) {
      void window.showErrorMessage(
        `实施失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
      )
      return
    }

    const settings = getSettings(this.context)
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
      void this.loadAndPush()
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
    const prompt = getImplementPlanPrompt(this.context, { planFile, issueNumber })
    if (prompt.includes('\'')) {
      void window.showErrorMessage('实施失败：prompt 含单引号，拒绝执行')
      return
    }

    // VS Code's default editor-tab icon (`>` arrow) does NOT honor the
    // `color` option. Force a `circle-filled` codicon so the tab actually
    // shows the issue color; keep `color` too for panel-view fallback.
    const { themeColor, iconUri } = await this.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: `issue-${issueNumber}-实施`,
      cwd: worktreePath,
      location: this.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    terminal.show(false)
    // Track for the auto-review flow: synchronize callbacks call
    // `injectIntoImplTerminal(issueNumber, text)` to feed review feedback
    // back into the same running cc session.
    this.implTerminals.set(issueNumber, terminal)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })
    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' '${prompt}'`
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
        void this.loadAndPush()
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
   * Resolve the gitea PR URL for the current workspace's remote and open it
   * in the user's default browser. Called from the webview's pr-link
   * button.
   */
  private async handleOpenPr(pr: string): Promise<void> {
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
    const url = `https://${remote.host}/${remote.owner}/${remote.repo}/pulls/${pr}`
    void env.openExternal(Uri.parse(url))
  }

  /**
   * Open the worktree directory in a **new** VS Code window. The Boolean
   * third arg to `vscode.openFolder` is "forceNewWindow"; we always force
   * a new window so the user keeps the kanban window open in parallel.
   */
  private async handleOpenWorktree(relPath: string): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      void window.showErrorMessage('请先打开一个工作区文件夹')
      return
    }
    const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath)
    try {
      await commands.executeCommand('vscode.openFolder', Uri.file(abs), true)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void window.showErrorMessage(`打开 worktree 失败: ${message}`)
    }
  }

  /**
   * Confirm + run `git worktree remove <abs>` (no --force), then clear
   * `worktreePath`/`branch` from the issue's state JSON and refresh the
   * board. If `git` rejects due to uncommitted changes we surface stderr
   * verbatim — the user can resolve manually and re-try.
   */
  private async handleDeleteWorktree(issueNumber: number, relPath: string): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      void window.showErrorMessage('请先打开一个工作区文件夹')
      return
    }
    const choice = await window.showWarningMessage(
      `确认删除 worktree ${relPath}?`,
      { modal: true },
      '删除',
    )
    if (choice !== '删除')
      return

    const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath)
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'git',
          ['-C', workspaceRoot, 'worktree', 'remove', abs],
          { timeout: 30_000 },
          (err, _stdout, stderr) => {
            if (err) {
              const detail = (stderr ?? '').trim() || err.message
              reject(new Error(detail))
              return
            }
            resolve()
          },
        )
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      void window.showErrorMessage(`git worktree remove 失败: ${message}`)
      return
    }

    // Best-effort: clear worktreePath + branch from the state JSON so the
    // detail panel reflects reality on the next refresh. Failures here are
    // non-fatal (worktree is already gone on disk).
    try {
      const remote = await detectRepo(workspaceRoot)
      if (remote) {
        const token = await getToken(this.context, remote.host)
        if (token) {
          await mergeStateJsonComment({
            host: remote.host,
            owner: remote.owner,
            repo: remote.repo,
            token,
            issueNumber,
            extra: { worktreePath: '', branch: '' },
          })
        }
      }
    }
    catch (err) {
      console.warn('[superpowers] failed to clear worktree state JSON:', err)
    }

    void this.loadAndPush()
    void window.showInformationMessage(`已删除 worktree #${issueNumber}`)
  }

  /**
   * Persist a kanban column change to Gitea state JSON. Today we only handle
   * `toColumn === 'done'` — other targets stay client-visual-only.
   *
   * Done flow:
   *   1. Re-fetch the issue's last comment, parse state JSON for `pr` and
   *      `worktreePath`.
   *   2. Require a `pr` field; require the PR is merged on gitea. Otherwise
   *      reject with an error toast and refresh to visually revert the
   *      optimistic move.
   *   3. Merge `{column: 'done'}` into state JSON.
   *   4. Best-effort: `git worktree remove --force` the worktree if it still
   *      exists (force is OK here since the work is already shipped via PR).
   *   5. Refresh + success toast.
   */
  private async handleColumnChange(issueNumber: number, toColumn: IssueColumn): Promise<void> {
    if (toColumn !== 'done') {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `暂不处理 toColumn=${toColumn} 的拖放持久化 (issue #${issueNumber})`,
      })
      return
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    // 1. Re-fetch latest state JSON for this issue.
    let prStr: string | undefined
    let worktreePath: string | undefined
    try {
      const comments = await listIssueComments({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: issueNumber,
      })
      if (comments.length > 0) {
        const lastBody = (comments[comments.length - 1].body ?? '').trim()
        if (lastBody) {
          try {
            const parsed = JSON.parse(lastBody) as unknown
            if (parsed && typeof parsed === 'object') {
              const obj = parsed as Record<string, unknown>
              if (typeof obj.pr === 'string' && obj.pr.length > 0)
                prStr = obj.pr
              if (typeof obj.worktreePath === 'string' && obj.worktreePath.length > 0)
                worktreePath = obj.worktreePath
            }
          }
          catch {
            // Non-JSON last comment; leave both undefined.
          }
        }
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `读取工单 #${issueNumber} 状态失败`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `读取工单 #${issueNumber} 状态失败: ${message}`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    // 2. Require a PR association.
    if (!prStr) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `工单 #${issueNumber} 无关联 PR，无法标记完成`,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `工单 #${issueNumber} 无关联 PR，无法标记完成`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    const prIndex = Number.parseInt(prStr, 10)
    if (!Number.isFinite(prIndex)) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `工单 #${issueNumber} 的 PR 字段无效: ${prStr}`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    // 3. Look up PR state on gitea.
    let pullRequest: Awaited<ReturnType<typeof getPullRequest>>
    try {
      pullRequest = await getPullRequest({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: prIndex,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `读取 PR #${prIndex} 状态失败 (issue #${issueNumber})`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `无法读取 PR #${prIndex} 状态: ${message}`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    if (!pullRequest.merged) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `PR #${prIndex} 尚未合并，工单 #${issueNumber} 不能完成`,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `PR #${prIndex} 尚未合并，工单 #${issueNumber} 不能完成`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    // 4. PR is merged — persist column='done' to state JSON.
    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { column: 'done' },
      })
      logger.add({
        level: 'info',
        source: 'panel',
        message: `工单 #${issueNumber} column=done 已持久化`,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `持久化 column=done 失败 (issue #${issueNumber})`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `保存工单 #${issueNumber} 状态失败: ${message}`,
        dismissOnTimer: 6000,
      })
      void this.loadAndPush()
      return
    }

    // 5. Best-effort cleanup of the worktree. Failures are non-fatal — the
    // state JSON already records done, user can manually clean later.
    if (worktreePath) {
      const abs = path.isAbsolute(worktreePath)
        ? worktreePath
        : path.join(workspaceRoot, worktreePath)
      if (fs.existsSync(abs)) {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'git',
              ['-C', workspaceRoot, 'worktree', 'remove', '--force', abs],
              { timeout: 30_000 },
              (err, _stdout, stderr) => {
                if (err) {
                  const detail = (stderr ?? '').trim() || err.message
                  reject(new Error(detail))
                  return
                }
                resolve()
              },
            )
          })
          logger.add({
            level: 'info',
            source: 'panel',
            message: `已清理 worktree ${worktreePath} (issue #${issueNumber})`,
          })
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.add({
            level: 'warn',
            source: 'panel',
            message: `清理 worktree 失败 (issue #${issueNumber})`,
            details: message,
          })
          this.postMessage({
            type: 'toast/show',
            id: makeNonce(),
            level: 'error',
            message: `工单 #${issueNumber} 已完成，但 worktree 清理失败: ${message}`,
            dismissOnTimer: 6000,
          })
          void this.loadAndPush()
          return
        }
      }
    }

    void this.loadAndPush()
    this.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: `工单 #${issueNumber} 已完成，worktree 已清理`,
      dismissOnTimer: 5000,
    })
  }

  /**
   * Server-side lock check for prerequisite gating. Fetches a fresh issues
   * snapshot (we don't trust webview state) and reports whether
   * `issueNumber` is blocked by an unfinished prerequisite. Mirrors the
   * webview-side `isIssueLocked` predicate: locked iff the issue has a
   * prerequisite that exists in the current snapshot and is not yet in the
   * `done` column.
   *
   * Fail-open: any error fetching issues is logged and we return
   * `{ locked: false }` so a transient Gitea hiccup can't lock the user out
   * of starting a session.
   */
  private async resolveLockedReason(
    issueNumber: number,
  ): Promise<{ locked: boolean, prerequisiteNumber?: number, prerequisiteColumn?: string }> {
    try {
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!workspaceRoot)
        return { locked: false }
      const remote = await detectRepo(workspaceRoot)
      if (!remote)
        return { locked: false }
      const token = await getToken(this.context, remote.host)
      if (!token)
        return { locked: false }
      const issues = await loadIssues({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        workspaceRoot,
      })
      const issue = issues.find(i => i.number === issueNumber)
      if (!issue)
        return { locked: false }
      if (issue.prerequisite === undefined)
        return { locked: false }
      const prereq = issues.find(i => i.number === issue.prerequisite)
      if (!prereq)
        return { locked: false }
      if (prereq.column === 'done')
        return { locked: false }
      return {
        locked: true,
        prerequisiteNumber: prereq.number,
        prerequisiteColumn: prereq.column,
      }
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `锁定检查失败，放行 #${issueNumber}`,
        details: message,
      })
      return { locked: false }
    }
  }

  private async handleSetDependency(issueNumber: number, prerequisiteNumber: number): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    try {
      await addDependency({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: issueNumber,
        dependencyIndex: prerequisiteNumber,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `设置工单 #${issueNumber} 依赖 #${prerequisiteNumber} 失败`,
        details: message,
      })
      void window.showWarningMessage(`设置工单 #${issueNumber} 依赖 #${prerequisiteNumber} 失败: ${message}`)
      return
    }

    logger.add({
      level: 'info',
      source: 'panel',
      message: `工单 #${issueNumber} 已设置前置依赖 #${prerequisiteNumber}`,
    })
    void this.loadAndPush()
  }

  private async handleClearDependency(issueNumber: number, prerequisiteNumber: number): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    try {
      await removeDependency({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        index: issueNumber,
        dependencyIndex: prerequisiteNumber,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `清除工单 #${issueNumber} 依赖 #${prerequisiteNumber} 失败`,
        details: message,
      })
      void window.showWarningMessage(`清除工单 #${issueNumber} 依赖 #${prerequisiteNumber} 失败: ${message}`)
      return
    }

    logger.add({
      level: 'info',
      source: 'panel',
      message: `工单 #${issueNumber} 已清除前置依赖 #${prerequisiteNumber}`,
    })
    void this.loadAndPush()
  }

  /**
   * Persist the per-issue `autoReview` override into the issue's state-JSON
   * comment. The webhook coordinator reads this on every PR `opened` /
   * `synchronize` to decide whether to fire a review. Set true/false → use
   * that value; we never write back `undefined` (the user explicitly chose).
   */
  private async handleUpdateAutoReview(issueNumber: number, value: boolean): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    // Snapshot the previous value so we can roll the webview back on failure
    // without re-broadcasting the whole issues list.
    let previousValue: boolean | undefined
    try {
      const existingState = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
      previousValue = typeof existingState.autoReview === 'boolean'
        ? existingState.autoReview
        : undefined
    }
    catch {
      // If we can't read the previous state, leave previousValue undefined —
      // the rollback patch will clear the override, which is the safest
      // recovery (webview will fall back to the global autoReview default).
      previousValue = undefined
    }

    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { autoReview: value },
      })
      logger.add({
        level: 'info',
        source: 'panel',
        message: `工单 #${issueNumber} autoReview=${value} 已持久化`,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `持久化 autoReview 失败 (issue #${issueNumber})`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `保存工单 #${issueNumber} 自动审查开关失败: ${message}`,
        dismissOnTimer: 6000,
      })
      // Roll back the optimistic update in the webview.
      this.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { autoReview: previousValue },
      })
    }
  }

  /**
   * Reloads issues from gitea and pushes to the webview. Public so the
   * always-on webhook coordinator can refresh us when a PR event arrives.
   */
  async loadAndPush(): Promise<void> {
    this.postMessage({ type: 'issues/loading' })

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    // eslint-disable-next-line no-console
    console.log('[superpowers/panel] loadAndPush workspaceRoot=', workspaceRoot)
    if (!workspaceRoot) {
      this.postMessage({
        type: 'issues/error',
        message: '请先打开一个工作区文件夹',
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'issues/error',
        message: '当前工作区没有 Gitea 远程仓库',
      })
      return
    }

    const { host, owner, repo } = remote
    const token = await getToken(this.context, host)
    if (!token) {
      const s = getSettings(this.context)
      this.postMessage({
        type: 'settings/show',
        host,
        tokenSaved: false,
        webhookPort: s.webhookPort,
        createIssuePrompt: s.createIssuePrompt,
        implementPlanPrompt: s.implementPlanPrompt,
        autoReview: s.autoReview,
        reviewPrompt: s.reviewPrompt,
      })
      return
    }

    try {
      const issues = await loadIssues({ host, token, owner, repo, workspaceRoot })
      this.postMessage({
        type: 'issues/update',
        issues,
        globalAutoReview: getSettings(this.context).autoReview,
      })
    }
    catch (err) {
      if (err instanceof GiteaApiError && err.status === 401) {
        await deleteToken(this.context, host)
        const s = getSettings(this.context)
        this.postMessage({
          type: 'settings/show',
          host,
          errorMessage: 'Token 无效或已过期，请重新填写',
          tokenSaved: false,
          webhookPort: s.webhookPort,
          createIssuePrompt: s.createIssuePrompt,
          implementPlanPrompt: s.implementPlanPrompt,
          autoReview: s.autoReview,
          reviewPrompt: s.reviewPrompt,
        })
        return
      }
      const baseMessage = err instanceof Error ? err.message : String(err)
      const message = `${baseMessage}\n\n[debug] host=${host} owner=${owner} repo=${repo}`
      this.postMessage({ type: 'issues/error', message })
    }
  }

  private async handleSettingsSave(payload: {
    host: string
    token: string
    webhookPort: number
    createIssuePrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
  }): Promise<void> {
    const trimmedHost = payload.host.trim()
    const trimmedToken = payload.token.trim()
    const prev = getSettings(this.context)
    // Capture the previous token *for this host* before overwriting it, so
    // we can decide below whether the kanban needs a re-fetch. (Only host
    // and token affect the issue list — port/url-prefix/prompts don't.)
    const oldToken = trimmedHost ? await getToken(this.context, trimmedHost) : undefined
    // Empty token + existing saved token = user wants to keep the existing
    // one (placeholder semantics in the modal). Skip rewriting and skip the
    // kanban refresh since auth didn't change.
    const keepExisting = trimmedToken === '' && !!oldToken
    if (!trimmedHost || (!trimmedToken && !keepExisting)) {
      this.postMessage({
        type: 'settings/show',
        host: trimmedHost,
        errorMessage: 'Host 和 Token 都不能为空',
        tokenSaved: !!oldToken,
        webhookPort: payload.webhookPort,
        createIssuePrompt: payload.createIssuePrompt || prev.createIssuePrompt,
        implementPlanPrompt: payload.implementPlanPrompt || prev.implementPlanPrompt,
        autoReview: payload.autoReview,
        reviewPrompt: payload.reviewPrompt || prev.reviewPrompt,
      })
      return
    }
    await saveSettings(this.context, {
      webhookPort: payload.webhookPort,
      createIssuePrompt: payload.createIssuePrompt,
      implementPlanPrompt: payload.implementPlanPrompt,
      autoReview: payload.autoReview,
      reviewPrompt: payload.reviewPrompt,
    })
    if (!keepExisting)
      await setToken(this.context, trimmedHost, trimmedToken)
    // Honor a port change without requiring a window reload. Restart the
    // listener and emit a log entry when the port actually changed so the
    // user can see it in the log modal.
    const newPort = getSettings(this.context).webhookPort
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
      await this.loadAndPush()
  }

  private async handleEditSettingsRequest(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    let host = ''
    if (workspaceRoot) {
      const remote = await detectRepo(workspaceRoot)
      if (remote)
        host = remote.host
    }
    const s = getSettings(this.context)
    const tok = host ? await getToken(this.context, host) : undefined
    const tokenSaved = !!tok && tok.length > 0
    // User clicked the gear themselves — let them back out without saving.
    this.postMessage({
      type: 'settings/show',
      host,
      canCancel: true,
      tokenSaved,
      webhookPort: s.webhookPort,
      createIssuePrompt: s.createIssuePrompt,
      implementPlanPrompt: s.implementPlanPrompt,
      autoReview: s.autoReview,
      reviewPrompt: s.reviewPrompt,
    })
  }

  private async handleIssueCreate(
    userRequest: string,
    images?: Array<{ mediaType: string, base64: string }>,
    profilePath?: string,
  ): Promise<void> {
    const trimmed = userRequest.trim()
    if (!trimmed) {
      // Webview already disables the submit button when empty, but be defensive.
      return
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      return
    }

    const remote = await detectRepo(workspaceRoot)
    if (!remote) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '当前工作区没有 Gitea 远程仓库',
        dismissOnTimer: 5000,
      })
      return
    }

    const token = await getToken(this.context, remote.host)
    if (!token) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    // Ensure the always-on webhook listener is up so we can receive the
    // `issues opened` callback that drives state-JSON fill-in.
    const settings = getSettings(this.context)
    try {
      await webhookCoordinator.ensurePort(settings.webhookPort)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `webhook 服务启动失败: ${message}`,
        dismissOnTimer: 8000,
      })
      return
    }

    const nonce = randomUUID()
    const shortNonce = nonce.slice(0, 8)
    const inboxDir = path.join(os.tmpdir(), 'spx-inbox', nonce)
    try {
      await fsp.mkdir(inboxDir, { recursive: true })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `创建临时目录失败: ${message}`,
        dismissOnTimer: 8000,
      })
      return
    }

    // Persist any pasted images to the inbox tmpdir so cc can Read them.
    // The `[Image #N]` tokens in `trimmed` stay in place — the prompt also
    // lists absolute paths at the end so cc can correlate.
    const mediaTypeToExt: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    const imagePaths: string[] = []
    if (images && images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const ext = mediaTypeToExt[img.mediaType.toLowerCase()] ?? 'png'
        const abs = path.join(inboxDir, `${i + 1}.${ext}`)
        try {
          await fsp.writeFile(abs, Buffer.from(img.base64, 'base64'))
          imagePaths.push(abs)
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.add({
            level: 'warn',
            source: 'panel',
            message: `图片落盘失败 (${i + 1}/${images.length})`,
            details: message,
          })
        }
      }
    }

    const color = pickRandomIssueColor()
    const prompt = getCreateIssuePrompt(this.context, {
      userRequest: trimmed,
      nonce,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    })
    if (prompt.includes('\'')) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '创建失败：prompt 含单引号，拒绝执行',
        dismissOnTimer: 8000,
      })
      try {
        await fsp.rm(inboxDir, { recursive: true, force: true })
      }
      catch {}
      return
    }

    const effectiveProfilePath
      = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
    if (effectiveProfilePath.includes('\'')) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `创建失败：profilePath 含单引号，拒绝执行 (${effectiveProfilePath})`,
        dismissOnTimer: 8000,
      })
      try {
        await fsp.rm(inboxDir, { recursive: true, force: true })
      }
      catch {}
      return
    }

    // Ensure the claude projects subdir exists *before* spawning the
    // terminal so the watcher can't miss the create event.
    const projDir = projectsDirFor(workspaceRoot)
    try {
      await fsp.mkdir(projDir, { recursive: true })
    }
    catch (err) {
      console.warn('[superpowers] failed to mkdir claude projects dir:', err)
    }
    const watchPromise = watchForNewSession({ projectsDir: projDir, timeoutMs: 120_000 })

    const terminalName = `issue-new-${shortNonce}-规划`
    const themeColor = new ThemeColor(color)
    const iconUri = themeColorIdToIconUri(color)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
      location: this.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })

    this.pendingIssueCreations.set(nonce, {
      profilePath: effectiveProfilePath,
      color,
      workspaceRoot,
      inboxDir,
      terminalName,
      createdAt: Date.now(),
    })

    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' '${prompt}'`
    terminal.sendText(cmd)
    logger.add({
      level: 'info',
      source: 'panel',
      message: `已发送新建工单 prompt nonce=${shortNonce}`,
    })

    this.postMessage({
      type: 'toast/show',
      id: `issue-new-${shortNonce}`,
      level: 'info',
      message: '正在打开新工单会话…',
      spinner: true,
      dismissOnTimer: 4000,
    })

    // Background: fill in sessionId once the jsonl materializes. If the
    // matching webhook fires before this resolves, the pending entry has
    // already been deleted and we silently no-op — the state JSON just
    // lacks sessionId in that (rare) race case, and the user can resume
    // from a later session id via the terminal.
    watchPromise.then((sid) => {
      if (!sid) {
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `新建工单会话监听超时 nonce=${shortNonce}`,
        })
        return
      }
      const pending = this.pendingIssueCreations.get(nonce)
      if (pending) {
        pending.sessionId = sid
        logger.add({
          level: 'info',
          source: 'panel',
          message: `已捕获新建工单会话 ${sid} nonce=${shortNonce}`,
        })
      }
    }).catch((err) => {
      console.warn('[superpowers] new-issue session watch failed:', err)
    })
  }

  /**
   * Read profiles from the hardcoded directory and push the list to the
   * webview. Failures are swallowed and surfaced as an empty list so the
   * modal simply hides its profile selector.
   */
  private async handleProfilesList(): Promise<void> {
    try {
      const profiles = await listClaudeProfiles()
      this.postMessage({ type: 'profiles/update', profiles })
    }
    catch {
      this.postMessage({ type: 'profiles/update', profiles: [] })
    }
  }

  /** Forces the open panel (if any) into the setup-auth state. */
  static requestEditAuth(): void {
    void KanbanWebviewPanel.current?.handleEditSettingsRequest()
  }

  postMessage(msg: ExtensionToWebview): void {
    void this.panel.webview.postMessage(msg)
  }

  /**
   * Removes and returns the {@link pendingIssueCreations} entry for the
   * given nonce, if any. Called by the webhook coordinator when a matching
   * `issues opened` payload arrives. Returning `undefined` (and leaving the
   * map untouched) signals "no match — treat as external issue creation".
   */
  takePendingIssueCreation(nonce: string): {
    sessionId?: string
    profilePath?: string
    color: string
    workspaceRoot: string
    inboxDir: string
    terminalName: string
    createdAt: number
  } | undefined {
    const entry = this.pendingIssueCreations.get(nonce)
    if (entry)
      this.pendingIssueCreations.delete(nonce)
    return entry
  }

  private dispose(): void {
    KanbanWebviewPanel.current = undefined
    webhookCoordinator.setActivePanel(undefined)
    while (this.disposables.length) {
      const d = this.disposables.pop()
      d?.dispose()
    }
    this.panel.dispose()
  }

  private buildHtml(): string {
    const distRoot = Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui')
    const indexPath = path.join(distRoot.fsPath, 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')

    const nonce = makeNonce()
    const cspSource = this.panel.webview.cspSource

    // 重写 src 和 href 的相对路径为 webview URI
    html = html.replace(/(src|href)="(\/[^"]+|\.\/[^"]+|[^"/][^"]*)"/g, (_m, attr, p) => {
      const cleaned = p.replace(/^\.?\//, '')
      const uri = this.panel.webview.asWebviewUri(Uri.joinPath(distRoot, cleaned))
      return `${attr}="${uri}"`
    })

    // 给所有 <script> 标签注入 nonce
    html = html.replace(/<script(\s[^>]*)?>/g, (_m, attrs) => {
      const a = attrs ?? ''
      return `<script nonce="${nonce}"${a}>`
    })

    // 注入 CSP
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`
    html = html.replace(
      /<head>/,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )

    return html
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64').replace(/[+/=]/g, '')
}
