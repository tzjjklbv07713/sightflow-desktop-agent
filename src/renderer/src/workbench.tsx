import React, { useMemo, useState } from 'react'

export type WorkbenchTheme = 'light' | 'dark'
export type WorkbenchState =
  | 'idle'
  | 'processing'
  | 'confirm'
  | 'executing'
  | 'success'
  | 'error'
  | 'review'

export interface WorkbenchLogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error' | 'metric'
  content: string
}

export interface TimelineStep {
  id: string
  label: string
  status: 'done' | 'current' | 'pending' | 'error'
  meta?: string
}

export interface TaskCardItem {
  id: string
  kind: 'task' | 'confirm' | 'result' | 'empty'
  title: string
  body: string
  accent?: string
  actions?: Array<{ id: string; label: string; primary?: boolean; onClick?: () => void }>
}

export interface LeftRailItem {
  id: string
  label: string
  meta?: string
  active?: boolean
  onClick?: () => void
}

export interface QuickAction {
  id: string
  label: string
  tone?: 'neutral' | 'accent' | 'danger'
  onClick?: () => void
}

export interface WorkbenchProps {
  theme: WorkbenchTheme
  onToggleTheme: () => void
  state: WorkbenchState
  statusText: string
  brandIconUrl?: string
  headerMeta?: string
  appChoices: LeftRailItem[]
  leftCategories: LeftRailItem[]
  leftPrimary: LeftRailItem[]
  leftHistory: LeftRailItem[]
  quickActions: QuickAction[]
  timeline: TimelineStep[]
  taskCards: TaskCardItem[]
  logs: WorkbenchLogEntry[]
  inspectorContext: Array<{ label: string; value: string }>
  inspectorDebug: Array<{ label: string; value: string }>
  inspectorActions: QuickAction[]
  statusStripLeft: string
  statusStripRight: string
  children?: React.ReactNode
}

const STATE_LABELS: Record<WorkbenchState, string> = {
  idle: '空闲',
  processing: '处理中',
  confirm: '待确认',
  executing: '执行中',
  success: '已完成',
  error: '异常',
  review: '复盘中'
}

const TASK_KIND_LABELS: Record<TaskCardItem['kind'], string> = {
  task: '任务',
  confirm: '确认',
  result: '结果',
  empty: '待命'
}

const LOG_TYPE_LABELS: Record<WorkbenchLogEntry['type'], string> = {
  thinking: '思考',
  reply: '回复',
  skip: '跳过',
  error: '错误',
  metric: '指标'
}

const MAIN_PANEL_COPY: Record<WorkbenchState, string> = {
  idle: '把关键切换前置到主区，执行路径在中部推进，实时运行日志固定留在底部，避免核心信息继续分散在边栏里。',
  processing: '系统正在整理最新观察与策略线索，主区会先更新任务链路，底部日志会持续补充过程细节。',
  confirm: '当前还缺少执行前准备，先在主控区确认目标应用与任务分类，再完成必要设置。',
  executing: '当前任务正在推进，主区聚焦关键节点和动作卡片，右侧只保留辅助状态，底部日志持续滚动。',
  success: '结果已经生成，主区保留下一步入口，右侧做补充检查，底部日志继续保留完整轨迹。',
  error: '当前出现异常，先看任务卡片和右侧状态，再从底部日志快速定位问题发生在什么时候。',
  review: '当前进入复盘态，主区聚焦关键节点，底部日志保留连续事件流，便于回看整段执行过程。'
}

const TASK_STACK_COPY: Record<WorkbenchState, string> = {
  idle: '卡片区优先承载下一步动作，而不是重复堆叠日志。',
  processing: '策略、确认和结果都会在这里按优先级展开。',
  confirm: '需要补准备时，卡片区会直接给出最短操作路径。',
  executing: '执行中的关键动作和中断入口会优先出现在这里。',
  success: '已有结果时，卡片区负责承接下一步，而不是把你送回侧栏里找入口。',
  error: '异常态下先看这里，再结合右侧状态和底部日志判断怎么处理。',
  review: '复盘态保留结果与跳过原因，方便快速判断是否继续推进。'
}

export function PageShell({
  theme,
  state,
  children
}: {
  theme: WorkbenchTheme
  state: WorkbenchState
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`page-shell theme-${theme}`} data-workbench-state={state}>
      <div className="page-shell__backdrop page-shell__backdrop--top" />
      <div className="page-shell__backdrop page-shell__backdrop--bottom" />
      {children}
    </div>
  )
}

export function WorkspaceHeader({
  theme,
  onToggleTheme,
  state,
  statusText,
  brandIconUrl,
  headerMeta
}: {
  theme: WorkbenchTheme
  onToggleTheme: () => void
  state: WorkbenchState
  statusText: string
  brandIconUrl?: string
  headerMeta?: string
}): React.JSX.Element {
  return (
    <header className="workspace-header">
      <div className="workspace-header__brand">
        <div className="workspace-header__brand-row">
          {brandIconUrl ? (
            <img src={brandIconUrl} alt="SightFlow" className="workspace-header__logo" />
          ) : null}
          <div>
            <div className="workspace-header__eyebrow">SightFlow Command Center</div>
            <div className="workspace-header__title">Professional Robot Workbench</div>
          </div>
        </div>
        {headerMeta ? <div className="workspace-header__meta">{headerMeta}</div> : null}
      </div>
      <div className="workspace-header__controls">
        <div className={`workspace-header__state workspace-header__state--${state}`}>
          <span className="workspace-header__state-dot" />
          <span>{statusText}</span>
        </div>
        <button type="button" className="workspace-header__theme-toggle" onClick={onToggleTheme}>
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
      </div>
    </header>
  )
}

export function WorkspaceLayout({
  left,
  center,
  right,
  dock
}: {
  left: React.ReactNode
  center: React.ReactNode
  right: React.ReactNode
  dock?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="workspace-layout">
      <aside className="workspace-layout__left">{left}</aside>
      <section className="workspace-layout__main">
        <main className="workspace-layout__center">{center}</main>
        {dock ? <div className="workspace-layout__dock">{dock}</div> : null}
      </section>
      <aside className="workspace-layout__right">{right}</aside>
    </div>
  )
}

export function LeftRail({
  appChoices,
  categories,
  primary,
  history,
  quickActions
}: {
  appChoices: LeftRailItem[]
  categories: LeftRailItem[]
  primary: LeftRailItem[]
  history: LeftRailItem[]
  quickActions: QuickAction[]
}): React.JSX.Element {
  const activeApp = useMemo(
    () => appChoices.find((item) => item.active) ?? appChoices[0],
    [appChoices]
  )
  const activeCategory = useMemo(
    () => categories.find((item) => item.active) ?? categories[0],
    [categories]
  )

  return (
    <div className="left-rail">
      <section className="left-rail__section left-rail__section--focus">
        <div className="left-rail__section-title">当前焦点</div>
        <div className="left-rail__context-grid">
          <div className="left-rail__context-card">
            <span className="left-rail__context-label">目标应用</span>
            <strong className="left-rail__context-value">{activeApp?.label || '未选择'}</strong>
            {activeApp?.meta ? (
              <span className="left-rail__context-meta">{activeApp.meta}</span>
            ) : null}
          </div>
          <div className="left-rail__context-card">
            <span className="left-rail__context-label">任务分类</span>
            <strong className="left-rail__context-value">
              {activeCategory?.label || '未选择'}
            </strong>
            {activeCategory?.meta ? (
              <span className="left-rail__context-meta">{activeCategory.meta}</span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="left-rail__section">
        <div className="left-rail__section-title">任务入口</div>
        <div className="left-rail__stack">
          {primary.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`left-rail__item${item.active ? ' active' : ''}`}
              onClick={item.onClick}
            >
              <span className="left-rail__item-label">{item.label}</span>
              {item.meta ? <span className="left-rail__item-meta">{item.meta}</span> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="left-rail__section">
        <div className="left-rail__section-title">最近记录</div>
        <div className="left-rail__stack left-rail__stack--dense left-rail__stack--history">
          {history.map((item) => (
            <button
              type="button"
              key={item.id}
              className="left-rail__item left-rail__item--history"
              onClick={item.onClick}
            >
              <span className="left-rail__item-label">{item.label}</span>
              {item.meta ? <span className="left-rail__item-meta">{item.meta}</span> : null}
            </button>
          ))}
        </div>
      </section>

      <QuickActionBar actions={quickActions} />
    </div>
  )
}

export function MainConversationPanel({
  state,
  timeline,
  cards,
  logs,
  appChoices,
  categories,
  context,
  debug
}: {
  state: WorkbenchState
  timeline: TimelineStep[]
  cards: TaskCardItem[]
  logs: WorkbenchLogEntry[]
  appChoices: LeftRailItem[]
  categories: LeftRailItem[]
  context: Array<{ label: string; value: string }>
  debug: Array<{ label: string; value: string }>
}): React.JSX.Element {
  return (
    <div className="main-panel">
      <MainControlDeck
        appChoices={appChoices}
        categories={categories}
        context={context}
        debug={debug}
      />

      <div className="main-panel__hero">
        <div className="main-panel__hero-copy">
          <div className="main-panel__eyebrow">Main Command Flow</div>
          <h1 className="main-panel__title">任务执行主控台</h1>
          <p className="main-panel__subtitle">{MAIN_PANEL_COPY[state]}</p>
        </div>
        <StateBadge state={state} />
      </div>

      <ExecutionTimeline steps={timeline} />

      <div className="main-panel__lower-grid">
        <ConversationThread logs={logs} />
        <TaskCardStack cards={cards} state={state} />
      </div>
    </div>
  )
}

export function ExecutionTimeline({ steps }: { steps: TimelineStep[] }): React.JSX.Element {
  return (
    <section className="execution-timeline">
      <div className="section-header">
        <div>
          <div className="section-header__eyebrow">Execution Timeline</div>
          <div className="section-header__title">任务链路</div>
        </div>
      </div>
      <div className="execution-timeline__track">
        {steps.map((step) => (
          <div className={`timeline-step timeline-step--${step.status}`} key={step.id}>
            <div className="timeline-step__marker" />
            <div className="timeline-step__content">
              <div className="timeline-step__label">{step.label}</div>
              {step.meta ? <div className="timeline-step__meta">{step.meta}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function TaskCardStack({
  cards,
  state
}: {
  cards: TaskCardItem[]
  state: WorkbenchState
}): React.JSX.Element {
  return (
    <section className="task-card-stack">
      <div className="section-header">
        <div>
          <div className="section-header__eyebrow">Task Cards</div>
          <div className="section-header__title">关键动作</div>
        </div>
      </div>
      <div className="task-card-stack__lead">{TASK_STACK_COPY[state]}</div>
      <div className="task-card-stack__grid">
        {cards.map((card) => (
          <article
            key={card.id}
            className={`task-card task-card--${card.kind} task-card--state-${state}`}
          >
            <div className="task-card__topline">
              <span className="task-card__kind">{TASK_KIND_LABELS[card.kind]}</span>
              {card.accent ? <span className="task-card__accent">{card.accent}</span> : null}
            </div>
            <h3 className="task-card__title">{card.title}</h3>
            <p className="task-card__body">{card.body}</p>
            {card.actions?.length ? (
              <div className="task-card__actions">
                {card.actions.map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    className={`task-card__action${action.primary ? ' primary' : ''}`}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {cards.length === 0 ? (
          <article className="task-card task-card--empty">
            <h3 className="task-card__title">等待任务开始</h3>
            <p className="task-card__body">
              这里会承接当前任务最关键的确认动作、执行动作与结果回看，不再把主路径埋进侧栏里。
            </p>
          </article>
        ) : null}
      </div>
      <div className="task-card-stack__state-note">当前状态：{STATE_LABELS[state]}</div>
    </section>
  )
}

export function RightInspectorPanel({
  context,
  debug,
  logs,
  actions
}: {
  context: Array<{ label: string; value: string }>
  debug: Array<{ label: string; value: string }>
  logs: WorkbenchLogEntry[]
  actions: QuickAction[]
}): React.JSX.Element {
  const [showContext, setShowContext] = useState(true)
  const [showStatus, setShowStatus] = useState(true)
  const [showDebug, setShowDebug] = useState(false)
  const [showActions, setShowActions] = useState(false)
  const statusFacts = useMemo(() => debug.slice(0, 2), [debug])
  const debugFacts = useMemo(() => debug.slice(2), [debug])
  const latestLog = useMemo(() => logs[logs.length - 1] ?? null, [logs])

  return (
    <div className="right-inspector">
      <InspectorSection
        title="上下文"
        subtitle="当前任务关键上下文"
        variant="context"
        open={showContext}
        onToggle={() => setShowContext((prev) => !prev)}
      >
        <InspectorFactList items={context} />
      </InspectorSection>

      <InspectorSection
        title="状态"
        subtitle="当前执行状态"
        variant="status"
        open={showStatus}
        onToggle={() => setShowStatus((prev) => !prev)}
      >
        <InspectorFactList items={statusFacts} />
        {latestLog ? <InspectorLatestEvent log={latestLog} /> : null}
      </InspectorSection>

      <InspectorSection
        title="快捷动作"
        subtitle="围绕当前任务的操作"
        variant="actions"
        open={showActions}
        onToggle={() => setShowActions((prev) => !prev)}
      >
        <QuickActionBar actions={actions} compact />
      </InspectorSection>

      <InspectorSection
        title="调试摘要"
        subtitle="只保留关键排查事实"
        variant="debug"
        open={showDebug}
        onToggle={() => setShowDebug((prev) => !prev)}
      >
        <InspectorFactList items={debugFacts} />
      </InspectorSection>
    </div>
  )
}

export function QuickActionBar({
  actions,
  compact = false
}: {
  actions: QuickAction[]
  compact?: boolean
}): React.JSX.Element {
  return (
    <section className={`quick-action-bar${compact ? ' quick-action-bar--compact' : ''}`}>
      <div className="left-rail__section-title">{compact ? '当前动作' : '快捷操作'}</div>
      <div className="quick-action-bar__grid">
        {actions.map((action) => (
          <button
            type="button"
            key={action.id}
            className={`quick-action-bar__button quick-action-bar__button--${action.tone || 'neutral'}`}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  )
}

export function StatusStrip({
  state,
  left,
  right
}: {
  state: WorkbenchState
  left: string
  right: string
}): React.JSX.Element {
  return (
    <footer className="status-strip" data-state={state}>
      <span>{left}</span>
      <span>{right}</span>
    </footer>
  )
}

export function Workbench({
  theme,
  onToggleTheme,
  state,
  statusText,
  brandIconUrl,
  headerMeta,
  appChoices,
  leftCategories,
  leftPrimary,
  leftHistory,
  quickActions,
  timeline,
  taskCards,
  logs,
  inspectorContext,
  inspectorDebug,
  inspectorActions,
  statusStripLeft,
  statusStripRight
}: WorkbenchProps): React.JSX.Element {
  return (
    <PageShell theme={theme} state={state}>
      <WorkspaceHeader
        theme={theme}
        onToggleTheme={onToggleTheme}
        state={state}
        statusText={statusText}
        brandIconUrl={brandIconUrl}
        headerMeta={headerMeta}
      />
      <WorkspaceLayout
        left={
          <LeftRail
            appChoices={appChoices}
            categories={leftCategories}
            primary={leftPrimary}
            history={leftHistory}
            quickActions={quickActions}
          />
        }
        center={
          <MainConversationPanel
            state={state}
            timeline={timeline}
            cards={taskCards}
            logs={logs}
            appChoices={appChoices}
            categories={leftCategories}
            context={inspectorContext}
            debug={inspectorDebug}
          />
        }
        right={
          <RightInspectorPanel
            context={inspectorContext}
            debug={inspectorDebug}
            logs={logs}
            actions={inspectorActions}
          />
        }
        dock={
          <LiveLogDock
            logs={logs}
            state={state}
            statusText={statusText}
            left={statusStripLeft}
            right={statusStripRight}
          />
        }
      />
      <StatusStrip state={state} left={statusStripLeft} right={statusStripRight} />
    </PageShell>
  )
}

function StateBadge({ state }: { state: WorkbenchState }): React.JSX.Element {
  return <div className={`state-badge state-badge--${state}`}>{STATE_LABELS[state]}</div>
}

function MainControlDeck({
  appChoices,
  categories,
  context,
  debug
}: {
  appChoices: LeftRailItem[]
  categories: LeftRailItem[]
  context: Array<{ label: string; value: string }>
  debug: Array<{ label: string; value: string }>
}): React.JSX.Element {
  const facts = useMemo(
    () => [context[1], context[2], debug[0], debug[1]].filter(Boolean),
    [context, debug]
  )

  return (
    <section className="control-deck">
      <div className="control-deck__header">
        <div>
          <div className="section-header__eyebrow">Primary Switchboard</div>
          <div className="section-header__title">主控切换</div>
        </div>
        <p className="control-deck__summary">
          把目标应用和任务分类提到主区最前面，切换后主任务区、右侧状态和底部日志会一起跟随。
        </p>
      </div>

      <div className="control-deck__groups">
        <SwitchGroup title="目标应用" items={appChoices} />
        <SwitchGroup title="任务分类" items={categories} category />
      </div>

      <div className="control-deck__facts">
        {facts.map((fact) => (
          <div className="control-fact" key={fact.label}>
            <span className="control-fact__label">{fact.label}</span>
            <span className="control-fact__value">{fact.value}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SwitchGroup({
  title,
  items,
  category = false
}: {
  title: string
  items: LeftRailItem[]
  category?: boolean
}): React.JSX.Element {
  return (
    <div className="control-switch-group">
      <div className="control-switch-group__label">{title}</div>
      <div className="control-switch-group__grid">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`control-switch${item.active ? ' active' : ''}${category ? ' control-switch--category' : ''}`}
            onClick={item.onClick}
          >
            <span className="control-switch__label">{item.label}</span>
            {item.meta ? <span className="control-switch__meta">{item.meta}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function InspectorSection({
  title,
  subtitle,
  variant = 'neutral',
  open,
  onToggle,
  children
}: {
  title: string
  subtitle: string
  variant?: 'context' | 'status' | 'actions' | 'debug' | 'neutral'
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={`inspector-section inspector-section--${variant}`}>
      <button type="button" className="inspector-section__header" onClick={onToggle}>
        <div>
          <div className="section-header__eyebrow">{subtitle}</div>
          <div className="section-header__title">{title}</div>
        </div>
        <span className="inspector-section__toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open ? <div className="inspector-section__body">{children}</div> : null}
    </section>
  )
}

function InspectorFactList({
  items
}: {
  items: Array<{ label: string; value: string }>
}): React.JSX.Element {
  return (
    <div className="inspector-fact-list">
      {items.map((item) => (
        <div className="inspector-fact" key={item.label}>
          <span className="inspector-fact__label">{item.label}</span>
          <span className="inspector-fact__value">{item.value}</span>
        </div>
      ))}
    </div>
  )
}

function InspectorLatestEvent({ log }: { log: WorkbenchLogEntry }): React.JSX.Element {
  return (
    <div className="inspector-signal">
      <div className="inspector-signal__topline">
        <span className={`inspector-log__type inspector-log__type--${log.type}`}>
          {LOG_TYPE_LABELS[log.type]}
        </span>
        <span className="inspector-signal__time">{log.time}</span>
      </div>
      <div className="inspector-signal__content">{log.content}</div>
    </div>
  )
}

function ConversationThread({ logs }: { logs: WorkbenchLogEntry[] }): React.JSX.Element {
  const entries = useMemo(() => logs.slice(-4).reverse(), [logs])

  return (
    <section className="conversation-thread">
      <div className="section-header">
        <div>
          <div className="section-header__eyebrow">Focus Feed</div>
          <div className="section-header__title">关键进展</div>
        </div>
      </div>
      <div className="conversation-thread__list">
        {entries.length === 0 ? (
          <div className="conversation-thread__empty">
            运行起来后，这里会摘出最值得盯的关键事件，完整连续日志会固定停在底部。
          </div>
        ) : (
          entries.map((entry, index) => (
            <div
              className={`conversation-bubble conversation-bubble--${entry.type}`}
              key={`${entry.time}-${index}`}
            >
              <div className="conversation-bubble__meta">
                {LOG_TYPE_LABELS[entry.type]} · {entry.time}
              </div>
              <div className="conversation-bubble__body">{entry.content}</div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function LiveLogDock({
  logs,
  state,
  statusText,
  left,
  right
}: {
  logs: WorkbenchLogEntry[]
  state: WorkbenchState
  statusText: string
  left: string
  right: string
}): React.JSX.Element {
  const entries = useMemo(() => logs.slice(-12).reverse(), [logs])

  return (
    <section className="log-dock" data-state={state}>
      <div className="log-dock__header">
        <div>
          <div className="section-header__eyebrow">Fixed Live Feed</div>
          <div className="section-header__title">实时运行日志</div>
        </div>
        <div className="log-dock__chips">
          <span className="log-dock__chip">{statusText}</span>
          <span className="log-dock__chip">{entries.length} 条可见日志</span>
        </div>
      </div>

      <div className="log-dock__summary">
        <span>{left}</span>
        <span>{right}</span>
      </div>

      <div className="log-dock__list">
        {entries.length === 0 ? (
          <div className="log-dock__empty">
            引擎启动后，实时日志会固定出现在这里，不需要再去右侧找运行轨迹。
          </div>
        ) : (
          entries.map((entry, index) => (
            <article
              className={`log-dock__entry log-dock__entry--${entry.type}`}
              key={`${entry.time}-${index}`}
            >
              <div className="log-dock__entry-topline">
                <span className={`inspector-log__type inspector-log__type--${entry.type}`}>
                  {LOG_TYPE_LABELS[entry.type]}
                </span>
                <span className="log-dock__time">{entry.time}</span>
              </div>
              <div className="log-dock__content">{entry.content}</div>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
