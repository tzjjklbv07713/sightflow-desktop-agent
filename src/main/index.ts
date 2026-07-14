import { app, BrowserWindow, desktopCapturer, ipcMain, shell } from 'electron'
import { is, optimizer } from '@electron-toolkit/utils'
import Store from 'electron-store'
import fs from 'node:fs'
import { join } from 'path'

import { BoxSelectDevice } from '../core/box-select-device'
import { type ChannelAdapter } from '../core/channel-adapter'
import { createDesktopChannelAdapter } from '../core/desktop-channel-adapter'
import { ReplyModelClient } from '../core/reply-client'
import { GenericChannelSession, createInitialGenericChannelState } from '../core/generic-channel-session'
import { RPADevice } from '../core/rpa-device'
import type { AppType, BoxRegions, CaptureStrategy, ScreenRect } from '../core/rpa/types'
import { RuntimeHost } from '../core/runtime-host'
import type { ProviderAdapter } from '../core/session-types'
import {
  appendTraceEvent,
  createAutomationTraceStore,
  type AutomationTrace,
  type AutomationTraceStore
} from '../core/automation-trace'
import {
  createKnowledgeBase,
  type KnowledgeBase,
  type KnowledgeEntryKind
} from '../core/knowledge-base'
import { type ObservedChatMessage } from '../core/chat/message-types'
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationExecutionMode,
  type AutomationSettings,
  type GroupReplyMode
} from '../core/automation-settings'
import { createLicenseService, type LicenseService } from './license-service'
import { createSettingsExportService, type SettingsExportService } from './settings-export-service'
import { exportDiagnosticsPackage } from './diagnostics-service'
import { checkAndRequestPermissions } from './permission'
import { runBoxSelectWizard } from './overlay-window'
import {
  BUILTIN_DOUBAO_PROVIDER_ID,
  getBuiltinDoubaoInstalledInfo,
  getBuiltinDoubaoManifestForUi,
  getInstalledProviderManifest,
  installProviderFromUrl,
  loadBuiltinDoubaoProvider,
  loadInstalledProvider,
  type InstalledProviderInfo,
  type ProviderBundleManifest
} from './provider-bundle'
import {
  startSkillServer,
  stopSkillServer,
  type SkillPauseResult,
  type SkillStartResult
} from './skill-server'

const icon = join(__dirname, '../../resources/icon.png')
let settingsExportService: SettingsExportService | null = null
let onboardingCompletedAt: string | null = null

const DEFAULT_OPENAI_COMPAT_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_PROVIDER_HUB_URL =
  process.env.SIGHTFLOW_PROVIDER_HUB_URL || 'https://sightflow.dev/provider-hub.json'
const PROVIDER_HUB_CACHE_KEY = 'providerHubCache'
const DEFAULT_REPLY_OUTPUT_MODE = 'typing-with-paste-fallback'
const MIN_TYPING_CPM = 60
const MAX_TYPING_CPM = 1200
const DEFAULT_TYPING_CPM = 280

type ReplyOutputMode = 'typing' | 'paste' | 'typing-with-paste-fallback'
const VALID_EXECUTION_MODES: AutomationExecutionMode[] = ['auto-send', 'draft', 'dry-run']
const VALID_GROUP_REPLY_MODES: GroupReplyMode[] = ['off', 'mention-only', 'mention-or-keyword', 'whitelist']
const VALID_AUTO_SEND_SCOPES: AutomationSettings['autoSendScope'][] = [
  'direct-only',
  'direct-and-whitelist-groups',
  'all'
]
const VALID_KNOWLEDGE_ENTRY_KINDS: KnowledgeEntryKind[] = ['faq', 'product', 'policy', 'tone', 'forbidden']

interface ReplyOutputConfig {
  mode: ReplyOutputMode
  typingCpm: number
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
    model: string
    baseURL: string
  }
  replyModel: {
    apiKey: string
    model: string
    baseURL: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  defaultCaptureStrategy: CaptureStrategy
  reply: ReplyOutputConfig
  automation: AutomationSettings
  capture: Partial<Record<AppType, PerAppCapture>>
}

interface ProviderHubCache {
  sourceUrl: string
  fetchedAt: string
  providers: Array<{
    id: string
    name: string
    description: string
    version: string
    manifestUrl: string
    capabilities: string[]
    configSchema: { fields: Array<Record<string, any>> }
  }>
}

const VALID_APP_TYPES: AppType[] = ['wechat', 'wework', 'dingtalk', 'lark', 'slack', 'telegram', 'generic']
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function coerceAppType(raw: unknown): AppType {
  return typeof raw === 'string' && VALID_APP_TYPES.includes(raw as AppType)
    ? (raw as AppType)
    : 'wechat'
}

function coerceStrategy(raw: unknown, fallback: CaptureStrategy = 'auto'): CaptureStrategy {
  return typeof raw === 'string' && VALID_CAPTURE_STRATEGIES.includes(raw as CaptureStrategy)
    ? (raw as CaptureStrategy)
    : fallback
}

function coerceRect(raw: unknown): ScreenRect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x)
  const y = Number(r.y)
  const width = Number(r.width)
  const height = Number(r.height)
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  return { x, y, width, height }
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const contactList = coerceRect(r.contactList)
  const chatMain = coerceRect(r.chatMain)
  const inputBox = coerceRect(r.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(r.unreadIndicator),
    displayId: typeof r.displayId === 'number' ? r.displayId : undefined,
    scaleFactor: typeof r.scaleFactor === 'number' ? r.scaleFactor : undefined,
    capturedAt: typeof r.capturedAt === 'number' ? r.capturedAt : Date.now()
  }
}

function normalizeCapture(raw: unknown): Partial<Record<AppType, PerAppCapture>> {
  const out: Partial<Record<AppType, PerAppCapture>> = {}
  if (!raw || typeof raw !== 'object') return out

  for (const key of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[key] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }

  return out
}

function normalizeReplyOutput(raw: unknown): ReplyOutputConfig {
  const mode =
    isRecord(raw) &&
    (raw.mode === 'typing' || raw.mode === 'paste' || raw.mode === 'typing-with-paste-fallback')
      ? (raw.mode as ReplyOutputMode)
      : DEFAULT_REPLY_OUTPUT_MODE
  const numeric = Number(isRecord(raw) ? raw.typingCpm : NaN)
  const typingCpm = Number.isFinite(numeric)
    ? Math.max(MIN_TYPING_CPM, Math.min(MAX_TYPING_CPM, Math.round(numeric)))
    : DEFAULT_TYPING_CPM
  return { mode, typingCpm }
}

function normalizeInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function normalizeKeywordList(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw
          .split(/[,]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : []
  const normalized = values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Array.from(new Set(normalized)).slice(0, 20)
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

function normalizeNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function normalizeAutomationSettings(raw: unknown): AutomationSettings {
  const source = isRecord(raw) ? raw : {}
  const executionMode = VALID_EXECUTION_MODES.includes(source.executionMode as AutomationExecutionMode)
    ? (source.executionMode as AutomationExecutionMode)
    : DEFAULT_AUTOMATION_SETTINGS.executionMode
  const groupReplyMode = VALID_GROUP_REPLY_MODES.includes(source.groupReplyMode as GroupReplyMode)
    ? (source.groupReplyMode as GroupReplyMode)
    : DEFAULT_AUTOMATION_SETTINGS.groupReplyMode
  const autoSendScope = VALID_AUTO_SEND_SCOPES.includes(source.autoSendScope as AutomationSettings['autoSendScope'])
    ? (source.autoSendScope as AutomationSettings['autoSendScope'])
    : DEFAULT_AUTOMATION_SETTINGS.autoSendScope

  return {
    executionMode,
    maxReplyChars: normalizeInteger(
      source.maxReplyChars,
      DEFAULT_AUTOMATION_SETTINGS.maxReplyChars,
      1,
      8000
    ),
    globalRateLimitPerMinute: normalizeInteger(
      source.globalRateLimitPerMinute,
      DEFAULT_AUTOMATION_SETTINGS.globalRateLimitPerMinute,
      1,
      120
    ),
    perChatRateLimitPerMinute: normalizeInteger(
      source.perChatRateLimitPerMinute,
      DEFAULT_AUTOMATION_SETTINGS.perChatRateLimitPerMinute,
      1,
      60
    ),
    groupReplyMode,
    groupTriggerKeywords: normalizeKeywordList(source.groupTriggerKeywords),
    groupWhitelist: normalizeKeywordList(source.groupWhitelist),
    autoSendScope,
    maxConsecutiveFailures: normalizeInteger(
      source.maxConsecutiveFailures,
      DEFAULT_AUTOMATION_SETTINGS.maxConsecutiveFailures,
      1,
      20
    ),
    perChatDailyLimit: normalizeInteger(
      source.perChatDailyLimit,
      DEFAULT_AUTOMATION_SETTINGS.perChatDailyLimit,
      1,
      2000
    ),
    globalDailyLimit: normalizeInteger(
      source.globalDailyLimit,
      DEFAULT_AUTOMATION_SETTINGS.globalDailyLimit,
      1,
      20000
    ),
    sensitiveKeywords: normalizeKeywordList(source.sensitiveKeywords).length
      ? normalizeKeywordList(source.sensitiveKeywords)
      : DEFAULT_AUTOMATION_SETTINGS.sensitiveKeywords,
    blockedChatKeywords: normalizeKeywordList(source.blockedChatKeywords),
    manualHandoffKeywords: normalizeKeywordList(source.manualHandoffKeywords).length
      ? normalizeKeywordList(source.manualHandoffKeywords)
      : DEFAULT_AUTOMATION_SETTINGS.manualHandoffKeywords,
    humanHandoffEnabled: normalizeBoolean(
      source.humanHandoffEnabled,
      DEFAULT_AUTOMATION_SETTINGS.humanHandoffEnabled
    ),
    requireKnowledgeForAutoSend: normalizeBoolean(
      source.requireKnowledgeForAutoSend,
      DEFAULT_AUTOMATION_SETTINGS.requireKnowledgeForAutoSend
    ),
    minKnowledgeConfidence: normalizeNumber(
      source.minKnowledgeConfidence,
      DEFAULT_AUTOMATION_SETTINGS.minKnowledgeConfidence,
      0,
      1
    ),
    negativeIntentKeywords: normalizeKeywordList(source.negativeIntentKeywords).length
      ? normalizeKeywordList(source.negativeIntentKeywords)
      : DEFAULT_AUTOMATION_SETTINGS.negativeIntentKeywords
  }
}

function readModelConfig(
  raw: unknown,
  fallback: { apiKey: string; model: string; baseURL: string }
): { apiKey: string; model: string; baseURL: string } {
  const source = isRecord(raw) ? raw : {}
  return {
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : fallback.apiKey,
    model:
      typeof source.model === 'string' && source.model
        ? source.model
        : fallback.model || DEFAULT_OPENAI_COMPAT_MODEL,
    baseURL:
      typeof source.baseURL === 'string' && source.baseURL
        ? source.baseURL
        : fallback.baseURL || DEFAULT_OPENAI_COMPAT_BASE_URL
  }
}

function normalizeSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {}
  const oldApiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const oldModel =
    typeof source.model === 'string' && source.model ? source.model : DEFAULT_OPENAI_COMPAT_MODEL
  const oldBaseURL =
    typeof source.baseURL === 'string' && source.baseURL ? source.baseURL : DEFAULT_OPENAI_COMPAT_BASE_URL
  const oldSystemPrompt = typeof source.systemPrompt === 'string' ? source.systemPrompt : ''
  const rawProviderConfig = isRecord(source.chatProvider?.config)
    ? { ...source.chatProvider.config }
    : {}

  if (rawProviderConfig.systemPrompt === undefined && oldSystemPrompt) {
    rawProviderConfig.systemPrompt = oldSystemPrompt
  }
  const legacyModelConfig = {
    apiKey: oldApiKey || '',
    model:
      typeof rawProviderConfig.model === 'string' && rawProviderConfig.model
        ? rawProviderConfig.model
        : oldModel,
    baseURL:
      typeof rawProviderConfig.baseURL === 'string' && rawProviderConfig.baseURL
        ? rawProviderConfig.baseURL
        : oldBaseURL
  }
  const vision = readModelConfig(source.vision, legacyModelConfig)
  const rawReplyModel = isRecord(source.replyModel) ? source.replyModel : {}
  const replyModel = readModelConfig(source.replyModel, {
    apiKey:
      typeof rawProviderConfig.apiKey === 'string' && rawProviderConfig.apiKey
        ? rawProviderConfig.apiKey
        : vision.apiKey,
    model:
      typeof rawProviderConfig.model === 'string' && rawProviderConfig.model
        ? rawProviderConfig.model
        : vision.model,
    baseURL:
      typeof rawProviderConfig.baseURL === 'string' && rawProviderConfig.baseURL
        ? rawProviderConfig.baseURL
        : vision.baseURL
  })
  const replyModelLooksUnset =
    (!replyModel.apiKey || !replyModel.apiKey.trim()) &&
    (!rawReplyModel.model || rawReplyModel.model === DEFAULT_OPENAI_COMPAT_MODEL) &&
    (!rawReplyModel.baseURL || rawReplyModel.baseURL === DEFAULT_OPENAI_COMPAT_BASE_URL)
  const normalizedReplyModel = replyModelLooksUnset
    ? {
        apiKey: vision.apiKey,
        model: vision.model,
        baseURL: vision.baseURL
      }
    : replyModel

  return {
    locale: source.locale === 'en' ? 'en' : 'zh',
    appType: coerceAppType(source.appType),
    vision,
    replyModel: normalizedReplyModel,
    chatProvider: {
      manifestUrl: typeof source.chatProvider?.manifestUrl === 'string' ? source.chatProvider.manifestUrl : '',
      installed: source.chatProvider?.installed || null,
      config: rawProviderConfig
    },
    defaultCaptureStrategy: coerceStrategy(source.defaultCaptureStrategy, 'auto'),
    reply: normalizeReplyOutput(source.reply),
    automation: normalizeAutomationSettings(source.automation),
    capture: normalizeCapture(source.capture)
  }
}

function replyModelUsesVisionFallback(raw: unknown): boolean {
  const source = isRecord(raw) ? raw : {}
  const replySource = isRecord(source.replyModel) ? source.replyModel : {}
  const replyModelLooksUnset =
    (!replySource.apiKey || typeof replySource.apiKey !== 'string' || !replySource.apiKey.trim()) &&
    (!replySource.model || replySource.model === DEFAULT_OPENAI_COMPAT_MODEL) &&
    (!replySource.baseURL || replySource.baseURL === DEFAULT_OPENAI_COMPAT_BASE_URL)

  if (!replyModelLooksUnset) return false
  const settings = normalizeSettings(raw)
  return Boolean(settings.vision.apiKey)
}

function replyModelMatchesVisionConfig(raw: unknown): boolean {
  const settings = normalizeSettings(raw)
  return (
    Boolean(settings.vision.apiKey) &&
    settings.replyModel.apiKey === settings.vision.apiKey &&
    settings.replyModel.model === settings.vision.model &&
    settings.replyModel.baseURL === settings.vision.baseURL
  )
}

type EnginePreflightResult = {
  ready: boolean
  startupStrategy: CaptureStrategy
  providerMode: string
  replyConfigState: 'inherited' | 'synced' | 'custom'
  summary: string
  blocks: Array<{ code: string; message: string }>
}

async function buildEnginePreflight(rawConfig: unknown): Promise<EnginePreflightResult> {
  const settings = normalizeSettings(rawConfig || settingsStore.store)
  const appType = settings.appType || 'wechat'
  const startupStrategy = resolveSettingsStrategy(appType, settings)
  const providerNeedsReplyKey =
    !settings.chatProvider.installed || settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
  const providerMode = !settings.chatProvider.installed
    ? 'builtin-doubao'
    : settings.chatProvider.installed.id

  const blocks: Array<{ code: string; message: string }> = []

  if (startupStrategy === 'vlm' && !settings.vision.apiKey) {
    blocks.push({ code: 'no_vision_key', message: 'vision api key is not set' })
  }

  if (providerNeedsReplyKey && !settings.replyModel.apiKey) {
    blocks.push({ code: 'no_reply_key', message: 'missing reply provider api key' })
  }

  if (settings.chatProvider.installed) {
    const installedManifest = await getInstalledProviderManifest(settings.chatProvider.installed)
    const isDoubao = settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
    const required = (installedManifest?.configSchema?.required || []).filter(
      (key: string) => !(isDoubao && key === 'apiKey')
    )
    const missing = required.find((key: string) => {
      const value = settings.chatProvider.config?.[key]
      return value === undefined || value === null || value === ''
    })
    if (missing) {
      blocks.push({ code: 'missing_required_field', message: `missing field: ${missing}` })
    }
  }

  const replyConfigState = replyModelUsesVisionFallback(rawConfig || settingsStore.store)
    ? 'inherited'
    : replyModelMatchesVisionConfig(rawConfig || settingsStore.store)
      ? 'synced'
      : 'custom'

  return {
    ready: blocks.length === 0,
    startupStrategy,
    providerMode,
    replyConfigState,
    summary: blocks[0]?.message || 'xxmissing fieldapix,xxxx,',
    blocks,
  }
}

function withSchemaDefaults(schema: ProviderBundleManifest['configSchema'], current: Record<string, any>): Record<string, any> {
  const next = { ...current }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}

function stripSettingsStoreBom(): void {
  try {
    const settingsPath = join(app.getPath('userData'), 'settings.json')
    const bytes = fs.readFileSync(settingsPath)
    if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
      fs.writeFileSync(settingsPath, bytes.subarray(3))
    }
  } catch {
    // ignore
  }
}

const StoreClass = (Store as any).default || Store
stripSettingsStoreBom()
const settingsStore = new StoreClass({
  name: 'settings',
  defaults: {
    locale: 'zh',
    appType: 'wechat',
    vision: {
      apiKey: '',
      model: DEFAULT_OPENAI_COMPAT_MODEL,
      baseURL: DEFAULT_OPENAI_COMPAT_BASE_URL
    },
    replyModel: {
      apiKey: '',
      model: DEFAULT_OPENAI_COMPAT_MODEL,
      baseURL: DEFAULT_OPENAI_COMPAT_BASE_URL
    },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    defaultCaptureStrategy: 'auto',
    reply: {
      mode: DEFAULT_REPLY_OUTPUT_MODE,
      typingCpm: DEFAULT_TYPING_CPM
    },
    automation: { ...DEFAULT_AUTOMATION_SETTINGS },
    capture: {}
  }
})

let runtime: RuntimeHost<any> | null = null
let runtimeChannel: GenericChannelSession | null = null
let runtimeAdapter: ChannelAdapter | null = null
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let knowledgeBase: KnowledgeBase | null = null
let traceStore: AutomationTraceStore | null = null
let licenseService: LicenseService | null = null
const humanHandoffChats = new Map<string, { active: boolean; reason?: string; updatedAt: string }>()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow!.on('ready-to-show', () => mainWindow!.show())
  mainWindow!.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  settingsWindow!.on('ready-to-show', () => settingsWindow!.show())
  settingsWindow!.on('closed', () => {
    settingsWindow = null
  })
  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    settingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}xwindow=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }
}

function getCachedProviderHub(): ProviderHubCache | null {
  const cached = settingsStore.get(PROVIDER_HUB_CACHE_KEY)
  if (!isRecord(cached) || !Array.isArray(cached.providers)) return null
  return cached as ProviderHubCache
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function normalizeManifestConfigFields(configSchema: any): any[] {
  if (!isRecord(configSchema)) return []
  const required = Array.isArray(configSchema.required)
    ? configSchema.required.filter((key) => typeof key === 'string')
    : []

  if (Array.isArray(configSchema.fields)) {
    return configSchema.fields
      .map((field: any) => {
        if (!isRecord(field) || typeof field.key !== 'string') return null
        return {
          key: field.key,
          label: typeof field.label === 'string' ? field.label : field.key,
          type:
            field.type === 'password' || field.type === 'url' || field.type === 'select' || field.type === 'textarea'
              ? field.type
              : 'text',
          required: field.required === true || required.includes(field.key),
          readonly: field.readonly === true,
          placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
          hint: typeof field.hint === 'string' ? field.hint : undefined,
          defaultValue: typeof field.defaultValue === 'string' ? field.defaultValue : undefined,
          options: Array.isArray(field.options)
            ? field.options
                .map((option: any) =>
                  typeof option === 'string'
                    ? { label: option, value: option }
                    : isRecord(option) && typeof option.value === 'string'
                      ? { label: typeof option.label === 'string' ? option.label : option.value, value: option.value }
                      : null
                )
                .filter(Boolean)
            : undefined
        }
      })
      .filter(Boolean)
  }

  if (!isRecord(configSchema.properties)) return []
  return Object.entries(configSchema.properties).map(([key, property]) => {
    const schema = isRecord(property) ? property : {}
    return {
      key,
      label: typeof schema.title === 'string' ? schema.title : key,
      type:
        schema.type === 'password' || schema.type === 'url' || schema.type === 'select' || schema.type === 'textarea'
          ? schema.type
          : 'text',
      required: required.includes(key),
      readonly: schema.readonly === true || schema.readOnly === true,
      placeholder: typeof schema.placeholder === 'string' ? schema.placeholder : undefined,
      hint: typeof schema.description === 'string' ? schema.description : undefined,
      defaultValue: typeof schema.default === 'string' ? schema.default : undefined,
      options: Array.isArray(schema.enum)
        ? schema.enum.map((value: any) => (typeof value === 'string' ? { label: value, value } : null)).filter(Boolean)
        : undefined
    }
  })
}

async function fetchProviderHub(url = DEFAULT_PROVIDER_HUB_URL): Promise<ProviderHubCache> {
  const hub = await fetchJson(url)
  if (!isRecord(hub) || !Array.isArray(hub.providers)) {
    throw new Error('Provider hub JSON must contain a providers array')
  }

  const providers = await Promise.all(
    hub.providers
      .filter((entry: any) => entry.enabled !== false && typeof entry.manifestUrl === 'string')
      .map(async (entry: any) => {
        const manifestUrl = entry.manifestUrl as string
        const manifest = await fetchJson(manifestUrl)
        const id =
          typeof manifest.id === 'string' ? manifest.id : typeof entry.id === 'string' ? entry.id : manifestUrl
        const name = typeof manifest.name === 'string' ? manifest.name : id
        const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
        const description = typeof manifest.description === 'string' ? manifest.description : undefined
        return {
          id,
          name,
          description,
          version,
          manifestUrl,
          capabilities: Array.isArray(manifest.capabilities)
            ? manifest.capabilities.filter((item: any) => typeof item === 'string')
            : undefined,
          configSchema: { fields: normalizeManifestConfigFields(manifest.configSchema) }
        }
      })
  )

  const cache: ProviderHubCache = {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    providers
  }
  settingsStore.set(PROVIDER_HUB_CACHE_KEY, cache)
  return cache
}

function notifyEngineStateChanged(status: 'running' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('engine:state', { status })
    }
  }
}

function notifyCaptureRegionsUpdated(appType: AppType, regions: BoxRegions | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:regions-updated', { appType, regions })
    }
  }
}

function resolveEffectiveStrategy(
  appType: AppType,
  perAppStrategy: CaptureStrategy,
  defaultStrategy: CaptureStrategy
): CaptureStrategy {
  const effective = perAppStrategy === 'auto' ? defaultStrategy : perAppStrategy
  if (effective === 'auto') return appType === 'wechat' || appType === 'wework' ? 'vlm' : 'box-select'
  return effective
}

function resolveSettingsStrategy(appType: AppType, settings: AppSettings): CaptureStrategy {
  const perApp = settings.capture[appType] || { strategy: 'auto', regions: null }
  return resolveEffectiveStrategy(appType, perApp.strategy, settings.defaultCaptureStrategy)
}

function persistRegionsAndStickyStrategy(
  appType: AppType,
  regions: BoxRegions,
  strategy: CaptureStrategy
): void {
  const current = normalizeSettings(settingsStore.store)
  const next = {
    ...current,
    capture: {
      ...current.capture,
      [appType]: { strategy, regions }
    }
  }
  settingsStore.set(next)
  notifyCaptureRegionsUpdated(appType, regions)
}

async function buildDevice(
  appType: AppType,
  settings: AppSettings,
  log: (type: 'thinking' | 'reply' | 'skip' | 'error' | 'metric', content: string) => void
): Promise<{ device: RPADevice | BoxSelectDevice; strategy: string }> {
  const perApp = settings.capture[appType] || { strategy: 'auto', regions: null }
  const effective = resolveSettingsStrategy(appType, settings)

  if (effective === 'vlm') {
    const rpa = new RPADevice()
    rpa.setAppType(appType)
    rpa.setApiKey(settings.vision.apiKey, settings.vision.model, settings.vision.baseURL)
    rpa.setReplyOutputConfig(settings.reply)
    return { device: rpa, strategy: 'vlm' }
  }

  let regions = perApp.regions
  if (!regions) {
    log('thinking', `falling back to box-select for ${appType} (api)`)
    const wizardResult = await runBoxSelectWizard({ appType, prefill: null })
    if (!wizardResult.ok || !wizardResult.regions) {
      throw new Error('user_cancelled_box_select_wizard')
    }
    regions = wizardResult.regions
    persistRegionsAndStickyStrategy(appType, regions, perApp.strategy)
  }

  const device = new BoxSelectDevice(regions)
  device.setReplyOutputConfig(settings.reply)
  return { device, strategy: 'box-select' }
}

async function startEngineCore(rawConfig: unknown): Promise<SkillStartResult> {
  if (runtime!.isRunning()) {
    return { ok: false, reason: 'already_running', message: 'engine already running' }
  }

  try {
    const settings = normalizeSettings(rawConfig || settingsStore.store)
    const appType = settings.appType || 'wechat'
    const startupStrategy = resolveSettingsStrategy(appType, settings)
    const providerNeedsReplyKey =
      !settings.chatProvider.installed || settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
    if (startupStrategy === 'vlm' && !settings.vision.apiKey) {
      return { ok: false, reason: 'no_vision_key', message: 'vision api key is not set' }
    }

    if (providerNeedsReplyKey && !settings.replyModel.apiKey) {
      return { ok: false, reason: 'no_reply_key', message: 'reply model api key is not set' }
    }

    let provider: ProviderAdapter
    if (!settings.chatProvider.installed) {
      const loaded = await loadBuiltinDoubaoProvider({
        ...settings.chatProvider.config,
        apiKey: settings.replyModel.apiKey,
        model: settings.replyModel.model,
        baseURL: settings.replyModel.baseURL
      })
      provider = loaded.provider
    } else {
      const installedManifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      const isDoubao = settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
      const required = (installedManifest?.configSchema?.required || []).filter(
        (key: string) => !(isDoubao && key === 'apiKey')
      )
      const missing = required.find((key: string) => {
        const value = settings.chatProvider.config?.[key]
        return value === undefined || value === null || value === ''
      })
      if (missing) {
        return { ok: false, reason: 'missing_required_field', message: `missing field: ${missing}` }
      }

      const effectiveConfig = isDoubao
        ? {
            ...settings.chatProvider.config,
            apiKey: settings.replyModel.apiKey,
            model: settings.replyModel.model,
            baseURL: settings.replyModel.baseURL
          }
        : settings.chatProvider.config
      const loaded = await loadInstalledProvider(settings.chatProvider.installed, effectiveConfig)
      provider = loaded.provider
    }

    const log = (type: 'thinking' | 'reply' | 'skip' | 'error' | 'metric', content: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:log', { type, content })
      }
    }

    let device: RPADevice | BoxSelectDevice
    let strategy: string
    try {
      const built = await buildDevice(appType, settings, log)
      device = built.device
      strategy = built.strategy
    } catch (err: any) {
      const message = err.message || String(err)
      if (message === 'user_cancelled_box_select_wizard') {
        return { ok: false, reason: 'wizard_cancelled', message: 'wizard cancelled by user' }
      }
      throw err
    }

    log('thinking', `strategy: ${strategy}`)
    const adapter = createDesktopChannelAdapter(device, strategy === 'vlm' ? 'native-pc' : 'rpa-fallback')
    adapter.setAppType(appType)
    adapter.setApiKey(settings.vision.apiKey, settings.vision.model, settings.vision.baseURL)
    adapter.setReplyOutputConfig?.(settings.reply)
    runtimeAdapter = adapter
    const channel = new GenericChannelSession(adapter, settings.automation)
    runtimeChannel = channel
    runtime = new RuntimeHost({
      appType,
      channel,
      provider,
      initialState: createInitialGenericChannelState(),
      onLog: log,
      getKnowledgeContext: async (message: ObservedChatMessage | null | undefined) =>
        knowledgeBase!.search(message) || {
          matches: [],
          confidence: 0,
          hasAnswer: false,
          forbiddenMatched: false,
          summary: ''
        },
      isHumanHandoffActive: getHumanHandoff,
      setHumanHandoff,
      recordTrace: recordAutomationTrace
    })

    runtime.startSession().catch((err) => {
      console.error('[Main] Runtime session error:', err)
    })
    notifyEngineStateChanged('running')
    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'engine_failed',
      message: error.message || String(error)
    }
  }
}

async function stopEngineCore(stopReason: string): Promise<SkillPauseResult> {
  if (!runtime!.isRunning()) {
    return { ok: false, reason: 'not_running', message: 'engine is not running' }
  }

  try {
    await runtime!.stopSession(stopReason)
    runtime = null
    runtimeAdapter = null
    runtimeChannel = null
    notifyEngineStateChanged('idle')
    return { ok: true }
  } catch (error: any) {
    return { ok: false, reason: 'pause_failed', message: error.message || String(error) }
  }
}

function normalizeCompatApiRoot(baseURL: string): string {
  let normalized = (baseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL).replace(/\/+$/, '')
  const lower = normalized.toLowerCase()

  for (const suffix of ['/chat/completions', '/models']) {
    if (lower.endsWith(suffix)) {
      normalized = normalized.slice(0, normalized.length - suffix.length)
      break
    }
  }

  return normalized || DEFAULT_OPENAI_COMPAT_BASE_URL
}

function buildModelsUrl(baseURL: string): string {
  return `${normalizeCompatApiRoot(baseURL)}/models`
}

function extractCompatApiErrorDetail(rawBody: string): string {
  const text = rawBody.trim()
  if (!text) return ''

  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return text.slice(0, 200)

    if (typeof parsed.message === 'string') return parsed.message.slice(0, 200)
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 200)
    if (isRecord(parsed.error) && typeof parsed.error.message === 'string') {
      return parsed.error.message.slice(0, 200)
    }
  } catch {
    return text.slice(0, 200)
  }

  return text.slice(0, 200)
}

function analyzeCompatApiFailure(
  status: number,
  rawBody: string
): { category: string; message: string } {
  const detail = extractCompatApiErrorDetail(rawBody)
  const category = classifyCompatApiErrorCategory(status, detail)

  switch (category) {
    case 'auth':
      return {
        category,
        message: `401 Unauthorized. check api key, account permissions, and base url${detail ? ` - ${detail}` : ''}`
      }
    case 'permission':
      return {
        category,
        message: `403 Forbidden. check api key permissions${detail ? ` - ${detail}` : ''}`
      }
    case 'base_url':
      return {
        category,
        message: `404 Not Found. check base url (/v1 or /api/v3) and model name${detail ? ` - ${detail}` : ''}`
      }
    case 'model':
      return {
        category,
        message: `check api key permissions${detail ? ` - ${detail}` : ''}`
      }
    case 'rate_limit':
      return {
        category,
        message: `429 Too Many Requests. slow down and retry${detail ? ` - ${detail}` : ''}`
      }
    case 'server':
      return {
        category,
        message: `request failed (status ${status})${detail ? ` - ${detail}` : ''}`
      }
    default:
      return {
        category,
        message: `API request failed: ${status}${detail ? ` - ${detail}` : ''}`
      }
  }
}

function classifyCompatApiErrorCategory(status: number, detail: string): string {
  const normalized = detail.toLowerCase()
  const looksLikeModelIssue =
    /model/.test(normalized) &&
    /(not found|does not exist|invalid|unsupported|unavailable|not exist|unknown)/.test(normalized)

  if (looksLikeModelIssue) return 'model'
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'base_url'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status === 400 && looksLikeModelIssue) return 'model'
  return 'unknown'
}

function classifyRuntimeErrorCategory(message: string): string {
  const normalized = message.toLowerCase()
  if (/(timed out|timeout|aborted|xxx)/.test(normalized)) return 'timeout'
  if (/(fetch failed|failed to fetch|network|econnrefused|enotfound|socket|certificate|tls)/.test(normalized)) {
    return 'network'
  }
  return 'unknown'
}

function updateRuntimeDeviceFromSettings(settings: AppSettings): void {
  if (runtimeAdapter) {
    runtimeAdapter.setAppType(settings.appType)
    runtimeAdapter.setApiKey(settings.vision.apiKey, settings.vision.model, settings.vision.baseURL)
    runtimeAdapter.setReplyOutputConfig?.(settings.reply)
  }
  runtimeChannel!.updateAutomationConfig(settings.automation)
  runtime!.updateAppType(settings.appType)
}

async function recordAutomationTrace(event: any): Promise<string | undefined> {
  if (!traceStore) return undefined

  let trace: AutomationTrace | null = event.traceId ? traceStore.get(event.traceId) : null
  if (!trace && event.type === 'start') {
    trace = traceStore.create({
      appType: event.appType,
      messageKey: event.messageKey,
      screenshot: event.screenshot,
      latestMessage: event.latestMessage
    })
  }
  if (!trace) return undefined

  if (event.observedMessage !== undefined) trace.observedMessage = event.observedMessage
  if (event.observationStages !== undefined) trace.observationStages = event.observationStages
  if (event.knowledge !== undefined) trace.knowledge = event.knowledge
  if (event.replyText !== undefined) trace.replyText = event.replyText
  if (event.policyDecision !== undefined) trace.policyDecision = event.policyDecision as any
  if (event.executionMode !== undefined) trace.executionMode = event.executionMode
  if (event.verification !== undefined) trace.verification = event.verification
  if (event.error !== undefined) trace.error = event.error

  switch (event.type) {
    case 'observed_message':
      trace.status = 'provider_running'
      break
    case 'policy':
      trace.status = 'provider_running'
      break
    case 'blocked':
      trace.status = 'blocked'
      break
    case 'drafted':
      trace.status = 'drafted'
      break
    case 'verified':
      break
    case 'sent':
      trace.status = 'sent'
      break
    case 'failed':
      trace.status = 'failed'
      break
    case 'skipped':
      trace.status = 'skipped'
      break
  }

  appendTraceEvent(trace, event.type, event.detail || event.error, {
    messageKey: event.messageKey,
    executionMode: event.executionMode
  })
  await traceStore.upsert(trace)
  return trace.id
}

function getHumanHandoff(chatKeyValue: string): boolean {
  return humanHandoffChats.get(chatKeyValue)?.active === true
}

function setHumanHandoff(chatKeyValue: string, active: boolean, reason?: string): void {
  humanHandoffChats.set(chatKeyValue, {
    active,
    reason,
    updatedAt: new Date().toISOString()
  })
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.electron')
  knowledgeBase = createKnowledgeBase(app.getPath('userData'))
  traceStore = createAutomationTraceStore(app.getPath('userData'))
  licenseService = createLicenseService(app.getPath('userData'))
  settingsExportService = createSettingsExportService(app.getPath('userData'))
  onboardingCompletedAt = (settingsStore.get('onboardingCompletedAt') as string | undefined) || null
  await Promise.all([knowledgeBase.load(), traceStore.load()])
  await checkAndRequestPermissions()
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('settings:getAll', async () => normalizeSettings(settingsStore.store))
  ipcMain.handle('settings:getMeta', async () => ({
    replyModelUsesVisionFallback: replyModelUsesVisionFallback(settingsStore.store),
    replyModelMatchesVisionConfig: replyModelMatchesVisionConfig(settingsStore.store)
  }))
  ipcMain.handle('engine:preflight', async (_event, config) => {
    const current = normalizeSettings(settingsStore.store)
    const merged = {
      ...current,
      ...config,
      vision: {
        ...current.vision,
        ...(config.vision || {})
      },
      replyModel: {
        ...current.replyModel,
        ...(config.replyModel || {})
      },
      chatProvider: {
        ...current.chatProvider,
        ...(config.chatProvider || {}),
        config: {
          ...current.chatProvider.config,
          ...(config.chatProvider?.config || {})
        }
      },
      reply: {
        ...current.reply,
        ...(config.reply || {})
      },
      automation: {
        ...current.automation,
        ...(config.automation || {})
      },
      capture: {
        ...current.capture,
        ...(config.capture || {})
      }
    }
    return buildEnginePreflight(merged)
  })
  ipcMain.handle('settings:get', async (_event, key) => normalizeSettings(settingsStore.store)[key as keyof AppSettings])
  ipcMain.handle('settings:set', async (_event, data) => {
    const current = normalizeSettings(settingsStore.store)
    const merged = {
      ...current,
      ...data,
      vision: {
        ...current.vision,
        ...(data.vision || {})
      },
      replyModel: {
        ...current.replyModel,
        ...(data.replyModel || {})
      },
      chatProvider: {
        ...current.chatProvider,
        ...(data.chatProvider || {}),
        config: {
          ...current.chatProvider.config,
          ...(data.chatProviderx.config || {})
        }
      },
      reply: {
        ...current.reply,
        ...(data.reply || {})
      },
      automation: {
        ...current.automation,
        ...(data.automation || {})
      },
      capture: {
        ...current.capture,
        ...(data.capture || {})
      }
    }
    const next = normalizeSettings(merged)
    settingsStore.set(next)
    updateRuntimeDeviceFromSettings(next)
    return { success: true }
  })

  ipcMain.handle('provider:installFromUrl', async (_event, manifestUrl: string) => {
    try {
      const result = await installProviderFromUrl(manifestUrl)
      const current = normalizeSettings(settingsStore.store)
      settingsStore.set({
        ...current,
        chatProvider: {
          ...current.chatProvider,
          manifestUrl,
          installed: result.installed,
          config: withSchemaDefaults(result.manifest.configSchema, current.chatProvider.config)
        }
      })
      return { success: true, installed: result.installed, manifest: result.manifest }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle('provider:getInstalled', async () => {
    const settings = normalizeSettings(settingsStore.store)
    if (settings.chatProvider.installed) {
      const manifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      return { installed: settings.chatProvider.installed, manifest, isBuiltinDefault: false }
    }
    const installed = await getBuiltinDoubaoInstalledInfo()
    const manifest = await getBuiltinDoubaoManifestForUi()
    return { installed, manifest, isBuiltinDefault: true }
  })

  ipcMain.handle('providerHub:getCatalog', async () => {
    const cached = getCachedProviderHub()
    if (cached) return { success: true, catalog: cached }
    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: any) {
      return { success: false, error: error.message || String(error), catalog: null }
    }
  })

  ipcMain.handle('providerHub:update', async () => {
    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: any) {
      return { success: false, error: error.message || String(error), catalog: getCachedProviderHub() }
    }
  })

  ipcMain.handle('settings:open', async () => {
    createSettingsWindow()
    return { success: true }
  })

  ipcMain.handle('conversation:list', async (_event, limit) => ({
    success: true,
    traces: traceStore!.list(normalizeInteger(limit, 100, 1, 300)) || [],
    stats: traceStore!.stats() || { total: 0, sent: 0, failed: 0, blocked: 0, skipped: 0, drafted: 0 }
  }))

  ipcMain.handle('conversation:getTrace', async (_event, traceId: string) => ({
    success: true,
    trace: typeof traceId === 'string' ? traceStore?.get(traceId) || null : null
  }))

  ipcMain.handle('conversation:setHandoff', async (_event, chatKeyValue: string, active: boolean, reason: string) => {
    if (typeof chatKeyValue !== 'string' || !chatKeyValue) {
      return { success: false, error: 'chatKey is required' }
    }
    setHumanHandoff(chatKeyValue, active === true, typeof reason === 'string' ? reason : 'manual')
    return { success: true, handoff: humanHandoffChats.get(chatKeyValue) }
  })

  ipcMain.handle('knowledge:list', async () => ({
    success: true,
    entries: knowledgeBase!.list() || []
  }))

  ipcMain.handle('knowledge:import', async (_event, args) => {
    const text = typeof args.text === 'string' ? args.text : ''
    const kind = VALID_KNOWLEDGE_ENTRY_KINDS.includes(args.kind) ? args.kind : 'faq'
    if (!text.trim()) return { success: false, error: 'knowledge text is required' }
    const imported = await knowledgeBase!.importText(text, kind)
    return { success: true, imported: imported || [], entries: knowledgeBase!.list() || [] }
  })

  ipcMain.handle('license:getState', async () => ({
    success: true,
    state: await licenseService!.getState()
  }))

  ipcMain.handle('license:activate', async (_event, licenseKey: string) => ({
    success: true,
    state: await licenseService?.activate(typeof licenseKey === 'string' ? licenseKey : '')
  }))

  ipcMain.handle('settings:export', async () => {
    const svc = settingsExportService
    if (svc == null) return { ok: false, error: 'export_service_uninitialized' }
    const current = normalizeSettings(settingsStore.store)
    const r = await svc.export(current)
    return r
  })

  ipcMain.handle('settings:import', async () => {
    const svc = settingsExportService
    if (svc == null) return { ok: false, error: 'export_service_uninitialized' }
    const result = await svc.import()
    if (!result.ok || !result.settings) return { ok: false, error: result.error || 'import_failed' }
    const current = normalizeSettings(settingsStore.store)
    const next = { ...current, ...result.settings }
    settingsStore.set(next)
    return { ok: true, settings: next, filePath: result.filePath }
  })

  ipcMain.handle('onboarding:status', async () => ({ completed: !!onboardingCompletedAt, completedAt: onboardingCompletedAt }))

  ipcMain.handle('onboarding:complete', async (_event, payload) => {
    const completedAt = (payload && typeof payload.completedAt === 'string') ? payload.completedAt : new Date().toISOString()
    onboardingCompletedAt = completedAt
    settingsStore.set('onboardingCompletedAt', completedAt)
    if (payload && typeof payload.appType === 'string') settingsStore.set('appType', payload.appType)
    return { ok: true, completedAt }
  })

  ipcMain.handle('onboarding:reset', async () => {
    onboardingCompletedAt = null
    settingsStore.delete('onboardingCompletedAt')
    return { ok: true }
  })
  ipcMain.handle('diagnostics:export', async (_event, opts?: { redact?: boolean }) => {
    const settings = normalizeSettings(settingsStore.store)
    const licenseState = await licenseService!.getState()
    const redact = opts?.redact !== false // default true: always redact for pilot compliance
    return exportDiagnosticsPackage({
      settingsSummary: {
        locale: settings.locale,
        appType: settings.appType,
        captureStrategy: resolveSettingsStrategy(settings.appType, settings),
        automation: settings.automation,
        provider: settings.chatProvider.installed!.id || BUILTIN_DOUBAO_PROVIDER_ID
      },
      traces: traceStore!.list(50) || [],
      stats: traceStore!.stats() || { total: 0, sent: 0, failed: 0, blocked: 0, skipped: 0, drafted: 0 },
      licenseState,
      knowledgeCount: knowledgeBase!.list().length || 0
    }, { redact })
  })

  ipcMain.handle('engine:start', async (_event, config) => {
    const result = await startEngineCore(config)
    return result.ok ? { success: true } : { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:stop', async (_event, reason) => {
    const result = await stopEngineCore(reason || 'ipc_stop')
    return result.ok ? { success: true } : { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:status', async () => ({ running: runtime!.isRunning() || false }))

  ipcMain.handle('engine:updateConfig', async (_event, config) => {
    const settings = normalizeSettings(config || settingsStore.store)
    updateRuntimeDeviceFromSettings(settings)
    return { success: true }
  })

  ipcMain.handle('engine:testConnection', async (_event, config) => {
    const settings = normalizeSettings(settingsStore.store)
    const apiKey = config.apiKey || settings.replyModel.apiKey
    const model = config.model || settings.replyModel.model
    const baseURL = config.baseURL || settings.replyModel.baseURL
    const client = new ReplyModelClient({ apiKey, model, baseURL })
    return client.testConnection()
  })

  ipcMain.handle('engine:listModels', async (_event, config) => {
    const settings = normalizeSettings(settingsStore.store)
    const apiKey = config.apiKey || settings.vision.apiKey
    const baseURL = config.baseURL || settings.vision.baseURL
    const startedAt = Date.now()
    const checkedAt = new Date(startedAt).toISOString()
    const normalizedBaseURL = normalizeCompatApiRoot(baseURL)
    const url = buildModelsUrl(baseURL)

    if (!apiKey) {
      return {
        success: false,
        error: 'API key is required',
        errorCategory: 'auth',
        models: [],
        url,
        checkedAt,
        normalizedBaseURL
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      })
      if (!response.ok) {
        const errorText = await response.text()
        const diagnostic = analyzeCompatApiFailure(response.status, errorText)
        return {
          success: false,
          error: diagnostic.message,
          errorCategory: diagnostic.category,
          models: [],
          url,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          checkedAt,
          normalizedBaseURL
        }
      }
      const payload = await response.json()
      const models =
        isRecord(payload) && Array.isArray(payload.data)
          ? payload.data.flatMap((item: any) => {
              if (!isRecord(item) || typeof item.id !== 'string') return []
              return [
                {
                  id: item.id,
                  owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
                  created: typeof item.created === 'number' ? item.created : undefined
                }
              ]
            })
          : []
      return {
        success: true,
        models,
        url,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        normalizedBaseURL
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'AI API request timed out (15s)',
          errorCategory: 'timeout',
          models: [],
          url,
          latencyMs: Date.now() - startedAt,
          checkedAt,
          normalizedBaseURL
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: message,
        errorCategory: classifyRuntimeErrorCategory(message),
        models: [],
        url,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        normalizedBaseURL
      }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('capture:openSetupWizard', async (_event, args) => {
    const settings = normalizeSettings(settingsStore.store)
    const appType = coerceAppType(args.appType)
    const prefill = settings.capture[appType]?.regions || null
    const result = await runBoxSelectWizard({ appType, steps: args.steps, prefill })
    if (!result.ok || !result.regions) {
      return { success: false, reason: result.reason || 'cancelled' }
    }
    const current = normalizeSettings(settingsStore.store)
    const next = {
      ...current,
      capture: {
        ...current.capture,
        [appType]: {
          strategy: current.capture[appType]?.strategy || 'auto',
          regions: result.regions
        }
      }
    }
    settingsStore.set(next)
    notifyCaptureRegionsUpdated(appType, result.regions)
    return { success: true, regions: result.regions }
  })

  ipcMain.handle('capture:getRegions', async (_event, appType) => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.capture[coerceAppType(appType)]?.regions || null
  })

  ipcMain.handle('capture:resetRegions', async (_event, appType) => {
    const current = normalizeSettings(settingsStore.store)
    const key = coerceAppType(appType)
    const next = {
      ...current,
      capture: {
        ...current.capture,
        [key]: { strategy: current.capture[key]?.strategy || 'auto', regions: null }
      }
    }
    settingsStore.set(next)
    notifyCaptureRegionsUpdated(key, null)
    return { success: true }
  })

  ipcMain.handle('capture-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      return sources?.[0]?.thumbnail.toDataURL() || null
    } catch (error) {
      console.error('Screen capture failed:', error)
      return null
    }
  })

  ipcMain.handle('test:vlm-parallel', async () => {
    const settings = normalizeSettings(settingsStore.store)
    const apiKey = settings.vision.apiKey
    if (!apiKey) return { error: 'reply api key is not set' }
    const { runVlmParallelTest } = await import('../core/rpa/tests/test-vlm-parallel')
    return await runVlmParallelTest(
      { apiKey, model: settings.vision.model, baseURL: settings.vision.baseURL },
      'wechat'
    )
  })

  startSkillServer({
    start: () => startEngineCore(undefined),
    pause: () => stopEngineCore('skill_pause'),
    isRunning: () => runtime?.isRunning() ?? false
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopSkillServer()
})
