import type {
  ExtensionContext,
  Terminal,
  TerminalEditorLocationOptions,
  WebviewPanel,
} from 'vscode'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { commands, env, TabInputTerminal, Uri, ViewColumn, window, workspace } from 'vscode'
import type { ExtensionToWebview, WebviewToExtension } from './messages'
import { issueTerminalColor } from './issueColor'
import { deleteToken, getToken, setToken } from '../auth/secrets'
import { createIssueViaClaude } from '../cc/createIssueFlow'
import { listClaudeProfiles } from '../cc/profiles'
import { getImplementPlanPrompt } from '../cc/prompts'
import { scanSessionFiles } from '../cc/sessionTranscript'
import { projectsDirFor, watchForNewSession } from '../cc/sessionWatcher'
import { detectRepo } from '../git/remote'
import { createWorktree } from '../git/worktree'
import {
  GiteaApiError,
  listIssueComments,
  postIssueComment,
} from '../gitea/api'
import { mergeStateJsonComment } from '../gitea/stateJson'
import { loadIssues } from '../gitea/issueLoader'
import { logger } from '../logging/logger'
import { getSettings, saveSettings } from '../settings/store'
import { webhookCoordinator } from '../webhook/coordinator'

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
      this.handleResumeSession(msg.sessionId, msg.profilePath, msg.cwd, msg.issueNumber)
      return
    }
    if (msg.type === 'session/focus') {
      this.handleSessionFocus(msg.sessionId)
      return
    }
    if (msg.type === 'session/resume-review') {
      this.handleResumeReviewSession(msg.sessionId, msg.issueNumber)
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

  

  

  private handleResumeSession(sessionId: string, profilePath?: string, relCwd?: string, issueNumber?: number): void {
    const existing = this.terminals.get(sessionId)
    if (existing) {
      existing.show(false)
      return
    }
    const effectiveProfilePath =
      profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
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
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: this.resolveTerminalLocation(false),
      ...(issueNumber !== undefined ? { color: issueTerminalColor(issueNumber) } : {}),
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
  injectIntoImplTerminal(issueNumber: number, text: string): boolean {
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
    const payload = `\n[审查反馈]\n${text}\n如果确认没问题就合并到main分支但暂时不要清理工作区\r`
    terminal.sendText(payload, false)
    return true
  }

  private handleResumeReviewSession(sessionId: string, issueNumber: number): void {
    const existing = this.reviewTerminals.get(sessionId)
    if (existing) {
      existing.show(false)
      return
    }
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    const terminal = window.createTerminal({
      name: `issue-${issueNumber}-审查`,
      cwd: workspaceRoot,
      location: this.resolveTerminalLocation(false),
      color: issueTerminalColor(issueNumber),
    })
    this.reviewTerminals.set(sessionId, terminal)
    terminal.show(false)
    terminal.sendText(`codex resume --dangerously-bypass-approvals-and-sandbox ${sessionId}`)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建审查会话终端 #${issueNumber}`,
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
      // eslint-disable-next-line no-console
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

    const terminal = window.createTerminal({
      name: `issue-${issueNumber}-实施`,
      cwd: worktreePath,
      location: this.resolveTerminalLocation(false),
      color: issueTerminalColor(issueNumber),
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
        // eslint-disable-next-line no-console
        console.warn('[superpowers] failed to persist implementSessionId:', err)
      }
    }).catch((err) => {
      // eslint-disable-next-line no-console
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

  /** Reloads issues from gitea and pushes to the webview. Public so the
   * always-on webhook coordinator can refresh us when a PR event arrives. */
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
      const issues = await loadIssues({ host, token, owner, repo })
      this.postMessage({ type: 'issues/update', issues })
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

    // The webview emits `toast/show` with the same id twice — first an
    // info-level spinner toast, then a success/error toast — so the UI
    // updates in place rather than stacking two distinct cards.
    await createIssueViaClaude({
      ctx: this.context,
      workspaceRoot,
      host: remote.host,
      owner: remote.owner,
      repo: remote.repo,
      token,
      userRequest: trimmed,
      images,
      profilePath,
      onProgress: (event) => {
        if (event.kind === 'started') {
          this.postMessage({
            type: 'toast/show',
            id: event.toastId,
            level: 'info',
            message: '正在创建工单…',
            spinner: true,
          })
          return
        }
        if (event.kind === 'success') {
          this.postMessage({
            type: 'toast/show',
            id: event.toastId,
            level: 'success',
            message: `#${event.issueNumber} 已创建`,
            link: { label: '查看', url: event.issueUrl },
            dismissOnTimer: 8000,
          })
          // Refresh kanban so the new card shows up in 待办.
          void this.loadAndPush()
          return
        }
        // failed
        this.postMessage({
          type: 'toast/show',
          id: event.toastId,
          level: 'error',
          message: event.message,
          dismissOnTimer: 10000,
        })
      },
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

  private postMessage(msg: ExtensionToWebview): void {
    void this.panel.webview.postMessage(msg)
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
