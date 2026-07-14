import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { t } from './i18n'
import logoUrl from './assets/logo.png'
import {
  PageShell,
  StatusStrip,
  WorkspaceHeader,
  WorkspaceLayout,
  Workbench,
  type TaskCardItem,
  type TimelineStep,
  type WorkbenchState,
  type WorkbenchTheme
} from './workbench'
import { Console } from './console'
import { OnboardingWizard, useOnboardingStatus } from './onboarding-wizard'
import './index.css'

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error' | 'metric'
  content: string
}

type LogFilter =
  | 'all'
  | LogEntry['type']
  | 'group'
  | 'groupMention'
  | 'groupWhitelist'
  | 'relevance'

type EngineStatus = 'idle' | 'running' | 'error'
type SettingsSection = 'base' | 'agent'
type AppType = 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic'

type CaptureStrategy = 'auto' | 'vlm' | 'box-select'
type AutomationExecutionMode = 'auto-send' | 'draft' | 'dry-run'
type GroupReplyMode = 'off' | 'mention-only' | 'mention-or-keyword' | 'whitelist'
type ReplyMode = 'typing' | 'paste' | 'typing-with-paste-fallback'

const MIN_TYPING_CPM = 60
const MAX_TYPING_CPM = 1200
const DEFAULT_TYPING_CPM = 280
const TYPING_CPM_PRESETS = [180, 280, 420, 600]
const DEFAULT_AUTOMATION_SETTINGS = {
  executionMode: 'auto-send' as AutomationExecutionMode,
  maxReplyChars: 1200,
  globalRateLimitPerMinute: 12,
  perChatRateLimitPerMinute: 4,
  groupReplyMode: 'off' as GroupReplyMode,
  groupTriggerKeywords: [] as string[],
  groupWhitelist: [] as string[]
}

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

function normalizeTypingCpmInput(value: string): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TYPING_CPM
  return Math.max(MIN_TYPING_CPM, Math.min(MAX_TYPING_CPM, Math.round(numeric)))
}

function readTypingCpmInput(input: HTMLInputElement | null, fallback: string): number {
  return normalizeTypingCpmInput(input?.value ?? fallback)
}

function normalizeIntegerInput(value: string | number | undefined, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function normalizeKeywordInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, 20)
}

function listToInput(value: string[]): string {
  return value.join(', ')
}

function appendTokenValue(existing: string, nextValue: string): string {
  const next = nextValue.trim()
  if (!next) return existing
  const merged = [...normalizeKeywordInput(existing), next]
  return listToInput(Array.from(new Set(merged)))
}

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeCompatApiRootPreview(baseURL: string, fallback: string): string {
  let normalized = (baseURL.trim() || fallback).replace(/\/+$/, '')
  const lower = normalized.toLowerCase()

  for (const suffix of ['/chat/completions', '/models']) {
    if (lower.endsWith(suffix)) {
      normalized = normalized.slice(0, normalized.length - suffix.length)
      break
    }
  }

  return normalized || fallback
}

function buildChatCompletionsUrlPreview(baseURL: string): string {
  return `${normalizeCompatApiRootPreview(baseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)}/chat/completions`
}

function buildModelsUrlPreview(baseURL: string): string {
  return `${normalizeCompatApiRootPreview(baseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)}/models`
}

function formatDiagnosticTimestamp(value?: string): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatLatency(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ms` : '未记录'
}

function getDiagnosticStateLabel(result: RequestDiagnosticResult | null): string {
  if (!result) return '未执行'
  return result.success ? '成功' : '失败'
}

function getDiagnosticCategoryLabel(category?: DiagnosticErrorCategory): string | null {
  switch (category) {
    case 'auth':
      return '鉴权失败'
    case 'permission':
      return '权限不足'
    case 'base_url':
      return '地址错误'
    case 'model':
      return '模型不可用'
    case 'rate_limit':
      return '触发限流'
    case 'timeout':
      return '请求超时'
    case 'network':
      return '网络异常'
    case 'server':
      return '服务端异常'
    case 'unknown':
      return '待人工判断'
    default:
      return null
  }
}

function getDiagnosticNextStep(category?: DiagnosticErrorCategory): string {
  switch (category) {
    case 'auth':
      return '先核对 API Key 是否对应当前中转站，再重新测试连接。'
    case 'permission':
      return '先换有权限的 Key 或降低到该账号可访问的模型。'
    case 'base_url':
      return '先把 Base URL 改成接口根路径，例如 /v1 或 /api/v3，再重试。'
    case 'model':
      return '先点拉取模型或刷新列表，再从候选列表里重新选择模型名。'
    case 'rate_limit':
      return '先等待一会儿再试，必要时更换账号或降低请求频率。'
    case 'timeout':
      return '先确认服务端可达，再重试；必要时换网络或稍后再试。'
    case 'network':
      return '先检查网络、代理和证书环境，确认本机能访问该接口。'
    case 'server':
      return '先稍后重试；如果持续失败，优先联系服务商检查接口状态。'
    default:
      return '先导出完整诊断，再按 URL、模型名、Key 这三个顺序排查。'
  }
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '未填写'
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`
}

function buildBaseUrlChecklist(args: {
  title: string
  rawBaseURL: string
  normalizedBaseURL?: string
  requestURL?: string
  category?: DiagnosticErrorCategory
}): string {
  return [
    `${args.title} / URL 检查项`,
    `分类：${getDiagnosticCategoryLabel(args.category) || '未分类'}`,
    `当前 Base URL：${args.rawBaseURL || '未填写'}`,
    `兼容根路径：${args.normalizedBaseURL || '未记录'}`,
    `最终请求 URL：${args.requestURL || '未记录'}`,
    '建议检查：',
    '1. Base URL 是否填写为接口根路径，例如 /v1 或 /api/v3',
    '2. 不要把 /chat/completions 当作 Base URL 提交',
    '3. 如果是第三方中转站，确认该地址支持 /models 和 /chat/completions'
  ].join('\n')
}

function buildCredentialChecklist(args: {
  title: string
  apiKey: string
  model: string
  rawBaseURL: string
  category?: DiagnosticErrorCategory
}): string {
  return [
    `${args.title} / Key 检查项`,
    `分类：${getDiagnosticCategoryLabel(args.category) || '未分类'}`,
    `当前模型：${args.model || '未填写'}`,
    `当前 Base URL：${args.rawBaseURL || '未填写'}`,
    `当前 Key：${maskSecret(args.apiKey)}`,
    '建议检查：',
    '1. 确认 Key 与当前中转站属于同一平台',
    '2. 确认该 Key 对当前模型有调用权限',
    '3. 如果连接测试是 401/403，优先更换 Key 再重试'
  ].join('\n')
}

function buildModelSelectionChecklist(args: {
  title: string
  model: string
  candidateCount: number
  sourceLabel?: string
}): string {
  return [
    `${args.title} / 模型检查项`,
    `当前模型：${args.model || '未填写'}`,
    `当前候选数量：${args.candidateCount}`,
    args.sourceLabel ? `候选来源：${args.sourceLabel}` : '',
    '建议检查：',
    '1. 先拉取或刷新模型列表',
    '2. 尽量从候选列表里重新点选一次模型名',
    '3. 如果列表为空，先检查 Key 权限和 Base URL'
  ]
    .filter(Boolean)
    .join('\n')
}

function minutesAgoIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

function buildMockConnectionPreview(args: {
  success: boolean
  apiKey: string
  model: string
  baseURL: string
  checkedAt: string
  category?: DiagnosticErrorCategory
  error?: string
  responsePreview?: string
}): ConnectionTestResult {
  return {
    success: args.success,
    error: args.error,
    errorCategory: args.category,
    model: args.model,
    checkedAt: args.checkedAt,
    latencyMs: args.success ? 842 : 1260,
    status: args.success ? 200 : args.category === 'base_url' ? 404 : args.category === 'auth' ? 401 : 400,
    normalizedBaseURL: normalizeCompatApiRootPreview(args.baseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
    url: buildChatCompletionsUrlPreview(args.baseURL),
    responsePreview: args.responsePreview
  }
}

function buildMockModelListPreview(args: {
  success: boolean
  baseURL: string
  checkedAt: string
  models?: string[]
  category?: DiagnosticErrorCategory
  error?: string
}): ModelListResult {
  return {
    success: args.success,
    error: args.error,
    errorCategory: args.category,
    checkedAt: args.checkedAt,
    latencyMs: args.success ? 910 : 1488,
    status: args.success ? 200 : args.category === 'model' ? 400 : args.category === 'rate_limit' ? 429 : 400,
    normalizedBaseURL: normalizeCompatApiRootPreview(args.baseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
    url: buildModelsUrlPreview(args.baseURL),
    models: args.models?.map((id) => ({ id }))
  }
}

function inferDiagnosticCategoryFromMessage(message: string): DiagnosticErrorCategory {
  const normalized = message.toLowerCase()

  if (/(401|unauthorized|api key|鉴权)/.test(normalized)) return 'auth'
  if (/(403|forbidden|permission|权限)/.test(normalized)) return 'permission'
  if (/(404|not found|base url|地址)/.test(normalized)) return 'base_url'
  if (/(429|rate limit|too many requests|限流)/.test(normalized)) return 'rate_limit'
  if (/(timeout|timed out|aborted|超时)/.test(normalized)) return 'timeout'
  if (/(model|模型).*(not found|does not exist|invalid|unsupported|不可用|不存在|无权访问)/.test(normalized)) {
    return 'model'
  }
  if (/(fetch failed|failed to fetch|network|econnrefused|enotfound|socket|tls|certificate|网络)/.test(normalized)) {
    return 'network'
  }
  if (/(500|502|503|504|server)/.test(normalized)) return 'server'

  return 'unknown'
}

function buildConnectionSuccessDetail(result: ConnectionTestResult | null): string | undefined {
  if (!result) return undefined
  if (result.model && result.responsePreview) return `模型：${result.model} / 返回：${result.responsePreview}`
  if (result.model) return `模型：${result.model}`
  return result.responsePreview
}

function buildModelListSuccessDetail(result: ModelListResult | null): string | undefined {
  if (!result) return undefined
  return `共返回 ${(result.models || []).length} 个模型`
}

function buildRecentSuccessLabel(
  connection: ConnectionTestResult | null,
  modelList: ModelListResult | null
): string | undefined {
  const parts: string[] = []

  if (connection?.success) {
    parts.push(`连接 ${formatDiagnosticTimestamp(connection.checkedAt)}`)
  }
  if (modelList?.success) {
    parts.push(`列表 ${formatDiagnosticTimestamp(modelList.checkedAt)}`)
  }

  return parts.length ? `最近成功：${parts.join(' / ')}` : undefined
}

function buildCombinedModelDiagnosticsExport(args: {
  visionStatus: string
  visionSummaryDetail: string
  visionRecentSuccess?: string
  visionModel: string
  visionBaseURL: string
  visionSourceLabel?: string
  visionConnectionResult: ConnectionTestResult | null
  visionModelListResult: ModelListResult | null
  visionConnectionDetail?: string
  visionModelListDetail?: string
  replyStatus: string
  replySummaryDetail: string
  replyRecentSuccess?: string
  replyModel: string
  replyBaseURL: string
  replySourceLabel?: string
  replyConnectionResult: ConnectionTestResult | null
  replyModelListResult: ModelListResult | null
  replyConnectionDetail?: string
  replyModelListDetail?: string
}): string {
  const lines = [
    'SightFlow 模型接入诊断',
    `导出时间：${formatDiagnosticTimestamp(new Date().toISOString())}`,
    '',
    `视觉状态：${args.visionStatus}`,
    `视觉摘要：${args.visionSummaryDetail}`,
    args.visionRecentSuccess || '',
    `视觉模型：${args.visionModel || '未填写'}`,
    `视觉 Base URL：${args.visionBaseURL || '未填写'}`,
    args.visionSourceLabel ? `视觉候选来源：${args.visionSourceLabel}` : '',
    buildDiagnosticCopyText('视觉模型 / 连接测试', args.visionConnectionResult, args.visionConnectionDetail),
    '',
    buildDiagnosticCopyText('视觉模型 / 拉取模型', args.visionModelListResult, args.visionModelListDetail),
    '',
    `回复状态：${args.replyStatus}`,
    `回复摘要：${args.replySummaryDetail}`,
    args.replyRecentSuccess || '',
    `回复模型：${args.replyModel || '未填写'}`,
    `回复 Base URL：${args.replyBaseURL || '未填写'}`,
    args.replySourceLabel ? `回复候选来源：${args.replySourceLabel}` : '',
    buildDiagnosticCopyText('回复模型 / 连接测试', args.replyConnectionResult, args.replyConnectionDetail),
    '',
    buildDiagnosticCopyText('回复模型 / 拉取模型', args.replyModelListResult, args.replyModelListDetail)
  ]

  return lines.filter(Boolean).join('\n')
}

function buildFailedModelDiagnosticsExport(args: {
  visionStatus: string
  visionSummaryDetail: string
  visionConnectionResult: ConnectionTestResult | null
  visionModelListResult: ModelListResult | null
  visionConnectionDetail?: string
  visionModelListDetail?: string
  replyStatus: string
  replySummaryDetail: string
  replyConnectionResult: ConnectionTestResult | null
  replyModelListResult: ModelListResult | null
  replyConnectionDetail?: string
  replyModelListDetail?: string
}): string {
  const blocks: string[] = []

  const pushFailureBlock = (
    title: string,
    result: RequestDiagnosticResult | null,
    detail?: string
  ): void => {
    if (!result || result.success) return
    blocks.push(
      [
        `- ${title}`,
        `  分类：${getDiagnosticCategoryLabel(result.errorCategory) || '未分类'}`,
        `  HTTP：${typeof result.status === 'number' ? result.status : '未记录'}`,
        `  详情：${detail || result.error || '未记录'}`,
        `  建议：${getDiagnosticNextStep(result.errorCategory)}`
      ].join('\n')
    )
  }

  pushFailureBlock('视觉模型 / 连接测试', args.visionConnectionResult, args.visionConnectionDetail)
  pushFailureBlock('视觉模型 / 拉取模型', args.visionModelListResult, args.visionModelListDetail)
  pushFailureBlock('回复模型 / 连接测试', args.replyConnectionResult, args.replyConnectionDetail)
  pushFailureBlock('回复模型 / 拉取模型', args.replyModelListResult, args.replyModelListDetail)

  if (!blocks.length) {
    return [
      'SightFlow 失败项诊断（短版）',
      `导出时间：${formatDiagnosticTimestamp(new Date().toISOString())}`,
      '当前没有失败项。',
      `视觉状态：${args.visionStatus} / ${args.visionSummaryDetail}`,
      `回复状态：${args.replyStatus} / ${args.replySummaryDetail}`
    ].join('\n')
  }

  return [
    'SightFlow 失败项诊断（短版）',
    `导出时间：${formatDiagnosticTimestamp(new Date().toISOString())}`,
    '',
    ...blocks.flatMap((block, index) => (index === 0 ? [block] : ['', block]))
  ].join('\n')
}

interface ServiceHealthSnapshot {
  status: string
  detail: string
}

function diagnosticTimestampValue(value?: string): number {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function buildServiceHealthSnapshot(args: {
  connectionResult: ConnectionTestResult | null
  modelListResult: ModelListResult | null
  source: ModelCandidateSourceState
  sourceLabel?: string
  connectionDetail?: string
  modelListDetail?: string
  candidateCount: number
}): ServiceHealthSnapshot {
  const { connectionResult, modelListResult, source, sourceLabel, connectionDetail, modelListDetail, candidateCount } = args
  const connectionAt = diagnosticTimestampValue(connectionResult?.checkedAt)
  const modelListAt = diagnosticTimestampValue(modelListResult?.checkedAt)

  if (connectionAt >= modelListAt && connectionResult) {
    if (connectionResult.success) {
      return {
        status: '连接成功',
        detail: connectionDetail || '最近一次连接测试已通过'
      }
    }
    return {
      status: `连接失败${getDiagnosticCategoryLabel(connectionResult.errorCategory) ? ` · ${getDiagnosticCategoryLabel(connectionResult.errorCategory)}` : ''}`,
      detail: connectionResult.error || '连接测试失败'
    }
  }

  if (modelListResult) {
    if (modelListResult.success) {
      return {
        status: '已拉取模型列表',
        detail: modelListDetail || '最近一次模型列表拉取成功'
      }
    }
    return {
      status: `列表失败${getDiagnosticCategoryLabel(modelListResult.errorCategory) ? ` · ${getDiagnosticCategoryLabel(modelListResult.errorCategory)}` : ''}`,
      detail: modelListResult.error || '模型列表拉取失败'
    }
  }

  if (source.source === 'cache') {
    return {
      status: '已恢复缓存',
      detail: sourceLabel || '已从本地缓存恢复模型列表'
    }
  }

  if (source.source === 'live') {
    return {
      status: '已拉取模型列表',
      detail: sourceLabel || '当前模型列表来自最近一次实时拉取'
    }
  }

  return {
    status: '待测试',
    detail: candidateCount ? `当前候选模型 ${candidateCount} 个` : '还没有可用模型列表'
  }
}

function buildDiagnosticCopyText(
  title: string,
  result: RequestDiagnosticResult | null,
  detail?: string
): string {
  if (!result) return `${title}\n状态：未执行`

  const lines = [
    title,
    `状态：${getDiagnosticStateLabel(result)}`,
    `分类：${getDiagnosticCategoryLabel(result.errorCategory) || '未分类'}`,
    `时间：${formatDiagnosticTimestamp(result.checkedAt)}`,
    `HTTP：${typeof result.status === 'number' ? result.status : '未记录'}`,
    `耗时：${formatLatency(result.latencyMs)}`,
    `URL：${result.url || '未记录'}`,
    `归一化 Base URL：${result.normalizedBaseURL || '未记录'}`
  ]

  if (detail) {
    lines.push(`详情：${detail}`)
  } else if (result.error) {
    lines.push(`详情：${result.error}`)
  }

  return lines.join('\n')
}

const MODEL_CANDIDATE_CACHE_KEY = 'sightflow-model-candidate-cache-v1'
const DIAGNOSTIC_SUCCESS_CACHE_KEY = 'sightflow-diagnostic-success-cache-v1'

type ModelCacheScope = 'vision' | 'reply'

interface CachedModelCandidateEntry {
  baseURL: string
  normalizedBaseURL: string
  checkedAt: string
  models: string[]
}

interface ModelCandidateCacheState {
  vision?: CachedModelCandidateEntry
  reply?: CachedModelCandidateEntry
}

interface ModelCandidateSourceState {
  source: 'none' | 'cache' | 'live'
  checkedAt?: string
}

interface CachedDiagnosticSuccessEntry {
  connection?: ConnectionTestResult
  modelList?: ModelListResult
}

interface DiagnosticSuccessCacheState {
  vision?: CachedDiagnosticSuccessEntry
  reply?: CachedDiagnosticSuccessEntry
}

type DiagnosticsPreviewMode = 'success' | 'failure' | null

function readModelCandidateCache(): ModelCandidateCacheState {
  try {
    const raw = window.localStorage.getItem(MODEL_CANDIDATE_CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as ModelCandidateCacheState
  } catch {
    return {}
  }
}

function writeModelCandidateCache(scope: ModelCacheScope, entry: CachedModelCandidateEntry): void {
  const current = readModelCandidateCache()
  window.localStorage.setItem(
    MODEL_CANDIDATE_CACHE_KEY,
    JSON.stringify({
      ...current,
      [scope]: entry
    })
  )
}

function buildModelListResultFromCache(entry: CachedModelCandidateEntry): ModelListResult {
  return {
    success: true,
    checkedAt: entry.checkedAt,
    normalizedBaseURL: entry.normalizedBaseURL,
    url: buildModelsUrlPreview(entry.baseURL),
    models: entry.models.map((id) => ({ id }))
  }
}

function clearModelCandidateCache(scope: ModelCacheScope): void {
  const current = readModelCandidateCache()
  const next = { ...current }
  delete next[scope]
  window.localStorage.setItem(MODEL_CANDIDATE_CACHE_KEY, JSON.stringify(next))
}

function readDiagnosticSuccessCache(): DiagnosticSuccessCacheState {
  try {
    const raw = window.localStorage.getItem(DIAGNOSTIC_SUCCESS_CACHE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as DiagnosticSuccessCacheState
  } catch {
    return {}
  }
}

function writeDiagnosticSuccessCache(
  scope: ModelCacheScope,
  patch: Partial<CachedDiagnosticSuccessEntry>
): void {
  const current = readDiagnosticSuccessCache()
  window.localStorage.setItem(
    DIAGNOSTIC_SUCCESS_CACHE_KEY,
    JSON.stringify({
      ...current,
      [scope]: {
        ...(current[scope] || {}),
        ...patch
      }
    })
  )
}

function clearDiagnosticSuccessCache(scope?: ModelCacheScope): void {
  if (!scope) {
    window.localStorage.removeItem(DIAGNOSTIC_SUCCESS_CACHE_KEY)
    return
  }
  const current = readDiagnosticSuccessCache()
  const next = { ...current }
  delete next[scope]
  window.localStorage.setItem(DIAGNOSTIC_SUCCESS_CACHE_KEY, JSON.stringify(next))
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

function resolveCaptureStrategy(settings: AppSettings | undefined): CaptureStrategy {
  const appType = settings?.appType || 'wechat'
  const perAppStrategy = settings?.capture?.[appType]?.strategy || 'auto'
  const configured = perAppStrategy === 'auto' ? settings?.defaultCaptureStrategy || 'auto' : perAppStrategy
  if (configured === 'auto') return isVlmSupported(appType) ? 'vlm' : 'box-select'
  return configured
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

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea'

interface ProviderConfigField {
  key: string
  label: string
  type: ProviderConfigFieldType
  required?: boolean
  readonly?: boolean
  placeholder?: string
  hint?: string
  defaultValue?: string
  options?: Array<{ label: string; value: string }>
}

interface ProviderCatalogItem {
  id: string
  name: string
  description?: string
  version: string
  manifestUrl: string
  capabilities?: string[]
  configSchema: {
    fields: ProviderConfigField[]
  }
}

interface ProviderHubCache {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

interface ProviderHubResult {
  success: boolean
  error?: string
  catalog?: ProviderHubCache | null
}

interface ModelListItem {
  id: string
  owned_by?: string
  created?: number
}

type DiagnosticErrorCategory =
  | 'auth'
  | 'permission'
  | 'base_url'
  | 'model'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

interface RequestDiagnosticResult {
  success: boolean
  error?: string
  errorCategory?: DiagnosticErrorCategory
  url?: string
  status?: number
  latencyMs?: number
  checkedAt?: string
  normalizedBaseURL?: string
}

interface ConnectionTestResult extends RequestDiagnosticResult {
  model?: string
  responsePreview?: string
}

interface ModelListResult extends RequestDiagnosticResult {
  models?: ModelListItem[]
}

interface MetricSummaryItem {
  label: string
  count: number
  latestMs: number
  avgMs: number
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
    config: Record<string, string>
  }
  defaultCaptureStrategy: CaptureStrategy
  reply: {
    mode: ReplyMode
    typingCpm: number
  }
  automation: {
    executionMode: AutomationExecutionMode
    maxReplyChars: number
    globalRateLimitPerMinute: number
    perChatRateLimitPerMinute: number
    groupReplyMode: GroupReplyMode
    groupTriggerKeywords?: string[]
    groupWhitelist?: string[]
  }
  capture: Partial<Record<AppType, PerAppCapture>>
}

interface SettingsInspectorSummary {
  visionStatus: string
  visionDetail: string
  visionRecentSuccess?: string
  replyStatus: string
  replyDetail: string
  replyRecentSuccess?: string
  preflightStatus?: string
  preflightDetail?: string
  refreshPreflight?: () => void
  exportText: string
  exportFailedText: string
  resetDiagnostics?: () => void
}

interface SettingsMeta {
  replyModelUsesVisionFallback?: boolean
  replyModelMatchesVisionConfig?: boolean
}

interface EnginePreflightResult {
  ready: boolean
  startupStrategy: CaptureStrategy
  providerMode: string
  replyConfigState: 'inherited' | 'synced' | 'custom'
  summary: string
  blocks: Array<{ code: string; message: string }>
}

const DEFAULT_OPENAI_COMPAT_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

function sortModelCandidates(models: string[]): string[] {
  const unique = Array.from(new Set(models.filter(Boolean)))
  return unique.sort((left, right) => {
    const leftRank = getModelRank(left)
    const rightRank = getModelRank(right)
    if (leftRank.group !== rightRank.group) return leftRank.group - rightRank.group
    if (leftRank.versionScore !== rightRank.versionScore) {
      return rightRank.versionScore - leftRank.versionScore
    }
    const leftVariant = variantRank(left)
    const rightVariant = variantRank(right)
    if (leftVariant !== rightVariant) return leftVariant - rightVariant
    return left.localeCompare(right, 'zh-Hans-CN', { sensitivity: 'base' })
  })
}

function isVisionLikeModel(model: string): boolean {
  return /(vision|image|vlm|vl-|gpt-4\.(1|5)|gpt-5.*vision|gpt-4o|gemini-1\.5|claude-3|doubao-vision)/i.test(model)
}

function getModelRank(model: string): { group: number; versionScore: number; familyScore: number } {
  const normalized = model.trim()
  if (/^(gpt-|claude-|gemini-|kimi-|MiniMax-|mimo-|doubao-)/i.test(normalized)) {
    const group = groupRank(normalized)
    const versionScore = extractVersionScore(normalized)
    const familyScore = familyRank(normalized)
    return { group, versionScore, familyScore }
  }
  if (/^(image-|vision-|vl-|vlm-)/i.test(normalized)) {
    return { group: 3, versionScore: extractVersionScore(normalized), familyScore: 0 }
  }
  return { group: 99, versionScore: 0, familyScore: 0 }
}

function groupRank(model: string): number {
  if (/^gpt-/i.test(model)) return 0
  if (/^claude-/i.test(model)) return 1
  if (/^gemini-/i.test(model)) return 2
  if (/^kimi-/i.test(model)) return 3
  if (/^MiniMax-/i.test(model)) return 4
  if (/^mimo-/i.test(model)) return 5
  if (/^doubao-/i.test(model)) return 6
  return 7
}

function familyRank(model: string): number {
  if (/^gpt-/i.test(model)) return 0
  if (/^claude-/i.test(model)) return 0
  if (/^gemini-/i.test(model)) return 0
  if (/^kimi-/i.test(model)) return 0
  if (/^MiniMax-/i.test(model)) return 0
  if (/^mimo-/i.test(model)) return 0
  if (/^doubao-/i.test(model)) return 0
  return 0
}

function variantRank(model: string): number {
  if (/preview/i.test(model)) return 3
  if (/compact/i.test(model)) return 2
  if (/(codex|code|coder|dev)/i.test(model)) return 1
  return 0
}

function extractVersionScore(model: string): number {
  const firstMatch = model.match(/(\d+(?:\.\d+)*)/)
  if (!firstMatch) return 0
  const parts = firstMatch[1].split('.').map((part) => Number.parseInt(part, 10) || 0)
  return parts.reduce((score, part, index) => score + part / Math.pow(100, index), 0)
}

function parseMetricLog(content: string): { label: string; ms: number } | null {
  const match = content.match(/^性能指标：(.+?)\s+(\d+)ms$/)
  if (!match) return null
  return { label: match[1], ms: Number(match[2]) }
}

function isLogEntryType(type: string): type is LogEntry['type'] {
  return type === 'thinking' || type === 'reply' || type === 'skip' || type === 'error' || type === 'metric'
}

function summarizeMetrics(logs: LogEntry[]): MetricSummaryItem[] {
  const groups = new Map<string, { count: number; totalMs: number; latestMs: number }>()
  for (const log of logs) {
    if (log.type !== 'metric' && !parseMetricLog(log.content)) continue
    const metric = parseMetricLog(log.content)
    if (!metric) continue
    const current = groups.get(metric.label) || { count: 0, totalMs: 0, latestMs: 0 }
    current.count += 1
    current.totalMs += metric.ms
    current.latestMs = metric.ms
    groups.set(metric.label, current)
  }
  return Array.from(groups.entries())
    .map(([label, data]) => ({
      label,
      count: data.count,
      latestMs: data.latestMs,
      avgMs: Math.round(data.totalMs / Math.max(1, data.count))
    }))
    .sort((left, right) => right.latestMs - left.latestMs)
    .slice(0, 6)
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${ms}ms`
}

function isGroupLog(entry: LogEntry): boolean {
  return /自动化群聊决策|chatType=group|group_/.test(entry.content)
}

function isGroupMentionLog(entry: LogEntry): boolean {
  return /mentioned=true|group_not_mentioned|@触发|@所有人|@我|@你/.test(entry.content)
}

function isGroupWhitelistLog(entry: LogEntry): boolean {
  return /whitelisted=true|group_not_whitelisted|白名单/.test(entry.content)
}

function isRelevanceLog(entry: LogEntry): boolean {
  return /自动化回复相关性|自动化回复依据/.test(entry.content)
}

const BUILTIN_PROVIDER_CATALOG: ProviderCatalogItem[] = [
  {
    id: 'doubao',
    name: '豆包 Seed',
    description: '本地内置聊天 Provider，使用回复模型配置中的 API Key、模型和 Base URL。',
    version: '1.0.0',
    manifestUrl: 'builtin://doubao',
    capabilities: ['chat'],
    configSchema: {
      fields: [
        {
          key: 'systemPrompt',
          label: '系统提示词',
          type: 'textarea',
          placeholder: '你是一个微信自动回复助手。根据截图中的聊天内容，生成合适的回复...'
        }
      ]
    }
  }
]

const RefreshIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 0 1-15.1 6.6" />
    <path d="M3 12A9 9 0 0 1 18.1 5.4" />
    <path d="M18 2v4h-4" />
    <path d="M6 22v-4h4" />
  </svg>
)

function ServiceDiagnosticCard({
  title,
  result,
  emptyText,
  successDetail,
  failureDetail,
  categoryLabel,
  nextStep,
  recentSuccessMeta,
  actions,
  onCopy
}: {
  title: string
  result: RequestDiagnosticResult | null
  emptyText: string
  successDetail?: string
  failureDetail?: string
  categoryLabel?: string | null
  nextStep?: string
  recentSuccessMeta?: string
  actions?: Array<{ label: string; onClick: () => void }>
  onCopy?: () => void
}): React.JSX.Element {
  const stateLabel = getDiagnosticStateLabel(result)
  const stateTone = !result ? 'idle' : result.success ? 'success' : 'error'

  return (
    <section className={`service-diagnostic service-diagnostic--${stateTone}`}>
      <div className="service-diagnostic__header">
        <div className="service-diagnostic__title">{title}</div>
        <div className="service-diagnostic__actions">
          {result && onCopy ? (
            <button type="button" className="service-diagnostic__copy-btn" onClick={onCopy}>
              复制
            </button>
          ) : null}
          <span className={`service-diagnostic__badge service-diagnostic__badge--${stateTone}`}>{stateLabel}</span>
        </div>
      </div>

      {!result ? (
        <div className="service-diagnostic__empty">{emptyText}</div>
      ) : (
        <>
          {categoryLabel ? <div className="service-diagnostic__classification">判定：{categoryLabel}</div> : null}
          <dl className="service-diagnostic__meta">
            <div>
              <dt>时间</dt>
              <dd>{formatDiagnosticTimestamp(result.checkedAt)}</dd>
            </div>
            <div>
              <dt>HTTP</dt>
              <dd>{typeof result.status === 'number' ? result.status : '未记录'}</dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{formatLatency(result.latencyMs)}</dd>
            </div>
          </dl>

          {result.url ? (
            <div className="service-diagnostic__path">
              <div className="service-diagnostic__path-label">请求 URL</div>
              <code className="service-diagnostic__url">{result.url}</code>
            </div>
          ) : null}
          {result.normalizedBaseURL ? (
            <div className="service-diagnostic__path">
              <div className="service-diagnostic__path-label">兼容根路径</div>
              <code className="service-diagnostic__url">{result.normalizedBaseURL}</code>
            </div>
          ) : null}

          {result.success && successDetail ? (
            <div className="service-diagnostic__message service-diagnostic__message--success">{successDetail}</div>
          ) : null}
          {!result.success && failureDetail ? (
            <div className="service-diagnostic__message service-diagnostic__message--error">{failureDetail}</div>
          ) : null}
          {!result?.success && nextStep ? <div className="service-diagnostic__next-step">建议：{nextStep}</div> : null}
          {!result?.success && actions?.length ? (
            <div className="service-diagnostic__action-list">
              {actions.map((action) => (
                <button key={action.label} type="button" className="service-diagnostic__action-chip" onClick={action.onClick}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          {recentSuccessMeta ? <div className="service-diagnostic__recent-success">{recentSuccessMeta}</div> : null}
        </>
      )}
    </section>
  )
}

function App(): React.JSX.Element {
  const isSettingsWindow = new URLSearchParams(window.location.search).get('window') === 'settings'
  const { status: onboardingStatus, reload: reloadOnboarding } = useOnboardingStatus()
  const [view, setView] = useState<'workbench' | 'console'>('workbench')
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [theme, setTheme] = useState<WorkbenchTheme>(() => {
    const stored = window.localStorage.getItem('sightflow-theme')
    return stored === 'light' || stored === 'dark' ? stored : 'dark'
  })

  // Sync UI status with engine state changes triggered out-of-band
  // (e.g. remote OpenClaw start/pause via the local skill HTTP server).
  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (data: { status: 'running' | 'idle' }) => {
      setStatus(data.status === 'running' ? 'running' : 'idle')
    })
    return cleanup
  }, [])

  useEffect(() => {
    window.localStorage.setItem('sightflow-theme', theme)
  }, [theme])

  // When the user clicks the re-init button in the Console overview,
  // the main process resets onboarding state and we reload the hook so
  // the wizard reappears immediately.
  useEffect(() => {
    const handler = () => { void reloadOnboarding() }
    window.addEventListener("sightflow:onboarding:reset", handler)
    return () => window.removeEventListener("sightflow:onboarding:reset", handler)
  }, [reloadOnboarding])

  if (onboardingStatus && !onboardingStatus.completed) {
    return (
      <div className={`app onboarding-window theme-${theme}`}>
        <OnboardingWizard onComplete={() => { void reloadOnboarding() }} />
      </div>
    )
  }

  if (isSettingsWindow) {
    return (
      <div className={`app settings-window theme-${theme}`}>
        <SettingsWindow theme={theme} onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))} />
        <Toast />
      </div>
    )
  }

  return (
    <>
      <nav className="view-tabs" aria-label="view switcher">
        <button
          type="button"
          className={'view-tabs__tab' + (view === 'workbench' ? ' view-tabs__tab--active' : '')}
          onClick={() => setView('workbench')}
        >
          workbench
        </button>
        <button
          type="button"
          className={'view-tabs__tab' + (view === 'console' ? ' view-tabs__tab--active' : '')}
          onClick={() => setView('console')}
        >
          console
        </button>
      </nav>
      {view === 'console' ? (
        <div className={'app console-window theme-' + theme}>
          <Console />
        </div>
      ) : (
        <>
          <ControlPanel
            status={status}
            setStatus={setStatus}
            theme={theme}
            onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          />
          <Toast />
        </>
      )}
    </>
  )
}

function ControlPanel({
  status,
  setStatus,
  theme,
  onToggleTheme
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
  theme: WorkbenchTheme
  onToggleTheme: () => void
}): React.JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [groupDebugOnly, setGroupDebugOnly] = useState(false)
  const [selectedLogFilter, setSelectedLogFilter] = useState<LogFilter>('all')
  const [appType, setAppType] = useState<AppType>('wechat')
  const [regions, setRegions] = useState<BoxRegions | null>(null)

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
      if (status === 'running') return
      setAppType(next)
      await window.electron?.invoke('settings:set', { appType: next })
      await window.electron?.invoke('engine:updateConfig', {
        ...((await window.electron?.invoke('settings:getAll')) as AppSettings),
        appType: next
      })
      await reloadRegionsForApp(next)
    },
    [reloadRegionsForApp, status]
  )

  const addLog = useCallback((type: LogEntry['type'], content: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  const metricSummary = useMemo(() => summarizeMetrics(logs), [logs])
  const visibleLogs = useMemo(() => {
    const activeFilter = groupDebugOnly ? 'group' : selectedLogFilter
    if (activeFilter === 'all') return logs
    if (activeFilter === 'metric') return logs.filter((entry) => entry.type === 'metric' || parseMetricLog(entry.content))
    if (activeFilter === 'group') return logs.filter((entry) => isGroupLog(entry))
    if (activeFilter === 'groupMention') return logs.filter((entry) => isGroupMentionLog(entry))
    if (activeFilter === 'groupWhitelist') return logs.filter((entry) => isGroupWhitelistLog(entry))
    if (activeFilter === 'relevance') return logs.filter((entry) => isRelevanceLog(entry))
    return logs.filter((entry) => entry.type === activeFilter && !parseMetricLog(entry.content))
  }, [groupDebugOnly, selectedLogFilter, logs])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (data: { type: string; content: string }) => {
      const type = isLogEntryType(data.type) ? data.type : 'skip'
      addLog(type, data.content)

      if (type === 'error' && data.content.includes('引擎无法启动')) {
        setStatus('error')
      }
    })
    return cleanup
  }, [addLog, setStatus])

  const handleStart = useCallback(async () => {
    const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
    if (resolveCaptureStrategy(settings) === 'vlm' && !settings?.vision?.apiKey) {
      showToast(t('control.start.novisionkey'), 'error')
      return
    }
    if (!settings?.chatProvider?.installed && !settings?.replyModel?.apiKey) {
      showToast(t('control.start.noreplykey'), 'error')
      return
    }
    const providerInfo = (await window.electron?.invoke('provider:getInstalled')) as {
      manifest: ProviderManifest | null
      isBuiltinDefault?: boolean
    }
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

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  const isVlm = isVlmSupported(appType)
  const captureReady = isVlm || regions !== null
  const workbenchState = useMemo<WorkbenchState>(() => {
    if (!captureReady) return 'confirm'
    if (status === 'error') return 'error'
    if (status === 'running') return 'executing'
    const latestLog = logs[logs.length - 1]
    if (!latestLog) return 'idle'
    if (latestLog.type === 'reply') return 'success'
    if (latestLog.type === 'thinking') return 'processing'
    if (latestLog.type === 'error') return 'error'
    if (latestLog.type === 'skip') return 'review'
    return 'idle'
  }, [captureReady, logs, status])
  const workbenchTimeline = useMemo<TimelineStep[]>(
    () => [
      {
        id: 'target',
        label: '目标应用准备',
        status: captureReady ? 'done' : 'current',
        meta: isVlm ? 'VLM 自动识别' : regions ? '框选区域已完成' : '等待框选'
      },
      {
        id: 'observe',
        label: '消息观察',
        status: logs.some((entry) => /自动化消息：/.test(entry.content)) ? 'done' : status === 'running' ? 'current' : 'pending',
        meta: appType === 'wechat' || appType === 'wework' ? '结构化消息 + 本地规则补强' : '桌面应用通用感知'
      },
      {
        id: 'decide',
        label: '策略与确认',
        status: logs.some((entry) => /自动化决策：/.test(entry.content)) ? 'done' : status === 'running' ? 'current' : 'pending',
        meta: 'Task-first / State-driven'
      },
      {
        id: 'execute',
        label: '执行与回看',
        status: status === 'running' ? 'current' : logs.some((entry) => entry.type === 'reply') ? 'done' : 'pending',
        meta: '发送 / 草稿 / dry-run'
      }
    ],
    [appType, captureReady, isVlm, logs, regions, status]
  )
  const inspectorContext = useMemo(
    () => [
      { label: '目标应用', value: APP_TYPE_LABELS[appType] },
      { label: '采集模式', value: isVlm ? 'VLM 自动识别' : regions ? 'Box Select 已完成' : 'Box Select 待配置' },
      { label: '任务入口', value: status === 'running' ? '执行中' : '等待启动' },
      { label: '主题', value: theme === 'dark' ? '暗色' : '亮色' },
      { label: '运行状态', value: statusLabel }
    ],
    [appType, isVlm, regions, status, statusLabel, theme]
  )
  const inspectorDebug = useMemo(
    () => [
      { label: '当前模式', value: groupDebugOnly ? '群聊调试' : '标准执行' },
      { label: '当前筛选', value: groupDebugOnly ? '群聊链路' : selectedLogFilter },
      { label: '日志条数', value: String(logs.length) },
      { label: '最近指标', value: metricSummary[0] ? `${metricSummary[0].label} ${formatMs(metricSummary[0].latestMs)}` : '暂无' },
      { label: '准备状态', value: captureReady ? 'Ready' : 'Pending' }
    ],
    [captureReady, groupDebugOnly, selectedLogFilter, logs.length, metricSummary]
  )
  const inspectorActions = useMemo(
    () => [
      {
        id: 'inspector-start',
        label: status === 'running' ? t('control.stop') : t('control.start'),
        tone: status === 'running' ? ('danger' as const) : ('accent' as const),
        onClick: () => {
          if (status === 'running') {
            void handleStop()
          } else {
            void handleStart()
          }
        }
      },
      {
        id: 'inspector-settings',
        label: '设置',
        tone: 'neutral' as const,
        onClick: () => void window.electron?.invoke('settings:open')
      },
      {
        id: 'inspector-group',
        label: groupDebugOnly ? '退出群聊调试' : '群聊调试',
        tone: 'neutral' as const,
        onClick: () => setGroupDebugOnly((prev) => !prev)
      }
    ],
    [groupDebugOnly, handleStart, handleStop, status]
  )
  const inspectorLogs = useMemo(
    () => visibleLogs.slice(-12),
    [visibleLogs]
  )
  const headerMeta = useMemo(
    () => `${APP_TYPE_LABELS[appType]} · ${isVlm ? 'VLM Auto' : 'Box Select'} · ${statusLabel}`,
    [appType, isVlm, statusLabel]
  )
  const statusStripLeft = useMemo(
    () => `${APP_TYPE_LABELS[appType]} / ${captureReady ? 'Ready' : 'Pending'}`,
    [appType, captureReady]
  )
  const statusStripRight = useMemo(
    () => `Logs ${logs.length} / ${groupDebugOnly ? 'Group Debug' : selectedLogFilter}`,
    [groupDebugOnly, logs.length, selectedLogFilter]
  )
  const appChoices = useMemo(
    () =>
      (Object.keys(APP_TYPE_LABELS) as AppType[]).map((type) => ({
        id: `app-${type}`,
        label: APP_TYPE_LABELS[type],
        meta: isVlmSupported(type) ? 'VLM' : 'Box Select',
        active: appType === type,
        onClick: () => void handleAppTypeChange(type)
      })),
    [appType, handleAppTypeChange]
  )
  const leftCategories = useMemo(
    () => [
      {
        id: 'cat-auto',
        label: '自动回复',
        active: !groupDebugOnly,
        onClick: () => {
          setSelectedLogFilter('all')
          setGroupDebugOnly(false)
        }
      },
      {
        id: 'cat-group',
        label: '群聊策略',
        active: groupDebugOnly,
        onClick: () => {
          setSelectedLogFilter('group')
          setGroupDebugOnly(true)
        }
      },
      {
        id: 'cat-diagnostics',
        label: '模型诊断',
        active: selectedLogFilter === 'relevance' || selectedLogFilter === 'metric',
        onClick: () => {
          setSelectedLogFilter('relevance')
          setGroupDebugOnly(false)
        }
      }
    ],
    [groupDebugOnly, selectedLogFilter]
  )
  const taskCards = useMemo<TaskCardItem[]>(() => {
    const currentLogs = inspectorLogs.slice(-3)
    const latestReply = [...logs].reverse().find((entry) => entry.type === 'reply')
    const latestError = [...logs].reverse().find((entry) => entry.type === 'error')
    const latestSkip = [...logs].reverse().find((entry) => entry.type === 'skip')

    if (!captureReady) {
      return [
        {
          id: 'task-confirm-setup',
          kind: 'confirm',
          title: '等待确认采集准备',
          body: isVlm
            ? `${APP_TYPE_LABELS[appType]} 依赖视觉模型完成布局与消息观察，请先检查模型配置。`
            : `${APP_TYPE_LABELS[appType]} 还未完成桌面采集准备，请先进入设置并完成框选。`,
          accent: 'Confirm',
          actions: [
            {
              id: 'open-settings',
              label: '打开设置',
              primary: true,
              onClick: () => void window.electron?.invoke('settings:open')
            }
          ]
        }
      ]
    }

    if (status === 'running') {
      return [
        {
          id: 'task-runtime',
          kind: 'task',
          title: '执行链路推进中',
          body: `当前主区围绕 ${APP_TYPE_LABELS[appType]} 的任务执行展开，右侧 Inspector 会持续更新状态与调试线索。`,
          accent: 'Executing'
        },
        {
          id: 'task-runtime-actions',
          kind: 'confirm',
          title: '当前可执行动作',
          body: '如果需要立即中止、切回设置或进入群聊调试，可以直接在这里处理。',
          actions: [
            {
              id: 'stop-run',
              label: t('control.stop'),
              primary: true,
              onClick: () => void handleStop()
            },
            {
              id: 'open-settings',
              label: '设置',
              onClick: () => void window.electron?.invoke('settings:open')
            }
          ]
        }
      ]
    }

    if (workbenchState === 'error') {
      return [
        {
          id: 'task-error',
          kind: 'result',
          title: '执行失败',
          body: latestError?.content || '执行链出现异常，请优先查看右侧状态与调试信息。',
          accent: 'Error',
          actions: [
            {
              id: 'restart-run',
              label: t('control.start'),
              primary: true,
              onClick: () => void handleStart()
            },
            {
              id: 'group-debug',
              label: '群聊调试',
              onClick: () => setGroupDebugOnly(true)
            }
          ]
        }
      ]
    }

    if (workbenchState === 'success') {
      return [
        {
          id: 'task-success',
          kind: 'result',
          title: '结果已生成',
          body: latestReply?.content || '已有回复结果，可继续回看上下文或处理下一条任务。',
          accent: 'Success',
          actions: [
            {
              id: 'filter-reply',
              label: '查看回复日志',
              primary: true,
              onClick: () => {
                setSelectedLogFilter('reply')
                setGroupDebugOnly(false)
              }
            },
            {
              id: 'start-next',
              label: t('control.start'),
              onClick: () => void handleStart()
            }
          ]
        }
      ]
    }

    if (workbenchState === 'review') {
      return [
        {
          id: 'task-review',
          kind: 'result',
          title: '进入回看状态',
          body: latestSkip?.content || '当前没有直接回复，系统保留了策略与跳过线索供回看。',
          accent: 'Review',
          actions: [
            {
              id: 'filter-skip',
              label: '查看跳过日志',
              primary: true,
              onClick: () => {
                setSelectedLogFilter('skip')
                setGroupDebugOnly(false)
              }
            },
            {
              id: 'enable-group-debug',
              label: '群聊调试',
              onClick: () => setGroupDebugOnly(true)
            }
          ]
        }
      ]
    }

    if (workbenchState === 'processing') {
      return [
        {
          id: 'task-processing',
          kind: 'task',
          title: '正在分析任务上下文',
          body: currentLogs.map((entry) => `${entry.type.toUpperCase()} · ${entry.content}`).join(' / ') || '系统正在分析最新任务线索。',
          accent: 'Processing'
        }
      ]
    }

    return [
      {
        id: 'task-idle',
        kind: 'empty',
        title: '等待任务开始',
        body: '请从左侧导航选择任务入口，或者点击底部操作启动执行流。'
      },
      {
        id: 'task-idle-context',
        kind: currentLogs.length > 0 ? 'result' : 'confirm',
        title: currentLogs.length > 0 ? '最近状态' : '准备信息',
        body:
          currentLogs.map((entry) => `${entry.type.toUpperCase()} · ${entry.content}`).join(' / ') ||
          '采集准备已完成，等待启动。',
        actions: currentLogs.length > 0
          ? [
              {
                id: 'inspect-latest',
                label: '查看最新日志',
                primary: true,
                onClick: () => {
                  setSelectedLogFilter('all')
                  setGroupDebugOnly(false)
                }
              }
            ]
          : undefined
      }
    ]
  }, [appType, captureReady, handleStart, handleStop, inspectorLogs, isVlm, logs, status, workbenchState])
  const quickActions = useMemo(
    () => [
      {
        id: 'qa-theme',
        label: theme === 'dark' ? '切亮色' : '切暗色',
        tone: 'neutral' as const,
        onClick: onToggleTheme
      },
      {
        id: 'qa-log',
        label: groupDebugOnly ? '退出群聊调试' : '群聊调试',
        tone: 'accent' as const,
        onClick: () => setGroupDebugOnly((prev) => !prev)
      },
      {
        id: 'qa-run',
        label: status === 'running' ? t('control.stop') : t('control.start'),
        tone: status === 'running' ? ('danger' as const) : ('accent' as const),
        onClick: () => {
          if (status === 'running') {
            void handleStop()
          } else {
            void handleStart()
          }
        }
      },
      {
        id: 'qa-settings',
        label: '打开设置',
        tone: 'neutral' as const,
        onClick: () => void window.electron?.invoke('settings:open')
      },
      {
        id: 'qa-target',
        label: APP_TYPE_LABELS[appType],
        tone: captureReady ? ('neutral' as const) : ('danger' as const),
        onClick: () => {
          setSelectedLogFilter('group')
          setGroupDebugOnly(true)
        }
      }
    ],
    [appType, captureReady, groupDebugOnly, handleStart, handleStop, onToggleTheme, status, theme]
  )
  const leftPrimary = useMemo(
    () => [
      {
        id: 'nav-workflow',
        label: '任务工作流',
        meta: workbenchState,
        active: selectedLogFilter === 'all' && !groupDebugOnly,
        onClick: () => {
          setSelectedLogFilter('all')
          setGroupDebugOnly(false)
        }
      },
      {
        id: 'nav-observe',
        label: '消息观察',
        meta: logs.some((entry) => /自动化消息：/.test(entry.content)) ? '结构化观察已到达' : '等待观察结果',
        active: selectedLogFilter === 'thinking',
        onClick: () => {
          setSelectedLogFilter('thinking')
          setGroupDebugOnly(false)
        }
      },
      {
        id: 'nav-policy',
        label: '策略决策',
        meta: groupDebugOnly ? '群聊调试链路' : '策略 / 白名单 / 相关性',
        active: groupDebugOnly || selectedLogFilter === 'skip',
        onClick: () => {
          setSelectedLogFilter('skip')
          setGroupDebugOnly(true)
        }
      },
      {
        id: 'nav-result',
        label: '执行结果',
        meta: logs.some((entry) => entry.type === 'reply') ? '已有结果' : '等待结果',
        active: selectedLogFilter === 'reply',
        onClick: () => {
          setSelectedLogFilter('reply')
          setGroupDebugOnly(false)
        }
      }
    ],
    [groupDebugOnly, logs, selectedLogFilter, workbenchState]
  )
  const leftHistory = useMemo(
    () =>
      logs
        .slice(-6)
        .reverse()
        .map((entry, index) => ({
          id: `${entry.time}-${index}`,
          label: entry.content.slice(0, 20) || '日志',
          meta: `${entry.type.toUpperCase()} · ${entry.time}`,
          onClick: () => {
            setSelectedLogFilter(entry.type)
            setGroupDebugOnly(false)
          }
        })),
    [logs]
  )

  return (
    <Workbench
      theme={theme}
      onToggleTheme={onToggleTheme}
      state={workbenchState}
      statusText={statusLabel}
      brandIconUrl={logoUrl}
      headerMeta={headerMeta}
      appChoices={appChoices}
      leftCategories={leftCategories}
      leftPrimary={leftPrimary}
      leftHistory={leftHistory}
      quickActions={quickActions}
      timeline={workbenchTimeline}
      taskCards={taskCards}
      logs={visibleLogs}
      inspectorContext={inspectorContext}
      inspectorDebug={inspectorDebug}
      inspectorActions={inspectorActions}
      statusStripLeft={statusStripLeft}
      statusStripRight={statusStripRight}
    />
  )
}

function SettingsWindow({
  theme,
  onToggleTheme
}: {
  theme: WorkbenchTheme
  onToggleTheme: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('base')
  const [inspectorSummary, setInspectorSummary] = useState<SettingsInspectorSummary | null>(null)

  const handleExportInspectorSummary = useCallback(async () => {
    if (!inspectorSummary?.exportText) return
    try {
      await copyToClipboard(inspectorSummary.exportText)
      showToast('完整模型诊断已复制', 'success')
    } catch (error: unknown) {
      showToast(`复制失败: ${getErrorMessage(error)}`, 'error')
    }
  }, [inspectorSummary])

  const handleExportInspectorFailures = useCallback(async () => {
    if (!inspectorSummary?.exportFailedText) return
    try {
      await copyToClipboard(inspectorSummary.exportFailedText)
      showToast('失败项诊断已复制', 'success')
    } catch (error: unknown) {
      showToast(`复制失败: ${getErrorMessage(error)}`, 'error')
    }
  }, [inspectorSummary])

  const handleResetInspectorSummary = useCallback(() => {
    inspectorSummary?.resetDiagnostics?.()
  }, [inspectorSummary])

  const handleRefreshInspectorPreflight = useCallback(() => {
    inspectorSummary?.refreshPreflight?.()
  }, [inspectorSummary])

  return (
    <PageShell theme={theme} state="review">
      <WorkspaceHeader
        theme={theme}
        onToggleTheme={onToggleTheme}
        state="review"
        statusText="设置工作台"
        brandIconUrl={logoUrl}
        headerMeta={section === 'base' ? '基础配置 / 双主题 / 自动化安全' : '智能体 / Provider / 模型接入'}
      />
      <WorkspaceLayout
        left={
          <aside className="settings-rail">
            <div className="settings-rail__title">设置导航</div>
            <button
              className={`settings-nav-item ${section === 'base' ? 'active' : ''}`}
              onClick={() => setSection('base')}
            >
              基础配置
            </button>
            <button
              className={`settings-nav-item ${section === 'agent' ? 'active' : ''}`}
              onClick={() => setSection('agent')}
            >
              智能体
            </button>
          </aside>
        }
        center={
          <main className="settings-main">
            {section === 'base' ? <SettingsPanel onInspectorSummaryChange={setInspectorSummary} /> : <AgentPanel />}
          </main>
        }
        right={
          <aside className="settings-inspector">
            <div className="settings-inspector__card settings-inspector__card--context">
              <div className="settings-inspector__eyebrow">Workspace Context</div>
              <h2>{section === 'base' ? '基础配置' : '智能体配置'}</h2>
              <p>
                {section === 'base'
                  ? '这里负责主题、模型、自动化安全和桌面输入行为。'
                  : '这里负责聊天智能体、Provider 与模型集成配置。'}
              </p>
            </div>
            {section === 'base' && inspectorSummary ? (
              <div className="settings-inspector__card settings-inspector__card--health">
                <div className="settings-inspector__card-header">
                  <div className="settings-inspector__eyebrow">Service Health</div>
                  <div className="settings-inspector__action-group">
                    <button
                      type="button"
                      className="settings-inspector__action-btn"
                      onClick={() => void handleExportInspectorFailures()}
                    >
                      导出失败
                    </button>
                    <button
                      type="button"
                      className="settings-inspector__action-btn"
                      onClick={handleResetInspectorSummary}
                    >
                      重置诊断
                    </button>
                    <button
                      type="button"
                      className="settings-inspector__action-btn"
                      onClick={() => void handleExportInspectorSummary()}
                    >
                      导出诊断
                    </button>
                  </div>
                </div>
                <div className="settings-inspector__summary-list">
                  <div className="settings-inspector__summary-item">
                    <div className="settings-inspector__summary-title">视觉模型</div>
                    <div className="settings-inspector__summary-status">{inspectorSummary.visionStatus}</div>
                    <div className="settings-inspector__summary-detail">{inspectorSummary.visionDetail}</div>
                    {inspectorSummary.visionRecentSuccess ? (
                      <div className="settings-inspector__summary-meta">{inspectorSummary.visionRecentSuccess}</div>
                    ) : null}
                  </div>
                  <div className="settings-inspector__summary-item">
                    <div className="settings-inspector__summary-title">回复模型</div>
                    <div className="settings-inspector__summary-status">{inspectorSummary.replyStatus}</div>
                    <div className="settings-inspector__summary-detail">{inspectorSummary.replyDetail}</div>
                    {inspectorSummary.replyRecentSuccess ? (
                      <div className="settings-inspector__summary-meta">{inspectorSummary.replyRecentSuccess}</div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
            {section === 'base' && inspectorSummary?.preflightStatus ? (
              <div className="settings-inspector__card settings-inspector__card--preflight">
                <div className="settings-inspector__card-header">
                  <div className="settings-inspector__eyebrow">Startup Preflight</div>
                  <button
                    type="button"
                    className="settings-inspector__action-btn"
                    onClick={handleRefreshInspectorPreflight}
                  >
                    重新检查
                  </button>
                </div>
                <div className="settings-inspector__summary-status">{inspectorSummary.preflightStatus}</div>
                <div className="settings-inspector__summary-detail">{inspectorSummary.preflightDetail}</div>
              </div>
            ) : null}
            <div className="settings-inspector__card settings-inspector__card--guide">
              <div className="settings-inspector__eyebrow">Progressive Disclosure</div>
              <p>默认只看当前设置分组，次级信息由表单提示和右侧说明补充。</p>
            </div>
          </aside>
        }
      />
      <StatusStrip
        state="review"
        left="设置工作台 / 亮暗主题共享结构"
        right={section === 'base' ? 'Base Settings' : 'Agent Settings'}
      />
    </PageShell>
  )
}

function SettingsPanel({
  onInspectorSummaryChange
}: {
  onInspectorSummaryChange?: (summary: SettingsInspectorSummary) => void
}): React.JSX.Element {
  const diagnosticsPreviewMode = useMemo<DiagnosticsPreviewMode>(() => {
    const value = new URLSearchParams(window.location.search).get('debugDiagnostics')
    if (value === 'success' || value === 'failure') return value
    return null
  }, [])
  const [visionApiKey, setVisionApiKey] = useState('')
  const [showVisionApiKey, setShowVisionApiKey] = useState(false)
  const [visionModel, setVisionModel] = useState(DEFAULT_OPENAI_COMPAT_MODEL)
  const [visionBaseURL, setVisionBaseURL] = useState(DEFAULT_OPENAI_COMPAT_BASE_URL)
  const [testingVision, setTestingVision] = useState(false)
  const [replyApiKey, setReplyApiKey] = useState('')
  const [showReplyApiKey, setShowReplyApiKey] = useState(false)
  const [replyModel, setReplyModel] = useState(DEFAULT_OPENAI_COMPAT_MODEL)
  const [replyBaseURL, setReplyBaseURL] = useState(DEFAULT_OPENAI_COMPAT_BASE_URL)
  const [replyMode, setReplyMode] = useState<ReplyMode>('typing-with-paste-fallback')
  const [typingCpmInput, setTypingCpmInput] = useState('280')
  const [executionMode, setExecutionMode] = useState<AutomationExecutionMode>(
    DEFAULT_AUTOMATION_SETTINGS.executionMode
  )
  const [maxReplyCharsInput, setMaxReplyCharsInput] = useState(String(DEFAULT_AUTOMATION_SETTINGS.maxReplyChars))
  const [globalRateLimitInput, setGlobalRateLimitInput] = useState(
    String(DEFAULT_AUTOMATION_SETTINGS.globalRateLimitPerMinute)
  )
  const [perChatRateLimitInput, setPerChatRateLimitInput] = useState(
    String(DEFAULT_AUTOMATION_SETTINGS.perChatRateLimitPerMinute)
  )
  const [groupReplyMode, setGroupReplyMode] = useState<GroupReplyMode>(DEFAULT_AUTOMATION_SETTINGS.groupReplyMode)
  const [groupTriggerKeywordsInput, setGroupTriggerKeywordsInput] = useState('')
  const [groupWhitelistInput, setGroupWhitelistInput] = useState('')
  const [groupTriggerKeywordDraft, setGroupTriggerKeywordDraft] = useState('')
  const [groupWhitelistDraft, setGroupWhitelistDraft] = useState('')
  const [testing, setTesting] = useState(false)
  const [pullingModels, setPullingModels] = useState(false)
  const [modelCandidates, setModelCandidates] = useState<string[]>([])
  const [showVisionOnly, setShowVisionOnly] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [visionConnectionResult, setVisionConnectionResult] = useState<ConnectionTestResult | null>(null)
  const [visionModelListResult, setVisionModelListResult] = useState<ModelListResult | null>(null)
  const [visionLastSuccessConnection, setVisionLastSuccessConnection] = useState<ConnectionTestResult | null>(null)
  const [visionLastSuccessModelList, setVisionLastSuccessModelList] = useState<ModelListResult | null>(null)
  const [visionModelSource, setVisionModelSource] = useState<ModelCandidateSourceState>({ source: 'none' })
  const [pullingReplyModels, setPullingReplyModels] = useState(false)
  const [replyModelCandidates, setReplyModelCandidates] = useState<string[]>([])
  const [replyModelPickerOpen, setReplyModelPickerOpen] = useState(false)
  const [replyConnectionResult, setReplyConnectionResult] = useState<ConnectionTestResult | null>(null)
  const [replyModelListResult, setReplyModelListResult] = useState<ModelListResult | null>(null)
  const [replyLastSuccessConnection, setReplyLastSuccessConnection] = useState<ConnectionTestResult | null>(null)
  const [replyLastSuccessModelList, setReplyLastSuccessModelList] = useState<ModelListResult | null>(null)
  const [replyModelSource, setReplyModelSource] = useState<ModelCandidateSourceState>({ source: 'none' })
  const [replyUsingInheritedConfig, setReplyUsingInheritedConfig] = useState(false)
  const [replyMatchesVisionConfig, setReplyMatchesVisionConfig] = useState(false)
  const [startupPreflight, setStartupPreflight] = useState<EnginePreflightResult | null>(null)
  const typingCpmInputRef = useRef<HTMLInputElement>(null)

  const typingCpm = useMemo(() => normalizeTypingCpmInput(typingCpmInput), [typingCpmInput])
  const maxReplyChars = useMemo(
    () => normalizeIntegerInput(maxReplyCharsInput, DEFAULT_AUTOMATION_SETTINGS.maxReplyChars, 1, 8000),
    [maxReplyCharsInput]
  )
  const globalRateLimit = useMemo(
    () =>
      normalizeIntegerInput(
        globalRateLimitInput,
        DEFAULT_AUTOMATION_SETTINGS.globalRateLimitPerMinute,
        1,
        120
      ),
    [globalRateLimitInput]
  )
  const perChatRateLimit = useMemo(
    () =>
      normalizeIntegerInput(
        perChatRateLimitInput,
        DEFAULT_AUTOMATION_SETTINGS.perChatRateLimitPerMinute,
        1,
        60
      ),
    [perChatRateLimitInput]
  )
  const groupTriggerKeywords = useMemo(
    () => normalizeKeywordInput(groupTriggerKeywordsInput),
    [groupTriggerKeywordsInput]
  )
  const groupWhitelist = useMemo(
    () => normalizeKeywordInput(groupWhitelistInput),
    [groupWhitelistInput]
  )

  useEffect(() => {
    const load = async (): Promise<void> => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      const meta = (await window.electron?.invoke('settings:getMeta')) as SettingsMeta | undefined
      const nextVisionBaseURL = settings?.vision?.baseURL || DEFAULT_OPENAI_COMPAT_BASE_URL
      const nextReplyBaseURL = settings?.replyModel?.baseURL || settings?.vision?.baseURL || DEFAULT_OPENAI_COMPAT_BASE_URL
      const cache = readModelCandidateCache()
      const successCache = readDiagnosticSuccessCache()
      setReplyUsingInheritedConfig(Boolean(meta?.replyModelUsesVisionFallback))
      setReplyMatchesVisionConfig(Boolean(meta?.replyModelMatchesVisionConfig))
      if (settings) {
        setVisionApiKey(settings.vision?.apiKey || '')
        setVisionModel(settings.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL)
        setVisionBaseURL(nextVisionBaseURL)
        setReplyApiKey(settings.replyModel?.apiKey || settings.vision?.apiKey || '')
        setReplyModel(settings.replyModel?.model || settings.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL)
        setReplyBaseURL(nextReplyBaseURL)
        setReplyMode(settings.reply?.mode || 'typing-with-paste-fallback')
        setTypingCpmInput(
          Number.isFinite(settings.reply?.typingCpm)
            ? String(normalizeTypingCpmInput(String(settings.reply.typingCpm)))
            : String(DEFAULT_TYPING_CPM)
        )
        setExecutionMode(settings.automation?.executionMode || DEFAULT_AUTOMATION_SETTINGS.executionMode)
        setMaxReplyCharsInput(
          String(
            normalizeIntegerInput(
              settings.automation?.maxReplyChars,
              DEFAULT_AUTOMATION_SETTINGS.maxReplyChars,
              1,
              8000
            )
          )
        )
        setGlobalRateLimitInput(
          String(
            normalizeIntegerInput(
              settings.automation?.globalRateLimitPerMinute,
              DEFAULT_AUTOMATION_SETTINGS.globalRateLimitPerMinute,
              1,
              120
            )
          )
        )
        setPerChatRateLimitInput(
          String(
            normalizeIntegerInput(
              settings.automation?.perChatRateLimitPerMinute,
              DEFAULT_AUTOMATION_SETTINGS.perChatRateLimitPerMinute,
              1,
              60
            )
          )
        )
        setGroupReplyMode(settings.automation?.groupReplyMode || DEFAULT_AUTOMATION_SETTINGS.groupReplyMode)
        setGroupTriggerKeywordsInput((settings.automation?.groupTriggerKeywords || []).join(', '))
        setGroupWhitelistInput((settings.automation?.groupWhitelist || []).join(', '))
        const inherited =
          Boolean(settings.vision?.apiKey) &&
          settings.replyModel?.apiKey === settings.vision?.apiKey &&
          settings.replyModel?.model === settings.vision?.model &&
          settings.replyModel?.baseURL === settings.vision?.baseURL
        setReplyUsingInheritedConfig(inherited)

        const expectedVisionRoot = normalizeCompatApiRootPreview(nextVisionBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)
        const expectedReplyRoot = normalizeCompatApiRootPreview(nextReplyBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)

        if (
          cache.vision?.models?.length &&
          cache.vision.normalizedBaseURL === expectedVisionRoot
        ) {
          const cachedVisionCandidates = sortModelCandidates(cache.vision.models)
          const cachedVisionResult = buildModelListResultFromCache({ ...cache.vision, models: cachedVisionCandidates })
          setModelCandidates(cachedVisionCandidates)
          setVisionModelListResult(cachedVisionResult)
          setVisionModelSource({ source: 'cache', checkedAt: cache.vision.checkedAt })
        }

        if (
          cache.reply?.models?.length &&
          cache.reply.normalizedBaseURL === expectedReplyRoot
        ) {
          const cachedReplyCandidates = sortModelCandidates(cache.reply.models)
          const cachedReplyResult = buildModelListResultFromCache({ ...cache.reply, models: cachedReplyCandidates })
          setReplyModelCandidates(cachedReplyCandidates)
          setReplyModelListResult(cachedReplyResult)
          setReplyModelSource({ source: 'cache', checkedAt: cache.reply.checkedAt })
        }
      }

      const cachedVisionSuccess = successCache.vision
      const cachedReplySuccess = successCache.reply

      if (cachedVisionSuccess?.connection?.success) {
        setVisionLastSuccessConnection(cachedVisionSuccess.connection)
      }
      if (cachedVisionSuccess?.modelList?.success) {
        setVisionLastSuccessModelList(cachedVisionSuccess.modelList)
      } else if (cache.vision?.models?.length) {
        setVisionLastSuccessModelList(
          buildModelListResultFromCache({ ...cache.vision, models: sortModelCandidates(cache.vision.models) })
        )
      }

      if (cachedReplySuccess?.connection?.success) {
        setReplyLastSuccessConnection(cachedReplySuccess.connection)
      }
      if (cachedReplySuccess?.modelList?.success) {
        setReplyLastSuccessModelList(cachedReplySuccess.modelList)
      } else if (cache.reply?.models?.length) {
        setReplyLastSuccessModelList(
          buildModelListResultFromCache({ ...cache.reply, models: sortModelCandidates(cache.reply.models) })
        )
      }

      if (diagnosticsPreviewMode === 'success') {
        const visionModels = sortModelCandidates([
          'doubao-vision-pro-32k',
          'doubao-seed-2-0-lite-260215',
          'gpt-4o'
        ])
        const replyModels = sortModelCandidates([
          'doubao-seed-2-0-lite-260215',
          'gpt-4.1-mini',
          'claude-3-5-sonnet'
        ])
        const visionSuccessConnection = buildMockConnectionPreview({
          success: true,
          apiKey: settings?.vision?.apiKey || 'mock-vision-key',
          model: settings?.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL,
          baseURL: nextVisionBaseURL,
          checkedAt: minutesAgoIso(4),
          responsePreview: '连接成功'
        })
        const visionSuccessList = buildMockModelListPreview({
          success: true,
          baseURL: nextVisionBaseURL,
          checkedAt: minutesAgoIso(3),
          models: visionModels
        })
        const replySuccessConnection = buildMockConnectionPreview({
          success: true,
          apiKey: settings?.replyModel?.apiKey || settings?.vision?.apiKey || 'mock-reply-key',
          model: settings?.replyModel?.model || settings?.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL,
          baseURL: nextReplyBaseURL,
          checkedAt: minutesAgoIso(6),
          responsePreview: '连接成功'
        })
        const replySuccessList = buildMockModelListPreview({
          success: true,
          baseURL: nextReplyBaseURL,
          checkedAt: minutesAgoIso(2),
          models: replyModels
        })

        setVisionConnectionResult(visionSuccessConnection)
        setVisionLastSuccessConnection(visionSuccessConnection)
        setVisionModelListResult(visionSuccessList)
        setVisionLastSuccessModelList(visionSuccessList)
        setVisionModelSource({ source: 'live', checkedAt: visionSuccessList.checkedAt })
        setModelCandidates(visionModels)

        setReplyConnectionResult(replySuccessConnection)
        setReplyLastSuccessConnection(replySuccessConnection)
        setReplyModelListResult(replySuccessList)
        setReplyLastSuccessModelList(replySuccessList)
        setReplyModelSource({ source: 'live', checkedAt: replySuccessList.checkedAt })
        setReplyModelCandidates(replyModels)
      }

      if (diagnosticsPreviewMode === 'failure') {
        const visionSuccessConnection = buildMockConnectionPreview({
          success: true,
          apiKey: settings?.vision?.apiKey || 'mock-vision-key',
          model: settings?.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL,
          baseURL: nextVisionBaseURL,
          checkedAt: minutesAgoIso(34),
          responsePreview: '连接成功'
        })
        const visionFailureList = buildMockModelListPreview({
          success: false,
          baseURL: `${nextVisionBaseURL}/models`,
          checkedAt: minutesAgoIso(2),
          category: 'model',
          error: '模型不存在、不可用，或当前 Key 无法访问该模型。 详情: model not found'
        })
        const replySuccessList = buildMockModelListPreview({
          success: true,
          baseURL: nextReplyBaseURL,
          checkedAt: minutesAgoIso(28),
          models: sortModelCandidates(['doubao-seed-2-0-lite-260215', 'gpt-4.1-mini'])
        })
        const replyFailureConnection = buildMockConnectionPreview({
          success: false,
          apiKey: settings?.replyModel?.apiKey || settings?.vision?.apiKey || 'mock-reply-key',
          model: settings?.replyModel?.model || settings?.vision?.model || DEFAULT_OPENAI_COMPAT_MODEL,
          baseURL: `${nextReplyBaseURL}/chat/completions`,
          checkedAt: minutesAgoIso(1),
          category: 'auth',
          error: '401 Unauthorized. 请检查 API Key 是否正确，是否把别家平台的 Key 填到了当前 Base URL。'
        })

        setVisionConnectionResult(null)
        setVisionLastSuccessConnection(visionSuccessConnection)
        setVisionModelListResult(visionFailureList)
        setVisionLastSuccessModelList(null)
        setVisionModelSource({ source: 'live', checkedAt: visionFailureList.checkedAt })
        setModelCandidates([])

        setReplyConnectionResult(replyFailureConnection)
        setReplyLastSuccessConnection(null)
        setReplyModelListResult(null)
        setReplyLastSuccessModelList(replySuccessList)
        setReplyModelSource({ source: 'cache', checkedAt: replySuccessList.checkedAt })
        setReplyModelCandidates(sortModelCandidates((replySuccessList.models || []).map((item) => item.id)))
      }
    }

    void load()
  }, [diagnosticsPreviewMode])

  const refreshStartupPreflight = useCallback(async () => {
    const current = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
    if (!current) return
    const draft = {
      ...current,
      vision: {
        ...current.vision,
        apiKey: visionApiKey,
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      replyModel: {
        ...current.replyModel,
        apiKey: replyApiKey,
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: replyBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      reply: {
        ...current.reply,
        mode: replyMode,
        typingCpm
      },
      automation: {
        ...current.automation,
        executionMode,
        maxReplyChars,
        globalRateLimitPerMinute: globalRateLimit,
        perChatRateLimitPerMinute: perChatRateLimit,
        groupReplyMode,
        groupTriggerKeywords,
        groupWhitelist
      }
    }
    const result = (await window.electron?.invoke('engine:preflight', draft)) as
      | EnginePreflightResult
      | undefined
    setStartupPreflight(result || null)
  }, [
    executionMode,
    globalRateLimit,
    groupReplyMode,
    groupTriggerKeywords,
    groupWhitelist,
    maxReplyChars,
    perChatRateLimit,
    replyApiKey,
    replyBaseURL,
    replyMode,
    replyModel,
    typingCpm,
    visionApiKey,
    visionBaseURL,
    visionModel
  ])

  const handleSaveSettings = useCallback(async () => {
    const nextTypingCpm = readTypingCpmInput(typingCpmInputRef.current, typingCpmInput)
    const nextMaxReplyChars = normalizeIntegerInput(
      maxReplyCharsInput,
      DEFAULT_AUTOMATION_SETTINGS.maxReplyChars,
      1,
      8000
    )
    const nextGlobalRateLimit = normalizeIntegerInput(
      globalRateLimitInput,
      DEFAULT_AUTOMATION_SETTINGS.globalRateLimitPerMinute,
      1,
      120
    )
    const nextPerChatRateLimit = normalizeIntegerInput(
      perChatRateLimitInput,
      DEFAULT_AUTOMATION_SETTINGS.perChatRateLimitPerMinute,
      1,
      60
    )
    setTypingCpmInput(String(nextTypingCpm))
    setMaxReplyCharsInput(String(nextMaxReplyChars))
    setGlobalRateLimitInput(String(nextGlobalRateLimit))
    setPerChatRateLimitInput(String(nextPerChatRateLimit))

    const payload: Partial<AppSettings> = {
      vision: {
        apiKey: visionApiKey,
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      replyModel: {
        apiKey: replyApiKey,
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: replyBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      reply: {
        mode: replyMode,
        typingCpm: nextTypingCpm
      },
      automation: {
        executionMode,
        maxReplyChars: nextMaxReplyChars,
        globalRateLimitPerMinute: nextGlobalRateLimit,
        perChatRateLimitPerMinute: nextPerChatRateLimit,
        groupReplyMode,
        groupTriggerKeywords: normalizeKeywordInput(groupTriggerKeywordsInput),
        groupWhitelist: normalizeKeywordInput(groupWhitelistInput)
      }
    }
    await window.electron?.invoke('settings:set', payload)
    await window.electron?.invoke('engine:updateConfig', {
      ...((await window.electron?.invoke('settings:getAll')) as AppSettings),
      ...payload,
      vision: {
        apiKey: visionApiKey,
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      replyModel: {
        apiKey: replyApiKey,
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: replyBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      },
      reply: {
        mode: replyMode,
        typingCpm: nextTypingCpm
      },
      automation: {
        executionMode,
        maxReplyChars: nextMaxReplyChars,
        globalRateLimitPerMinute: nextGlobalRateLimit,
        perChatRateLimitPerMinute: nextPerChatRateLimit,
        groupReplyMode,
        groupTriggerKeywords: normalizeKeywordInput(groupTriggerKeywordsInput),
        groupWhitelist: normalizeKeywordInput(groupWhitelistInput)
      }
    })
    const meta = (await window.electron?.invoke('settings:getMeta')) as SettingsMeta | undefined
    setReplyUsingInheritedConfig(Boolean(meta?.replyModelUsesVisionFallback))
    setReplyMatchesVisionConfig(Boolean(meta?.replyModelMatchesVisionConfig))
    await refreshStartupPreflight()
    showToast(t('settings.saved'), 'success')
  }, [
    executionMode,
    globalRateLimitInput,
    groupReplyMode,
    groupTriggerKeywordsInput,
    groupWhitelistInput,
    maxReplyCharsInput,
    perChatRateLimitInput,
    replyApiKey,
    replyBaseURL,
    replyMode,
    replyModel,
    typingCpmInput,
    visionApiKey,
    visionBaseURL,
    visionModel,
    refreshStartupPreflight
  ])

  useEffect(() => {
    if (diagnosticsPreviewMode) return
    void refreshStartupPreflight()
  }, [diagnosticsPreviewMode, refreshStartupPreflight])

  const handleTestConnection = useCallback(async () => {
    if (!replyApiKey) return
    setTesting(true)
    try {
      const result = ((await window.electron?.invoke('engine:testConnection', {
        apiKey: replyApiKey,
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: replyBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      })) as ConnectionTestResult | undefined)
      const nextResult: ConnectionTestResult = result || {
        success: false,
        error: t('settings.testConnection.fail'),
        errorCategory: 'unknown',
        url: buildChatCompletionsUrlPreview(replyBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(replyBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL
      }
      setReplyConnectionResult(nextResult)
      if (nextResult.success) {
        setReplyLastSuccessConnection(nextResult)
        writeDiagnosticSuccessCache('reply', { connection: nextResult })
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${nextResult.error || ''}`, 'error')
      }
    } catch (error: unknown) {
      const nextResult: ConnectionTestResult = {
        success: false,
        error: getErrorMessage(error),
        errorCategory: inferDiagnosticCategoryFromMessage(getErrorMessage(error)),
        url: buildChatCompletionsUrlPreview(replyBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(replyBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
        model: replyModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL
      }
      setReplyConnectionResult(nextResult)
      showToast(`${t('settings.testConnection.fail')}: ${nextResult.error}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [replyApiKey, replyBaseURL, replyModel])

  const handleVisionTestConnection = useCallback(async () => {
    if (!visionApiKey) return
    setTestingVision(true)
    try {
      const result = ((await window.electron?.invoke('engine:testConnection', {
        apiKey: visionApiKey,
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
        baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      })) as ConnectionTestResult | undefined)
      const nextResult: ConnectionTestResult = result || {
        success: false,
        error: t('settings.testConnection.fail'),
        errorCategory: 'unknown',
        url: buildChatCompletionsUrlPreview(visionBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(visionBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL
      }
      setVisionConnectionResult(nextResult)
      if (nextResult.success) {
        setVisionLastSuccessConnection(nextResult)
        writeDiagnosticSuccessCache('vision', { connection: nextResult })
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${nextResult.error || ''}`, 'error')
      }
    } catch (error: unknown) {
      const nextResult: ConnectionTestResult = {
        success: false,
        error: getErrorMessage(error),
        errorCategory: inferDiagnosticCategoryFromMessage(getErrorMessage(error)),
        url: buildChatCompletionsUrlPreview(visionBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(visionBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
        model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL
      }
      setVisionConnectionResult(nextResult)
      showToast(`${t('settings.testConnection.fail')}: ${nextResult.error}`, 'error')
    } finally {
      setTestingVision(false)
    }
  }, [visionApiKey, visionBaseURL, visionModel])

  const fetchModelCandidates = useCallback(
    async (apiKey: string, baseURL: string) => {
      const result = ((await window.electron?.invoke('engine:listModels', {
        apiKey,
        baseURL: baseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
      })) as ModelListResult | undefined)

      const nextResult: ModelListResult = result || {
        success: false,
        error: t('settings.fetchModels.fail'),
        errorCategory: 'unknown',
        url: buildModelsUrlPreview(baseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(baseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)
      }
      if (nextResult.success) {
        return {
          ...nextResult,
          success: true as const,
          candidates: sortModelCandidates((nextResult.models || []).map((item) => item.id))
        }
      }

      const errorMessage = String(nextResult.error || '')
      if (errorMessage.includes("No handler registered for 'engine:listModels'")) {
        return {
          ...nextResult,
          success: false as const,
          error: t('settings.fetchModels.restartRequired'),
          errorCategory: 'unknown' as const,
          candidates: []
        }
      }

      return {
        ...nextResult,
        success: false as const,
        error: nextResult.error || t('settings.fetchModels.fail'),
        errorCategory: nextResult.errorCategory || inferDiagnosticCategoryFromMessage(nextResult.error || ''),
        candidates: []
      }
    },
    []
  )

  const handlePullModels = useCallback(async () => {
    if (!visionApiKey) return
    setPullingModels(true)
    try {
      const result = await fetchModelCandidates(visionApiKey, visionBaseURL)
      setVisionModelListResult(result)
      if (result.success) {
        setModelCandidates(result.candidates)
        setModelPickerOpen(true)
        setVisionModelSource({ source: 'live', checkedAt: result.checkedAt })
        setVisionLastSuccessModelList(result)
        writeDiagnosticSuccessCache('vision', { modelList: result })
        writeModelCandidateCache('vision', {
          baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL,
          normalizedBaseURL:
            result.normalizedBaseURL ||
            normalizeCompatApiRootPreview(visionBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
          checkedAt: result.checkedAt || new Date().toISOString(),
          models: result.candidates
        })
        showToast(`${t('settings.fetchModels.success')}：${result.candidates.length}`, 'success')
        return
      }
      showToast(`${t('settings.fetchModels.fail')}: ${result.error || ''}`, 'error')
    } catch (error: unknown) {
      const failedResult: ModelListResult = {
        success: false,
        error: getErrorMessage(error),
        errorCategory: inferDiagnosticCategoryFromMessage(getErrorMessage(error)),
        url: buildModelsUrlPreview(visionBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(visionBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)
      }
      setVisionModelListResult(failedResult)
      showToast(`${t('settings.fetchModels.fail')}: ${failedResult.error}`, 'error')
    } finally {
      setPullingModels(false)
    }
  }, [fetchModelCandidates, visionApiKey, visionBaseURL])

  const handlePullReplyModels = useCallback(async () => {
    if (!replyApiKey) return
    setPullingReplyModels(true)
    try {
      const result = await fetchModelCandidates(replyApiKey, replyBaseURL)
      setReplyModelListResult(result)
      if (result.success) {
        setReplyModelCandidates(result.candidates)
        setReplyModelPickerOpen(true)
        setReplyModelSource({ source: 'live', checkedAt: result.checkedAt })
        setReplyLastSuccessModelList(result)
        writeDiagnosticSuccessCache('reply', { modelList: result })
        writeModelCandidateCache('reply', {
          baseURL: replyBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL,
          normalizedBaseURL:
            result.normalizedBaseURL ||
            normalizeCompatApiRootPreview(replyBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL),
          checkedAt: result.checkedAt || new Date().toISOString(),
          models: result.candidates
        })
        showToast(`${t('settings.fetchModels.success')}：${result.candidates.length}`, 'success')
        return
      }
      showToast(`${t('settings.fetchModels.fail')}: ${result.error || ''}`, 'error')
    } catch (error: unknown) {
      const failedResult: ModelListResult = {
        success: false,
        error: getErrorMessage(error),
        errorCategory: inferDiagnosticCategoryFromMessage(getErrorMessage(error)),
        url: buildModelsUrlPreview(replyBaseURL),
        checkedAt: new Date().toISOString(),
        normalizedBaseURL: normalizeCompatApiRootPreview(replyBaseURL, DEFAULT_OPENAI_COMPAT_BASE_URL)
      }
      setReplyModelListResult(failedResult)
      showToast(`${t('settings.fetchModels.fail')}: ${failedResult.error}`, 'error')
    } finally {
      setPullingReplyModels(false)
    }
  }, [fetchModelCandidates, replyApiKey, replyBaseURL])

  const handleCopySecret = useCallback(async (value: string) => {
    if (!value.trim()) return
    try {
      await copyToClipboard(value)
      showToast('已复制', 'success')
    } catch (error: unknown) {
      showToast(`复制失败: ${getErrorMessage(error)}`, 'error')
    }
  }, [])

  const handleSyncVisionToReply = useCallback(async () => {
    if (!visionApiKey.trim()) {
      showToast('请先填写并保存视觉模型配置', 'error')
      return
    }

    const nextReplyConfig = {
      apiKey: visionApiKey.trim(),
      model: visionModel.trim() || DEFAULT_OPENAI_COMPAT_MODEL,
      baseURL: visionBaseURL.trim() || DEFAULT_OPENAI_COMPAT_BASE_URL
    }

    setReplyApiKey(nextReplyConfig.apiKey)
    setReplyModel(nextReplyConfig.model)
    setReplyBaseURL(nextReplyConfig.baseURL)

    await window.electron?.invoke('settings:set', {
      replyModel: nextReplyConfig
    })
    const nextSettings = (await window.electron?.invoke('settings:getAll')) as AppSettings
    await window.electron?.invoke('engine:updateConfig', nextSettings)
    setReplyUsingInheritedConfig(false)
    setReplyMatchesVisionConfig(true)
    await refreshStartupPreflight()
    showToast('已将视觉配置同步到回复模型', 'success')
  }, [visionApiKey, visionBaseURL, visionModel, refreshStartupPreflight])

  const copyDiagnostic = useCallback(async (title: string, result: RequestDiagnosticResult | null, detail?: string) => {
    if (!result) return
    try {
      await copyToClipboard(buildDiagnosticCopyText(title, result, detail))
      showToast('诊断信息已复制', 'success')
    } catch (error: unknown) {
      showToast(`复制失败: ${getErrorMessage(error)}`, 'error')
    }
  }, [])

  const copyHelperText = useCallback(async (text: string, successMessage: string) => {
    try {
      await copyToClipboard(text)
      showToast(successMessage, 'success')
    } catch (error: unknown) {
      showToast(`复制失败: ${getErrorMessage(error)}`, 'error')
    }
  }, [])

  const clearVisionModelCache = useCallback(() => {
    clearModelCandidateCache('vision')
    setModelCandidates([])
    setModelPickerOpen(false)
    if (visionModelSource.source === 'cache') {
      setVisionModelListResult(null)
    }
    setVisionModelSource({ source: 'none' })
    showToast('视觉模型缓存已清空', 'success')
  }, [visionModelSource.source])

  const clearReplyModelCache = useCallback(() => {
    clearModelCandidateCache('reply')
    setReplyModelCandidates([])
    setReplyModelPickerOpen(false)
    if (replyModelSource.source === 'cache') {
      setReplyModelListResult(null)
    }
    setReplyModelSource({ source: 'none' })
    showToast('回复模型缓存已清空', 'success')
  }, [replyModelSource.source])

  const resetDiagnostics = useCallback(() => {
    setVisionConnectionResult(null)
    setVisionModelListResult(null)
    setVisionLastSuccessConnection(null)
    setVisionLastSuccessModelList(null)
    setReplyConnectionResult(null)
    setReplyModelListResult(null)
    setReplyLastSuccessConnection(null)
    setReplyLastSuccessModelList(null)
    clearDiagnosticSuccessCache()
    showToast('模型诊断已重置', 'success')
  }, [])

  const rerunVisionModelPull = useCallback(() => {
    clearVisionModelCache()
    void handlePullModels()
  }, [clearVisionModelCache, handlePullModels])

  const rerunReplyModelPull = useCallback(() => {
    clearReplyModelCache()
    void handlePullReplyModels()
  }, [clearReplyModelCache, handlePullReplyModels])

  const visibleCandidates = useMemo(() => {
    return showVisionOnly ? modelCandidates.filter((model) => isVisionLikeModel(model)) : modelCandidates
  }, [modelCandidates, showVisionOnly])
  const visibleReplyCandidates = useMemo(() => sortModelCandidates(replyModelCandidates), [replyModelCandidates])
  const visionConnectionDetail = useMemo(() => buildConnectionSuccessDetail(visionConnectionResult), [visionConnectionResult])
  const visionModelListDetail = useMemo(() => buildModelListSuccessDetail(visionModelListResult), [visionModelListResult])
  const replyConnectionDetail = useMemo(() => buildConnectionSuccessDetail(replyConnectionResult), [replyConnectionResult])
  const replyModelListDetail = useMemo(() => buildModelListSuccessDetail(replyModelListResult), [replyModelListResult])
  const visionRecentSuccess = useMemo(
    () => buildRecentSuccessLabel(visionLastSuccessConnection, visionLastSuccessModelList),
    [visionLastSuccessConnection, visionLastSuccessModelList]
  )
  const replyRecentSuccess = useMemo(
    () => buildRecentSuccessLabel(replyLastSuccessConnection, replyLastSuccessModelList),
    [replyLastSuccessConnection, replyLastSuccessModelList]
  )
  const visionModelSourceLabel = useMemo(() => {
    if (visionModelSource.source === 'cache') {
      return `已从本地缓存恢复 · ${formatDiagnosticTimestamp(visionModelSource.checkedAt)}`
    }
    if (visionModelSource.source === 'live') {
      return `最近一次实时拉取 · ${formatDiagnosticTimestamp(visionModelSource.checkedAt)}`
    }
    return ''
  }, [visionModelSource])
  const replyModelSourceLabel = useMemo(() => {
    if (replyModelSource.source === 'cache') {
      return `已从本地缓存恢复 · ${formatDiagnosticTimestamp(replyModelSource.checkedAt)}`
    }
    if (replyModelSource.source === 'live') {
      return `最近一次实时拉取 · ${formatDiagnosticTimestamp(replyModelSource.checkedAt)}`
    }
    return ''
  }, [replyModelSource])
  const visionFetchButtonLabel =
    pullingModels
      ? t('settings.fetchModels.fetching')
      : modelCandidates.length || visionModelSource.source !== 'none'
        ? '刷新列表'
        : t('settings.fetchModels')
  const replyFetchButtonLabel =
    pullingReplyModels
      ? t('settings.fetchModels.fetching')
      : replyModelCandidates.length || replyModelSource.source !== 'none'
        ? '刷新列表'
        : t('settings.fetchModels')
  const visionHealthSnapshot = useMemo(
    () =>
      buildServiceHealthSnapshot({
        connectionResult: visionConnectionResult,
        modelListResult: visionModelListResult,
        source: visionModelSource,
        sourceLabel: visionModelSourceLabel,
        connectionDetail: visionConnectionDetail,
        modelListDetail: visionModelListDetail,
        candidateCount: modelCandidates.length
      }),
    [
      modelCandidates.length,
      visionConnectionDetail,
      visionConnectionResult,
      visionModelListDetail,
      visionModelListResult,
      visionModelSource,
      visionModelSourceLabel
    ]
  )
  const replyHealthSnapshot = useMemo(
    () =>
      buildServiceHealthSnapshot({
        connectionResult: replyConnectionResult,
        modelListResult: replyModelListResult,
        source: replyModelSource,
        sourceLabel: replyModelSourceLabel,
        connectionDetail: replyConnectionDetail,
        modelListDetail: replyModelListDetail,
        candidateCount: replyModelCandidates.length
      }),
    [
      replyConnectionDetail,
      replyConnectionResult,
      replyModelCandidates.length,
      replyModelListDetail,
      replyModelListResult,
      replyModelSource,
      replyModelSourceLabel
    ]
  )
  const visionConnectionActions = useMemo(() => {
    const category = visionConnectionResult?.errorCategory
    const actions: Array<{ label: string; onClick: () => void }> = []

    if (category === 'base_url' || category === 'network' || category === 'timeout' || category === 'server') {
      actions.push({
        label: '复制 URL 检查项',
        onClick: () =>
          void copyHelperText(
            buildBaseUrlChecklist({
              title: '视觉模型 / 连接测试',
              rawBaseURL: visionBaseURL,
              normalizedBaseURL: visionConnectionResult?.normalizedBaseURL,
              requestURL: visionConnectionResult?.url,
              category
            }),
            'URL 检查项已复制'
          )
      })
    }

    if (category === 'auth' || category === 'permission') {
      actions.push({
        label: '复制 Key 检查项',
        onClick: () =>
          void copyHelperText(
            buildCredentialChecklist({
              title: '视觉模型 / 连接测试',
              apiKey: visionApiKey,
              model: visionModel,
              rawBaseURL: visionBaseURL,
              category
            }),
            'Key 检查项已复制'
          )
      })
    }

    return actions
  }, [copyHelperText, visionApiKey, visionBaseURL, visionConnectionResult, visionModel])
  const visionModelListActions = useMemo(() => {
    const category = visionModelListResult?.errorCategory
    const actions: Array<{ label: string; onClick: () => void }> = []

    if (category === 'model' || category === 'unknown') {
      actions.push({ label: '清缓存后重拉', onClick: rerunVisionModelPull })
      actions.push({
        label: '复制模型检查项',
        onClick: () =>
          void copyHelperText(
            buildModelSelectionChecklist({
              title: '视觉模型 / 拉取模型',
              model: visionModel,
              candidateCount: modelCandidates.length,
              sourceLabel: visionModelSourceLabel
            }),
            '模型检查项已复制'
          )
      })
    }

    if (category === 'base_url' || category === 'network' || category === 'timeout' || category === 'server') {
      actions.push({
        label: '复制 URL 检查项',
        onClick: () =>
          void copyHelperText(
            buildBaseUrlChecklist({
              title: '视觉模型 / 拉取模型',
              rawBaseURL: visionBaseURL,
              normalizedBaseURL: visionModelListResult?.normalizedBaseURL,
              requestURL: visionModelListResult?.url,
              category
            }),
            'URL 检查项已复制'
          )
      })
    }

    if (category === 'auth' || category === 'permission') {
      actions.push({
        label: '复制 Key 检查项',
        onClick: () =>
          void copyHelperText(
            buildCredentialChecklist({
              title: '视觉模型 / 拉取模型',
              apiKey: visionApiKey,
              model: visionModel,
              rawBaseURL: visionBaseURL,
              category
            }),
            'Key 检查项已复制'
          )
      })
    }

    return actions
  }, [
    copyHelperText,
    modelCandidates.length,
    rerunVisionModelPull,
    visionApiKey,
    visionBaseURL,
    visionModel,
    visionModelListResult,
    visionModelSourceLabel
  ])
  const replyConnectionActions = useMemo(() => {
    const category = replyConnectionResult?.errorCategory
    const actions: Array<{ label: string; onClick: () => void }> = []

    if (category === 'base_url' || category === 'network' || category === 'timeout' || category === 'server') {
      actions.push({
        label: '复制 URL 检查项',
        onClick: () =>
          void copyHelperText(
            buildBaseUrlChecklist({
              title: '回复模型 / 连接测试',
              rawBaseURL: replyBaseURL,
              normalizedBaseURL: replyConnectionResult?.normalizedBaseURL,
              requestURL: replyConnectionResult?.url,
              category
            }),
            'URL 检查项已复制'
          )
      })
    }

    if (category === 'auth' || category === 'permission') {
      actions.push({
        label: '复制 Key 检查项',
        onClick: () =>
          void copyHelperText(
            buildCredentialChecklist({
              title: '回复模型 / 连接测试',
              apiKey: replyApiKey,
              model: replyModel,
              rawBaseURL: replyBaseURL,
              category
            }),
            'Key 检查项已复制'
          )
      })
    }

    return actions
  }, [copyHelperText, replyApiKey, replyBaseURL, replyConnectionResult, replyModel])
  const replyModelListActions = useMemo(() => {
    const category = replyModelListResult?.errorCategory
    const actions: Array<{ label: string; onClick: () => void }> = []

    if (category === 'model' || category === 'unknown') {
      actions.push({ label: '清缓存后重拉', onClick: rerunReplyModelPull })
      actions.push({
        label: '复制模型检查项',
        onClick: () =>
          void copyHelperText(
            buildModelSelectionChecklist({
              title: '回复模型 / 拉取模型',
              model: replyModel,
              candidateCount: replyModelCandidates.length,
              sourceLabel: replyModelSourceLabel
            }),
            '模型检查项已复制'
          )
      })
    }

    if (category === 'base_url' || category === 'network' || category === 'timeout' || category === 'server') {
      actions.push({
        label: '复制 URL 检查项',
        onClick: () =>
          void copyHelperText(
            buildBaseUrlChecklist({
              title: '回复模型 / 拉取模型',
              rawBaseURL: replyBaseURL,
              normalizedBaseURL: replyModelListResult?.normalizedBaseURL,
              requestURL: replyModelListResult?.url,
              category
            }),
            'URL 检查项已复制'
          )
      })
    }

    if (category === 'auth' || category === 'permission') {
      actions.push({
        label: '复制 Key 检查项',
        onClick: () =>
          void copyHelperText(
            buildCredentialChecklist({
              title: '回复模型 / 拉取模型',
              apiKey: replyApiKey,
              model: replyModel,
              rawBaseURL: replyBaseURL,
              category
            }),
            'Key 检查项已复制'
          )
      })
    }

    return actions
  }, [
    copyHelperText,
    replyApiKey,
    replyBaseURL,
    replyModel,
    replyModelCandidates.length,
    replyModelListResult,
    replyModelSourceLabel,
    rerunReplyModelPull
  ])
  const combinedDiagnosticsExport = useMemo(
    () =>
      buildCombinedModelDiagnosticsExport({
        visionStatus: visionHealthSnapshot.status,
        visionSummaryDetail: visionHealthSnapshot.detail,
        visionRecentSuccess,
        visionModel,
        visionBaseURL,
        visionSourceLabel: visionModelSourceLabel,
        visionConnectionResult,
        visionModelListResult,
        visionConnectionDetail,
        visionModelListDetail,
        replyStatus: replyHealthSnapshot.status,
        replySummaryDetail: replyHealthSnapshot.detail,
        replyRecentSuccess,
        replyModel,
        replyBaseURL,
        replySourceLabel: replyModelSourceLabel,
        replyConnectionResult,
        replyModelListResult,
        replyConnectionDetail,
        replyModelListDetail
      }),
    [
      replyBaseURL,
      replyConnectionDetail,
      replyConnectionResult,
      replyModel,
      replyModelListDetail,
      replyModelListResult,
      replyHealthSnapshot.detail,
      replyHealthSnapshot.status,
      replyRecentSuccess,
      replyModelSourceLabel,
      visionBaseURL,
      visionConnectionDetail,
      visionConnectionResult,
      visionHealthSnapshot.detail,
      visionHealthSnapshot.status,
      visionModel,
      visionModelListDetail,
      visionModelListResult,
      visionRecentSuccess,
      visionModelSourceLabel
    ]
  )
  const failedDiagnosticsExport = useMemo(
    () =>
      buildFailedModelDiagnosticsExport({
        visionStatus: visionHealthSnapshot.status,
        visionSummaryDetail: visionHealthSnapshot.detail,
        visionConnectionResult,
        visionModelListResult,
        visionConnectionDetail,
        visionModelListDetail,
        replyStatus: replyHealthSnapshot.status,
        replySummaryDetail: replyHealthSnapshot.detail,
        replyConnectionResult,
        replyModelListResult,
        replyConnectionDetail,
        replyModelListDetail
      }),
    [
      replyConnectionDetail,
      replyConnectionResult,
      replyHealthSnapshot.detail,
      replyHealthSnapshot.status,
      replyModelListDetail,
      replyModelListResult,
      visionConnectionDetail,
      visionConnectionResult,
      visionHealthSnapshot.detail,
      visionHealthSnapshot.status,
      visionModelListDetail,
      visionModelListResult
    ]
  )

  useEffect(() => {
    onInspectorSummaryChange?.({
      visionStatus: visionHealthSnapshot.status,
      visionDetail: visionHealthSnapshot.detail,
      visionRecentSuccess,
      replyStatus: replyHealthSnapshot.status,
      replyDetail: replyHealthSnapshot.detail,
      replyRecentSuccess,
      preflightStatus: startupPreflight
        ? startupPreflight.ready
          ? '可启动'
          : '启动前拦截'
        : '检查中',
      preflightDetail: startupPreflight
        ? `${startupPreflight.startupStrategy.toUpperCase()} / ${
            startupPreflight.replyConfigState === 'inherited'
              ? '回复继承视觉配置'
              : startupPreflight.replyConfigState === 'synced'
                ? '回复已同步视觉配置'
                : '回复独立配置'
          } / ${startupPreflight.summary}`
        : '正在计算当前启动前检查结果',
      refreshPreflight: () => {
        void refreshStartupPreflight()
      },
      exportText: combinedDiagnosticsExport,
      exportFailedText: failedDiagnosticsExport,
      resetDiagnostics
    })
  }, [
    combinedDiagnosticsExport,
    failedDiagnosticsExport,
    onInspectorSummaryChange,
    replyHealthSnapshot.detail,
    replyHealthSnapshot.status,
    replyRecentSuccess,
    resetDiagnostics,
    startupPreflight,
    visionHealthSnapshot.detail,
    visionHealthSnapshot.status,
    visionRecentSuccess
  ])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>基础配置</h1>
          <p>维护桌面端运行所需的基础参数。</p>
        </div>
      </div>

      <div className="card base-settings-card base-settings-card--vision">
        <div className="card-title">{t('settings.vision')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionApiKey')}</label>
          <div className="secret-input">
            <input
              className="form-input"
              type={showVisionApiKey ? 'text' : 'password'}
              value={visionApiKey}
              onChange={(e) => setVisionApiKey(e.target.value)}
              placeholder={t('settings.visionApiKey.placeholder')}
              autoComplete="off"
            />
            <button
              type="button"
              className="secret-action-btn"
              onClick={() => setShowVisionApiKey((prev) => !prev)}
              title={showVisionApiKey ? '隐藏明文' : '显示明文'}
            >
              {showVisionApiKey ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="secret-action-btn"
              onClick={() => void handleCopySecret(visionApiKey)}
              title="复制"
            >
              复制
            </button>
          </div>
          <div className="form-hint">{t('settings.visionApiKey.hint')}</div>
        </div>

        <div className="form-group">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 5
            }}
          >
            <label className="form-label" style={{ marginBottom: 0 }}>
              {t('settings.visionModel')}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label className="model-toggle">
                <input
                  type="checkbox"
                  checked={showVisionOnly}
                  onChange={(e) => setShowVisionOnly(e.target.checked)}
                />
                <span>{t('settings.visionOnly')}</span>
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handlePullModels}
                disabled={!visionApiKey || pullingModels}
                style={{ whiteSpace: 'nowrap', paddingInline: 12 }}
              >
                {visionFetchButtonLabel}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={clearVisionModelCache}
                disabled={!modelCandidates.length && visionModelSource.source === 'none'}
                style={{ whiteSpace: 'nowrap', paddingInline: 12 }}
              >
                清缓存
              </button>
            </div>
          </div>
          <input
            className="form-input"
            value={visionModel}
            onChange={(e) => setVisionModel(e.target.value)}
            placeholder={DEFAULT_OPENAI_COMPAT_MODEL}
            autoComplete="off"
            onFocus={() => setModelPickerOpen(true)}
            onClick={() => setModelPickerOpen(true)}
          />
          <div className="model-panel-actions">
            <button
              type="button"
              className="model-panel-toggle"
              onClick={() => setModelPickerOpen((current) => !current)}
              disabled={!modelCandidates.length}
            >
              {modelPickerOpen ? t('settings.models.collapse') : t('settings.models.expand')}
            </button>
            {modelCandidates.length ? (
              <span className="model-panel-count">
                {showVisionOnly ? `${visibleCandidates.length}/${modelCandidates.length}` : modelCandidates.length}
              </span>
            ) : null}
          </div>
          {modelPickerOpen && visibleCandidates.length ? (
            <div className="model-picker">
              {visibleCandidates.map((model) => (
                <button
                  key={model}
                  type="button"
                  className={`model-option${visionModel === model ? ' active' : ''}`}
                  onClick={() => {
                    setVisionModel(model)
                    setModelPickerOpen(false)
                  }}
                >
                  {model}
                </button>
              ))}
            </div>
          ) : null}
          <div className="form-hint">
            {modelCandidates.length
              ? `已拉取 ${modelCandidates.length} 个候选模型，下面列表可滚动选择`
              : '点击“拉取模型”从接口获取可用模型，或直接手动填写模型名'}
          </div>
          <div className="form-hint">刷新列表不会改动当前已填的模型名，只会更新候选模型集合。</div>
          {visionModelSourceLabel ? <div className="model-panel-note">{visionModelSourceLabel}</div> : null}
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionBaseUrl')}</label>
          <input
            className="form-input"
            value={visionBaseURL}
            onChange={(e) => setVisionBaseURL(e.target.value)}
            placeholder={DEFAULT_OPENAI_COMPAT_BASE_URL}
            autoComplete="off"
          />
          <div className="form-hint">
            建议填写兼容接口根路径，例如 `https://.../v1` 或 `https://.../api/v3`。如果直接填了
            `/chat/completions` 或 `/models`，系统会自动兼容。
          </div>
        </div>

        <button
          className="btn btn-secondary"
          onClick={handleVisionTestConnection}
          disabled={!visionApiKey || testingVision}
        >
          {testingVision ? t('settings.testConnection.testing') : t('settings.testConnection')}
        </button>

        <div className="service-diagnostics">
          <div className="service-diagnostics__title">最近诊断</div>
          <div className="service-diagnostics__grid">
            <ServiceDiagnosticCard
              title="连接测试"
              result={visionConnectionResult}
              emptyText="还没有执行视觉模型连接测试。"
              successDetail={visionConnectionDetail}
              failureDetail={visionConnectionResult?.error}
              categoryLabel={getDiagnosticCategoryLabel(visionConnectionResult?.errorCategory)}
              nextStep={getDiagnosticNextStep(visionConnectionResult?.errorCategory)}
              actions={visionConnectionActions}
              recentSuccessMeta={
                visionLastSuccessConnection?.success
                  ? `最近成功：${formatDiagnosticTimestamp(visionLastSuccessConnection.checkedAt)}`
                  : undefined
              }
              onCopy={() =>
                void copyDiagnostic(
                  '视觉模型 / 连接测试',
                  visionConnectionResult,
                  visionConnectionResult?.success ? visionConnectionDetail : visionConnectionResult?.error
                )
              }
            />
            <ServiceDiagnosticCard
              title="拉取模型"
              result={visionModelListResult}
              emptyText="还没有拉取视觉模型列表。"
              successDetail={visionModelListDetail}
              failureDetail={visionModelListResult?.error}
              categoryLabel={getDiagnosticCategoryLabel(visionModelListResult?.errorCategory)}
              nextStep={getDiagnosticNextStep(visionModelListResult?.errorCategory)}
              actions={visionModelListActions}
              recentSuccessMeta={
                visionLastSuccessModelList?.success
                  ? `最近成功：${formatDiagnosticTimestamp(visionLastSuccessModelList.checkedAt)}`
                  : undefined
              }
              onCopy={() =>
                void copyDiagnostic(
                  '视觉模型 / 拉取模型',
                  visionModelListResult,
                  visionModelListResult?.success ? visionModelListDetail : visionModelListResult?.error
                )
              }
            />
          </div>
        </div>

      </div>

      <div className="card base-settings-card base-settings-card--reply-model">
        <div className="card-title">{t('settings.replyModel')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.replyApiKey')}</label>
          <div className="secret-input">
            <input
              className="form-input"
              type={showReplyApiKey ? 'text' : 'password'}
              value={replyApiKey}
              onChange={(e) => setReplyApiKey(e.target.value)}
              placeholder={t('settings.replyApiKey.placeholder')}
              autoComplete="off"
            />
            <button
              type="button"
              className="secret-action-btn"
              onClick={() => setShowReplyApiKey((prev) => !prev)}
              title={showReplyApiKey ? '隐藏明文' : '显示明文'}
            >
              {showReplyApiKey ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="secret-action-btn"
              onClick={() => void handleCopySecret(replyApiKey)}
              title="复制"
            >
              复制
            </button>
          </div>
          <div className="form-hint">{t('settings.replyApiKey.hint')}</div>
          {replyUsingInheritedConfig ? (
            <div className="form-hint">当前回复模型与视觉模型配置一致，可直接运行；如需显式固化到回复配置，点下面的同步按钮。</div>
          ) : replyMatchesVisionConfig ? (
            <div className="form-hint">当前回复模型已显式同步为与视觉模型一致的配置。</div>
          ) : null}
          <div className="sync-config-actions">
            <button type="button" className="btn btn-secondary" onClick={handleSyncVisionToReply}>
              {replyMatchesVisionConfig ? '重新同步视觉配置' : '同步视觉配置'}
            </button>
          </div>
        </div>

        <div className="form-group">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 5
            }}
          >
            <label className="form-label" style={{ marginBottom: 0 }}>
              {t('settings.replyModelName')}
            </label>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handlePullReplyModels}
              disabled={!replyApiKey || pullingReplyModels}
              style={{ whiteSpace: 'nowrap', paddingInline: 12 }}
            >
              {replyFetchButtonLabel}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={clearReplyModelCache}
              disabled={!replyModelCandidates.length && replyModelSource.source === 'none'}
              style={{ whiteSpace: 'nowrap', paddingInline: 12 }}
            >
              清缓存
            </button>
          </div>
          <input
            className="form-input"
            value={replyModel}
            onChange={(e) => setReplyModel(e.target.value)}
            placeholder={DEFAULT_OPENAI_COMPAT_MODEL}
            autoComplete="off"
            onFocus={() => setReplyModelPickerOpen(true)}
            onClick={() => setReplyModelPickerOpen(true)}
          />
          <div className="model-panel-actions">
            <button
              type="button"
              className="model-panel-toggle"
              onClick={() => setReplyModelPickerOpen((current) => !current)}
              disabled={!replyModelCandidates.length}
            >
              {replyModelPickerOpen ? t('settings.models.collapse') : t('settings.models.expand')}
            </button>
            {replyModelCandidates.length ? (
              <span className="model-panel-count">{replyModelCandidates.length}</span>
            ) : null}
          </div>
          {replyModelPickerOpen && visibleReplyCandidates.length ? (
            <div className="model-picker">
              {visibleReplyCandidates.map((model) => (
                <button
                  key={model}
                  type="button"
                  className={`model-option${replyModel === model ? ' active' : ''}`}
                  onClick={() => {
                    setReplyModel(model)
                    setReplyModelPickerOpen(false)
                  }}
                >
                  {model}
                </button>
              ))}
            </div>
          ) : null}
          <div className="form-hint">刷新列表不会改动当前已填的模型名，只会更新候选模型集合。</div>
          {replyModelSourceLabel ? <div className="model-panel-note">{replyModelSourceLabel}</div> : null}
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.replyBaseUrl')}</label>
          <input
            className="form-input"
            value={replyBaseURL}
            onChange={(e) => setReplyBaseURL(e.target.value)}
            placeholder={DEFAULT_OPENAI_COMPAT_BASE_URL}
            autoComplete="off"
          />
          <div className="form-hint">
            回复模型同样建议填接口根路径。当前支持直接粘贴 `/chat/completions` 或 `/models`，保存后会按兼容路径自动请求。
          </div>
        </div>

        <button className="btn btn-secondary" onClick={handleTestConnection} disabled={!replyApiKey || testing}>
          {testing ? t('settings.testConnection.testing') : t('settings.testConnection')}
        </button>

        <div className="service-diagnostics">
          <div className="service-diagnostics__title">最近诊断</div>
          <div className="service-diagnostics__grid">
            <ServiceDiagnosticCard
              title="连接测试"
              result={replyConnectionResult}
              emptyText="还没有执行回复模型连接测试。"
              successDetail={replyConnectionDetail}
              failureDetail={replyConnectionResult?.error}
              categoryLabel={getDiagnosticCategoryLabel(replyConnectionResult?.errorCategory)}
              nextStep={getDiagnosticNextStep(replyConnectionResult?.errorCategory)}
              actions={replyConnectionActions}
              recentSuccessMeta={
                replyLastSuccessConnection?.success
                  ? `最近成功：${formatDiagnosticTimestamp(replyLastSuccessConnection.checkedAt)}`
                  : undefined
              }
              onCopy={() =>
                void copyDiagnostic(
                  '回复模型 / 连接测试',
                  replyConnectionResult,
                  replyConnectionResult?.success ? replyConnectionDetail : replyConnectionResult?.error
                )
              }
            />
            <ServiceDiagnosticCard
              title="拉取模型"
              result={replyModelListResult}
              emptyText="还没有拉取回复模型列表。"
              successDetail={replyModelListDetail}
              failureDetail={replyModelListResult?.error}
              categoryLabel={getDiagnosticCategoryLabel(replyModelListResult?.errorCategory)}
              nextStep={getDiagnosticNextStep(replyModelListResult?.errorCategory)}
              actions={replyModelListActions}
              recentSuccessMeta={
                replyLastSuccessModelList?.success
                  ? `最近成功：${formatDiagnosticTimestamp(replyLastSuccessModelList.checkedAt)}`
                  : undefined
              }
              onCopy={() =>
                void copyDiagnostic(
                  '回复模型 / 拉取模型',
                  replyModelListResult,
                  replyModelListResult?.success ? replyModelListDetail : replyModelListResult?.error
                )
              }
            />
          </div>
        </div>
      </div>

      <div className="card base-settings-card base-settings-card--reply-output">
        <div className="card-title">{t('settings.reply')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.reply.mode')}</label>
          <select className="form-input" value={replyMode} onChange={(e) => setReplyMode(e.target.value as ReplyMode)}>
            <option value="typing-with-paste-fallback">{t('settings.reply.mode.hybrid')}</option>
            <option value="typing">{t('settings.reply.mode.typing')}</option>
            <option value="paste">{t('settings.reply.mode.paste')}</option>
          </select>
          <div className="form-hint">{t('settings.reply.mode.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">
            {t('settings.reply.typingCpm')}: {typingCpm}
          </label>
          <div className="typing-cpm-controls">
            <input
              className="typing-cpm-slider"
              type="range"
              min={MIN_TYPING_CPM}
              max={MAX_TYPING_CPM}
              step={10}
              value={typingCpm}
              onChange={(e) => setTypingCpmInput(e.target.value)}
            />
            <div className="typing-cpm-scale">
              <span>{MIN_TYPING_CPM}</span>
              <span>{MAX_TYPING_CPM}</span>
            </div>
            <div className="typing-cpm-presets">
              {TYPING_CPM_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`typing-cpm-preset${typingCpm === preset ? ' active' : ''}`}
                  onClick={() => setTypingCpmInput(String(preset))}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              ref={typingCpmInputRef}
              className="form-input typing-cpm-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={typingCpmInput}
              onChange={(e) => setTypingCpmInput(e.target.value)}
              onBlur={() => setTypingCpmInput(String(normalizeTypingCpmInput(typingCpmInput)))}
              autoComplete="off"
            />
          </div>
          <div className="form-hint">{t('settings.reply.typingCpm.hint')}</div>
        </div>

      </div>

      <div className="card base-settings-card base-settings-card--automation">
        <div className="card-title">自动化安全</div>

        <div className="form-group">
          <label className="form-label">执行模式</label>
          <select
            className="form-input"
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value as AutomationExecutionMode)}
          >
            <option value="auto-send">自动发送</option>
            <option value="draft">草稿模式</option>
            <option value="dry-run">dry-run 空跑</option>
          </select>
          <div className="form-hint">草稿模式只输入不发送；dry-run 不点击、不输入，只记录计划回复。</div>
        </div>

        <div className="form-group">
          <label className="form-label">群聊回复策略</label>
          <select
            className="form-input"
            value={groupReplyMode}
            onChange={(e) => setGroupReplyMode(e.target.value as GroupReplyMode)}
          >
            <option value="off">关闭主动群聊回复</option>
            <option value="mention-only">仅被 @ 时回复</option>
            <option value="mention-or-keyword">@ 或关键词触发</option>
            <option value="whitelist">仅白名单群</option>
          </select>
          <div className="form-hint">结构化群聊识别已接入，关键词触发会优先使用消息摘要内容。</div>
        </div>

        <div className="form-group">
          <label className="form-label">群聊触发关键词</label>
          <textarea
            className="form-input"
            rows={3}
            value={groupTriggerKeywordsInput}
            onChange={(e) => setGroupTriggerKeywordsInput(e.target.value)}
            placeholder="例如：报价, 订单, 在吗"
          />
          <div className="form-hint">用逗号或换行分隔，仅在“@ 或关键词触发”模式下生效。</div>
          <div className="token-editor">
            <input
              className="form-input"
              value={groupTriggerKeywordDraft}
              onChange={(e) => setGroupTriggerKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setGroupTriggerKeywordsInput(appendTokenValue(groupTriggerKeywordsInput, groupTriggerKeywordDraft))
                  setGroupTriggerKeywordDraft('')
                }
              }}
              placeholder="输入一个关键词后回车"
            />
            <button
              type="button"
              className="btn btn-secondary token-editor-btn"
              onClick={() => {
                setGroupTriggerKeywordsInput(appendTokenValue(groupTriggerKeywordsInput, groupTriggerKeywordDraft))
                setGroupTriggerKeywordDraft('')
              }}
            >
              添加
            </button>
          </div>
          {groupTriggerKeywords.length > 0 ? (
            <div className="token-list">
              {groupTriggerKeywords.map((item) => (
                <button
                  type="button"
                  key={item}
                  className="token-chip"
                  onClick={() =>
                    setGroupTriggerKeywordsInput(listToInput(groupTriggerKeywords.filter((keyword) => keyword !== item)))
                  }
                  title="点击删除"
                >
                  <span>{item}</span>
                  <span className="token-chip-remove">×</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="form-group">
          <label className="form-label">群白名单</label>
          <textarea
            className="form-input"
            rows={3}
            value={groupWhitelistInput}
            onChange={(e) => setGroupWhitelistInput(e.target.value)}
            placeholder="例如：客户支持群, VIP 订单群"
          />
          <div className="form-hint">用逗号或换行分隔，仅在“仅白名单群”模式下生效，按群名匹配。</div>
          <div className="token-editor">
            <input
              className="form-input"
              value={groupWhitelistDraft}
              onChange={(e) => setGroupWhitelistDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  setGroupWhitelistInput(appendTokenValue(groupWhitelistInput, groupWhitelistDraft))
                  setGroupWhitelistDraft('')
                }
              }}
              placeholder="输入一个群名后回车"
            />
            <button
              type="button"
              className="btn btn-secondary token-editor-btn"
              onClick={() => {
                setGroupWhitelistInput(appendTokenValue(groupWhitelistInput, groupWhitelistDraft))
                setGroupWhitelistDraft('')
              }}
            >
              添加
            </button>
          </div>
          {groupWhitelist.length > 0 ? (
            <div className="token-list">
              {groupWhitelist.map((item) => (
                <button
                  type="button"
                  key={item}
                  className="token-chip"
                  onClick={() =>
                    setGroupWhitelistInput(listToInput(groupWhitelist.filter((group) => group !== item)))
                  }
                  title="点击删除"
                >
                  <span>{item}</span>
                  <span className="token-chip-remove">×</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="automation-grid">
          <div className="form-group">
            <label className="form-label">最大回复长度：{maxReplyChars}</label>
            <input
              className="form-input"
              type="number"
              min={1}
              max={8000}
              value={maxReplyCharsInput}
              onChange={(e) => setMaxReplyCharsInput(e.target.value)}
              onBlur={() => setMaxReplyCharsInput(String(maxReplyChars))}
            />
          </div>

          <div className="form-group">
            <label className="form-label">全局每分钟上限：{globalRateLimit}</label>
            <input
              className="form-input"
              type="number"
              min={1}
              max={120}
              value={globalRateLimitInput}
              onChange={(e) => setGlobalRateLimitInput(e.target.value)}
              onBlur={() => setGlobalRateLimitInput(String(globalRateLimit))}
            />
          </div>

          <div className="form-group">
            <label className="form-label">单会话每分钟上限：{perChatRateLimit}</label>
            <input
              className="form-input"
              type="number"
              min={1}
              max={60}
              value={perChatRateLimitInput}
              onChange={(e) => setPerChatRateLimitInput(e.target.value)}
              onBlur={() => setPerChatRateLimitInput(String(perChatRateLimit))}
            />
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleSaveSettings} style={{ width: '100%' }}>
          {t('settings.saveSettings')}
        </button>
      </div>
    </div>
  )
}

function AgentPanel(): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>(BUILTIN_PROVIDER_CATALOG)
  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDER_CATALOG[0]?.id || '')
  const [activeId, setActiveId] = useState('doubao')
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({})
  const [currentSettings, setCurrentSettings] = useState<AppSettings | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [updatingCatalog, setUpdatingCatalog] = useState(false)
  const selectedProvider = catalog.find((provider) => provider.id === selectedId) || catalog[0]

  const loadSettingsAndCatalog = useCallback(async (forceUpdate: boolean) => {
    setLoadingCatalog(!forceUpdate)
    setUpdatingCatalog(forceUpdate)
    try {
      const [settings, result] = await Promise.all([
        window.electron?.invoke('settings:getAll') as Promise<AppSettings | undefined>,
        window.electron?.invoke(forceUpdate ? 'providerHub:update' : 'providerHub:getCatalog') as Promise<ProviderHubResult>
      ])

      const nextCatalog = mergeProviderCatalog(result?.catalog?.providers || [])
      const nextActiveId = settings?.chatProvider?.installed?.id || 'doubao'
      setCatalog(nextCatalog)
      setCurrentSettings(settings || null)
      setActiveId(nextActiveId)
      setSelectedId((current) => current || nextActiveId || BUILTIN_PROVIDER_CATALOG[0]?.id || nextCatalog[0]?.id || '')
      setProviderDrafts((prev) => ({
        ...prev,
        doubao: {
          ...getProviderDefaults(BUILTIN_PROVIDER_CATALOG[0]),
          ...(prev.doubao || {}),
          ...(!settings?.chatProvider?.installed ? settings?.chatProvider?.config || {} : {})
        },
        [nextActiveId]: {
          ...getProviderDefaults(nextCatalog.find((provider) => provider.id === nextActiveId)),
          ...(prev[nextActiveId] || {}),
          ...(settings?.chatProvider?.config || {})
        }
      }))

      if (result && !result.success) {
        showToast(`智能体列表加载失败: ${result.error || ''}`, 'error')
      } else if (forceUpdate) {
        showToast('智能体列表已更新', 'success')
      }
    } finally {
      setLoadingCatalog(false)
      setUpdatingCatalog(false)
    }
  }, [])

  useEffect(() => {
    void loadSettingsAndCatalog(false)
  }, [loadSettingsAndCatalog])

  const selectedValues = useMemo(
    () => getProviderValues(providerDrafts, selectedProvider, currentSettings),
    [currentSettings, providerDrafts, selectedProvider]
  )

  const setProviderValue = useCallback(
    (fieldKey: string, value: string) => {
      if (!selectedProvider) return
      setProviderDrafts((prev) => ({
        ...prev,
        [selectedProvider.id]: {
          ...getProviderValues(prev, selectedProvider, currentSettings),
          [fieldKey]: value
        }
      }))
    },
    [currentSettings, selectedProvider]
  )

  const persistProvider = useCallback(
    async (provider: ProviderCatalogItem, values: Record<string, string>) => {
      const missing = getMissingRequiredFields(provider, values)
      if (missing.length > 0) {
        showToast(`缺少必填项: ${missing.join('、')}`, 'error')
        return false
      }

      if (provider.id === 'doubao') {
        await window.electron?.invoke('settings:set', {
          chatProvider: {
            manifestUrl: '',
            installed: null,
            config: values
          }
        })
        const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
        await window.electron?.invoke('engine:updateConfig', settings)
        setCurrentSettings(settings)
        setActiveId('doubao')
        return true
      }

      const installResult = await window.electron?.invoke('provider:installFromUrl', provider.manifestUrl)
      if (!installResult?.success) {
        showToast(installResult?.error || '智能体安装失败', 'error')
        return false
      }

      await window.electron?.invoke('settings:set', {
        chatProvider: {
          manifestUrl: provider.manifestUrl,
          installed: installResult.installed,
          config: values
        }
      })
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
      await window.electron?.invoke('engine:updateConfig', settings)
      setCurrentSettings(settings)
      setActiveId(provider.id)
      return true
    },
    [currentSettings]
  )

  const handleSaveConfig = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('智能体配置已保存', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  const handleActivate = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('已切换当前智能体', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <div className="settings-title-row">
            <h1>智能体</h1>
            <button
              className="icon-action refresh-action"
              onClick={() => loadSettingsAndCatalog(true)}
              disabled={updatingCatalog}
              title={updatingCatalog ? '更新中...' : '更新列表'}
              aria-label={updatingCatalog ? '更新中' : '更新智能体列表'}
            >
              <span className={updatingCatalog ? 'refresh-icon spinning' : 'refresh-icon'}>
                <RefreshIcon />
              </span>
            </button>
            {updatingCatalog ? <span className="inline-status">更新中...</span> : null}
          </div>
          <p>选择负责聊天分析和内容生成的智能体，并维护各自配置。</p>
        </div>
      </div>

      {loadingCatalog ? (
        <div className="provider-hub-meta">
          <span className="spinner" />
          正在加载远端智能体列表
        </div>
      ) : null}

      <div className="provider-layout">
        <div className="provider-list">
          {!loadingCatalog && catalog.length === 0 ? (
            <div className="provider-empty">暂无可用智能体，请点击更新列表。</div>
          ) : null}
          {catalog.map((provider) => {
            const description = provider.description || provider.name
            const active = activeId === provider.id

            return (
              <button
                key={provider.id}
                className={`provider-card ${selectedId === provider.id ? 'selected' : ''} ${active ? 'active' : ''}`}
                onClick={() => setSelectedId(provider.id)}
              >
                <div className="provider-card-top">
                  <span className="provider-name">{provider.name}</span>
                  {active ? (
                    <span className="provider-status" title="当前启用" aria-label="当前启用">
                      <span className="provider-status-dot" />
                      启用中
                    </span>
                  ) : null}
                </div>
                <div className="provider-desc" title={description}>
                  {description}
                </div>
                <div className="provider-version">v{provider.version}</div>
              </button>
            )
          })}
        </div>

        <div className={`card provider-config-card${selectedProvider?.id === activeId ? ' provider-config-card--active' : ''}`}>
          {selectedProvider ? (
            <>
              <div className="provider-config-header">
                <div>
                  <div className="card-title">智能体配置</div>
                  <h2>{selectedProvider.name}</h2>
                </div>
                <span className="provider-version">v{selectedProvider.version}</span>
              </div>

              {selectedProvider.configSchema.fields.map((field) => (
                <ProviderFieldInput
                  key={field.key}
                  field={field}
                  value={selectedValues[field.key] || ''}
                  onChange={(value) => setProviderValue(field.key, value)}
                />
              ))}

              <div className="provider-actions">
                <button className="btn btn-secondary" onClick={handleSaveConfig}>
                  保存配置
                </button>
                <button className="btn btn-primary" onClick={handleActivate}>
                  启用此智能体
                </button>
              </div>
            </>
          ) : (
            <div className="provider-empty">没有选中的智能体。</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderFieldInput({
  field,
  value,
  onChange
}: {
  field: ProviderConfigField
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`form-group provider-field${field.required ? ' provider-field--required' : ''}${field.readonly ? ' provider-field--readonly' : ''} provider-field--${field.type}`}
    >
      <label className="form-label">
        {field.label}
        {field.required ? <span className="required-mark"> *</span> : null}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={4}
          readOnly={field.readonly}
        />
      ) : field.type === 'select' ? (
        <select
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={field.readonly}
        >
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="form-input"
          type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
          readOnly={field.readonly}
        />
      )}
      {field.hint ? <div className="form-hint">{field.hint}</div> : null}
    </div>
  )
}

function mergeProviderCatalog(remoteProviders: ProviderCatalogItem[]): ProviderCatalogItem[] {
  const remoteOnly = remoteProviders.filter(
    (provider) => !BUILTIN_PROVIDER_CATALOG.some((builtin) => builtin.id === provider.id)
  )
  return [...BUILTIN_PROVIDER_CATALOG, ...remoteOnly]
}

function getProviderDefaults(provider: ProviderCatalogItem | undefined): Record<string, string> {
  if (!provider) return {}
  return provider.configSchema.fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.key] = field.defaultValue || ''
    return acc
  }, {})
}

function getProviderValues(
  drafts: Record<string, Record<string, string>>,
  provider: ProviderCatalogItem | undefined,
  settings: AppSettings | null
): Record<string, string> {
  if (!provider) return {}
  const defaults = getProviderDefaults(provider)
  if (provider.id === 'doubao') {
    return {
      ...defaults,
      ...(settings?.chatProvider.installed ? {} : settings?.chatProvider.config || {}),
      ...(drafts.doubao || {})
    }
  }
  return {
    ...defaults,
    ...(settings?.chatProvider.installed?.id === provider.id ? settings.chatProvider.config : {}),
    ...(drafts[provider.id] || {})
  }
}

function getMissingRequiredFields(
  provider: ProviderCatalogItem,
  values: Record<string, string>
): string[] {
  return provider.configSchema.fields
    .filter((field) => field.required && !values[field.key]?.trim())
    .map((field) => field.label)
}

let _showToast: ((msg: string, type: 'success' | 'error') => void) | null = null

function showToast(msg: string, type: 'success' | 'error'): void {
  _showToast?.(msg, type)
}

function Toast(): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  const publishToast = useCallback((msg: string, t: 'success' | 'error') => {
    setMessage(msg)
    setType(t)
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), 2500)
  }, [])

  useEffect(() => {
    _showToast = publishToast
    return () => {
      if (_showToast === publishToast) {
        _showToast = null
      }
    }
  }, [publishToast])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
