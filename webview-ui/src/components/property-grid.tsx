/**
 * 属性网格（Property Grid）组件
 *
 * 以表格形式展示和编辑键值配置项，支持分组折叠、搜索过滤、
 * 多种字段类型（文本、数字、布尔、选择、颜色、密码、动作），适用于
 * 系统参数配置 / 单一对象字段查看 等场景。
 *
 * 从 mantine 版本 1:1 移植到 Tailwind + shadcn 风格；移除了所有显式
 * 背景色，依赖 VS Code 主题 CSS 变量。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
} from 'lucide-react'

// --- 类型定义 ---

/** 字段类型枚举 */
export type FieldType =
  | 'string'
  | 'multiline'
  | 'number'
  | 'boolean'
  | 'select'
  | 'color'
  | 'password'
  | 'action'
  | 'file-link'
  | 'pr-link'

/** 属性定义 */
export interface PropertyDef {
  /** 属性 key */
  key: string
  /** 显示标签 */
  label: string
  /** 字段类型 */
  type: FieldType
  /** 说明描述（鼠标悬浮显示） */
  description?: string
  /** 下拉选项（type=select 时使用） */
  options?: Array<{ label: string, value: string | number }>
  /** 是否只读 */
  readOnly?: boolean
  /** type='action' / 'pr-link' 专用：点击值时的回调 */
  onAction?: (value: unknown) => void
  /** type='action' 专用：值前的图标 */
  actionIcon?: ReactNode
  /** type='file-link' 专用：点击文件名时调用，参数为 value（workspace 相对路径） */
  onOpen?: (path: string) => void
  /** type='file-link' 专用：点击右侧图标按钮时调用，用于重新扫描/加载 */
  onReload?: () => void
  /** type='file-link' 专用：重新加载按钮的图标，默认为 RefreshCw */
  reloadIcon?: ReactNode
  /** type='file-link' 专用：第二个右侧按钮的图标，缺省则不渲染该按钮 */
  secondaryActionIcon?: ReactNode
  /** type='file-link' 专用：第二个右侧按钮的 tooltip */
  secondaryActionTitle?: string
  /** type='file-link' 专用：第二个右侧按钮的点击回调 */
  onSecondaryAction?: () => void
  /** type='file-link' 专用：第二个右侧按钮是否禁用 */
  secondaryDisabled?: boolean
}

/** 属性分组定义 */
export interface PropertyGroup {
  /** 分组唯一 ID */
  id: string
  /** 分组标签 */
  label: string
  /** 属性列表 */
  properties: PropertyDef[]
  /** 可选：在分组标题行右侧渲染的额外操作按钮（如图标按钮）。 */
  actions?: ReactNode
}

/** PropertyGrid 组件 Props */
export interface PropertyGridProps {
  /** 分组 Schema 定义 */
  schema: PropertyGroup[]
  /** 当前配置数据 */
  data: Record<string, unknown>
  /** 数据变更回调 */
  onChange?: (key: string, value: unknown) => void
  /** 保存回调 */
  onSave?: (data: Record<string, unknown>) => void
  /** 重置回调 */
  onReset?: () => void
  /** 标题 */
  title?: string
  /** 搜索框占位文案 */
  searchPlaceholder?: string
  /** 空状态文案 */
  emptyMessage?: string
  /** 保存按钮文案 */
  saveLabel?: string
  /** 重置按钮文案 */
  resetLabel?: string
  /** 保存中状态 */
  saving?: boolean
  /** 保存按钮禁用态 */
  saveDisabled?: boolean
  /** 是否填满父容器高度 */
  fillHeight?: boolean
  /** 隐藏顶部工具栏（标题 + 搜索框） */
  hideToolbar?: boolean
}

// --- 共享样式 ---

/** 输入框基础样式（无 ring，依赖父容器边框） */
const inputClass
  = 'w-full bg-transparent border-0 outline-none px-2 py-1.5 text-xs text-[var(--vscode-input-foreground)] focus:ring-1 focus:ring-inset focus:ring-[var(--vscode-focusBorder)] disabled:opacity-60 disabled:cursor-not-allowed'

// --- 内部子组件 ---

/** 属性行：渲染一条属性的标签列和值编辑列 */
function PropertyRow({
  propDef,
  value,
  onChange,
  fullKey,
  isSelected,
  onSelect,
  registerCellRef,
}: {
  propDef: PropertyDef
  value: unknown
  onChange: (key: string, value: unknown) => void
  fullKey: string
  isSelected: boolean
  onSelect: (fullKey: string) => void
  registerCellRef: (fullKey: string, el: HTMLDivElement | null) => void
}) {
  const [showPassword, setShowPassword] = useState(false)
  const ro = propDef.readOnly

  function renderControl(): ReactNode {
    switch (propDef.type) {
      case 'boolean':
        return (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <input
              type="checkbox"
              checked={!!value}
              onChange={e => onChange(propDef.key, e.target.checked)}
              disabled={ro}
              className="h-3.5 w-3.5 cursor-pointer disabled:cursor-not-allowed"
            />
            <span className="text-xs opacity-60">{value ? 'True' : 'False'}</span>
          </div>
        )

      case 'select':
        if (ro) {
          const match = (propDef.options ?? []).find(o => String(o.value) === String(value ?? ''))
          return (
            <span className="block truncate px-2 py-1.5 text-xs">
              {match?.label ?? String(value ?? '')}
            </span>
          )
        }
        return (
          <select
            value={String(value ?? '')}
            onChange={e => onChange(propDef.key, e.target.value)}
            className={`${inputClass} appearance-none`}
          >
            {(propDef.options ?? []).map(o => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        )

      case 'multiline':
        return (
          <textarea
            aria-label={propDef.label}
            value={String(value ?? '')}
            onChange={e => onChange(propDef.key, e.target.value)}
            disabled={ro}
            rows={3}
            className={`${inputClass} resize-y font-mono`}
          />
        )

      case 'color':
        return (
          <div className="flex items-center gap-2 px-2 py-1">
            <input
              type="color"
              value={String(value ?? '#000000')}
              onChange={e => onChange(propDef.key, e.target.value)}
              disabled={ro}
              className="h-6 w-6 shrink-0 cursor-pointer border-0 p-0 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <input
              type="text"
              value={String(value ?? '')}
              onChange={e => onChange(propDef.key, e.target.value)}
              disabled={ro}
              className={`${inputClass} flex-1 font-mono uppercase`}
            />
          </div>
        )

      case 'number':
        return (
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={e =>
              onChange(propDef.key, e.target.value === '' ? null : Number(e.target.value))}
            disabled={ro}
            className={`${inputClass} font-mono`}
          />
        )

      case 'password':
        return (
          <div className="relative flex items-center">
            <input
              type={showPassword ? 'text' : 'password'}
              value={String(value ?? '')}
              onChange={e => onChange(propDef.key, e.target.value)}
              disabled={ro}
              className={`${inputClass} pr-8`}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              aria-label={showPassword ? '隐藏' : '显示'}
              className="absolute right-2 grid size-5 place-items-center opacity-60 hover:opacity-100"
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        )

      case 'action':
        if (value == null || value === '') {
          return <span className="px-2 py-1.5 text-xs opacity-50">—</span>
        }
        return (
          <button
            type="button"
            data-property-action="primary"
            onClick={() => propDef.onAction?.(value)}
            disabled={ro}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {propDef.actionIcon}
            <span className="truncate font-mono underline-offset-2 hover:underline">
              {String(value)}
            </span>
          </button>
        )

      case 'file-link': {
        const hasValue = typeof value === 'string' && value.length > 0
        const reloadIcon = propDef.reloadIcon ?? <RefreshCw className="size-3.5" />
        const hasSecondary = propDef.secondaryActionIcon != null
        const secondaryDisabled = !!propDef.secondaryDisabled
        return (
          <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
            {hasValue
              ? (
                  <button
                    type="button"
                    data-property-action="primary"
                    onClick={() => propDef.onOpen?.(value as string)}
                    title={value as string}
                    className="min-w-0 flex-1 truncate text-left text-xs font-mono text-[var(--vscode-textLink-foreground)] underline-offset-2 hover:text-[var(--vscode-textLink-activeForeground)] hover:underline"
                  >
                    {value as string}
                  </button>
                )
              : (
                  <span className="min-w-0 flex-1 truncate text-xs opacity-50">未加载</span>
                )}
            {!hasValue && (
              <button
                type="button"
                onClick={() => propDef.onReload?.()}
                aria-label="重新加载"
                className="grid size-5 shrink-0 place-items-center opacity-60 hover:opacity-100"
              >
                {reloadIcon}
              </button>
            )}
            {hasSecondary && (
              <button
                type="button"
                onClick={() => {
                  if (secondaryDisabled)
                    return
                  propDef.onSecondaryAction?.()
                }}
                disabled={secondaryDisabled}
                title={propDef.secondaryActionTitle}
                aria-label={propDef.secondaryActionTitle ?? '次要操作'}
                className={`grid size-5 shrink-0 place-items-center ${
                  secondaryDisabled
                    ? 'cursor-not-allowed opacity-30'
                    : 'opacity-60 hover:opacity-100'
                }`}
              >
                {propDef.secondaryActionIcon}
              </button>
            )}
          </div>
        )
      }

      case 'pr-link': {
        const hasValue = typeof value === 'string' && value.length > 0
        if (!hasValue) {
          return (
            <span className="block truncate px-2 py-1.5 text-xs opacity-50">未关联 PR</span>
          )
        }
        return (
          <button
            type="button"
            data-property-action="primary"
            onClick={() => propDef.onAction?.(value)}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
          >
            <span className="truncate font-mono underline-offset-2 hover:underline">
              {`#${value as string}`}
            </span>
          </button>
        )
      }

      case 'string':
      default:
        if (ro) {
          return <span className="block truncate px-2 py-1.5 text-xs">{String(value ?? '')}</span>
        }
        return (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={e => onChange(propDef.key, e.target.value)}
            className={inputClass}
          />
        )
    }
  }

  return (
    <div className="group flex min-h-[36px] border-b border-[var(--vscode-panel-border)] transition-colors last:border-b-0">
      {/* 标签列 */}
      <div className="flex w-[38%] flex-shrink-0 items-center gap-1.5 border-r border-[var(--vscode-panel-border)] px-3 py-1">
        <span className="truncate text-xs font-medium" title={propDef.label}>
          {propDef.label}
        </span>
        {propDef.description && (
          <span
            title={propDef.description}
            className="grid size-3 cursor-help place-items-center opacity-60"
          >
            <Info className="size-3" />
          </span>
        )}
      </div>

      {/* 值编辑列 */}
      <div
        ref={el => registerCellRef(fullKey, el)}
        data-property-cell={fullKey}
        onClickCapture={(e) => {
          if (!isSelected) {
            e.stopPropagation()
            e.preventDefault()
            onSelect(fullKey)
          }
        }}
        className={`flex min-w-0 flex-1 ${
          propDef.type === 'multiline' ? 'items-stretch' : 'items-center'
        } ${
          isSelected ? 'rounded ring-2 ring-inset ring-[var(--vscode-focusBorder)]' : ''
        } ${
          !isSelected
          && (propDef.type === 'action'
            || propDef.type === 'file-link'
            || propDef.type === 'pr-link')
            ? 'cursor-pointer'
            : ''
        }`}
      >
        {renderControl()}
      </div>
    </div>
  )
}

// --- 主组件 ---

/**
 * 属性网格组件
 *
 * 以表格形式按分组展示可编辑的配置项，支持搜索、折叠分组、保存和重置。
 *
 * @example
 * ```tsx
 * <PropertyGrid
 *   schema={CONFIG_SCHEMA}
 *   data={configData}
 *   onChange={(key, value) => setConfigData(prev => ({ ...prev, [key]: value }))}
 *   onSave={(data) => saveConfig(data)}
 *   onReset={() => setConfigData(INITIAL_DATA)}
 * />
 * ```
 */
export function PropertyGrid({
  schema,
  data,
  onChange,
  onSave,
  onReset,
  title = '系统参数配置',
  searchPlaceholder = '搜索配置项（key 或名称）...',
  emptyMessage,
  saveLabel = '保存配置',
  resetLabel = '重置默认值',
  saving = false,
  saveDisabled = false,
  fillHeight = false,
  hideToolbar = false,
}: PropertyGridProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cellRefsRef = useRef<Map<string, HTMLDivElement>>(new Map())

  /** 切换到新 data 时清空选中 */
  useEffect(() => {
    setSelectedKey(null)
  }, [data])

  /** 点击网格外部时清空选中 */
  useEffect(() => {
    if (selectedKey == null)
      return
    function handleMouseDown(e: MouseEvent): void {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target))
        setSelectedKey(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [selectedKey])

  /** 注册/解除每个 value cell 的 DOM 引用，便于 scrollIntoView */
  function registerCellRef(fullKey: string, el: HTMLDivElement | null): void {
    if (el)
      cellRefsRef.current.set(fullKey, el)
    else
      cellRefsRef.current.delete(fullKey)
  }

  /** 根据搜索词过滤 schema（提前声明，供键盘 effect 使用） */
  const filteredSchema = useMemo(() => {
    if (!searchTerm.trim())
      return schema
    const lower = searchTerm.toLowerCase()
    return schema
      .map(group => ({
        ...group,
        properties: group.properties.filter(
          p => p.label.toLowerCase().includes(lower) || p.key.toLowerCase().includes(lower),
        ),
      }))
      .filter(g => g.properties.length > 0)
  }, [schema, searchTerm])

  /** 当前可见的 value cell 顺序列表（折叠分组的属性被排除） */
  const visibleCellKeys = useMemo(() => {
    const keys: string[] = []
    for (const group of filteredSchema) {
      if (collapsedGroups[group.id])
        continue
      for (const prop of group.properties)
        keys.push(`${group.id}/${prop.key}`)
    }
    return keys
  }, [filteredSchema, collapsedGroups])

  /** 选中后启用键盘导航（捕获阶段，优先于 App 全局 window 监听） */
  useEffect(() => {
    if (selectedKey == null)
      return

    function handleKeyDown(e: KeyboardEvent): void {
      if (selectedKey == null)
        return

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const idx = visibleCellKeys.indexOf(selectedKey)
        if (idx < 0)
          return
        e.preventDefault()
        e.stopPropagation()
        const next = e.key === 'ArrowDown'
          ? Math.min(idx + 1, visibleCellKeys.length - 1)
          : Math.max(idx - 1, 0)
        const nextKey = visibleCellKeys[next]
        if (nextKey !== selectedKey) {
          setSelectedKey(nextKey)
          // 滚动到视野内（异步等待 DOM 更新 ref）
          requestAnimationFrame(() => {
            const el = cellRefsRef.current.get(nextKey)
            el?.scrollIntoView({ block: 'nearest' })
          })
        }
        return
      }

      if (e.key === 'Enter') {
        const cell = cellRefsRef.current.get(selectedKey)
        if (!cell)
          return
        const action = cell.querySelector<HTMLElement>('[data-property-action="primary"]')
        if (!action)
          return
        e.preventDefault()
        e.stopPropagation()
        action.click()
      }
      // ArrowLeft / ArrowRight / 其他键：不处理，让事件继续冒泡给 App 全局监听
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [selectedKey, visibleCellKeys])

  function toggleGroup(groupId: string): void {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  function handleChange(key: string, value: unknown): void {
    onChange?.(key, value)
  }

  return (
    <div
      ref={rootRef}
      data-testid="property-grid-root"
      data-fill-height={fillHeight ? 'true' : 'false'}
      className="flex w-full flex-col"
      style={{ height: fillHeight ? '100%' : undefined, minHeight: 0 }}
    >
      {/* 顶部工具栏 */}
      {!hideToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-md border border-b-0 border-[var(--vscode-panel-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Settings className="size-4 text-[var(--vscode-textLink-foreground)]" />
            <span className="text-sm font-bold">{title}</span>
          </div>
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 size-3.5 opacity-60" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-[260px] rounded border border-[var(--vscode-input-border,transparent)] py-1 pl-7 pr-2 text-xs text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>
        </div>
      )}

      {/* 属性表格 */}
      <div
        className={`overflow-y-auto border border-[var(--vscode-panel-border)] ${
          hideToolbar ? 'rounded-md' : 'rounded-b-md'
        }`}
        style={{
          flex: fillHeight ? 1 : undefined,
          height: fillHeight ? '100%' : undefined,
          minHeight: 0,
        }}
      >
        {filteredSchema.length === 0
          ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <Search className="size-10 opacity-30" />
                <span className="text-xs opacity-60">
                  {emptyMessage ?? `没有找到与 "${searchTerm}" 相关的配置项`}
                </span>
              </div>
            )
          : (
              filteredSchema.map((group) => {
                const isCollapsed = !!collapsedGroups[group.id]
                return (
                  <div key={group.id}>
                    {/* 分组标题行 */}
                    <div className="sticky top-0 z-[5] flex w-full items-center gap-1.5 border-b border-[var(--vscode-panel-border)] px-3 py-1.5 transition-colors">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        className="flex flex-1 items-center gap-1.5 text-left"
                      >
                        <span className="grid place-items-center opacity-60">
                          {isCollapsed
                            ? <ChevronRight className="size-3.5" />
                            : <ChevronDown className="size-3.5" />}
                        </span>
                        <span className="text-xs font-bold uppercase tracking-wider">
                          {group.label}
                        </span>
                        <span className="ml-auto text-xs opacity-60">
                          {group.properties.length}
                          {' 项'}
                        </span>
                      </button>
                      {group.actions && (
                        <div className="ml-1.5 flex shrink-0 items-center">
                          {group.actions}
                        </div>
                      )}
                    </div>

                    {/* 分组属性行列表 */}
                    {!isCollapsed && group.properties.map((prop) => {
                      const fullKey = `${group.id}/${prop.key}`
                      return (
                        <PropertyRow
                          key={prop.key}
                          propDef={prop}
                          value={data[prop.key]}
                          onChange={handleChange}
                          fullKey={fullKey}
                          isSelected={selectedKey === fullKey}
                          onSelect={setSelectedKey}
                          registerCellRef={registerCellRef}
                        />
                      )
                    })}
                  </div>
                )
              })
            )}
      </div>

      {/* 底部操作按钮 */}
      {(onSave || onReset) && (
        <div className="mt-3 flex justify-end gap-2">
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded border border-[var(--vscode-panel-border)] px-3 py-1.5 text-xs hover:border-[var(--vscode-focusBorder)]"
            >
              <RotateCcw className="size-3.5" />
              {resetLabel}
            </button>
          )}
          {onSave && (
            <button
              type="button"
              onClick={() => onSave(data)}
              disabled={saving || saveDisabled}
              className="inline-flex items-center gap-1.5 rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-xs text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="size-3.5" />
              {saving ? '保存中…' : saveLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// --- 演示用默认 Schema 与数据（供开发测试使用） ---

/** 示例 Schema（开发测试用） */
export const DEMO_SCHEMA: PropertyGroup[] = [
  {
    id: 'general',
    label: '常规设置 (General)',
    properties: [
      { key: 'appName', label: '应用名称', type: 'string', description: '系统在前端展示的全局名称' },
      { key: 'maxUsers', label: '最大用户数', type: 'number', description: '系统允许注册的最大账号数量' },
      { key: 'maintenanceMode', label: '维护模式', type: 'boolean', description: '开启后除超管外其他用户无法登录' },
      {
        key: 'defaultLanguage',
        label: '默认语言',
        type: 'select',
        options: [
          { label: '简体中文 (zh-CN)', value: 'zh-CN' },
          { label: 'English (en-US)', value: 'en-US' },
          { label: '日本語 (ja-JP)', value: 'ja-JP' },
        ],
      },
    ],
  },
  {
    id: 'database',
    label: '数据库连接 (Database)',
    properties: [
      { key: 'dbHost', label: '主机地址 (Host)', type: 'string' },
      { key: 'dbPort', label: '端口号 (Port)', type: 'number' },
      { key: 'dbUser', label: '用户名 (User)', type: 'string' },
      { key: 'dbPassword', label: '密码 (Password)', type: 'password' },
      { key: 'dbSsl', label: '启用 SSL', type: 'boolean' },
    ],
  },
  {
    id: 'appearance',
    label: '外观主题 (Appearance)',
    properties: [
      { key: 'primaryColor', label: '系统主色调', type: 'color', description: '全局按钮和高亮的主题色' },
      { key: 'sidebarWidth', label: '侧边栏宽度 (px)', type: 'number' },
      { key: 'enableAnimation', label: '启用界面动画', type: 'boolean' },
    ],
  },
]

/** 示例数据（开发测试用） */
export const DEMO_DATA: Record<string, unknown> = {
  appName: '星辰客户增长平台',
  maxUsers: 500,
  maintenanceMode: false,
  defaultLanguage: 'zh-CN',
  dbHost: 'pg-prod-cluster-01.internal',
  dbPort: 5432,
  dbUser: 'admin_sys',
  dbPassword: 'super_secret_password_123!',
  dbSsl: true,
  primaryColor: '#2563eb',
  sidebarWidth: 256,
  enableAnimation: true,
}
