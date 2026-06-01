/**
 * 底部 panel：左侧垂直 tab 切换两个 property grid。
 *
 * - tab 1 「工单」：现有 IssueDetailPanel（基于 PropertyGrid）
 * - tab 2 「Profile」：工作区 KV 表 ProfileGrid
 *
 * tab 状态用 useState，无持久化；激活态加左侧 2px 高亮条。
 */

import type { ProfilesData } from '../lib/messages'
import type { Issue } from '../types'
import { ClipboardList, Layers } from 'lucide-react'
import { useState } from 'react'
import { IssueDetailPanel } from './IssueDetailPanel'
import { ProfileGrid } from './ProfileGrid'

type TabKey = 'issue' | 'profile'

interface BottomTabsProps {
  // Issue tab props (pass-through to IssueDetailPanel)
  issue: Issue | null
  allIssues: Issue[]
  globalAutoReview: boolean
  onOpenInBrowser: (url: string) => void
  onResumeSession: (sessionId: string, profilePath?: string, cwd?: string, issueNumber?: number) => void
  onResumeReviewSession: (sessionId: string, issueNumber: number, cwd?: string) => void
  onOpenFile: (path: string) => void
  onImplement: (issueNumber: number, planFile: string, profilePath?: string, sessionId?: string) => void
  onOpenPr: (pr: string) => void
  onGeneratePrDiffSummary: (issueNumber: number) => void
  onOpenWorktree: (path: string) => void
  onDeleteWorktree: (issueNumber: number, path: string) => void
  onDeleteIssue?: (issueNumber: number) => void
  onCloseIssue: (issueNumber: number) => void
  onCloseSessionTab: (issueNumber: number, kind: 'brainstorm' | 'implement' | 'review') => void
  onStartBrainstormSession: (issueNumber: number) => void
  onUpdateAutoReview: (issueNumber: number, value: boolean) => void
  onOpenLogs: () => void

  // Profile tab props
  profileData: ProfilesData
  onProfileSave: (next: ProfilesData) => void
  onProfileOpen: (value: string) => void
}

export function BottomTabs(props: BottomTabsProps) {
  const [tab, setTab] = useState<TabKey>('issue')

  return (
    <div className="flex h-full w-full bg-[var(--vscode-editor-background)]">
      {/* 左侧垂直 tab 栏 */}
      <div className="flex w-9 shrink-0 flex-col items-stretch border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background,var(--vscode-editor-background))]">
        <TabButton
          active={tab === 'issue'}
          onClick={() => setTab('issue')}
          icon={<ClipboardList className="size-4" />}
          title="工单"
        />
        <TabButton
          active={tab === 'profile'}
          onClick={() => setTab('profile')}
          icon={<Layers className="size-4" />}
          title="Profile"
        />
      </div>

      {/* 右侧内容 */}
      <div className="min-w-0 flex-1 overflow-hidden">
        {tab === 'issue'
          ? (
              <IssueDetailPanel
                issue={props.issue}
                allIssues={props.allIssues}
                globalAutoReview={props.globalAutoReview}
                onOpenInBrowser={props.onOpenInBrowser}
                onResumeSession={props.onResumeSession}
                onResumeReviewSession={props.onResumeReviewSession}
                onOpenFile={props.onOpenFile}
                onImplement={props.onImplement}
                onOpenPr={props.onOpenPr}
                onGeneratePrDiffSummary={props.onGeneratePrDiffSummary}
                onOpenWorktree={props.onOpenWorktree}
                onDeleteWorktree={props.onDeleteWorktree}
                onDeleteIssue={props.onDeleteIssue}
                onCloseIssue={props.onCloseIssue}
                onCloseSessionTab={props.onCloseSessionTab}
                onStartBrainstormSession={props.onStartBrainstormSession}
                onUpdateAutoReview={props.onUpdateAutoReview}
                onOpenLogs={props.onOpenLogs}
              />
            )
          : (
              <ProfileGrid
                data={props.profileData}
                onSave={props.onProfileSave}
                onOpen={props.onProfileOpen}
              />
            )}
      </div>
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
}

function TabButton({ active, onClick, icon, title }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`relative flex h-9 w-full items-center justify-center transition-colors ${
        active
          ? 'text-[var(--vscode-foreground)]'
          : 'text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-0 h-full w-[2px] bg-[var(--vscode-focusBorder)]" />
      )}
      {icon}
    </button>
  )
}
