// src/main/settings-export-service.ts
//
// 锟斤拷锟矫客凤拷锟斤拷锟斤拷锟矫碉拷锟诫导锟斤拷锟斤拷锟今（计伙拷锟斤拷 6.6锟斤拷锟斤拷
// 锟结供锟斤拷锟斤拷锟缴诧拷拇锟斤拷锟斤拷锟?serializeSettings / parseSettings锟斤拷锟皆硷拷一锟斤拷
// file-backed 锟斤拷锟斤拷 SettingsExportService锟斤拷锟斤拷锟斤拷通锟斤拷 IPC 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?// settings:export / settings:import锟斤拷

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AppType,
  BoxRegions,
  CaptureStrategy,
  ScreenRect
} from '../core/rpa/types'

export interface ExportableSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: { apiKey: string; model: string; baseURL: string }
  replyModel: { apiKey: string; model: string; baseURL: string }
  chatProvider: {
    manifestUrl: string
    installedId: string | null
    config: Record<string, string>
  }
  defaultCaptureStrategy: CaptureStrategy
  reply: { mode: 'typing' | 'paste' | 'typing-with-paste-fallback'; typingCpm: number }
  automation: Record<string, unknown>
  capture: Partial<Record<AppType, { strategy: CaptureStrategy; regions: BoxRegions | null }>>
}

export interface ExportEnvelope {
  kind: 'sightflow-settings'
  version: 1
  exportedAt: string
  machineHint: string
  settings: ExportableSettings
}

export const SETTINGS_EXPORT_VERSION = 1
export const SETTINGS_EXPORT_KIND = 'sightflow-settings'

const VALID_APP_TYPES: AppType[] = [
  'wechat',
  'wework',
  'dingtalk',
  'lark',
  'slack',
  'telegram',
  'generic'
]
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']
const VALID_REPLY_MODES: ExportableSettings['reply']['mode'][] = [
  'typing',
  'paste',
  'typing-with-paste-fallback'
]

export function serializeSettings(raw: unknown, machineHint = 'unknown'): ExportEnvelope {
  const settings = sanitizeSettings(raw)
  return {
    kind: SETTINGS_EXPORT_KIND,
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    machineHint,
    settings
  }
}

export function parseSettings(text: string): {
  ok: boolean
  envelope?: ExportEnvelope
  settings?: ExportableSettings
  error?: string
} {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `invalid_json: ${(err as Error).message}` }
  }
  return validateEnvelope(raw)
}

export function validateEnvelope(raw: unknown): {
  ok: boolean
  envelope?: ExportEnvelope
  settings?: ExportableSettings
  error?: string
} {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'envelope_not_object' }
  const envelope = raw as Record<string, unknown>
  if (envelope.kind !== SETTINGS_EXPORT_KIND) return { ok: false, error: 'envelope_wrong_kind' }
  if (envelope.version !== SETTINGS_EXPORT_VERSION) return { ok: false, error: 'envelope_unsupported_version' }
  if (!envelope.settings || typeof envelope.settings !== 'object') {
    return { ok: false, error: 'envelope_missing_settings' }
  }
  try {
    const settings = sanitizeSettings(envelope.settings)
    return {
      ok: true,
      envelope: {
        kind: SETTINGS_EXPORT_KIND,
        version: SETTINGS_EXPORT_VERSION,
        exportedAt:
          typeof envelope.exportedAt === 'string' ? envelope.exportedAt : new Date().toISOString(),
        machineHint: typeof envelope.machineHint === 'string' ? envelope.machineHint : 'unknown',
        settings
      },
      settings
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export class SettingsExportService {
  constructor(private readonly filePath: string) {}

  async export(raw: unknown, machineHint = 'unknown'): Promise<{ ok: boolean; filePath?: string; error?: string }> {
    try {
      const envelope = serializeSettings(raw, machineHint)
      await writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
      return { ok: true, filePath: this.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async import(): Promise<{
    ok: boolean
    settings?: ExportableSettings
    filePath?: string
    error?: string
  }> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      const result = parseSettings(text)
      if (!result.ok || !result.settings) return { ok: false, error: result.error || 'unknown_error' }
      return { ok: true, settings: result.settings, filePath: this.filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}

export function createSettingsExportService(userDataPath: string): SettingsExportService {
  return new SettingsExportService(path.join(userDataPath, 'settings-export.json'))
}

// ---------- sanitizers ----------

function sanitizeSettings(raw: unknown): ExportableSettings {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const appType = coerceAppType(root.appType)
  const vision = coerceCredentials(root.vision)
  const replyModel = coerceCredentials(root.replyModel)
  const reply = coerceReply(root.reply)
  const chatProvider = coerceChatProvider(root.chatProvider, appType)
  const defaultCaptureStrategy = coerceStrategy(root.defaultCaptureStrategy)
  const automation = isRecord(root.automation) ? { ...(root.automation as Record<string, unknown>) } : {}
  const capture = coerceCapture(root.capture)
  const locale = coerceLocale(root.locale)

  return {
    locale,
    appType,
    vision,
    replyModel,
    chatProvider,
    defaultCaptureStrategy,
    reply,
    automation,
    capture
  }
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

function coerceLocale(raw: unknown): ExportableSettings['locale'] {
  return raw === 'en' || raw === 'zh' ? raw : 'zh'
}

function coerceCredentials(raw: unknown): { apiKey: string; model: string; baseURL: string } {
  const r = isRecord(raw) ? raw : {}
  return {
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    model: typeof r.model === 'string' ? r.model : '',
    baseURL: typeof r.baseURL === 'string' ? r.baseURL : ''
  }
}

function coerceReply(raw: unknown): ExportableSettings['reply'] {
  const r = isRecord(raw) ? raw : {}
  const mode = VALID_REPLY_MODES.includes(r.mode as ExportableSettings['reply']['mode'])
    ? (r.mode as ExportableSettings['reply']['mode'])
    : 'typing-with-paste-fallback'
  const cpm = Number(r.typingCpm)
  return {
    mode,
    typingCpm: Number.isFinite(cpm) ? Math.max(60, Math.min(1200, Math.round(cpm))) : 280
  }
}

function coerceChatProvider(
  raw: unknown,
  appType: AppType
): ExportableSettings['chatProvider'] {
  const r = isRecord(raw) ? raw : {}
  const installed = isRecord(r.installed) ? (r.installed as Record<string, unknown>) : null
  const installedId = (() => {
    if (installed && typeof installed.id === 'string' && installed.id.length > 0) return installed.id
    if (typeof r.installedId === 'string' && r.installedId.length > 0) return r.installedId
    return null
  })()
  const manifestUrl = typeof r.manifestUrl === 'string' ? r.manifestUrl : ''
  const config: Record<string, string> = {}
  if (isRecord(r.config)) {
    for (const [key, value] of Object.entries(r.config as Record<string, unknown>)) {
      if (typeof value === 'string') config[key] = value
    }
  }
  void appType // currently unused, reserved for future per-app provider defaults
  return { manifestUrl, installedId, config }
}

function coerceCapture(raw: unknown): ExportableSettings['capture'] {
  const out: ExportableSettings['capture'] = {}
  if (!isRecord(raw)) return out
  for (const appType of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[appType]
    if (!isRecord(value)) continue
    const v = value as Record<string, unknown>
    out[appType] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }
  return out
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!isRecord(raw)) return null
  const contactList = coerceRect(raw.contactList)
  const chatMain = coerceRect(raw.chatMain)
  const inputBox = coerceRect(raw.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(raw.unreadIndicator),
    displayId: typeof raw.displayId === 'number' ? raw.displayId : undefined,
    scaleFactor: typeof raw.scaleFactor === 'number' ? raw.scaleFactor : undefined,
    capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : Date.now()
  }
}

function coerceRect(raw: unknown): ScreenRect | null {
  if (!isRecord(raw)) return null
  const x = Number((raw as Record<string, unknown>).x)
  const y = Number((raw as Record<string, unknown>).y)
  const width = Number((raw as Record<string, unknown>).width)
  const height = Number((raw as Record<string, unknown>).height)
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  return { x, y, width, height }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

