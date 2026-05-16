export type IssueColumn = 'todo' | 'in-progress' | 'review' | 'done'

export interface Issue {
  id: string
  number: number
  title: string
  column: IssueColumn
  sessionId?: string
  htmlUrl: string
}

export const COLUMN_ORDER: IssueColumn[] = ['todo', 'in-progress', 'review', 'done']

export const COLUMN_LABELS: Record<IssueColumn, string> = {
  'todo': '待办',
  'in-progress': '进行中',
  'review': '审查',
  'done': '完成',
}
