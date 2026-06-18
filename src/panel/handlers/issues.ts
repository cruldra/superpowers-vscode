import type { IssueColumn } from '../../gitea/types'
import type { KanbanWebviewPanel } from '../KanbanPanel'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { commands, env, ThemeColor, Uri, window, workspace } from 'vscode'
import { getToken } from '../../auth/secrets'
import { getBrainstormPrompt } from '../../cc/prompts'
import { projectsDirFor, watchForNewSession } from '../../cc/sessionWatcher'
import { spawnClaude } from '../../cc/spawnClaude'
import { deleteLocalBranch, gitFetch } from '../../git/branchSync'
import { detectRepo } from '../../git/remote'
import {
  addDependency,
  closeIssue,
  deleteBranch,
  deleteIssue,
  getPullRequest,
  GiteaApiError,
  listIssueComments,
  mergePullRequest,
  removeDependency,
} from '../../gitea/api'
import { isValidSpxFilePath, loadIssues } from '../../gitea/issueLoader'
import { mergeStateJsonComment, readStateJsonComment } from '../../gitea/stateJson'
import { logger } from '../../logging/logger'
import { getSettings } from '../../settings/store'
import { webhookCoordinator } from '../../webhook/coordinator'
import { pickRandomIssueColor, themeColorIdToIconUri } from '../issueColor'
import { DEFAULT_PROFILE_PATH, makeNonce, PR_DIFF_SUMMARY_PROFILE_PATH } from '../KanbanPanel'
import * as sessions from './sessions'

export async function handleColumnChange(panel: KanbanWebviewPanel, issueNumber: number, toColumn: IssueColumn): Promise<void> {
  if (toColumn === 'in-progress') {
    await handleDropToInProgress(panel, issueNumber)
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
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: { column: fromColumn ?? 'in-progress' },
    })
  }

  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    panel.postMessage({
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    rollback(undefined)
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  let testSessionId: string | undefined
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
            if (typeof obj.testSessionId === 'string' && obj.testSessionId.length > 0)
              testSessionId = obj.testSessionId
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
    panel.postMessage({
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
      await syncCloseGiteaIssue(panel, {
        host: remote.host,
        token,
        owner: remote.owner,
        repo: remote.repo,
        issueNumber,
      })
      panel.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { column: 'done' },
      })
      panel.postMessage({
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
      panel.postMessage({
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
    panel.postMessage({
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
    panel.postMessage({
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
      panel.postMessage({
        type: 'toast/show',
        id: makeNonce(),
        level: 'info',
        message: `已合并 PR #${prIndex}`,
        dismissOnTimer: 4000,
      })
      // 合并成功后做一次 fetch，让本地 main 能感知远端的 merge commit
      // （best-effort，失败不影响合并流程，只 log）。
      try {
        const fetched = await gitFetch(workspaceRoot)
        if (fetched.ok) {
          logger.add({
            level: 'info',
            source: 'panel',
            message: `git fetch origin 成功 (PR #${prIndex} 合并后)`,
          })
        }
        else {
          logger.add({
            level: 'warn',
            source: 'panel',
            message: `git fetch origin 失败 (PR #${prIndex} 合并后)`,
            details: fetched.stderr,
          })
        }
      }
      catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `git fetch origin 抛错 (PR #${prIndex} 合并后)`,
          details: m,
        })
      }
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
        await sessions.startConflictResolution(panel, {
          issueNumber,
          prIndex,
          workspaceRoot,
          featureBranch,
          worktreePath,
          profilePath,
        })
      }
      else {
        panel.postMessage({
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
      extra: { column: 'done', worktreePath: '', prMerged: true, prMergedAt: pullRequest.merged_at ?? new Date().toISOString() },
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `保存工单 #${issueNumber} 状态失败: ${message}`,
      dismissOnTimer: 6000,
    })
    rollback(fromColumn)
    return
  }

  await syncCloseGiteaIssue(panel, {
    host: remote.host,
    token,
    owner: remote.owner,
    repo: remote.repo,
    issueNumber,
  })

  // Before removing the worktree, copy the impl- and test-session jsonl into
  // the workspace-root projects dir so `claude --resume` can still find them
  // after the worktree (and its projects dir) are gone.
  if ((implementSessionId || testSessionId) && worktreePath) {
    try {
      const worktreeAbs = path.isAbsolute(worktreePath)
        ? worktreePath
        : path.join(workspaceRoot, worktreePath)
      const srcProjectsDir = projectsDirFor(worktreeAbs)
      const dstProjectsDir = projectsDirFor(workspaceRoot)
      const sessionIds = [implementSessionId, testSessionId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
      for (const sessionId of sessionIds) {
        const srcJsonl = path.join(srcProjectsDir, `${sessionId}.jsonl`)
        const dstJsonl = path.join(dstProjectsDir, `${sessionId}.jsonl`)
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
      // worktree 还被占用时（实施/测试会话终端 cwd 在里面、cc/codex 持有 git
      // 锁或打开文件）git worktree remove 会失败。先 dispose 该工单的全部会话
      // 终端，再等一小会让进程退出释放占用，然后再删。
      let disposedAny = false
      for (const [terminal, origin] of panel.terminalOrigin) {
        if (origin.issueNumber === issueNumber) {
          try {
            terminal.dispose()
            disposedAny = true
          }
          catch {
            // dispose 失败无所谓，VS Code 会清掉关闭事件
          }
        }
      }
      if (disposedAny)
        await new Promise<void>(r => setTimeout(r, 600))

      // Pre-remove hook — same best-effort contract as the other call
      // sites. Run before the actual remove so user scripts can still
      // touch the worktree dir.
      const settingsForHook = getSettings(panel.context)
      await panel.dispatchWorktreeHook('pre-remove', {
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
        panel.postMessage({
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

  if (featureBranch) {
    const settingsForBranchCleanup = getSettings(panel.context)
    const protectedBranches = new Set(
      ['main', 'master', settingsForBranchCleanup.devBranch, settingsForBranchCleanup.autoBuildBranch]
        .filter((branch): branch is string => Boolean(branch)),
    )
    if (protectedBranches.has(featureBranch)) {
      logger.add({
        level: 'warn',
        source: 'panel',
        message: `跳过受保护分支清理 ${featureBranch} (issue #${issueNumber})`,
      })
    }
    else {
      try {
        await deleteBranch({
          host: remote.host,
          token,
          owner: remote.owner,
          repo: remote.repo,
          branch: featureBranch,
        })
        logger.add({
          level: 'info',
          source: 'panel',
          message: `已删除远程 feature 分支 ${featureBranch} (issue #${issueNumber})`,
        })
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `删除远程 feature 分支失败 ${featureBranch} (issue #${issueNumber})`,
          details: message,
        })
      }

      try {
        const deleted = await deleteLocalBranch(workspaceRoot, featureBranch)
        if (deleted.ok) {
          logger.add({
            level: 'info',
            source: 'panel',
            message: `已删除本地 feature 分支 ${featureBranch} (issue #${issueNumber})`,
            details: deleted.stdout || deleted.stderr,
          })
        }
        else {
          logger.add({
            level: 'warn',
            source: 'panel',
            message: `删除本地 feature 分支失败 ${featureBranch} (issue #${issueNumber})`,
            details: deleted.stderr || deleted.stdout,
          })
        }
      }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.add({
          level: 'warn',
          source: 'panel',
          message: `删除本地 feature 分支抛错 ${featureBranch} (issue #${issueNumber})`,
          details: message,
        })
      }
    }
  }

  // 6. 全部成功 → 增量推 done + 清掉 worktreePath + 标记 prMerged。
  // webview 端 `{ ...issue, ...patch }` spread 会把 worktreePath 覆盖成
  // undefined，详情面板的 worktree 链接行因此消失。
  panel.postMessage({
    type: 'issue/patch',
    issueNumber,
    patch: {
      column: 'done',
      worktreePath: undefined,
      prMerged: true,
      prMergedAt: pullRequest.merged_at ?? new Date().toISOString(),
    },
  })
  panel.postMessage({
    type: 'toast/show',
    id: makeNonce(),
    level: 'success',
    message: `工单 #${issueNumber} 已完成，worktree 已清理`,
    dismissOnTimer: 5000,
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
export async function handleDropToInProgress(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  // Failed pre-flight → rollback optimistic move to source column.
  // Drags into in-progress typically originate from 'todo', so fall back
  // there when state JSON has no usable column field.
  const rollback = (fromColumn: IssueColumn | undefined): void => {
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: { column: fromColumn ?? 'todo' },
    })
  }

  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    rollback(undefined)
    panel.postMessage({
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    rollback(undefined)
    panel.postMessage({
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
    panel.postMessage({
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
    panel.postMessage({
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
    panel.postMessage({
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
    await panel.handleImplement(issueNumber, planFile, profilePath, sessionId)
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `启动实施失败 #${issueNumber}`,
      dismissOnTimer: 5000,
    })
  }
}

/**
 * 关闭 Gitea 工单，不清理本地会话、worktree、PR 或分支。
 * 成功后复用 issue/remove 消息，让 open issues 看板立即移除该工单。
 */
export async function handleCloseIssue(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  logger.add({
    level: 'info',
    source: 'panel',
    message: `收到关闭工单请求 #${issueNumber}`,
  })

  const choice = await window.showWarningMessage(
    `确定关闭工单 #${issueNumber}？此操作只会关闭 Gitea 工单，不会清理本地会话、worktree、PR 或分支。`,
    { modal: true },
    '关闭工单',
  )
  if (choice !== '关闭工单')
    return

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
  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }
  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '请先完成 Gitea 配置',
      dismissOnTimer: 5000,
    })
    return
  }

  try {
    await closeIssue({
      host: remote.host,
      token,
      owner: remote.owner,
      repo: remote.repo,
      issueNumber,
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'error',
      source: 'panel',
      message: `关闭工单 #${issueNumber} 失败`,
      details: message,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `关闭工单 #${issueNumber} 失败: ${message}`,
      dismissOnTimer: 6000,
    })
    return
  }

  logger.add({
    level: 'info',
    source: 'panel',
    message: `已关闭工单 #${issueNumber}`,
  })
  panel.postMessage({ type: 'issue/remove', issueNumber })
  panel.postMessage({
    type: 'toast/show',
    id: makeNonce(),
    level: 'success',
    message: `已关闭工单 #${issueNumber}`,
    dismissOnTimer: 4000,
  })
}

/**
 * 硬删 Gitea 工单 + 关联资源（worktree / PR / feature branch / cc session
 * tabs）。每步独立 try/catch，任一步失败立即停下并 toast 报错，让用户手动
 * 处理。前端在最后一步收到 `issue/remove` 后从 issues 数组移除该工单。
 */
export async function handleDeleteIssue(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
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
    panel.postMessage({
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }
  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
    panel.postMessage({
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
  for (const [terminal, origin] of panel.terminalOrigin) {
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
      const settingsForHook = getSettings(panel.context)
      await panel.dispatchWorktreeHook('pre-remove', {
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
        panel.postMessage({
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
        panel.postMessage({
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
      panel.postMessage({
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
    panel.postMessage({
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
  panel.postMessage({ type: 'issue/remove', issueNumber })
  panel.postMessage({
    type: 'toast/show',
    id: makeNonce(),
    level: 'success',
    message: `工单 #${issueNumber} 已删除`,
    dismissOnTimer: 4000,
  })
}

export async function handleIssueCreate(
  panel: KanbanWebviewPanel,
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
    panel.postMessage({
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  const settings = getSettings(panel.context)
  try {
    await webhookCoordinator.ensurePort(settings.webhookPort)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    panel.postMessage({
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
    panel.postMessage({
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
  const prompt = getBrainstormPrompt(panel.context, {
    userRequest: trimmed,
    nonce,
    imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
  })
  if (prompt.includes('\'')) {
    panel.postMessage({
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
    panel.postMessage({
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
    location: panel.resolveTerminalLocation(false),
    iconPath: iconUri,
    color: themeColor,
  })
  terminal.show(false)
  logger.add({
    level: 'info',
    source: 'terminal',
    message: `已创建终端 "${terminal.name}"`,
  })

  panel.pendingIssueCreations.set(nonce, {
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

  panel.postMessage({
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
    const pending = panel.pendingIssueCreations.get(nonce)
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
 * 把 Gitea 工单状态改成 closed。failure non-fatal —— state JSON 已写、PR 已合、
 * 看板已切到 done 列，rollback 意义不大。失败时打 warn 日志 + warning toast，
 * 用户可手动关闭工单。
 */
export async function syncCloseGiteaIssue(panel: KanbanWebviewPanel, opts: {
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
    panel.postMessage({
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
export async function resolveLockedReason(
  panel: KanbanWebviewPanel,
  issueNumber: number,
): Promise<{ locked: boolean, prerequisiteNumber?: number, prerequisiteColumn?: string }> {
  try {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!workspaceRoot)
      return { locked: false }
    const remote = await detectRepo(workspaceRoot)
    if (!remote)
      return { locked: false }
    const token = await getToken(panel.context, remote.host)
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

export async function handleSetDependency(panel: KanbanWebviewPanel, issueNumber: number, prerequisiteNumber: number): Promise<void> {
  // Gitea-only: dependency links don't map to YouTrack. Ignore for youtrack
  // cards rather than calling the gitea API with a synthetic number.
  if (panel.isYouTrackIssue(issueNumber) || panel.isYouTrackIssue(prerequisiteNumber))
    return
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

  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  void panel.loadAndPush()
}

export async function handleClearDependency(panel: KanbanWebviewPanel, issueNumber: number, prerequisiteNumber: number): Promise<void> {
  if (panel.isYouTrackIssue(issueNumber) || panel.isYouTrackIssue(prerequisiteNumber))
    return
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

  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  void panel.loadAndPush()
}

/**
 * Persist the per-issue `autoReview` override into the issue's state-JSON
 * comment. The webhook coordinator reads this on every PR `opened` /
 * `synchronize` to decide whether to fire a review. Set true/false → use
 * that value; we never write back `undefined` (the user explicitly chose).
 */
export async function handleUpdateAutoReview(panel: KanbanWebviewPanel, issueNumber: number, value: boolean): Promise<void> {
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

  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
    const existingState = await panel.readIssueState(issueNumber)
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
    await panel.mergeIssueState(issueNumber, { autoReview: value })
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `保存工单 #${issueNumber} 自动审查开关失败: ${message}`,
      dismissOnTimer: 6000,
    })
    // Roll back the optimistic update in the webview.
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: { autoReview: previousValue },
    })
  }
}

/**
 * Persist a per-issue `profilePath` override into the issue's state JSON
 * comment. The implement / implement-resume / conflict-resolution cc sessions
 * launch with this profile (see resolveImplementProfilePath); empty falls back
 * to DEFAULT_PROFILE_PATH. Mirrors handleUpdateAutoReview: optimistic update on
 * the webview, rolled back via `issue/patch` if the persist fails.
 */
export async function handleUpdateProfilePath(panel: KanbanWebviewPanel, issueNumber: number, profilePath: string): Promise<void> {
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

  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  let previousValue: string | undefined
  try {
    const existingState = await panel.readIssueState(issueNumber)
    previousValue = typeof existingState.profilePath === 'string'
      ? existingState.profilePath
      : undefined
  }
  catch {
    // If we can't read the previous state, leave previousValue undefined —
    // the rollback patch will clear the override, falling back to the default.
    previousValue = undefined
  }

  try {
    await panel.mergeIssueState(issueNumber, { profilePath })
    logger.add({
      level: 'info',
      source: 'panel',
      message: `工单 #${issueNumber} profilePath=${profilePath} 已持久化`,
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'error',
      source: 'panel',
      message: `持久化 profilePath 失败 (issue #${issueNumber})`,
      details: message,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `保存工单 #${issueNumber} 配置文件失败: ${message}`,
      dismissOnTimer: 6000,
    })
    // Roll back the optimistic update in the webview.
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: { profilePath: previousValue },
    })
  }
}

/**
 * Persist a per-issue `testProfilePath` override into the issue's state JSON
 * comment. The manually-started test cc session launches with this profile
 * (see resolveTestProfilePath); empty falls back to the implement `profilePath`,
 * then DEFAULT_PROFILE_PATH. Mirrors handleUpdateProfilePath: optimistic update
 * on the webview, rolled back via `issue/patch` if the persist fails.
 */
export async function handleUpdateTestProfilePath(panel: KanbanWebviewPanel, issueNumber: number, testProfilePath: string): Promise<void> {
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

  const remote = await detectRepo(workspaceRoot)
  if (!remote) {
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: '当前工作区没有 Gitea 远程仓库',
      dismissOnTimer: 5000,
    })
    return
  }

  const token = await getToken(panel.context, remote.host)
  if (!token) {
    panel.postMessage({
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
  let previousValue: string | undefined
  try {
    const existingState = await panel.readIssueState(issueNumber)
    previousValue = typeof existingState.testProfilePath === 'string'
      ? existingState.testProfilePath
      : undefined
  }
  catch {
    // If we can't read the previous state, leave previousValue undefined —
    // the rollback patch will clear the override, falling back to the default.
    previousValue = undefined
  }

  try {
    await panel.mergeIssueState(issueNumber, { testProfilePath })
    logger.add({
      level: 'info',
      source: 'panel',
      message: `工单 #${issueNumber} testProfilePath=${testProfilePath} 已持久化`,
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.add({
      level: 'error',
      source: 'panel',
      message: `持久化 testProfilePath 失败 (issue #${issueNumber})`,
      details: message,
    })
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `保存工单 #${issueNumber} 测试配置文件失败: ${message}`,
      dismissOnTimer: 6000,
    })
    // Roll back the optimistic update in the webview.
    panel.postMessage({
      type: 'issue/patch',
      issueNumber,
      patch: { testProfilePath: previousValue },
    })
  }
}

export async function handleOpenFile(panel: KanbanWebviewPanel, relPath: string): Promise<void> {
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
    panel.postMessage({
      type: 'toast/show',
      id: makeNonce(),
      level: 'error',
      message: `打开文件失败: ${message}`,
      dismissOnTimer: 6000,
    })
  }
}

/**
 * Resolve the gitea PR URL for the current workspace's remote and open it
 * in the user's default browser. Called from the webview's pr-link
 * button.
 */
export async function handleOpenPr(panel: KanbanWebviewPanel, pr: string): Promise<void> {
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

export async function handleGeneratePrDiffSummary(panel: KanbanWebviewPanel, issueNumber: number): Promise<void> {
  try {
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

    try {
      const state = await readStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
      })
      const pr = typeof state.pr === 'string' && /^\d+$/.test(state.pr) ? state.pr : undefined
      if (!pr) {
        panel.postMessage({
          type: 'toast/show',
          id: randomUUID(),
          level: 'error',
          message: `#${issueNumber} 尚未关联有效 PR`,
          dismissOnTimer: 8000,
        })
        void window.showErrorMessage(`#${issueNumber} 尚未关联有效 PR`)
        return
      }
      const stateWorktreePath = typeof state.worktreePath === 'string' && state.worktreePath.length > 0
        ? state.worktreePath
        : undefined
      if (!stateWorktreePath) {
        panel.postMessage({
          type: 'toast/show',
          id: randomUUID(),
          level: 'error',
          message: `#${issueNumber} 尚未记录 worktree 路径`,
          dismissOnTimer: 8000,
        })
        void window.showErrorMessage(`#${issueNumber} 尚未记录 worktree 路径`)
        return
      }
      const worktreePath = path.isAbsolute(stateWorktreePath)
        ? stateWorktreePath
        : path.join(workspaceRoot, stateWorktreePath)
      let worktreeStat: fs.Stats
      try {
        worktreeStat = await fsp.stat(worktreePath)
      }
      catch {
        void window.showErrorMessage(`#${issueNumber} 的 worktree 不存在: ${worktreePath}`)
        return
      }
      if (!worktreeStat.isDirectory()) {
        void window.showErrorMessage(`#${issueNumber} 的 worktree 不是目录: ${worktreePath}`)
        return
      }

      const outputRelPath = `docs/pr-diff/pr-${pr}-issue-${issueNumber}.md`
      const outputAbsPath = path.join(workspaceRoot, outputRelPath)

      panel.postMessage({
        type: 'toast/show',
        id: randomUUID(),
        level: 'info',
        message: `已启动 PR #${pr} 变更摘要生成`,
        dismissOnTimer: 5000,
      })

      const profilePath = PR_DIFF_SUMMARY_PROFILE_PATH
      const prompt = `你在一个 VS Code 扩展启动的后台 Claude 会话中工作。\n\n硬性限制：\n- 不要修改代码。\n- 不要创建或切换分支。\n- 不要提交。\n- 不要 push。\n- 不要写任何文件。\n- 只分析当前 PR 的代码变动，并把 Markdown 摘要正文直接输出到 stdout。\n\n任务：\n- 当前工作目录是工单 #\${issueNumber} 的 worktree。\n- 分析 PR #\${pr} 与主分支的代码差异。\n- 用 git 拿差异：先 git fetch origin main，再 git diff origin/main...HEAD（概览可加 --stat）。注意 tea 没有 diff 子命令，不要尝试 tea pulls diff。\n\n输出必须是合法 Markdown，预览器要能渲染出标题层级与代码块高亮，结构如下：\n1. 第一行是一级标题：# PR #\${pr} 代码变更摘要\n2. 紧接着用 1~2 句话概述本次变更：做了什么、新增了哪些包/模块、关键依赖方向（例如「stockpool/ 是与 orders/ catalog/ 平级的新子域包，其 service 只单向依赖 orders/catalog 的 repository，无循环导入」）。\n3. 然后写一行图例：图例：\\\`+\\\` = 新建文件　\\\`✎\\\` = 修改文件\n4. 然后是一棵统一的目录树，放进单个围栏代码块（语言标注用 text）：树前一行写三个反引号紧跟 text，树后一行写三个反引号。\n\n目录树规则：\n- 用 box-drawing 连线字符画树：├──、└──、│，缩进对齐，像 tree 命令的输出，不要只用纯空格缩进糊一棵没有连线的树。\n- 从仓库根开始保留真实目录层级。\n- 每个文件行以标记开头：新建文件用「+ 」、修改文件用「✎ 」，后接文件名 + 若干空格对齐 + 一句中文目的描述（简短，点出关键符号/端点/职责）。\n- 目录节点行尾可加可选的阶段/分组标签（如 [Phase N]），仅当本次变更本身有清晰阶段时才加；没有就不加，不要硬编。\n- 关键：整棵树一定要写在围栏代码块之内，否则 Markdown 预览器会折叠空白、丢掉层级与连线。\n\n排序与重点：\n- 按架构重要性排列：核心业务/领域代码（实现逻辑、入口、API routes、数据模型、service/repository）靠前。\n- alembic 数据库迁移文件、测试文件不算重点：放在各自模块或整棵树的靠后位置，照常用 +/✎ 标记列出，但不要放在最前、不要强调。\n- 测试文件判定：文件名形如 test_* / *_test.* / *.test.* / *.spec.*，或路径包含 tests/、__tests__/ 目录，或 conftest.py、fixture、mock 文件。\n- 迁移文件判定：路径在 alembic/、migrations/、versions/ 之下的文件。\n\n格式示例（请照此结构输出，不要照抄内容）：\n\n# PR #123 代码变更摘要\n\nstockpool/ 是与 orders/ catalog/ 平级的新子域包，其 service 只单向依赖 orders/catalog 的 repository，无循环导入。\n\n图例：\\\`+\\\` = 新建文件　\\\`✎\\\` = 修改文件\n\n\\\`\\\`\\\`text\nbackend/\n└── src/luffy_agent/commerce/\n    ├── models.py            ✎ +StockPool；ProductCatalog 加 pool_id\n    ├── stockpool/\n    │   ├── service.py       + reserve_pool_or_raise + compute_pool_views\n    │   └── routes.py        + /admin/commerce/stock-pools\n    ├── orders/service.py    ✎ create_order 绑定池分支\n    └── alembic/versions/    + stock_pool 建表 + pool_id 加列\n\\\`\\\`\\\`\n\n要求：\n- 每个新增/修改文件一行，一句话说明新增/修改了什么及其目的。\n- 整棵树只用一个围栏代码块，用 box-drawing 连线保留真实目录层级。\n- 只输出上述 Markdown 正文本身，不要写文件，不要任何前导说明/寒暄/结尾总结，第一行就是 # PR #\${pr} 代码变更摘要 标题。`

      const result = await spawnClaude({
        prompt,
        cwd: worktreePath,
        profilePath,
        timeoutMs: 600_000,
      })

      const summary = result.resultText.trim()
      if (!summary) {
        panel.postMessage({
          type: 'toast/show',
          id: randomUUID(),
          level: 'error',
          message: 'Claude 未返回摘要内容',
          dismissOnTimer: 8000,
        })
        void window.showErrorMessage('Claude 未返回摘要内容')
        return
      }

      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true })
      fs.writeFileSync(outputAbsPath, summary, 'utf8')

      await mergeStateJsonComment({
        host: remote.host,
        owner: remote.owner,
        repo: remote.repo,
        token,
        issueNumber,
        extra: { prDiffFile: outputRelPath },
      })
      panel.postMessage({
        type: 'issue/patch',
        issueNumber,
        patch: { prDiffFile: outputRelPath },
      })
      panel.postMessage({
        type: 'toast/show',
        id: randomUUID(),
        level: 'success',
        message: `PR #${pr} 变更摘要已生成`,
        dismissOnTimer: 5000,
      })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.add({
        level: 'error',
        source: 'panel',
        message: `生成 PR 变更摘要失败 #${issueNumber}`,
        details: message,
      })
      panel.postMessage({
        type: 'toast/show',
        id: randomUUID(),
        level: 'error',
        message: `生成 PR 变更摘要失败: ${message}`,
        dismissOnTimer: 8000,
      })
      void window.showErrorMessage(`生成 PR 变更摘要失败: ${message}`)
    }
  }
  finally {
    panel.postMessage({ type: 'issue/pr-diff-summary-done', issueNumber })
  }
}
