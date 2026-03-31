export type PlanStatus = 'default' | 'needsTesting' | 'completed'
export type PlanTaskStatus = 'running' | 'completed' | 'failed'

export interface SpecFile {
  name: string
  date: string
  title: string
  path: string
}

export interface PlanFile {
  name: string
  date: string
  title: string
  path: string
  status: PlanStatus
  taskStatus?: PlanTaskStatus
  progress: {
    completed: number
    total: number
  }
}

export interface SuperpowersData {
  specs: SpecFile[]
  plans: PlanFile[]
}

export interface GroupedFiles {
  [date: string]: SpecFile[] | PlanFile[]
}
