import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { AppType } from '../rpa/types'
import type { UiAutomationRect } from './probe'

export type ChatMessageDirection = 'self' | 'contact' | 'system' | 'unknown'

export interface UiChatMessageRow {
  messageId: string
  text: string
  senderName: string
  direction: ChatMessageDirection
  automationId?: string
  runtimeId?: number
  className?: string
  controlType?: string
  bounds?: UiAutomationRect | null
}

export interface UiChatMessageSnapshot {
  ok: true
  appType: AppType
  capturedAt: number
  total: number
  rows: UiChatMessageRow[]
  paneBounds?: UiAutomationRect | null
  chatCenterX?: number
}

export type UiChatMessageFailure =
  | { ok: false; appType: AppType; reason: 'unsupported_platform'; message: string }
  | { ok: false; appType: AppType; reason: 'uia_probe_failed'; message: string }
  | { ok: false; appType: AppType; reason: 'no_chat_pane'; message: string }

export type UiChatMessageResult = UiChatMessageSnapshot | UiChatMessageFailure

const MAX_STDOUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 6000
const MAX_ROWS = 24

export async function extractChatMessages(
  appType: AppType,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<UiChatMessageResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      appType,
      reason: 'unsupported_platform',
      message: 'UIAutomation chat extractor only supports Windows'
    }
  }

  try {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(__dirname, 'chat-messages.ps1'),
      '-appType',
      appType,
      '-maxRows',
      String(MAX_ROWS)
    ]
    const stdout = await runPowerShell(args, timeoutMs)
    const parsed = parseResult(stdout)
    if (!parsed) {
      return {
        ok: false,
        appType,
        reason: 'uia_probe_failed',
        message: 'Chat extractor returned an unparsable payload'
      }
    }
    if (!parsed.ok) {
      return {
        ok: false,
        appType,
        reason: parsed.reason === 'no_chat_pane' ? 'no_chat_pane' : 'uia_probe_failed',
        message: parsed.message || 'Chat extractor failed'
      }
    }
    return normalizeSuccess(appType, parsed)
  } catch (error) {
    return {
      ok: false,
      appType,
      reason: 'uia_probe_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function runPowerShell(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      args,
      { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message
          reject(new Error(detail))
          return
        }
        resolve(stdout)
      }
    )
  })
}

interface RawSuccess {
  ok: true
  paneBounds?: UiAutomationRect | null
  chatCenterX?: number
  rows?: RawRow[]
}

interface RawRow {
  text?: string
  senderName?: string
  direction?: string
  automationId?: string
  runtimeId?: string
  className?: string
  controlType?: string
  bounds?: UiAutomationRect | null
}

interface RawFailure {
  ok: false
  reason?: string
  message?: string
}

type RawResult = RawSuccess | RawFailure

function parseResult(raw: string): RawResult | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.ok === true || parsed.ok === false) return parsed as RawResult
    return null
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0])
      if (!parsed || typeof parsed !== 'object') return null
      if (parsed.ok === true || parsed.ok === false) return parsed as RawResult
      return null
    } catch {
      return null
    }
  }
}

function normalizeSuccess(appType: AppType, raw: RawSuccess): UiChatMessageSnapshot {
  const rows = Array.isArray(raw.rows) ? raw.rows : []
  const chatCenterX = typeof raw.chatCenterX === 'number' ? raw.chatCenterX : undefined
  const paneBounds = raw.paneBounds ?? null

  const normalizedRows: UiChatMessageRow[] = rows
    .map((row) => normalizeRow(row, chatCenterX))
    .filter((row): row is UiChatMessageRow => row !== null)

  return {
    ok: true,
    appType,
    capturedAt: Date.now(),
    total: normalizedRows.length,
    rows: normalizedRows,
    paneBounds,
    chatCenterX
  }
}

function normalizeRow(
  row: RawRow | null | undefined,
  chatCenterX: number | undefined
): UiChatMessageRow | null {
  if (!row) return null
  const text = typeof row.text === 'string' ? row.text.trim() : ''
  if (!text) return null
  const direction = normalizeDirection(row.direction, row.bounds, chatCenterX)
  const baseId = row.automationId && row.automationId.length > 0
    ? 'uia:' + row.automationId
    : row.runtimeId && row.runtimeId.length > 0
      ? 'uia:' + row.runtimeId
      : null
  const messageId = baseId ?? hashMessageId(text, row.bounds)
  return {
    messageId,
    text,
    senderName: typeof row.senderName === 'string' ? row.senderName : '',
    direction,
    automationId:
      typeof row.automationId === 'string' && row.automationId ? row.automationId : undefined,
    runtimeId: row.runtimeId ? hashRuntimeId(row.runtimeId) : undefined,
    className: typeof row.className === 'string' && row.className ? row.className : undefined,
    controlType:
      typeof row.controlType === 'string' && row.controlType ? row.controlType : undefined,
    bounds: row.bounds ?? null
  }
}

function normalizeDirection(
  raw: string | undefined,
  bounds: UiAutomationRect | null | undefined,
  chatCenterX: number | undefined
): ChatMessageDirection {
  if (raw === 'self' || raw === 'contact' || raw === 'system' || raw === 'unknown') {
    return raw
  }
  if (!bounds || typeof chatCenterX !== 'number') return 'unknown'
  const centerX = bounds.x + Math.round(bounds.width / 2)
  const offset = centerX - chatCenterX
  if (offset > 24) return 'self'
  if (offset < -24) return 'contact'
  return 'unknown'
}

function hashMessageId(text: string, bounds: UiAutomationRect | null | undefined): string {
  const seed = text + '__' + (bounds?.x ?? 0) + '_' + (bounds?.y ?? 0) + '_' + (bounds?.width ?? 0) + '_' + (bounds?.height ?? 0)
  return 'uia:hash:' + createHash('sha1').update(seed).digest('hex').slice(0, 16)
}

function hashRuntimeId(runtimeId: string): number {
  let hash = 2166136261
  for (let i = 0; i < runtimeId.length; i += 1) {
    hash ^= runtimeId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// Internal helpers exposed only for unit tests. Production callers should
// rely on extractChatMessages, which validates the platform and wraps the
// PowerShell pipeline.
export const __testing__ = {
  normalizeRow,
  normalizeSuccess,
  parseResult
}
