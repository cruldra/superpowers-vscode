import type { Task } from '../types'

export type ExtensionToWebview =
  | { type: 'tasks/update', tasks: Task[] }

export type WebviewToExtension =
  | { type: 'tasks/request' }
  | { type: 'task/open', path: string }
