import { useEffect, useState } from 'react'
import { onMessage, postMessage } from '../lib/vscode'
import type { Task } from '../types'

export function useTasks(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === 'tasks/update')
        setTasks(msg.tasks)
    })
    postMessage({ type: 'tasks/request' })
    return cleanup
  }, [])

  return tasks
}
