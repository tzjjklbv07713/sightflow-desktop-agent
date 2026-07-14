import { useCallback, useEffect, useMemo, useState } from 'react'

// Console 是一个独立的、可复用的客服操作台。
// IPC: conversation:list / getTrace / setHandoff, knowledge:list / import,
//      license:getState / activate, diagnostics:export.

export interface AutomationTraceEvent {
  at: string
  type: string
  detail?: string
  data?: unknown
}

export interface AutomationTrace {
  id: string
  appType: string
  messageKey: string
  status: string
  startedAt: string
  updatedAt: string
  screenshot?: string
  latestMessage?: unknown
  observationStages?: Array<{
    stage: 'accessibility' | 'native-structure' | 'ocr' | 'vision'
    hit: boolean
    reason?: string
    confidence?: number
  }>
  observedMessage?: {
    chat?: { id?: string; type?: string; name?: string; whitelisted?: boolean }
    direction?: string
    kind?: string
    content?: string
    summary?: string
    senderName?: string
    confidence?: number
    source?: string
  } | null
  knowledge?: {
    confidence?: number
    hasAnswer?: boolean
    forbiddenMatched?: boolean
    matches?: Array<{ entry: { kind: string; title: string }; score: number }>
  } | null
  replyText?: string
  policyDecision?: { allowed: boolean; text?: string; reason?: string }
  executionMode?: string
  verification?: {
    ok: boolean
    mode: 'sent' | 'drafted'
    reason?: string
    details?: string
    evidence?: { diffPercentage?: number }
  }
  error?: string
  events: AutomationTraceEvent[]
}

export interface AutomationTraceStats {
  total: number
  sent: number
  failed: number
  blocked: number
  skipped: number
  drafted: number
}

interface ConversationListResult {
  success: boolean
  traces?: AutomationTrace[]
  stats?: AutomationTraceStats
  error?: string
}

interface HandoffResult {
  success: boolean
  handoff?: { chatKey: string; active: boolean; reason?: string; updatedAt: number }
  error?: string
}

interface KnowledgeEntry {
  id: string
  kind: 'faq' | 'product' | 'policy' | 'tone' | 'forbidden'
  title: string
  content: string
  keywords?: string[]
  enabled: boolean
  updatedAt: string
}

interface KnowledgeListResult {
  success: boolean
  entries?: KnowledgeEntry[]
  error?: string
}

interface LicenseState {
  machineId: string
  activated: boolean
  plan: 'trial' | 'commercial'
  activatedAt?: string
  expiresAt?: string
  lastCheckedAt?: string
  message?: string
}

interface LicenseGetResult {
  success: boolean
  state?: LicenseState
  error?: string
}

interface DiagnosticsResult {
  success: boolean
  filePath?: string
  redacted?: boolean
  error?: string
}

interface KnowledgeImportSource {
  path: string
}

type ConsoleTab = 'overview' | 'traces' | 'trace-detail' | 'knowledge' | 'license' | 'diagnostics'

const STATUS_LABEL: Record<string, string> = {
  observing: '正在观察',
  provider_running: '模型调用中',
  skipped: '已跳过',
  blocked: '被策略拦截',
  drafted: '仅生成草稿',
  sent: '已发送',
  failed: '失败'
}

const STATUS_TONE: Record<string, string> = {
  observing: 'cool',
  provider_running: 'cool',
  skipped: 'neutral',
  blocked: 'amber',
  drafted: 'cool',
  sent: 'mint',
  failed: 'rose'
}

function formatTimestamp(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T | null> {
  try {
    const handler = window.electron as
      | { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
      | undefined
    if (!handler?.invoke) return null
    return (await handler.invoke(channel, ...args)) as T
  } catch (err) {
    console.warn('[Console] invoke failed', channel, err)
    return null
  }
}

export function Console(): React.JSX.Element {
  const [tab, setTab] = useState<ConsoleTab>('overview')
  const [traces, setTraces] = useState<AutomationTrace[]>([])
  const [stats, setStats] = useState<AutomationTraceStats | null>(null)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<AutomationTrace | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [license, setLicense] = useState<LicenseState | null>(null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(null)
  const [redactDiagnostics, setRedactDiagnostics] = useState<boolean>(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error] = useState<string | null>(null)

  const reloadOverview = useCallback(async () => {
    const r = await invoke<ConversationListResult>('conversation:list')
    if (r?.success && r.traces) setTraces(r.traces)
    if (r?.stats) setStats(r.stats)
  }, [])

  const reloadKnowledge = useCallback(async () => {
    const r = await invoke<KnowledgeListResult>('knowledge:list')
    if (r?.success && r.entries) setKnowledge(r.entries)
  }, [])

  const reloadLicense = useCallback(async () => {
    const r = await invoke<LicenseGetResult>('license:getState')
    if (r?.state) setLicense(r.state)
  }, [])

  useEffect(() => {
    void reloadOverview()
    void reloadKnowledge()
    void reloadLicense()
  }, [reloadOverview, reloadKnowledge, reloadLicense])

  const openTrace = useCallback(async (id: string) => {
    setSelectedTraceId(id)
    setTab('trace-detail')
    const r = await invoke<{ success: boolean; trace?: AutomationTrace }>('conversation:getTrace', id)
    if (r?.trace) setSelectedTrace(r.trace)
  }, [])

  const toggleHandoff = useCallback(async (chatKey: string, active: boolean, reason?: string) => {
    setBusy('conversation:setHandoff')
    try {
      await invoke<HandoffResult>('conversation:setHandoff', { chatKey, active, reason })
      await reloadOverview()
    } finally {
      setBusy(null)
    }
  }, [reloadOverview])

  const importKnowledge = useCallback(async (source: KnowledgeImportSource) => {
    setBusy('knowledge:import')
    try {
      const r = await invoke<KnowledgeListResult>('knowledge:import', source)
      if (r?.success && r.entries) setKnowledge(r.entries)
    } finally {
      setBusy(null)
    }
  }, [])

  const activateLicense = useCallback(async (key: string): Promise<void> => {
    setBusy('license:activate')
    try {
      const r = await invoke<LicenseGetResult>('license:activate', key)
      if (r?.state) setLicense(r.state)
    } finally {
      setBusy(null)
    }
  }, [])

  const exportDiagnostics = useCallback(async (): Promise<void> => {
    setBusy('diagnostics:export')
    try {
      const r = await invoke<DiagnosticsResult>('diagnostics:export', { redact: redactDiagnostics })
      setDiagnostics(r || null)
    } finally {
      setBusy(null)
    }
  }, [redactDiagnostics])

  const replayOnboarding = useCallback(async () => {
    try {
      await invoke<{ ok: boolean }>('onboarding:reset')
    } finally {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sightflow:onboarding:reset'))
      }
    }
  }, [])

  const tabs = useMemo(
    () => [
      { id: 'overview' as const, label: '运行指标' },
      { id: 'traces' as const, label: '`会话记录 (${stats?.total ?? traces.length})`' },
      { id: 'knowledge' as const, label: '`知识库 (${knowledge.length})`' },
      { id: 'license' as const, label: '授权' },
      { id: 'diagnostics' as const, label: '诊断包' }
    ],
    [stats?.total, traces.length, knowledge.length]
  )

  return (
    <div className="console">
      <nav className="console__tabs" aria-label="客服操作台">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={'`console__tab' + (tab === t.id || (t.id === 'traces' && tab === 'trace-detail') ? ' console__tab--active' : '') + '`'}
            onClick={() => {
              if (t.id !== 'traces') setSelectedTraceId(null)
              setTab(t.id)
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error ? <div className="console__error">{error}</div> : null}

      {tab === 'overview' ? (
        <OverviewPanel
          stats={stats}
          traces={traces}
          onOpenTrace={openTrace}
          onExport={exportDiagnostics}
          busy={busy}
          diagnostics={diagnostics}
          onReplayOnboarding={replayOnboarding}
        />
      ) : null}

      {tab === 'traces' ? (
        <TracesPanel traces={traces} stats={stats} onOpenTrace={openTrace} />
      ) : null}

      {tab === 'trace-detail' && selectedTraceId ? (
        <TraceDetailPanel
          trace={selectedTrace}
          onBack={() => setTab('traces')}
          onToggleHandoff={toggleHandoff}
          busy={busy}
        />
      ) : null}

      {tab === 'knowledge' ? (
        <KnowledgePanel
          entries={knowledge}
          busy={busy}
          onImport={importKnowledge}
          onRefresh={reloadKnowledge}
        />
      ) : null}

      {tab === 'license' ? (
        <LicensePanel state={license} busy={busy} onActivate={activateLicense} />
      ) : null}

      {tab === 'diagnostics' ? (
        <DiagnosticsPanel
          diagnostics={diagnostics}
          busy={busy}
          onExport={exportDiagnostics}
          redact={redactDiagnostics}
          onToggleRedact={() => setRedactDiagnostics((v) => !v)}
        />
      ) : null}
    </div>
  )
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: string }): React.JSX.Element {
  return (
    <div className={'`console__stat' + (tone ? ' console__stat--' + tone : '') + '`'}>
      <div className="console__stat-value">{value}</div>
      <div className="console__stat-label">{label}</div>
    </div>
  )
}

function StatusPill({ status }: { status?: string }): React.JSX.Element {
  const tone = STATUS_TONE[status || ''] || 'neutral'
  return <span className={'`console__pill console__pill--' + tone + '`'}>{STATUS_LABEL[status || ''] || status || '-'}</span>
}

interface OverviewPanelProps {
  stats: AutomationTraceStats | null
  traces: AutomationTrace[]
  onOpenTrace: (id: string) => void
  onExport: () => void
  busy: string | null
  diagnostics: DiagnosticsResult | null
  onReplayOnboarding: () => void
}

function OverviewPanel(props: OverviewPanelProps): React.JSX.Element {
  const { stats, traces, onOpenTrace, onExport, busy, diagnostics, onReplayOnboarding } = props
  const recent = traces.slice(0, 5)
  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>运行指标</h3>
          <p className="console__hint">最近一次自动回复任务的统计与最近 5 条会话记录。</p>
        </div>
        <div className="console__panel-actions">
          <button type="button" className="console__secondary" onClick={onReplayOnboarding}>重新引导</button>
          <button
            type="button"
            className="console__primary"
            onClick={onExport}
            disabled={busy === 'diagnostics:export'}
          >
            {busy === 'diagnostics:export' ? '导出中…' : '导出诊断包'}
          </button>
        </div>
      </header>

      <div className="console__grid console__grid--stats">
        <StatTile label="总任务" value={stats?.total ?? traces.length} />
        <StatTile label="已发送" value={stats?.sent ?? 0} tone="mint" />
        <StatTile label="被拦截" value={stats?.blocked ?? 0} tone="amber" />
        <StatTile label="仅草稿" value={stats?.drafted ?? 0} tone="cool" />
        <StatTile label="已跳过" value={stats?.skipped ?? 0} />
        <StatTile label="失败" value={stats?.failed ?? 0} tone="rose" />
      </div>

      {diagnostics && diagnostics.success ? (
        <div className="console__card">
          <h4>最近一次诊断包</h4>
          <p>
            路径：<code>{diagnostics.filePath}</code>
            {diagnostics.redacted ? <span className="console__pill console__pill--cool">已脱敏</span> : null}
          </p>
        </div>
      ) : null}

      <div className="console__card">
        <h4>最近 5 条会话</h4>
        {recent.length === 0 ? (
          <p className="console__hint">还没有自动化任务记录。</p>
        ) : (
          <ul className="console__list">
            {recent.map((tt) => (
              <li key={tt.id} onClick={() => onOpenTrace(tt.id)} className="console__list-row">
                <StatusPill status={tt.status} />
                <span className="console__list-title">
                  {(tt.observedMessage && tt.observedMessage.chat && tt.observedMessage.chat.name) || tt.messageKey || tt.id}
                </span>
                <span className="console__hint">{formatTimestamp(tt.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface TracesPanelProps {
  traces: AutomationTrace[]
  stats: AutomationTraceStats | null
  onOpenTrace: (id: string) => void
}

function TracesPanel(props: TracesPanelProps): React.JSX.Element {
  const { traces, stats, onOpenTrace } = props
  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>会话记录</h3>
          <p className="console__hint">
            点击一条记录查看完整 trace 与策略原因。{stats ? ' 共 ' + stats.total + ' 条。' : ''}
          </p>
        </div>
      </header>
      {traces.length === 0 ? (
        <p className="console__hint">暂无会话记录。</p>
      ) : (
        <ul className="console__list">
          {traces.map((tt) => (
            <li key={tt.id} onClick={() => onOpenTrace(tt.id)} className="console__list-row">
              <StatusPill status={tt.status} />
              <span className="console__list-title">
                {(tt.observedMessage && tt.observedMessage.chat && tt.observedMessage.chat.name) || tt.messageKey || tt.id}
              </span>
              <span className="console__hint">{formatTimestamp(tt.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface TraceDetailPanelProps {
  trace: AutomationTrace | null
  onBack: () => void
  onToggleHandoff: (chatKey: string, active: boolean, reason?: string) => void
  busy: string | null
}

function TraceDetailPanel(props: TraceDetailPanelProps): React.JSX.Element {
  const { trace, onBack, onToggleHandoff, busy } = props
  if (!trace) {
    return (
      <div className="console__panel">
        <p className="console__hint">正在加载 trace…</p>
        <button type="button" className="console__secondary" onClick={onBack}>返回</button>
      </div>
    )
  }
  const chatKey = (trace.observedMessage && trace.observedMessage.chat && trace.observedMessage.chat.id) || trace.messageKey || trace.id
  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>会话详情</h3>
          <p className="console__hint">
            <StatusPill status={trace.status} /> · {formatTimestamp(trace.updatedAt)}
          </p>
        </div>
        <div className="console__panel-actions">
          <button type="button" className="console__secondary" onClick={onBack}>返回</button>
          <button
            type="button"
            className="console__primary"
            disabled={busy === 'conversation:setHandoff'}
            onClick={() => onToggleHandoff(chatKey, true, 'manual-handoff-from-console')}
          >
            接管此会话
          </button>
        </div>
      </header>

      <div className="console__card">
        <h4>客户最新消息</h4>
        <p>{(trace.observedMessage && trace.observedMessage.content) || (trace.observedMessage && trace.observedMessage.summary) || '(空)'}</p>
        {trace.observedMessage && trace.observedMessage.senderName ? (
          <p className="console__hint">来自：{trace.observedMessage.senderName}</p>
        ) : null}
      </div>

      <div className="console__card">
        <h4>策略判断</h4>
        {trace.policyDecision ? (
          <>
            <p>
              <StatusPill status={trace.policyDecision.allowed ? 'sent' : 'blocked'} />
              {trace.policyDecision.allowed ? '允许发送' : '已拦截'}
            </p>
            {trace.policyDecision.reason ? <p className="console__hint">原因：{trace.policyDecision.reason}</p> : null}
          </>
        ) : (
          <p className="console__hint">无策略记录。</p>
        )}
      </div>

      {trace.replyText ? (
        <div className="console__card">
          <h4>AI 回复</h4>
          <p>{trace.replyText}</p>
        </div>
      ) : null}

      {trace.verification ? (
        <div className="console__card">
          <h4>发送校验</h4>
          <p>{trace.verification.ok ? '已通过' : '未通过'} / {trace.verification.reason || 'unknown'}</p>
          {trace.verification.details ? (
            <p className="console__hint">{trace.verification.details}</p>
          ) : null}
          {typeof trace.verification.evidence?.diffPercentage === 'number' ? (
            <p className="console__hint">差异：{trace.verification.evidence.diffPercentage}%</p>
          ) : null}
        </div>
      ) : null}

      {trace.observationStages && trace.observationStages.length > 0 ? (
        <div className="console__card">
          <h4>识别链路</h4>
          <ul>
            {trace.observationStages.map((stage, index) => (
              <li key={index}>
                {stage.stage} / {stage.hit ? 'hit' : 'miss'}
                {stage.reason ? ` / ${stage.reason}` : ''}
                {typeof stage.confidence === 'number' ? ` / ${stage.confidence.toFixed(2)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {trace.knowledge ? (
        <div className="console__card">
          <h4>知识库命中</h4>
          <p>置信度：{trace.knowledge.confidence ?? '-'}{trace.knowledge.hasAnswer ? '' : '（未命中）'}</p>
          {trace.knowledge.matches && trace.knowledge.matches.length > 0 ? (
            <ul>
              {trace.knowledge.matches.map((m, i) => (
                <li key={i}>[{m.entry.kind}] {m.entry.title}（score={m.score.toFixed(2)}）</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="console__card">
        <h4>事件流</h4>
        <ol className="console__list">
          {trace.events.map((e, i) => (
            <li key={i} className="console__list-row">
              <span className="console__hint">{formatTimestamp(e.at)}</span>
              <span>{e.type}</span>
              {e.detail ? <span className="console__hint">{e.detail}</span> : null}
            </li>
          ))}
        </ol>
      </div>

      {trace.error ? (
        <div className="console__card console__card--error">
          <h4>错误</h4>
          <p>{trace.error}</p>
        </div>
      ) : null}
    </div>
  )
}

interface KnowledgePanelProps {
  entries: KnowledgeEntry[]
  busy: string | null
  onImport: (source: KnowledgeImportSource) => void
  onRefresh: () => void
}

function KnowledgePanel(props: KnowledgePanelProps): React.JSX.Element {
  const { entries, busy, onImport, onRefresh } = props
  const [path, setPath] = useState('')
  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>知识库</h3>
          <p className="console__hint">支持 FAQ / 商品 / 售后规则 / 语气 / 禁答五类条目。</p>
        </div>
        <div className="console__panel-actions">
          <button type="button" className="console__secondary" onClick={onRefresh}>刷新</button>
        </div>
      </header>

      <div className="console__card">
        <h4>导入</h4>
        <div className="console__form-row">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="knowledge.json 绝对路径"
            className="console__input"
          />
          <button
            type="button"
            className="console__primary"
            disabled={!path.trim() || busy === 'knowledge:import'}
            onClick={() => {
              const next = path
              setPath('')
              onImport({ path: next })
            }}
          >
            {busy === 'knowledge:import' ? '导入中…' : '导入'}
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="console__hint">尚未导入任何条目。</p>
      ) : (
        <ul className="console__knowledge-list">
          {entries.map((e) => (
            <li key={e.id} className={e.enabled ? '' : 'console__knowledge-list--disabled'}>
              <div className="console__knowledge-row">
                <span className="console__pill console__pill--cool">{e.kind}</span>
                <strong>{e.title}</strong>
                {!e.enabled ? <span className="console__pill console__pill--amber">已禁用</span> : null}
              </div>
              <p>{e.content}</p>
              {e.keywords && e.keywords.length > 0 ? (
                <p className="console__hint">关键词：{e.keywords.join('、')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface LicensePanelProps {
  state: LicenseState | null
  busy: string | null
  onActivate: (key: string) => void
}

function LicensePanel(props: LicensePanelProps): React.JSX.Element {
  const { state, busy, onActivate } = props
  const [key, setKey] = useState('')

  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>授权</h3>
          <p className="console__hint">机器码：<code>{state ? state.machineId : '尚未生成'}</code></p>
        </div>
      </header>

      {state ? (
        <div className="console__card">
          <dl>
            <dt>状态</dt><dd>{state.activated ? '已激活' : '未激活'}</dd>
            <dt>套餐</dt><dd>{state.plan === 'commercial' ? '商业版' : '试用版'}</dd>
            {state.activatedAt ? (<><dt>激活时间</dt><dd>{formatTimestamp(state.activatedAt)}</dd></>) : null}
            {state.expiresAt ? (<><dt>到期时间</dt><dd>{formatTimestamp(state.expiresAt)}</dd></>) : null}
            {state.message ? (<><dt>备注</dt><dd>{state.message}</dd></>) : null}
          </dl>
        </div>
      ) : (
        <p className="console__hint">正在加载授权状态…</p>
      )}

      <div className="console__card">
        <h4>激活</h4>
        <p className="console__hint">输入授权码（商业版以 SF-COM- 开头）。</p>
        <div className="console__form-row">
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="SF-COM-XXXX-XXXX"
            className="console__input"
          />
          <button
            type="button"
            className="console__primary"
            disabled={!key.trim() || busy === 'license:activate'}
            onClick={() => {
              const next = key
              setKey('')
              onActivate(next)
            }}
          >
            {busy === 'license:activate' ? '激活中…' : '激活'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface DiagnosticsPanelProps {
  diagnostics: DiagnosticsResult | null
  busy: string | null
  onExport: () => void
  redact: boolean
  onToggleRedact: () => void
}

function DiagnosticsPanel(props: DiagnosticsPanelProps): React.JSX.Element {
  const { diagnostics, busy, onExport, redact, onToggleRedact } = props
  return (
    <div className="console__panel">
      <header className="console__panel-header">
        <div>
          <h3>诊断包</h3>
          <p className="console__hint">导出最近 50 条 trace、授权状态、知识库摘要和当前配置。</p>
        </div>
        <div className="console__panel-actions">
          <label className="console__checkbox">
            <input
              type="checkbox"
              checked={redact}
              onChange={onToggleRedact}
              data-testid="diagnostics-redact-toggle"
            />
            导出前脱敏
          </label>
          <button
            type="button"
            className="console__primary"
            onClick={onExport}
            disabled={busy === 'diagnostics:export'}
          >
            {busy === 'diagnostics:export' ? '导出中…' : '导出诊断包'}
          </button>
        </div>
      </header>

      {diagnostics && diagnostics.success ? (
        <div className="console__card">
          <h4>最近一次导出</h4>
          <p>路径：<code>{diagnostics.filePath}</code></p>
          <p className="console__hint">
            脱敏：{diagnostics.redacted ? '已开启（符合试点合规）' : '已关闭（请确认合规）'}
          </p>
        </div>
      ) : null}

      {diagnostics && !diagnostics.success ? (
        <div className="console__card console__card--error">
          <h4>导出失败</h4>
          <p>{diagnostics.error || '未知错误'}</p>
        </div>
      ) : null}

      {!diagnostics ? (
        <p className="console__hint">尚未导出诊断包，点上方按钮生成一份即可。</p>
      ) : null}
    </div>
  )
}
