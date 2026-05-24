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
import { commands, env, extensions, TabInputTerminal, ThemeColor, Uri, ViewColumn, window, workspace } from 'vscode'
import { deleteToken, getToken, setToken } from '../auth/secrets'
import { listClaudeProfiles } from '../cc/profiles'
import { getBrainstormContinuePrompt, getBrainstormPrompt, getImplementPlanPrompt } from '../cc/prompts'
import { watchForNewCodexSession } from '../cc/codexSessionWatcher'
import { projectsDirFor, watchForNewSession } from '../cc/sessionWatcher'
import { spawnClaude } from '../cc/spawnClaude'
import { lockEnvFiles, findEnvFiles, unlockEnvFiles } from '../files/envLock'
import { checkBranchSync, runBranchSync } from '../git/branchSync'
import { detectRepo } from '../git/remote'
import { createWorktree } from '../git/worktree'
import { runPostCreateHook, runPreRemoveHook, type HookContext } from '../git/worktreeHooks'
import {
  addDependency,
  closeIssue,
  deleteBranch,
  deleteIssue,
  getPullRequest,
  GiteaApiError,
  listIssueComments,
  mergePullRequest,
  postIssueComment,
  removeDependency,
} from '../gitea/api'
import { isValidSpxFilePath, loadIssues } from '../gitea/issueLoader'
import { mergeStateJsonComment, readStateJsonComment } from '../gitea/stateJson'
import { logger } from '../logging/logger'
import { getSettings, saveSettings } from '../settings/store'
import { webhookCoordinator } from '../webhook/coordinator'
import { PALETTE, pickRandomIssueColor, resolveIssueColor, themeColorIdToIconUri } from './issueColor'

const DEFAULT_PROFILE_PATH = '/home/cruldra/Sources/cruldra-profile/claude-config/profiles/offical.json'

/**
 * Minimal subset of the built-in `vscode.git` extension's public API that we
 * consume. The official typings live in the VS Code repo's extension source
 * (not on npm), so we inline just the fields needed to observe working-tree
 * state and unregister our listener.
 *
 * Reference: microsoft/vscode → extensions/git/src/api/git.d.ts
 */
interface GitExtensionApiRepositoryStateChange {
  (listener: () => unknown): { dispose: () => void }
}

interface GitExtensionApiRepositoryState {
  readonly workingTreeChanges: ReadonlyArray<{ uri: Uri }>
  readonly indexChanges: ReadonlyArray<{ uri: Uri }>
  readonly untrackedChanges?: ReadonlyArray<{ uri: Uri }>
  readonly onDidChange: GitExtensionApiRepositoryStateChange
}

interface GitExtensionApiRepository {
  readonly rootUri: Uri
  readonly state: GitExtensionApiRepositoryState
}

interface GitExtensionApi {
  readonly repositories: ReadonlyArray<GitExtensionApiRepository>
}

interface GitExtensionExports {
  getAPI: (version: 1) => GitExtensionApi
}

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
    /** The brainstorm terminal created synchronously in `handleIssueCreate`.
     * Stored here so `linkPendingTerminalToIssue` can promote it into
     * `newIssueTerminals` once the webhook tells us the issueNumber. */
    terminal: Terminal
    createdAt: number
  }>()

  /**
   * issueNumber → the brainstorm terminal originally created via the new-issue
   * flow (its name is `issue-new-{shortNonce}-规划`, NOT `issue-${N}-规划`).
   * Populated by `linkPendingTerminalToIssue` after the webhook coordinator
   * matches the nonce in `issue.body` to an entry in `pendingIssueCreations`.
   *
   * VS Code's Terminal API has no rename method, so we can't fix the tab name
   * after the fact. Instead we keep this side-map so `handleSessionFocus`
   * (card → terminal) and `handleActiveTerminalChanged` (terminal → card) can
   * still find the tab and round-trip selection.
   */
  private readonly newIssueTerminals = new Map<number, Terminal>()

  /**
   * Terminal → 它属于哪个 issue 的哪类会话 tab。
   *
   * 仅用于详情面板"会话 id 行右侧的关闭按钮"特性：在四个 issue-aware Map
   * (`terminals` / `implTerminals` / `reviewTerminals` / `newIssueTerminals`)
   * 任意一项 set 时同步登记，`onDidCloseTerminal` 命中后反查这里再推
   * `issue/patch { brainstorm|implement|reviewTabOpen: false }` 给 webview。
   *
   * 用普通 Map 而不是 WeakMap：onDidCloseTerminal 需要把 closed Terminal
   * 作为 key 查；WeakMap 不暴露 has/get 之外的迭代 API 但其实 get 就够用，
   * 不过 VS Code 文档里 Terminal 实例生命周期与 Map 中的引用不冲突，普通
   * Map 更易于 inspect / debug。条目数顶天就是当前活跃 tab 数，无压力。
   */
  private readonly terminalOrigin = new Map<Terminal, { issueNumber: number, kind: 'brainstorm' | 'implement' | 'review' }>()

  /**
   * Concurrency lock for the "提交当前代码" button. The webview already
   * disables the button while `commit/state running=true` is in flight, but
   * we keep a server-side lock as defense against duplicate messages.
   */
  private commitRunning = false

  /**
   * Whether the workspace git working tree currently has any uncommitted
   * changes (working tree, index, or untracked). Populated by
   * `setupGitWatcher()` via the built-in `vscode.git` extension and pushed to
   * the webview as `commit/has-changes`. The webview only renders the
   * "提交代码" toolbar button while this is true (or while a commit run is
   * in flight, so users can still see the spinner). Defaults to `false` so
   * the button stays hidden until we've actually observed the repo state.
   */
  private hasGitChanges = false

  /**
   * Disposable returned by `repository.state.onDidChange` while we're
   * watching the workspace repo. Stored so we can detach the listener when
   * the panel is disposed (otherwise the git extension would keep a strong
   * reference to our callback closure for the lifetime of the editor).
   */
  private gitStateDisposable: { dispose: () => void } | undefined

  /**
   * 最近一次 onDidChangeActiveTerminal 触发反选 webview 的时间戳（ms epoch）。
   * `handleSessionFocus` 收到 webview 回发的 session/focus 时检查这个，
   * 距离 <200ms 且工单号相同 → 跳过优先级跳转，避免点审查 tab 自动弹回实施 tab。
   */
  private lastReverseSelectAt = 0
  private lastReverseSelectIssueNumber = -1

  /**
   * 上一次被 `handleActiveTerminalChanged` 处理的 terminal 引用。同一 terminal
   * 短时间内重复触发（OSC title 改写、shell prompt 重绘等导致的 onDidChangeTabs
   * 误触）直接 noop，避免 webview 反复 setPendingSelectId 造成 UI 闪烁。
   * `onDidCloseTerminal` 中清掉该 ref。
   */
  private lastActiveTerminalRef: Terminal | undefined

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
        for (const [n, t] of this.newIssueTerminals) {
          if (t === closed) {
            this.newIssueTerminals.delete(n)
            break
          }
        }
        // 反查 terminalOrigin 给详情面板推 *TabOpen: false，让关闭按钮消失。
        this.untrackClosedTerminal(closed)
        if (closed === this.lastActiveTerminalRef)
          this.lastActiveTerminalRef = undefined
      }),
      // 用户在 column 2 切换终端 tab 时，反向选中看板上对应的工单卡片。
      window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal)
          return
        this.handleActiveTerminalChanged(terminal)
      }),
      // 补充监听 tab 切换事件：当 column 2 只有一个 terminal tab 时，
      // 它始终是 active terminal，`onDidChangeActiveTerminal` 不会触发；
      // 但用户点击该 tab 仍会让它成为 active tab，`onDidChangeTabs` 会以
      // `changed` + `isActive=true` 的形式投递事件。两者并存时
      // `handleActiveTerminalChanged` 内的 `lastReverseSelectAt` 时间窗
      // 已能去重，不会回环放大。
      window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.changed) {
          if (!tab.isActive)
            continue
          if (!(tab.input instanceof TabInputTerminal))
            continue
          // TabInputTerminal 只有构造器、无任何字段，只能用 tab.label
          // 反查 `window.terminals` 里的实例。终端 name 常被 shell 的
          // OSC title 序列改写（追加 git branch 等后缀），所以双向 startsWith
          // 兜底，参考 `injectIntoImplTerminal` 里的命名匹配策略。
          const label = tab.label
          const term = window.terminals.find(
            t => label.startsWith(t.name) || t.name.startsWith(label),
          )
          if (term)
            this.handleActiveTerminalChanged(term)
        }
      }),
    )

    // Start observing the workspace repo so we can hide the "提交代码"
    // toolbar button whenever the working tree is clean. Fire-and-forget —
    // `setupGitWatcher` handles its own activation + retry logic.
    this.setupGitWatcher()
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
      this.handleSessionFocus(msg.issueNumber)
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
      return
    }
    if (msg.type === 'commit/run') {
      void this.handleCommitRun()
      return
    }
    if (msg.type === 'session/close-tab') {
      this.handleCloseSessionTab(msg.issueNumber, msg.kind)
      return
    }
    if (msg.type === 'branch-sync/check') {
      void this.handleBranchSyncCheck()
      return
    }
    if (msg.type === 'branch-sync/run') {
      void this.handleBranchSyncRun()
      return
    }
    if (msg.type === 'env-lock/check') {
      void this.handleEnvLockCheck()
      return
    }
    if (msg.type === 'env-lock/toggle') {
      void this.handleEnvLockToggle()
      return
    }
    if (msg.type === 'issue/delete') {
      void this.handleDeleteIssue(msg.issueNumber)
      return
    }
    if (msg.type === 'brainstorm/start') {
      void this.handleStartBrainstormSession(msg.issueNumber)
    }
  }

  private resolveTerminalLocation(preserveFocus: boolean): TerminalEditorLocationOptions {
    // Pin all plugin-managed terminals to editor group 2 (right side of the
    // kanban panel in column 1). VS Code creates the group on demand if it
    // doesn't exist yet, and stacks new terminals as tabs in that group when
    // it does — exactly what we want, no manual scan of existing tabs needed.
    return { viewColumn: ViewColumn.Two, preserveFocus }
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
          this.postMessage({
            type: 'issue/patch',
            issueNumber,
            patch: { color: id },
          })
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
      if (issueNumber !== undefined)
        this.trackSessionTerminal(existingByName, issueNumber, 'brainstorm')
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
    if (issueNumber !== undefined)
      this.trackSessionTerminal(terminal, issueNumber, 'brainstorm')
    terminal.show(false)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })
    // Worktree 已清理时给用户一个明确提示，避免他们误以为 cc 在原
    // worktree 路径里跑。toast 上 dismissOnTimer 5s 自动消失。
    if (cwdFallback) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'info',
        message: `工单 #${issueNumber ?? '?'} 的 worktree 已清理，会话将在工作区根目录恢复`,
        dismissOnTimer: 5000,
      })
    }
    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" --resume ${sessionId}`
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
    // `isFirstReview` 参数保留只为兼容签名（调用方仍按 first/再审 区分），
    // 方法体本身不再消费它——合并改由用户拖工单到"完成"列时插件 API 触发，
    // cc 不允许自行合并。
    void isFirstReview
    let terminal = this.implTerminals.get(issueNumber)
    if (!terminal) {
      // Match by prefix — shell OSC title escapes can append a git branch
      // suffix to terminal.name (e.g. "issue-48-实施 5f56026c").
      const wantedPrefix = `issue-${issueNumber}-实施`
      for (const t of window.terminals) {
        if (t.name.startsWith(wantedPrefix)) {
          terminal = t
          this.implTerminals.set(issueNumber, t)
          this.trackSessionTerminal(t, issueNumber, 'implement')
          break
        }
      }
    }
    if (!terminal)
      return false
    // cc 的 TUI 在 raw 模式下，LF (\n) 只算输入框内的换行，CR (\r)
    // 才会被识别为 Enter（提交消息）。实测把多行内容 + 末尾 \r 在同一次
    // sendText 里发出去时，cc 进入多行输入模式后并不会把紧跟的 \r 当成
    // 提交键，结果就是反馈只粘贴到输入框、没提交。
    // 拆两次发：先把内容完整推进输入框，250ms 后再独立发一个 \r 作为 Enter。
    const body = `\n[审查反馈]\n${text}`
    terminal.sendText(body, false)
    setTimeout(() => {
      terminal!.sendText('\r', false)
    }, 250)
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
      this.trackSessionTerminal(existingByName, issueNumber, 'review')
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
    this.trackSessionTerminal(terminal, issueNumber, 'review')
    terminal.show(false)
    terminal.sendText(`codex resume --dangerously-bypass-approvals-and-sandbox ${sessionId}`)
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建审查会话终端 #${issueNumber} cwd=${worktreeAbs}`,
    })
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
  public async triggerAutoReviewTab(opts: {
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
    const existing = this.findExistingTerminal(terminalName)
    const isReuse = !!existing

    if (isReuse) {
      const terminal = existing!
      this.trackSessionTerminal(terminal, opts.issueNumber, 'review')
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

    const { themeColor, iconUri } = await this.resolveIssueIcon(opts.issueNumber)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: effectiveCwd,
      location: this.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建审查终端 "${terminalName}" cwd=${effectiveCwd}`,
    })
    this.trackSessionTerminal(terminal, opts.issueNumber, 'review')
    terminal.show(false)

    if (cwdFallback) {
      this.postMessage({
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
    const cmd = `codex --dangerously-bypass-approvals-and-sandbox '${opts.prompt}'`
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
        const token = await getToken(this.context, remote.host)
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
        this.postMessage({
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
   * Focus an already-open terminal for `sessionId` without stealing focus
   * from the kanban. Called when the webview's selection changes via arrow
   * keys / clicks — if there's no terminal for this session yet, this is a
   * no-op (user has to press Enter to spawn one).
   */
  private handleSessionFocus(issueNumber: number): void {
    // 如果这次 session/focus 是 onDidChangeActiveTerminal 反选触发的回路
    // （而不是用户主动点卡片切换工单），跳过优先级跳转，否则会把用户刚刚
    // 点的"审查 tab"弹回到优先级更高的"实施 tab"。
    const REVERSE_LOOP_WINDOW_MS = 200
    if (
      this.lastReverseSelectIssueNumber === issueNumber
      && Date.now() - this.lastReverseSelectAt < REVERSE_LOOP_WINDOW_MS
    ) {
      return
    }
    // Priority 0: new-issue flow terminal whose name is `issue-new-{nonce}-规划`,
    // not `issue-${N}-规划`. The webhook coordinator stitches issueNumber →
    // terminal into `newIssueTerminals` via `linkPendingTerminalToIssue`.
    // We can't rename the terminal tab (VS Code API limitation), so this
    // side-map is the only way to find it by issueNumber.
    const newIssueTerm = this.newIssueTerminals.get(issueNumber)
    if (newIssueTerm && newIssueTerm.exitStatus === undefined) {
      newIssueTerm.show(true)
      return
    }
    // Priority 1-3: 实施 > 规划 > 审查. Match by terminal.name since we know the
    // convention (issue-${N}-实施 / issue-${N}-规划 / issue-${N}-审查).
    const namePriority = [
      `issue-${issueNumber}-实施`,
      `issue-${issueNumber}-规划`,
      `issue-${issueNumber}-审查`,
    ]
    for (const name of namePriority) {
      const term = this.findExistingTerminal(name)
      if (term) {
        term.show(true)
        return
      }
    }
    // 找不到不报错，静默 return（用户没开过终端，正常）。
  }

  /**
   * 反向选中：用户在 column 2 切换 terminal tab 时，从 terminal.name 解析
   * issueNumber 并通知 webview 选中对应工单。
   *
   * 终端名按 `issue-${N}-(规划|实施|审查)` 命名；`issue-new-${nonce}-...`
   * 是新建工单流程的占位 tab，没有 issue number，跳过。
   */
  private handleActiveTerminalChanged(terminal: Terminal): void {
    // Dedupe by reference: OSC title rewrites / shell prompt updates fire
    // onDidChangeTabs repeatedly for the same terminal. Skip if it's the
    // same reference we just handled.
    if (terminal === this.lastActiveTerminalRef)
      return
    this.lastActiveTerminalRef = terminal
    // Primary: `issue-${N}-(规划|实施|审查)` — the steady-state naming.
    const m = terminal.name.match(/^issue-(\d+)-(规划|实施|审查)/)
    if (m) {
      const issueNumber = Number.parseInt(m[1], 10)
      if (Number.isFinite(issueNumber)) {
        this.lastReverseSelectAt = Date.now()
        this.lastReverseSelectIssueNumber = issueNumber
        this.postMessage({ type: 'issue/select-by-number', issueNumber })
      }
      return
    }
    // Fallback: `issue-new-${shortNonce}-规划` — created via the new-issue flow
    // before we knew the issueNumber. Reverse-scan `newIssueTerminals` (which
    // was populated by the webhook coordinator via `linkPendingTerminalToIssue`).
    if (terminal.name.startsWith('issue-new-')) {
      for (const [num, term] of this.newIssueTerminals) {
        if (term === terminal) {
          this.lastReverseSelectAt = Date.now()
          this.lastReverseSelectIssueNumber = num
          this.postMessage({ type: 'issue/select-by-number', issueNumber: num })
          return
        }
      }
    }
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
      this.trackSessionTerminal(existingImpl, issueNumber, 'implement')
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

    // Run the post-create lifecycle hook. Fire-and-await so subsequent
    // steps (mkdir projects dir, terminal spawn, cc launch) see whatever
    // setup the user script performed (e.g. .env copy). Failures are
    // logged + toasted but never block the implement flow.
    await this.dispatchWorktreeHook('post-create', {
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
      this.postMessage({
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
    this.trackSessionTerminal(terminal, issueNumber, 'implement')
    logger.add({
      level: 'info',
      source: 'terminal',
      message: `已创建终端 "${terminal.name}"`,
    })
    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
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
        this.postMessage({
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
  private async handleStartBrainstormSession(issueNumber: number): Promise<void> {
    const terminalName = `issue-${issueNumber}-规划`
    const existing = this.findExistingTerminal(terminalName)
    if (existing) {
      this.trackSessionTerminal(existing, issueNumber, 'brainstorm')
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
    const token = await getToken(this.context, remote.host)
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

    const prompt = getBrainstormContinuePrompt(this.context, { issueNumber })
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

    const { themeColor, iconUri } = await this.resolveIssueIcon(issueNumber)
    const terminal = window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
      location: this.resolveTerminalLocation(false),
      iconPath: iconUri,
      color: themeColor,
    })
    this.trackSessionTerminal(terminal, issueNumber, 'brainstorm')
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
        this.postMessage({
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

    // Run the pre-remove lifecycle hook so the user can tear down resources
    // (close IDE windows, etc.) before the worktree dir vanishes. Best-effort
    // — never blocks the removal.
    const settingsForHook = getSettings(this.context)
    await this.dispatchWorktreeHook('pre-remove', {
      workspaceRoot,
      worktreePath: abs,
      branch: '',
      issueNumber,
      mainBranch: settingsForHook.devBranch || 'main',
      customScriptPath: settingsForHook.worktreePreRemoveScript,
    })

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

    this.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: {
        worktreePath: undefined,
        branch: undefined,
        worktreeExists: false,
      },
    })
    void window.showInformationMessage(`已删除 worktree #${issueNumber}`)
  }


  /**
   * Run a user-provided shell script (post-create / pre-remove) and surface
   * the outcome via logger + a toast. Always returns — failures of any
   * kind never abort the calling flow, per the lifecycle-hook contract:
   * worktree creation / removal is the source of truth, user scripts are
   * best-effort sidecars.
   */
  private async dispatchWorktreeHook(
    phase: 'post-create' | 'pre-remove',
    ctx: HookContext,
  ): Promise<void> {
    const result = phase === 'post-create'
      ? await runPostCreateHook(ctx)
      : await runPreRemoveHook(ctx)

    // 'skipped' = the script simply isn't on disk. That's the intended
    // default state — stay silent, don't pester the user.
    if (result.status === 'skipped')
      return

    if (result.status === 'ok') {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `worktree ${phase} 钩子完成 #${ctx.issueNumber}`,
        details: `path=${result.scriptPath}\nstdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}`,
      })
      return
    }

    // Anything else (failed / timeout / enoent) — warn-level log + a
    // toast. ToastLevel only has 'info' | 'success' | 'error'; we use
    // 'info' to keep it non-blocking, matching the "doesn't affect main
    // flow" semantics. Detailed stdout/stderr stays in the log to avoid
    // spamming the toast surface.
    const label = phase === 'post-create' ? '创建后' : '删除前'
    logger.add({
      level: 'warn',
      source: 'panel',
      message: `worktree ${phase} 钩子失败 #${ctx.issueNumber}: ${result.status}`,
      details: [
        `path=${result.scriptPath ?? '(unresolved)'}`,
        result.exitCode !== undefined ? `exitCode=${result.exitCode}` : null,
        result.errorMessage ? `err=${result.errorMessage}` : null,
        result.stdout ? `stdout=${result.stdout}` : null,
        result.stderr ? `stderr=${result.stderr}` : null,
      ].filter((line): line is string => line !== null).join('\n'),
    })
    this.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'info',
      message: `worktree ${label}钩子失败 #${ctx.issueNumber}（不影响后续流程，详情见日志）`,
      dismissOnTimer: 5000,
    })
  }


  /**
   * 硬删 Gitea 工单 + 关联资源（worktree / PR / feature branch / cc session
   * tabs）。每步独立 try/catch，任一步失败立即停下并 toast 报错，让用户手动
   * 处理。前端在最后一步收到 `issue/remove` 后从 issues 数组移除该工单。
   */
  private async handleDeleteIssue(issueNumber: number): Promise<void> {
    // 1. modal confirm — 用户没点"删除"就 abort
    const choice = await window.showWarningMessage(
      `确定删除工单 #${issueNumber}？此操作不可撤销，将清理 worktree / 关闭 PR / 删除 feature branch / 删除 issue。`,
      { modal: true },
      '删除',
    )
    if (choice !== '删除')
      return

    // 2. workspace / repo / token 前置
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

    // 3. 读 state JSON 拿 pr / branch / worktreePath
    let stateObj: Record<string, unknown> = {}
    try {
      stateObj = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `读取工单 #${issueNumber} 状态失败: ${message}`,
        dismissOnTimer: 6000,
      })
      return
    }
    const prStr = typeof stateObj.pr === 'string' ? stateObj.pr : ''
    const branch = typeof stateObj.branch === 'string' ? stateObj.branch : ''
    const worktreePath = typeof stateObj.worktreePath === 'string' ? stateObj.worktreePath : ''

    // 4. 关 cc/codex tab：扫 terminalOrigin 找该工单的所有 terminal 全部 dispose
    for (const [terminal, origin] of this.terminalOrigin) {
      if (origin.issueNumber === issueNumber) {
        try {
          terminal.dispose()
        }
        catch {
          // dispose 失败也无所谓，VS Code 自己会清掉关闭事件
        }
      }
    }

    // 5. 删 worktree（如有）— git worktree remove --force，失败立即停
    if (worktreePath) {
      const absWorktree = path.isAbsolute(worktreePath)
        ? worktreePath
        : path.join(workspaceRoot, worktreePath)
      if (fs.existsSync(absWorktree)) {
        // Pre-remove hook before nuking the worktree. Best-effort —
        // hook failure does NOT block the destructive delete.
        const settingsForHook = getSettings(this.context)
        await this.dispatchWorktreeHook('pre-remove', {
          workspaceRoot,
          worktreePath: absWorktree,
          branch,
          issueNumber,
          mainBranch: settingsForHook.devBranch || 'main',
          customScriptPath: settingsForHook.worktreePreRemoveScript,
        })
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              'git',
              ['-C', workspaceRoot, 'worktree', 'remove', '--force', absWorktree],
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
          this.postMessage({
            type: 'toast/show',
            id: makeNonce(),
            level: 'error',
            message: `删除 worktree 失败 #${issueNumber}: ${message}`,
            dismissOnTimer: 6000,
          })
          return
        }
      }
    }

    // 6. 关 PR（gitea 把 PR 当 issue subtype 处理，PATCH /issues/{prNumber} 即可）
    if (prStr) {
      const prIndex = Number.parseInt(prStr, 10)
      if (Number.isFinite(prIndex)) {
        try {
          await closeIssue({
            host: remote.host,
            token,
            owner: remote.owner,
            repo: remote.repo,
            issueNumber: prIndex,
          })
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessage({
            type: 'toast/show',
            id: makeNonce(),
            level: 'error',
            message: `关闭 PR #${prIndex} 失败 (issue #${issueNumber}): ${message}`,
            dismissOnTimer: 6000,
          })
          return
        }
      }
    }

    // 7. 删 feature branch（如有）
    if (branch) {
      try {
        await deleteBranch({
          host: remote.host,
          token,
          owner: remote.owner,
          repo: remote.repo,
          branch,
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessage({
          type: 'toast/show',
          id: makeNonce(),
          level: 'error',
          message: `删除分支 ${branch} 失败 (issue #${issueNumber}): ${message}`,
          dismissOnTimer: 6000,
        })
        return
      }
    }

    // 8. 硬删 issue 本身
    try {
      await deleteIssue({
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        issueNumber,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `删除工单 #${issueNumber} 失败: ${message}`,
        dismissOnTimer: 6000,
      })
      return
    }

    logger.add({
      level: 'info',
      source: 'panel',
      message: `已硬删工单 #${issueNumber}（含 worktree / PR / branch / tab）`,
    })

    // 9. 前端推 remove + success toast
    this.postMessage({ type: 'issue/remove', issueNumber })
    this.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: `工单 #${issueNumber} 已删除`,
      dismissOnTimer: 4000,
    })
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
    if (toColumn === 'in-progress') {
      await this.handleDropToInProgress(issueNumber)
      return
    }

    if (toColumn !== 'done') {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `暂不处理 toColumn=${toColumn} 的拖放持久化 (issue #${issueNumber})`,
      })
      return
    }

    // 失败回滚时使用的"原列"。读 state JSON 时尽量带出，最终读不到时
    // 兜底到 'in-progress'（绝大多数被拖到 done 的工单来自 in-progress / review）。
    const rollback = (fromColumn: IssueColumn | undefined): void => {
      this.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { column: fromColumn ?? 'in-progress' },
      })
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
      rollback(undefined)
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
      rollback(undefined)
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
      rollback(undefined)
      return
    }

    // 1. Re-fetch latest state JSON for this issue.
    let prStr: string | undefined
    let worktreePath: string | undefined
    let fromColumn: IssueColumn | undefined
    let implementSessionId: string | undefined
    let featureBranch: string | undefined
    let profilePath: string | undefined
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
              if (
                typeof obj.column === 'string'
                && ['todo', 'in-progress', 'review', 'done'].includes(obj.column)
              ) {
                fromColumn = obj.column as IssueColumn
              }
              if (typeof obj.implementSessionId === 'string' && obj.implementSessionId.length > 0)
                implementSessionId = obj.implementSessionId
              if (typeof obj.branch === 'string' && obj.branch.length > 0)
                featureBranch = obj.branch
              if (typeof obj.profilePath === 'string' && obj.profilePath.length > 0)
                profilePath = obj.profilePath
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
      rollback(undefined)
      return
    }

    // 2. 无关联 PR 的工单（讨论 / 文档 / 运维类）也允许拖到完成列，
    // 跳过 PR 合并 + worktree 清理，仅持久化 column='done'。
    if (!prStr) {
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
          message: `工单 #${issueNumber} 无 PR，直接标记完成`,
        })
        await this.syncCloseGiteaIssue({
          host: remote.host,
          token,
          owner: remote.owner,
          repo: remote.repo,
          issueNumber,
        })
        this.postMessage({
          type: 'issue/patch',
          issueNumber,
          patch: { column: 'done' },
        })
        this.postMessage({
          type: 'toast/show',
          id: makeNonce(),
          level: 'success',
          message: `工单 #${issueNumber} 已完成`,
          dismissOnTimer: 4000,
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'error',
          source: 'panel',
          message: `持久化 column=done 失败 (#${issueNumber}, no PR)`,
          details: message,
        })
        this.postMessage({
          type: 'toast/show',
          id: makeNonce(),
          level: 'error',
          message: `保存工单 #${issueNumber} 状态失败: ${message}`,
          dismissOnTimer: 6000,
        })
        rollback(fromColumn)
      }
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
      rollback(fromColumn)
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
      rollback(fromColumn)
      return
    }

    if (!pullRequest.merged) {
      // PR 还没合并 → 由插件代为合并（用户拖到"完成"列即表示放行）。
      // 合并失败（冲突 / 已关闭 / 权限）回滚拖动到原列。
      try {
        await mergePullRequest({
          host: remote.host,
          token,
          owner: remote.owner,
          repo: remote.repo,
          index: prIndex,
        })
        logger.add({
          level: 'info',
          source: 'panel',
          message: `已合并 PR #${prIndex} (issue #${issueNumber})`,
        })
        this.postMessage({
          type: 'toast/show',
          id: makeNonce(),
          level: 'info',
          message: `已合并 PR #${prIndex}`,
          dismissOnTimer: 4000,
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const isConflict = err instanceof GiteaApiError
          && (err.status === 405 || /conflict/i.test(err.message))
        logger.add({
          level: 'error',
          source: 'panel',
          message: `合并 PR #${prIndex} 失败 (issue #${issueNumber})${isConflict ? ' [冲突]' : ''}`,
          details: message,
        })
        if (isConflict && featureBranch && worktreePath) {
          // 走冲突解决分支：直接在实施 worktree 里 merge dev 制造冲突落地，
          // 再开一个临时 cc 会话让 cc 解决。fire-and-forget，不进任何 map / state JSON。
          await this.startConflictResolution({
            issueNumber,
            prIndex,
            workspaceRoot,
            featureBranch,
            worktreePath,
            profilePath,
          })
        }
        else {
          this.postMessage({
            type: 'toast/show',
            id: makeNonce(),
            level: 'error',
            message: isConflict
              ? `合并 PR #${prIndex} 失败 [冲突]：state JSON 缺少 branch 或 worktreePath 字段，无法自动解决`
              : `合并 PR #${prIndex} 失败: ${message}`,
            dismissOnTimer: 6000,
          })
        }
        rollback(fromColumn)
        return
      }
    }

    // 4. PR is merged — persist column='done' + prMerged=true + 清空 worktreePath
    // 到 state JSON。state JSON 用空字符串清空（loader 把 length===0 视为 unset）。
    try {
      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { column: 'done', worktreePath: '', prMerged: true },
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
      rollback(fromColumn)
      return
    }

    await this.syncCloseGiteaIssue({
      host: remote.host,
      token,
      owner: remote.owner,
      repo: remote.repo,
      issueNumber,
    })

    // Before removing the worktree, copy the impl-session jsonl into the
    // workspace-root projects dir so `claude --resume` can still find it
    // after the worktree (and its projects dir) are gone.
    if (implementSessionId && worktreePath) {
      try {
        const worktreeAbs = path.isAbsolute(worktreePath)
          ? worktreePath
          : path.join(workspaceRoot, worktreePath)
        const srcProjectsDir = projectsDirFor(worktreeAbs)
        const dstProjectsDir = projectsDirFor(workspaceRoot)
        const srcJsonl = path.join(srcProjectsDir, `${implementSessionId}.jsonl`)
        const dstJsonl = path.join(dstProjectsDir, `${implementSessionId}.jsonl`)
        if (fs.existsSync(srcJsonl)) {
          if (!fs.existsSync(dstProjectsDir))
            fs.mkdirSync(dstProjectsDir, { recursive: true })
          if (!fs.existsSync(dstJsonl)) {
            fs.copyFileSync(srcJsonl, dstJsonl)
            logger.add({
              level: 'info',
              source: 'panel',
              message: `已复制 cc session jsonl 到主 workspace projects 目录 (issue #${issueNumber})`,
              details: `${srcJsonl} → ${dstJsonl}`,
            })
          }
        }
      }
      catch (err) {
        // Non-fatal — worktree cleanup still proceeds. User can manually copy
        // the jsonl later if needed.
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `复制 cc session jsonl 失败 (issue #${issueNumber})，worktree 清理仍继续`,
          details: message,
        })
      }
    }

    // 5. Best-effort cleanup of the worktree. Failures are non-fatal — the
    // state JSON already records done, user can manually clean later.
    if (worktreePath) {
      const abs = path.isAbsolute(worktreePath)
        ? worktreePath
        : path.join(workspaceRoot, worktreePath)
      if (fs.existsSync(abs)) {
        // Pre-remove hook — same best-effort contract as the other call
        // sites. Run before the actual remove so user scripts can still
        // touch the worktree dir.
        const settingsForHook = getSettings(this.context)
        await this.dispatchWorktreeHook('pre-remove', {
          workspaceRoot,
          worktreePath: abs,
          branch: featureBranch ?? '',
          issueNumber,
          mainBranch: settingsForHook.devBranch || 'main',
          customScriptPath: settingsForHook.worktreePreRemoveScript,
        })
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
          rollback(fromColumn)
          return
        }
      }
    }

    // 6. 全部成功 → 增量推 done + 清掉 worktreePath + 标记 prMerged。
    // webview 端 `{ ...issue, ...patch }` spread 会把 worktreePath 覆盖成
    // undefined，详情面板的 worktree 链接行因此消失。
    this.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: {
        column: 'done',
        worktreePath: undefined,
        prMerged: true,
      },
    })
    this.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'success',
      message: `工单 #${issueNumber} 已完成，worktree 已清理`,
      dismissOnTimer: 5000,
    })
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
   *   3. 用 claude --dangerously-skip-permissions 启临时终端，给 cc 写死的
   *      解决指引。cc commit + push 后由用户重新拖到完成列触发重试。
   */
  private async startConflictResolution(opts: {
    issueNumber: number
    prIndex: number
    workspaceRoot: string
    featureBranch: string
    worktreePath: string
    profilePath?: string
  }): Promise<void> {
    const { issueNumber, prIndex, workspaceRoot, featureBranch, worktreePath, profilePath } = opts
    const settings = getSettings(this.context)
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
      this.postMessage({
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
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `检查工作区状态失败：${detail}`,
        dismissOnTimer: 6000,
      })
      return
    }
    if (statusResult.stdout.trim().length > 0) {
      this.postMessage({
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
      this.postMessage({
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
        location: this.resolveTerminalLocation(false),
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
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `创建冲突解决终端失败：${detail}`,
        dismissOnTimer: 6000,
      })
      return
    }
    terminal.show(false)
    // 与 handleImplement 保持一致：用同一份 profile 启动 cc，让冲突解决会话
    // 与该工单的实施/头脑风暴会话体验一致。空串/未传时回落到默认 profile。
    const effectiveProfilePath
      = profilePath && profilePath.trim() !== '' ? profilePath : DEFAULT_PROFILE_PATH
    if (effectiveProfilePath.includes('\'')) {
      logger.add({
        level: 'error',
        source: 'panel',
        message: `冲突解决：profilePath 含单引号，拒绝执行 (issue #${issueNumber})`,
        details: effectiveProfilePath,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `冲突解决失败：profilePath 含单引号 (${effectiveProfilePath})`,
        dismissOnTimer: 6000,
      })
      return
    }
    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
    terminal.sendText(cmd)

    logger.add({
      level: 'info',
      source: 'panel',
      message: `冲突解决：cc 会话已启动 (issue #${issueNumber}, PR #${prIndex}, branch ${featureBranch}, cwd ${worktreeAbs}, profile ${effectiveProfilePath})`,
    })
    this.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'info',
      message: `PR #${prIndex} 冲突，已在 worktree 内 merge，cc 会话正在解决冲突`,
      dismissOnTimer: 8000,
    })
  }

  /**
   * Handle a "drag to in-progress" kanban move.
   *
   * Validates the issue has a valid `planFile` recorded in its state JSON,
   * and that the file actually exists on disk, then delegates the full
   * implementation pipeline to `handleImplement` (which owns issue locking,
   * tab reuse, state JSON column/branch/worktreePath writes, gitea webhook
   * registration, cc spawn). On any pre-flight failure, rolls the optimistic
   * column move back to the source column.
   */
  private async handleDropToInProgress(issueNumber: number): Promise<void> {
    // Failed pre-flight → rollback optimistic move to source column.
    // Drags into in-progress typically originate from 'todo', so fall back
    // there when state JSON has no usable column field.
    const rollback = (fromColumn: IssueColumn | undefined): void => {
      this.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { column: fromColumn ?? 'todo' },
      })
    }

    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      rollback(undefined)
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
      rollback(undefined)
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
      rollback(undefined)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先完成 Gitea 配置',
        dismissOnTimer: 5000,
      })
      return
    }

    // Read latest state JSON to obtain source column + planFile + optional
    // profilePath / sessionId.
    let stateObj: Record<string, unknown> = {}
    try {
      stateObj = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `读取工单 #${issueNumber} 状态失败`,
        details: message,
      })
      rollback(undefined)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `读取工单 #${issueNumber} 状态失败: ${message}`,
        dismissOnTimer: 6000,
      })
      return
    }

    const fromColumn: IssueColumn | undefined
      = (typeof stateObj.column === 'string'
        && ['todo', 'in-progress', 'review', 'done'].includes(stateObj.column))
        ? stateObj.column as IssueColumn
        : undefined

    // No-op if state JSON already says in-progress (drag-on-self).
    if (fromColumn === 'in-progress') {
      logger.add({
        level: 'info',
        source: 'panel',
        message: `#${issueNumber} 已在 in-progress，跳过拖放触发`,
      })
      return
    }

    // planFile must be a valid spx path and actually exist on disk.
    const planFileRaw = stateObj.planFile
    if (!isValidSpxFilePath(planFileRaw)) {
      rollback(fromColumn)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `工单 #${issueNumber} 无合法 planFile，无法启动实施`,
        dismissOnTimer: 5000,
      })
      return
    }
    const planFile: string = planFileRaw
    const absPlan = path.isAbsolute(planFile) ? planFile : path.join(workspaceRoot, planFile)
    if (!fs.existsSync(absPlan)) {
      rollback(fromColumn)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `计划文件不存在 #${issueNumber}: ${planFile}`,
        dismissOnTimer: 5000,
      })
      return
    }

    const profilePath = typeof stateObj.profilePath === 'string' ? stateObj.profilePath : undefined
    const sessionId = typeof stateObj.sessionId === 'string' ? stateObj.sessionId : undefined
    try {
      await this.handleImplement(issueNumber, planFile, profilePath, sessionId)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      rollback(fromColumn)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `拖到 in-progress 触发实施失败 #${issueNumber}`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `启动实施失败 #${issueNumber}`,
        dismissOnTimer: 5000,
      })
    }
  }

  /**
   * 把 Gitea 工单状态改成 closed。failure non-fatal —— state JSON 已写、PR 已合、
   * 看板已切到 done 列，rollback 意义不大。失败时打 warn 日志 + warning toast，
   * 用户可手动关闭工单。
   */
  private async syncCloseGiteaIssue(opts: {
    host: string
    token: string
    owner: string
    repo: string
    issueNumber: number
  }): Promise<void> {
    try {
      await closeIssue(opts)
      logger.add({
        level: 'info',
        source: 'panel',
        message: `已关闭 Gitea 工单 #${opts.issueNumber}`,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `同步关闭 Gitea 工单 #${opts.issueNumber} 失败`,
        details: message,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `工单 #${opts.issueNumber} 状态同步失败，请手动关闭: ${message}`,
        dismissOnTimer: 6000,
      })
    }
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
        brainstormPrompt: s.brainstormPrompt,
        implementPlanPrompt: s.implementPlanPrompt,
        autoReview: s.autoReview,
        reviewPrompt: s.reviewPrompt,
        devBranch: s.devBranch,
        autoBuildBranch: s.autoBuildBranch,
        worktreePostCreateScript: s.worktreePostCreateScript,
        worktreePreRemoveScript: s.worktreePreRemoveScript,
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
      // Re-publish the cached git state so a slow webview boot (or a
      // refresh after git events already fired) still picks up the latest
      // value. Cheap — the webview discards if equal.
      this.postMessage({ type: 'commit/has-changes', value: this.hasGitChanges })
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
          brainstormPrompt: s.brainstormPrompt,
          implementPlanPrompt: s.implementPlanPrompt,
          autoReview: s.autoReview,
          reviewPrompt: s.reviewPrompt,
          devBranch: s.devBranch,
          autoBuildBranch: s.autoBuildBranch,
          worktreePostCreateScript: s.worktreePostCreateScript,
          worktreePreRemoveScript: s.worktreePreRemoveScript,
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
    brainstormPrompt: string
    implementPlanPrompt: string
    autoReview: boolean
    reviewPrompt: string
    devBranch: string
    autoBuildBranch: string
    worktreePostCreateScript: string
    worktreePreRemoveScript: string
  }): Promise<void> {
    const trimmedHost = payload.host.trim()
    const trimmedToken = payload.token.trim()
    const trimmedDevBranch = payload.devBranch.trim()
    const trimmedAutoBuildBranch = payload.autoBuildBranch.trim()
    // Hook script paths: keep '' meaningful (= "use default
    // .spx/worktree-*.sh"). Just strip whitespace.
    const trimmedPostCreate = payload.worktreePostCreateScript.trim()
    const trimmedPreRemove = payload.worktreePreRemoveScript.trim()
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
        brainstormPrompt: payload.brainstormPrompt || prev.brainstormPrompt,
        implementPlanPrompt: payload.implementPlanPrompt || prev.implementPlanPrompt,
        autoReview: payload.autoReview,
        reviewPrompt: payload.reviewPrompt || prev.reviewPrompt,
        devBranch: trimmedDevBranch || prev.devBranch,
        autoBuildBranch: trimmedAutoBuildBranch,
        worktreePostCreateScript: trimmedPostCreate,
        worktreePreRemoveScript: trimmedPreRemove,
      })
      return
    }
    await saveSettings(this.context, {
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
    // Branch-sync inputs may have changed — refresh the toolbar button.
    void this.handleBranchSyncCheck()
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
      brainstormPrompt: s.brainstormPrompt,
      implementPlanPrompt: s.implementPlanPrompt,
      autoReview: s.autoReview,
      reviewPrompt: s.reviewPrompt,
      devBranch: s.devBranch,
      autoBuildBranch: s.autoBuildBranch,
      worktreePostCreateScript: s.worktreePostCreateScript,
      worktreePreRemoveScript: s.worktreePreRemoveScript,
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
    const prompt = getBrainstormPrompt(this.context, {
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
      terminal,
      createdAt: Date.now(),
    })

    const cmd = `claude --dangerously-skip-permissions --settings '${effectiveProfilePath}' --system-prompt="$(serena prompts print-cc-system-prompt-override)" '${prompt}'`
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


  private async handleCommitRun(): Promise<void> {
    if (this.commitRunning)
      return

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

    const profiles = await listClaudeProfiles()
    const deepseek = profiles.find(p => p.name === 'deepseek')
    if (!deepseek) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '未找到 deepseek profile，请在 /home/cruldra/Sources/cruldra-profile/claude-config/profiles/ 下创建 deepseek.json',
        dismissOnTimer: 8000,
      })
      return
    }

    this.commitRunning = true
    this.postMessage({ type: 'commit/state', running: true })

    try {
      // claude -p 提交流程可能跑得比较久（要 git add / 编 commit message / git
      // commit），所以给一个比较宽松的超时（30 min）。
      await spawnClaude({
        prompt: '提交下代码',
        cwd: workspaceRoot,
        profilePath: deepseek.path,
        timeoutMs: 30 * 60 * 1000,
        bare: true,
      })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'success',
        message: '提交完成',
        dismissOnTimer: 5000,
      })
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `提交失败: ${msg}`,
        dismissOnTimer: 8000,
      })
    }
    finally {
      this.commitRunning = false
      this.postMessage({ type: 'commit/state', running: false })
    }
  }

  /**
   * Compute how far the remote auto-build branch is behind the remote dev
   * branch, then push a `branch-sync/status` to the webview. Called on
   * webview init, after `settings/save`, and after a successful sync.
   *
   * Empty `autoBuildBranch` setting means "use devBranch" — collapsing to
   * the equal-branch case in `checkBranchSync`, which marks it unavailable.
   */
  private async handleBranchSyncCheck(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    const s = getSettings(this.context)
    const devBranch = s.devBranch
    // Empty string in storage means "follow devBranch" — resolve to
    // devBranch so the check naturally hits the "same branch" disabled
    // branch.
    const autoBuildBranch = s.autoBuildBranch.length > 0 ? s.autoBuildBranch : devBranch

    if (!workspaceRoot) {
      this.postMessage({
        type: 'branch-sync/status',
        behind: 0,
        devBranch,
        autoBuildBranch,
        unavailable: true,
        reason: '请先打开一个工作区文件夹',
      })
      return
    }

    const status = await checkBranchSync({ workspaceRoot, devBranch, autoBuildBranch })
    this.postMessage({ type: 'branch-sync/status', ...status })
  }

  /**
   * Fast-forward push remote dev to remote autoBuild. Toasts on
   * success/failure and re-emits status so the button updates.
   */
  private async handleBranchSyncRun(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    const s = getSettings(this.context)
    const devBranch = s.devBranch
    const autoBuildBranch = s.autoBuildBranch.length > 0 ? s.autoBuildBranch : devBranch

    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      void this.handleBranchSyncCheck()
      return
    }

    if (devBranch === autoBuildBranch) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'info',
        message: '开发分支与自动化构建分支相同，无需同步',
        dismissOnTimer: 5000,
      })
      void this.handleBranchSyncCheck()
      return
    }

    try {
      await runBranchSync({ workspaceRoot, devBranch, autoBuildBranch })
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'success',
        message: `已同步 ${devBranch} → ${autoBuildBranch}`,
        dismissOnTimer: 5000,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `分支同步失败：${message}`,
        dismissOnTimer: 8000,
      })
    }
    finally {
      // Re-emit status regardless of success/failure so the button reflects
      // the new behind count (0 on success, unchanged on failure).
      void this.handleBranchSyncCheck()
    }
  }

  /**
   * Push the current env-lock state to the webview. State persists in
   * `workspaceState` under `'envLocked'`. First call (key not yet set)
   * defaults to locked AND eagerly chmods all `.env*` files to 0o444 so
   * UI and filesystem agree; subsequent calls trust the stored value.
   * The file count is recomputed via a fresh scan each time so the toolbar
   * reflects what the next toggle will actually act on.
   */
  private async handleEnvLockCheck(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    // 用底层 get 不传默认值，能区分"从未设过"(undefined) 和"用户主动选 false"。
    const stored = this.context.workspaceState.get<boolean>('envLocked')
    if (!workspaceRoot) {
      // 无工作区时无文件可锁，UI 默认显示锁定状态但 fileCount=0 等价于无操作。
      this.postMessage({ type: 'env-lock/status', locked: stored ?? true, fileCount: 0 })
      return
    }

    if (stored === undefined) {
      // 首次启动：默认锁定 + 真正 chmod 0o444 + 持久化，避免 UI 与 fs 不一致。
      const result = await lockEnvFiles(workspaceRoot)
      await this.context.workspaceState.update('envLocked', true)
      if (result.total === 0) {
        logger.add({
          level: 'info',
          source: 'panel',
          message: '首次启动：工作区无 .env 文件，跳过自动锁定',
        })
      }
      else if (result.failed.length === 0) {
        logger.add({
          level: 'info',
          source: 'panel',
          message: `首次启动自动锁定 ${result.ok.length} 个 .env 文件`,
        })
      }
      else {
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `首次启动自动锁定：成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`,
        })
      }
      this.postMessage({
        type: 'env-lock/status',
        locked: true,
        fileCount: result.total,
        failedCount: result.failed.length > 0 ? result.failed.length : undefined,
      })
      return
    }

    const files = await findEnvFiles(workspaceRoot)
    this.postMessage({ type: 'env-lock/status', locked: stored, fileCount: files.length })
  }

  /**
   * Flip the env-lock state: chmod every `.env*` file to 0o444 (lock) or
   * 0o644 (unlock), then persist the new state and re-emit status. Failures
   * surface as a toast but don't block the state flip — partially-locked
   * trees are visible via the failedCount in the next `env-lock/status`.
   */
  private async handleEnvLockToggle(): Promise<void> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: '请先打开一个工作区文件夹',
        dismissOnTimer: 5000,
      })
      void this.handleEnvLockCheck()
      return
    }

    const prevLocked = this.context.workspaceState.get<boolean>('envLocked', false)
    const nextLocked = !prevLocked
    const result = nextLocked
      ? await lockEnvFiles(workspaceRoot)
      : await unlockEnvFiles(workspaceRoot)

    await this.context.workspaceState.update('envLocked', nextLocked)

    if (result.total === 0) {
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'info',
        message: '工作区无 .env 文件',
        dismissOnTimer: 5000,
      })
    }
    else if (result.failed.length === 0) {
      const verb = nextLocked ? '锁定' : '解锁'
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'success',
        message: `已${verb} ${result.ok.length} 个 .env 文件`,
        dismissOnTimer: 4000,
      })
    }
    else {
      const verb = nextLocked ? '锁定' : '解锁'
      this.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'error',
        message: `${verb}完成：成功 ${result.ok.length} 个，失败 ${result.failed.length} 个`,
        dismissOnTimer: 8000,
      })
    }

    this.postMessage({
      type: 'env-lock/status',
      locked: nextLocked,
      fileCount: result.total,
      failedCount: result.failed.length > 0 ? result.failed.length : undefined,
    })
  }

  /**
   * Subscribes to the built-in `vscode.git` extension so the webview can hide
   * the "提交代码" toolbar button while the working tree is clean. Called
   * once from the constructor.
   *
   * Failure modes:
   *  - `vscode.git` extension not installed (rare; the user can disable
   *    built-ins). We log a warning and force `hasGitChanges = true` so the
   *    button stays visible — better to show a button that's a no-op than
   *    to hide functionality the user can't recover.
   *  - The repo for `workspaceFolders[0]` isn't in `api.repositories` yet
   *    (git extension initializes asynchronously). We retry once after 1s
   *    before giving up; on retry failure we leave `hasGitChanges = false`
   *    (no repo means nothing to commit anyway).
   */
  private setupGitWatcher(): void {
    const wsRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!wsRoot)
      return

    const gitExt = extensions.getExtension<GitExtensionExports>('vscode.git')
    if (!gitExt) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: 'vscode.git 扩展未找到，提交按钮将持续显示',
      })
      // Fallback: keep the button visible so users can at least trigger
      // commits manually even though we can't observe state.
      this.updateHasChanges(true)
      return
    }

    const activation = gitExt.isActive
      ? Promise.resolve(gitExt.exports)
      : Promise.resolve(gitExt.activate())

    void activation.then((exports) => {
      const api = exports.getAPI(1)
      const findRepo = (): GitExtensionApiRepository | undefined =>
        api.repositories.find(r => r.rootUri.fsPath === wsRoot)

      const updateState = (): void => {
        const repo = findRepo()
        if (!repo) {
          this.updateHasChanges(false)
          return
        }
        const total
          = repo.state.workingTreeChanges.length
            + repo.state.indexChanges.length
            + (repo.state.untrackedChanges?.length ?? 0)
        this.updateHasChanges(total > 0)
      }

      const subscribe = (repo: GitExtensionApiRepository): void => {
        this.gitStateDisposable = repo.state.onDidChange(updateState)
      }

      updateState()
      const repo = findRepo()
      if (repo) {
        subscribe(repo)
        return
      }
      // vscode.git activation can resolve before its `repositories` array
      // has populated for the freshly opened workspace. Retry once after a
      // short delay; if still missing we just leave the button hidden.
      setTimeout(() => {
        const retried = findRepo()
        if (retried)
          subscribe(retried)
        updateState()
      }, 1000)
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'warn',
        source: 'panel',
        message: '激活 vscode.git 扩展失败，提交按钮将持续显示',
        details: msg,
      })
      this.updateHasChanges(true)
    })
  }

  /**
   * Updates the cached `hasGitChanges` flag and (when it changed) notifies
   * the webview. Idempotent — calling with the current value is a no-op, so
   * `onDidChange` bursts from the git extension don't spam the webview.
   */
  private updateHasChanges(value: boolean): void {
    if (this.hasGitChanges === value)
      return
    this.hasGitChanges = value
    this.postMessage({ type: 'commit/has-changes', value })
  }

  /** Forces the open panel (if any) into the setup-auth state. */
  static requestEditAuth(): void {
    void KanbanWebviewPanel.current?.handleEditSettingsRequest()
  }

  postMessage(msg: ExtensionToWebview): void {
    void this.panel.webview.postMessage(msg)
  }

  /**
   * 登记一个新创建/复用的会话终端，并主动推一条 issue/patch 把对应 tab 打开
   * 标志置 true。详情面板侧据此在三行会话 id 右侧渲染关闭按钮。
   *
   * 复用场景（map 命中、existingByName 命中）也会再调一次，是幂等的：
   * 重复设置 terminalOrigin 不影响，重复推 true 在 webview 端的
   * `mergeIssuePatch` 也是 no-op。
   */
  private trackSessionTerminal(
    terminal: Terminal,
    issueNumber: number,
    kind: 'brainstorm' | 'implement' | 'review',
  ): void {
    this.terminalOrigin.set(terminal, { issueNumber, kind })
    this.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch:
        kind === 'brainstorm'
          ? { brainstormTabOpen: true }
          : kind === 'implement'
            ? { implementTabOpen: true }
            : { reviewTabOpen: true },
    })
  }

  /**
   * onDidCloseTerminal 触发后调用：反查 `terminalOrigin` 找到该 terminal
   * 对应的工单 + 会话类型，并推 false 让详情面板隐藏关闭按钮。
   *
   * 同时从 `terminalOrigin` 删除条目；四个 issue-aware Map 的清理仍由
   * 现有 onDidCloseTerminal 循环负责，本方法只关心 webview 通知。
   */
  private untrackClosedTerminal(closed: Terminal): void {
    const origin = this.terminalOrigin.get(closed)
    if (!origin)
      return
    this.terminalOrigin.delete(closed)
    this.postMessage({
      type: 'issue/patch',
      issueNumber: origin.issueNumber,
      patch:
        origin.kind === 'brainstorm'
          ? { brainstormTabOpen: false }
          : origin.kind === 'implement'
            ? { implementTabOpen: false }
            : { reviewTabOpen: false },
    })
  }

  /**
   * webview 端"关闭 tab"按钮入口：直接扫 `terminalOrigin` 找匹配
   * (issueNumber, kind) 的 terminal 并 `dispose()`。VS Code 随后会发
   * onDidCloseTerminal，由统一回调清理四个 issue-aware Map 和推 flag=false
   * ——本方法不直接改任何 Map，避免双重清理。
   *
   * 用 terminalOrigin 而不是分别查四个 Map：审查 tab 在
   * `triggerAutoReviewTab` 路径里不会进 `reviewTerminals`（那个 Map 按
   * thread_id 索引，此路径还没 thread_id），但会被登记到 terminalOrigin，
   * 所以用它做单一真相源最稳。
   */
  private handleCloseSessionTab(issueNumber: number, kind: 'brainstorm' | 'implement' | 'review'): void {
    let terminal: Terminal | undefined
    for (const [t, origin] of this.terminalOrigin) {
      if (origin.issueNumber === issueNumber && origin.kind === kind) {
        terminal = t
        break
      }
    }
    if (!terminal) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `关闭 ${kind} tab 失败 #${issueNumber}：未找到对应终端`,
      })
      return
    }
    terminal.dispose()
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
    terminal: Terminal
    createdAt: number
  } | undefined {
    const entry = this.pendingIssueCreations.get(nonce)
    if (entry)
      this.pendingIssueCreations.delete(nonce)
    return entry
  }

  /**
   * Called by the webhook coordinator after it parses a `spx:nonce=...` token
   * out of `issue.body` and matches it to an entry in `pendingIssueCreations`.
   * Promotes the in-flight brainstorm terminal into the issueNumber-keyed
   * `newIssueTerminals` map so subsequent `handleSessionFocus(issueNumber)`
   * and `handleActiveTerminalChanged` calls can find it.
   *
   * Also drops the terminal into `terminals` keyed by sessionId (when known)
   * so `handleResumeSession` reuses the same tab instead of spawning a new
   * one. Does NOT remove the pending entry — `takePendingIssueCreation` is
   * still responsible for cleanup on its own path.
   */
  public linkPendingTerminalToIssue(nonce: string, issueNumber: number): void {
    const pending = this.pendingIssueCreations.get(nonce)
    if (!pending)
      return
    this.newIssueTerminals.set(issueNumber, pending.terminal)
    if (pending.sessionId && pending.sessionId.length > 0)
      this.terminals.set(pending.sessionId, pending.terminal)
    this.trackSessionTerminal(pending.terminal, issueNumber, 'brainstorm')
  }

  private dispose(): void {
    KanbanWebviewPanel.current = undefined
    webhookCoordinator.setActivePanel(undefined)
    this.gitStateDisposable?.dispose()
    this.gitStateDisposable = undefined
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
