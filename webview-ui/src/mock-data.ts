import type { Issue } from './types'

export const mockIssues: Issue[] = [
  // todo (4)
  { id: 'issue-12', number: 12, title: '支持 Gitea OAuth 登录', column: 'todo' },
  { id: 'issue-17', number: 17, title: '为 Kanban 列添加 WIP 上限', column: 'todo' },
  { id: 'issue-23', number: 23, title: '支持按 milestone 过滤 issue', column: 'todo' },
  { id: 'issue-31', number: 31, title: '增加键盘快捷键打开当前 issue', column: 'todo' },

  // in-progress (3)
  { id: 'issue-13', number: 13, title: '重构 webview 与扩展端的消息协议', column: 'in-progress' },
  { id: 'issue-21', number: 21, title: '把 issue 列表分页加载', column: 'in-progress' },
  { id: 'issue-28', number: 28, title: '实现拖拽改变 issue 状态', column: 'in-progress' },

  // review (1)
  { id: 'issue-19', number: 19, title: '修复夜间模式按钮对比度', column: 'review' },

  // done (2)
  { id: 'issue-7', number: 7, title: '初始化 VS Code 扩展骨架', column: 'done' },
  { id: 'issue-9', number: 9, title: '接入 Tailwind 与 shadcn 样式', column: 'done' },
]
