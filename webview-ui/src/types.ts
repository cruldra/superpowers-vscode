export type Phase = 'planning' | 'development'

export type PlanningState =
  | 'write-spec'
  | 'spec-review'
  | 'write-plan'
  | 'plan-review'

export type DevelopmentState =
  | 'create-worktree'
  | 'implement'
  | 'review'
  | 'fix'
  | 'review-passed'
  | 'merge-cleanup'

export type TaskState = PlanningState | DevelopmentState

export interface Task {
  id: string
  title: string
  date: string
  topic: string
  specPath?: string
  planPath?: string
  phase: Phase
  state: TaskState
}

export type ExtensionToWebview =
  | { type: 'tasks/update'; tasks: Task[] }

export type WebviewToExtension =
  | { type: 'tasks/request' }
  | { type: 'task/open'; path: string }
