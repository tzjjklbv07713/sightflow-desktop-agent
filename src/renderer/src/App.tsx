import { useState, useCallback, useRef, useEffect } from 'react'
import { t } from './i18n'
import logoUrl from './assets/logo.png'
import './index.css'

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
}

type EngineStatus = 'idle' | 'running' | 'error'
type View = 'control' | 'settings'
type AppType = 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic'

type CaptureStrategy = 'auto' | 'vlm' | 'box-select'

interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

interface BoxRegions {
  contactList: ScreenRect
  chatMain: ScreenRect
  inputBox: ScreenRect
  unreadIndicator: ScreenRect | null
  displayId?: number
  scaleFactor?: number
  capturedAt: number
}

const APP_TYPE_LABELS: Record<AppType, string> = {
  wechat: '微信',
  wework: '企业微信',
  dingtalk: '钉钉',
  lark: '飞书 / Lark',
  slack: 'Slack',
  telegram: 'Telegram',
  generic: '其他桌面应用'
}

const VLM_SUPPORTED_APPS: AppType[] = ['wechat', 'wework']

function isVlmSupported(appType: AppType): boolean {
  return VLM_SUPPORTED_APPS.includes(appType)
}

interface ProviderSchemaField {
  type: 'string' | 'password' | 'select' | 'boolean'
  title: string
  default?: string | boolean
  enum?: string[]
}

interface ProviderManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  entry: string
  capabilities: ['chat']
  configSchema: {
    type: 'object'
    properties: Record<string, ProviderSchemaField>
    required?: string[]
  }
}

interface InstalledProviderInfo {
  id: string
  name: string
  version: string
  entryFile: string
  installedAt: string
}

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: {
    apiKey: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  defaultCaptureStrategy: CaptureStrategy
  capture: Partial<Record<AppType, PerAppCapture>>
}

const PROVIDER_NAME_LABELS: Record<string, string> = {
  'volcengine-ark': '火山方舟聊天服务'
}

const PROVIDER_FIELD_LABELS: Record<string, string> = {
  apiKey: '接口密钥',
  model: '模型名称',
  systemPrompt: '系统提示词'
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.14v14l11-7-11-7z" />
  </svg>
)

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

const GearIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const BackIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

function App() {
  const [view, setView] = useState<View>('control')
  const [status, setStatus] = useState<EngineStatus>('idle')

  // Sync UI status with engine state changes triggered out-of-band
  // (e.g. remote OpenClaw start/pause via the local skill HTTP server).
  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (data: { status: 'running' | 'idle' }) => {
      setStatus(data.status === 'running' ? 'running' : 'idle')
    })
    return cleanup
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        {view === 'settings' ? (
          <button
            className="bottom-btn bottom-btn-settings"
            onClick={() => setView('control')}
            style={{ width: 32, height: 32, marginRight: 4 }}
          >
            <BackIcon />
          </button>
        ) : null}
        <img src={logoUrl} alt="SightFlow" className="app-logo" />
      </header>

      <div className="app-content">
        {view === 'control' ? (
          <ControlPanel status={status} setStatus={setStatus} />
        ) : (
          <SettingsPanel />
        )}
      </div>

      {view === 'control' && (
        <BottomBar status={status} setStatus={setStatus} onSettings={() => setView('settings')} />
      )}

      <Toast />
    </div>
  )
}

function getProviderDisplayName(
  provider: InstalledProviderInfo | null | undefined,
  manifest: ProviderManifest | null
) {
  return (
    (provider?.id && PROVIDER_NAME_LABELS[provider.id]) ||
    (manifest?.id && PROVIDER_NAME_LABELS[manifest.id]) ||
    provider?.name ||
    manifest?.name ||
    ''
  )
}

function getProviderFieldLabel(fieldKey: string, field: ProviderSchemaField) {
  return PROVIDER_FIELD_LABELS[fieldKey] || field.title
}

function ControlPanel({
  status,
  setStatus
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
}) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  // 首屏目标应用 + 框选状态：直接读 / 写 settings，让用户上手第一步就能完成。
  const [appType, setAppType] = useState<AppType>('wechat')
  const [regions, setRegions] = useState<BoxRegions | null>(null)
  const [openingWizard, setOpeningWizard] = useState(false)

  const reloadRegionsForApp = useCallback(async (type: AppType) => {
    const r = (await window.electron?.invoke('capture:getRegions', type)) as BoxRegions | null
    setRegions(r ?? null)
  }, [])

  // 初次加载：读出当前 appType + 对应的框选区域
  useEffect(() => {
    void (async () => {
      const settings = (await window.electron?.invoke('settings:getAll')) as
        | AppSettings
        | undefined
      const initial = settings?.appType || 'wechat'
      setAppType(initial)
      await reloadRegionsForApp(initial)
    })()
  }, [reloadRegionsForApp])

  // 监听 main 进程的"区域已更新"事件——比如向导刚跑完
  useEffect(() => {
    const cleanup = window.electron?.on(
      'capture:regions-updated',
      (data: { appType: AppType; regions: BoxRegions | null }) => {
        if (data.appType === appType) setRegions(data.regions)
      }
    )
    return cleanup
  }, [appType])

  const handleAppTypeChange = useCallback(
    async (next: AppType) => {
      setAppType(next)
      await window.electron?.invoke('settings:set', { appType: next })
      await window.electron?.invoke('engine:updateConfig', {
        ...((await window.electron?.invoke('settings:getAll')) as AppSettings),
        appType: next
      })
      await reloadRegionsForApp(next)
    },
    [reloadRegionsForApp]
  )

  const handleOpenWizard = useCallback(async () => {
    setOpeningWizard(true)
    try {
      const result = (await window.electron?.invoke('capture:openSetupWizard', {
        appType
      })) as { success: boolean; reason?: string; regions?: BoxRegions } | undefined
      if (result?.success && result.regions) {
        setRegions(result.regions)
        showToast('已保存框选区域', 'success')
      } else if (result?.reason === 'cancelled' || result?.reason === 'closed') {
        showToast('框选已取消', 'error')
      } else {
        showToast('框选失败', 'error')
      }
    } finally {
      setOpeningWizard(false)
    }
  }, [appType])

  const addLog = useCallback((type: LogEntry['type'], content: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (data: { type: string; content: string }) => {
      addLog(data.type as LogEntry['type'], data.content)

      if (data.type === 'error' && data.content.includes('引擎无法启动')) {
        setStatus('error')
      }
    })
    return cleanup
  }, [addLog, setStatus])

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  const isVlm = isVlmSupported(appType)
  const captureReady = isVlm || regions !== null

  return (
    <div className="fade-in">
      <div className={`status-indicator ${status}`}>
        <div className={`status-dot ${status}`} />
        <span className="status-text">{statusLabel}</span>
      </div>

      <TargetAppQuickCard
        appType={appType}
        regions={regions}
        captureReady={captureReady}
        isVlm={isVlm}
        openingWizard={openingWizard}
        onAppTypeChange={handleAppTypeChange}
        onOpenWizard={handleOpenWizard}
      />

      <div className="card">
        <div className="card-title">{t('control.log')}</div>
        <div className="message-log" ref={logRef}>
          {logs.length === 0 ? (
            <div className="message-log-empty">{t('control.log.empty')}</div>
          ) : (
            logs.map((entry, i) => (
              <div className="log-entry" key={i}>
                <span className="log-time">{entry.time}</span>
                <span className={`log-type ${entry.type}`}>
                  {t(`control.log.${entry.type}` as never)}
                </span>
                <span>{entry.content}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

interface TargetAppQuickCardProps {
  appType: AppType
  regions: BoxRegions | null
  captureReady: boolean
  isVlm: boolean
  openingWizard: boolean
  onAppTypeChange: (t: AppType) => void
  onOpenWizard: () => void
}

// 首屏的"目标应用 + 框选"快捷卡片：让新用户开箱即用，不用先翻设置。
function TargetAppQuickCard({
  appType,
  regions,
  captureReady,
  isVlm,
  openingWizard,
  onAppTypeChange,
  onOpenWizard
}: TargetAppQuickCardProps): React.JSX.Element {
  const statusText = isVlm
    ? '自动识别（VLM）'
    : regions
      ? `已框选 ${regions.unreadIndicator ? '4' : '3'} / 4 个区域`
      : '尚未框选'

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">目标应用</div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <select
          className="form-input"
          value={appType}
          onChange={(e) => onAppTypeChange(e.target.value as AppType)}
          style={{ flex: 1 }}
        >
          {(Object.keys(APP_TYPE_LABELS) as AppType[]).map((type) => (
            <option key={type} value={type}>
              {APP_TYPE_LABELS[type]}
              {!isVlmSupported(type) ? '（框选）' : ''}
            </option>
          ))}
        </select>

        {!isVlm && (
          <button
            className={regions ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={onOpenWizard}
            disabled={openingWizard}
            style={{ whiteSpace: 'nowrap' }}
          >
            {openingWizard ? '打开中...' : regions ? '重新框选' : '开始框选'}
          </button>
        )}
      </div>

      <div
        className="form-hint"
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: captureReady ? '#94a3b8' : '#fbbf24'
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: 999,
            background: captureReady ? '#34d399' : '#fbbf24'
          }}
        />
        {statusText}
        {!isVlm && !regions ? '：点右侧按钮先把 4 个关键区域圈出来' : ''}
      </div>
    </div>
  )
}

function BottomBar({
  status,
  setStatus,
  onSettings
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
  onSettings: () => void
}) {
  const handleStart = useCallback(async () => {
    const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
    if (!settings?.vision?.apiKey) {
      showToast(t('control.start.novisionkey'), 'error')
      return
    }
    // 没装自定义 provider → 走内置 doubao（getInstalled 会返回 isBuiltinDefault: true）
    const providerInfo = (await window.electron?.invoke('provider:getInstalled')) as {
      manifest: ProviderManifest | null
      isBuiltinDefault?: boolean
    }
    // doubao 默认共享视觉密钥，required 已剥离 apiKey
    const required = providerInfo?.manifest?.configSchema?.required || []
    const missing = required.find((key) => {
      const value = settings.chatProvider.config?.[key]
      return value === undefined || value === null || value === ''
    })
    if (missing) {
      showToast(`${t('control.start.missingProviderField')}: ${missing}`, 'error')
      return
    }

    const result = await window.electron?.invoke('engine:start', settings)
    if (result?.success) {
      setStatus('running')
      showToast(t('toast.engineStarted'), 'success')
    } else {
      setStatus('error')
      showToast(result?.error || t('toast.startFailed'), 'error')
    }
  }, [setStatus])

  const handleStop = useCallback(async () => {
    await window.electron?.invoke('engine:stop')
    setStatus('idle')
    showToast(t('toast.engineStopped'), 'success')
  }, [setStatus])

  const running = status === 'running'

  return (
    <div className="bottom-bar">
      {running ? (
        <button className="bottom-btn bottom-btn-stop" onClick={handleStop}>
          <StopIcon />
          {t('control.stop')}
        </button>
      ) : (
        <button className="bottom-btn bottom-btn-play" onClick={handleStart}>
          <PlayIcon />
          {t('control.start')}
        </button>
      )}
      <button className="bottom-btn bottom-btn-settings" onClick={onSettings}>
        <GearIcon />
      </button>
    </div>
  )
}

function SettingsPanel() {
  const [appType, setAppType] = useState<AppType>('wechat')
  const [visionApiKey, setVisionApiKey] = useState('')
  const [providerManifestUrl, setProviderManifestUrl] = useState('')
  const [installedProvider, setInstalledProvider] = useState<InstalledProviderInfo | null>(null)
  const [installedManifest, setInstalledManifest] = useState<ProviderManifest | null>(null)
  const [providerConfig, setProviderConfig] = useState<Record<string, any>>({})
  const [testing, setTesting] = useState(false)
  const [installing, setInstalling] = useState(false)
  /** true 表示当前没装自定义 provider，正在用内置 doubao 默认值 */
  const [isBuiltinDefault, setIsBuiltinDefault] = useState(false)

  // capture / 框选策略
  const [defaultCaptureStrategy, setDefaultCaptureStrategy] = useState<CaptureStrategy>('auto')
  const [perAppStrategy, setPerAppStrategy] = useState<CaptureStrategy>('auto')
  const [perAppRegions, setPerAppRegions] = useState<BoxRegions | null>(null)
  const [openingWizard, setOpeningWizard] = useState(false)

  // settings 加载 + per-app 切换：每次 appType 变了就重新读 capture[appType] 状态
  const reloadCaptureForApp = useCallback((settings: AppSettings, type: AppType) => {
    const entry = settings.capture?.[type]
    setPerAppStrategy(entry?.strategy ?? 'auto')
    setPerAppRegions(entry?.regions ?? null)
  }, [])

  useEffect(() => {
    const load = async () => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (settings) {
        const initialAppType = settings.appType || 'wechat'
        setAppType(initialAppType)
        setVisionApiKey(settings.vision?.apiKey || '')
        setProviderManifestUrl(settings.chatProvider?.manifestUrl || '')
        setInstalledProvider(settings.chatProvider?.installed || null)
        setProviderConfig(settings.chatProvider?.config || {})
        setDefaultCaptureStrategy(settings.defaultCaptureStrategy || 'auto')
        reloadCaptureForApp(settings, initialAppType)
      }

      const providerInfo = (await window.electron?.invoke('provider:getInstalled')) as {
        installed: InstalledProviderInfo | null
        manifest: ProviderManifest | null
        isBuiltinDefault?: boolean
      }
      setIsBuiltinDefault(Boolean(providerInfo?.isBuiltinDefault))
      if (providerInfo?.installed) {
        setInstalledProvider(providerInfo.installed)
      }
      if (providerInfo?.manifest) {
        const manifest = providerInfo.manifest
        setInstalledManifest(manifest)
        setProviderConfig((prev) => applyManifestDefaults(manifest, prev))
      }
    }

    void load()
  }, [reloadCaptureForApp])

  // 切目标 app 时，把对应的 capture 配置同步到 UI
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (cancelled || !settings) return
      reloadCaptureForApp(settings, appType)
    })()
    return () => {
      cancelled = true
    }
  }, [appType, reloadCaptureForApp])

  // 监听 main 进程发的"区域已更新"事件——比如向导刚跑完，立即刷新 chip
  useEffect(() => {
    const cleanup = window.electron?.on(
      'capture:regions-updated',
      (data: { appType: AppType; regions: BoxRegions | null }) => {
        if (data.appType === appType) {
          setPerAppRegions(data.regions)
        }
      }
    )
    return cleanup
  }, [appType])

  const handleSaveVision = useCallback(async () => {
    const payload: Partial<AppSettings> = {
      appType,
      vision: { apiKey: visionApiKey }
    }

    await window.electron?.invoke('settings:set', payload)
    await window.electron?.invoke('engine:updateConfig', {
      ...(await window.electron?.invoke('settings:getAll')),
      ...payload,
      vision: { apiKey: visionApiKey }
    })
    showToast(t('settings.saved'), 'success')
  }, [appType, visionApiKey])

  const handleInstallProvider = useCallback(async () => {
    if (!providerManifestUrl.trim()) {
      showToast(t('settings.providerManifest.required'), 'error')
      return
    }

    setInstalling(true)
    try {
      const result = await window.electron?.invoke(
        'provider:installFromUrl',
        providerManifestUrl.trim()
      )
      if (!result?.success) {
        showToast(result?.error || t('settings.providerInstall.failed'), 'error')
        return
      }

      setIsBuiltinDefault(false)
      setInstalledProvider(result.installed)
      setInstalledManifest(result.manifest)
      setProviderConfig((prev) => applyManifestDefaults(result.manifest as ProviderManifest, prev))
      showToast(t('settings.providerInstall.success'), 'success')
    } finally {
      setInstalling(false)
    }
  }, [providerManifestUrl])

  const handleSaveProvider = useCallback(async () => {
    if (!installedManifest) {
      showToast(t('settings.providerInstall.required'), 'error')
      return
    }

    const required = installedManifest.configSchema.required || []
    const missing = required.find((key) => {
      const value = providerConfig[key]
      return value === undefined || value === null || value === ''
    })
    if (missing) {
      showToast(`${t('settings.providerField.required')}: ${missing}`, 'error')
      return
    }

    // 内置 doubao 默认模式：保存 config（model / systemPrompt 等），但 installed 仍为 null
    // 这样下次仍走内置 doubao + 共享视觉密钥的路径
    await window.electron?.invoke('settings:set', {
      chatProvider: {
        manifestUrl: providerManifestUrl,
        installed: isBuiltinDefault ? null : installedProvider,
        config: providerConfig
      }
    })

    showToast(t('settings.provider.saved'), 'success')
  }, [installedManifest, installedProvider, providerConfig, providerManifestUrl, isBuiltinDefault])

  // 切换默认抓取策略 → 立即写盘，避免依赖 vision 卡的"保存"按钮
  const handleSetDefaultStrategy = useCallback(async (next: CaptureStrategy) => {
    setDefaultCaptureStrategy(next)
    await window.electron?.invoke('settings:set', { defaultCaptureStrategy: next })
  }, [])

  // 切换当前 app 的策略
  const handleSetPerAppStrategy = useCallback(
    async (next: CaptureStrategy) => {
      setPerAppStrategy(next)
      const current = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      const existing = current?.capture?.[appType] || null
      await window.electron?.invoke('settings:set', {
        capture: {
          [appType]: {
            strategy: next,
            regions: existing?.regions ?? null
          }
        }
      })
    },
    [appType]
  )

  const handleOpenWizard = useCallback(async () => {
    setOpeningWizard(true)
    try {
      const result = (await window.electron?.invoke('capture:openSetupWizard', {
        appType
      })) as { success: boolean; reason?: string; regions?: BoxRegions } | undefined

      if (result?.success && result.regions) {
        setPerAppRegions(result.regions)
        showToast('已保存框选区域', 'success')
      } else if (result?.reason === 'cancelled' || result?.reason === 'closed') {
        showToast('框选已取消', 'error')
      } else {
        showToast('框选失败', 'error')
      }
    } finally {
      setOpeningWizard(false)
    }
  }, [appType])

  const handleResetRegions = useCallback(async () => {
    await window.electron?.invoke('capture:resetRegions', appType)
    setPerAppRegions(null)
    showToast('已清除框选区域', 'success')
  }, [appType])

  const handleTestConnection = useCallback(async () => {
    if (!visionApiKey) return
    setTesting(true)
    try {
      const result = await window.electron?.invoke('engine:testConnection', {
        apiKey: visionApiKey
      })
      if (result?.success) {
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${result?.error || ''}`, 'error')
      }
    } catch (e: any) {
      showToast(`${t('settings.testConnection.fail')}: ${e.message}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [visionApiKey])

  return (
    <div className="slide-up">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">{t('settings.vision')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.appType')}</label>
          <select
            className="form-input"
            value={appType}
            onChange={(e) => setAppType(e.target.value as AppType)}
          >
            {(Object.keys(APP_TYPE_LABELS) as AppType[]).map((type) => (
              <option key={type} value={type}>
                {APP_TYPE_LABELS[type]}
                {!isVlmSupported(type) ? ' （框选）' : ''}
              </option>
            ))}
          </select>
          <div className="form-hint">
            微信 / 企业微信 默认走自动识别；其他应用通过手动框选关键区域接入。
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionApiKey')}</label>
          <input
            className="form-input"
            type="password"
            value={visionApiKey}
            onChange={(e) => setVisionApiKey(e.target.value)}
            placeholder={t('settings.visionApiKey.placeholder')}
            autoComplete="off"
          />
          <div className="form-hint">{t('settings.visionApiKey.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionModel')}</label>
          <input className="form-input" value="doubao-seed-2-0-lite-260215" disabled />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionBaseUrl')}</label>
          <input className="form-input" value="https://ark.cn-beijing.volces.com/api/v3" disabled />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={handleTestConnection}
            disabled={!visionApiKey || testing}
          >
            {testing ? t('settings.testConnection.testing') : t('settings.testConnection')}
          </button>
          <button className="btn btn-primary" onClick={handleSaveVision} style={{ flex: 1 }}>
            {t('settings.saveVision')}
          </button>
        </div>
      </div>

      <CaptureStrategyCard
        appType={appType}
        defaultStrategy={defaultCaptureStrategy}
        perAppStrategy={perAppStrategy}
        regions={perAppRegions}
        openingWizard={openingWizard}
        onSetDefaultStrategy={handleSetDefaultStrategy}
        onSetPerAppStrategy={handleSetPerAppStrategy}
        onOpenWizard={handleOpenWizard}
        onResetRegions={handleResetRegions}
      />

      <div className="card">
        <div className="card-title">{t('settings.chatProvider')}</div>

        {isBuiltinDefault ? (
          <div className="form-hint" style={{ marginBottom: 12 }}>
            默认使用内置 doubao 提供方，与上方视觉接口密钥共享 API Key，无需重复填写。
            如需切换到其他聊天服务，请填入 manifest 地址安装。
          </div>
        ) : null}

        <div className="form-group">
          <label className="form-label">{t('settings.providerManifest')}</label>
          <input
            className="form-input"
            value={providerManifestUrl}
            onChange={(e) => setProviderManifestUrl(e.target.value)}
            placeholder={t('settings.providerManifest.placeholder')}
            autoComplete="off"
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            className="btn btn-secondary"
            onClick={handleInstallProvider}
            disabled={!providerManifestUrl || installing}
          >
            {installing ? t('settings.providerInstall.installing') : t('settings.providerInstall')}
          </button>
        </div>

        {installedProvider && !isBuiltinDefault ? (
          <div className="form-group">
            <label className="form-label">{t('settings.providerInstalled')}</label>
            <div className="form-hint">
              {getProviderDisplayName(installedProvider, installedManifest)} ·{' '}
              {installedProvider.version}
            </div>
            <div className="form-hint">
              {new Date(installedProvider.installedAt).toLocaleString()}
            </div>
          </div>
        ) : null}

        {installedManifest ? (
          <>
            {Object.entries(installedManifest.configSchema.properties).map(([key, field]) => (
              <DynamicProviderField
                key={key}
                fieldKey={key}
                field={field}
                value={providerConfig[key]}
                onChange={(value) => setProviderConfig((prev) => ({ ...prev, [key]: value }))}
              />
            ))}

            <button
              className="btn btn-primary"
              onClick={handleSaveProvider}
              style={{ width: '100%' }}
            >
              {t('settings.provider.save')}
            </button>
          </>
        ) : (
          <div className="form-hint">{t('settings.providerInstall.required')}</div>
        )}
      </div>
    </div>
  )
}

interface CaptureStrategyCardProps {
  appType: AppType
  defaultStrategy: CaptureStrategy
  perAppStrategy: CaptureStrategy
  regions: BoxRegions | null
  openingWizard: boolean
  onSetDefaultStrategy: (s: CaptureStrategy) => void
  onSetPerAppStrategy: (s: CaptureStrategy) => void
  onOpenWizard: () => void
  onResetRegions: () => void
}

// 解析"实际生效的策略"，让 UI 上能展示比 perAppStrategy 更具体的选择。
function effectiveStrategy(
  appType: AppType,
  perApp: CaptureStrategy,
  defaultStrategy: CaptureStrategy
): 'vlm' | 'box-select' {
  const eff = perApp === 'auto' ? defaultStrategy : perApp
  if (eff === 'auto') {
    return isVlmSupported(appType) ? 'vlm' : 'box-select'
  }
  return eff
}

function CaptureStrategyCard({
  appType,
  defaultStrategy,
  perAppStrategy,
  regions,
  openingWizard,
  onSetDefaultStrategy,
  onSetPerAppStrategy,
  onOpenWizard,
  onResetRegions
}: CaptureStrategyCardProps): React.JSX.Element {
  const isVlm = isVlmSupported(appType)
  const eff = effectiveStrategy(appType, perAppStrategy, defaultStrategy)

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">抓取方式</div>

      <div className="form-hint" style={{ marginBottom: 12 }}>
        当前应用：<strong style={{ color: '#cbd5e1' }}>{APP_TYPE_LABELS[appType]}</strong>
        ，实际生效：
        <strong style={{ color: '#38bdf8' }}>
          {eff === 'vlm' ? '自动识别（VLM）' : '手动框选'}
        </strong>
      </div>

      <div className="form-group">
        <label className="form-label">该应用的策略</label>
        <select
          className="form-input"
          value={perAppStrategy}
          onChange={(e) => onSetPerAppStrategy(e.target.value as CaptureStrategy)}
        >
          <option value="auto">智能默认（推荐）</option>
          <option value="vlm" disabled={!isVlm}>
            自动识别 VLM{!isVlm ? '（仅微信 / 企业微信）' : ''}
          </option>
          <option value="box-select">手动框选</option>
        </select>
        <div className="form-hint">
          智能默认：微信走 VLM；其他应用走框选；VLM 失败时自动切换到框选并记住选择。
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">框选区域</label>
        {regions ? (
          <div
            className="form-hint"
            style={{
              padding: '8px 10px',
              background: 'rgba(30, 41, 59, 0.6)',
              borderRadius: 6,
              color: '#cbd5e1'
            }}
          >
            ✓ 已配置 {regions.unreadIndicator ? '4' : '3'}/4 个区域
            {regions.displayId !== undefined ? ` · 显示器 ${regions.displayId}` : ''}
            <br />
            <span style={{ color: '#94a3b8' }}>
              捕获时间：{new Date(regions.capturedAt).toLocaleString()}
            </span>
          </div>
        ) : (
          <div className="form-hint">尚未配置：点击下方按钮逐步绘制 4 个区域。</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={onOpenWizard}
          disabled={openingWizard}
          style={{ flex: 1 }}
        >
          {openingWizard ? '正在打开...' : regions ? '重新框选' : '开始框选'}
        </button>
        {regions ? (
          <button className="btn btn-secondary" onClick={onResetRegions}>
            清除
          </button>
        ) : null}
      </div>

      <hr style={{ margin: '16px 0', border: '1px solid rgba(148,163,184,0.15)' }} />

      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">全局默认（仅当上方为「智能默认」时生效）</label>
        <select
          className="form-input"
          value={defaultStrategy}
          onChange={(e) => onSetDefaultStrategy(e.target.value as CaptureStrategy)}
        >
          <option value="auto">智能默认（按应用类型决定）</option>
          <option value="vlm">优先 VLM</option>
          <option value="box-select">优先框选</option>
        </select>
      </div>
    </div>
  )
}

function DynamicProviderField({
  fieldKey,
  field,
  value,
  onChange
}: {
  fieldKey: string
  field: ProviderSchemaField
  value: any
  onChange: (value: any) => void
}) {
  const label = getProviderFieldLabel(fieldKey, field)
  const normalizedValue =
    value !== undefined
      ? value
      : field.default !== undefined
        ? field.default
        : field.type === 'boolean'
          ? false
          : ''

  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {field.type === 'select' ? (
        <select
          className="form-input"
          value={String(normalizedValue)}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.enum || []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#cbd5e1' }}>
          <input
            type="checkbox"
            checked={Boolean(normalizedValue)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      ) : fieldKey === 'systemPrompt' ? (
        <textarea
          className="form-input"
          rows={4}
          value={String(normalizedValue)}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="form-input"
          type={field.type === 'password' ? 'password' : 'text'}
          value={String(normalizedValue)}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      )}
    </div>
  )
}

function applyManifestDefaults(
  manifest: ProviderManifest,
  current: Record<string, any>
): Record<string, any> {
  const next = { ...current }
  for (const [key, field] of Object.entries(manifest.configSchema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}

let _showToast: ((msg: string, type: 'success' | 'error') => void) | null = null

function showToast(msg: string, type: 'success' | 'error') {
  _showToast?.(msg, type)
}

function Toast() {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  _showToast = useCallback((msg: string, t: 'success' | 'error') => {
    setMessage(msg)
    setType(t)
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), 2500)
  }, [])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
