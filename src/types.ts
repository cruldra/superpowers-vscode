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
  /** `${date}-${topic}` */
  id: string
  /** 首选 spec 的首个 H1，缺则取 plan 的，再缺取 topic */
  title: string
  /** YYYY-MM-DD */
  date: string
  /** 文件名中间段，例如 "react-shadcn-rewrite" */
  topic: string
  /** spec 绝对路径，可缺 */
  specPath?: string
  /** plan 绝对路径，可缺 */
  planPath?: string
  phase: Phase
  state: TaskState
}
