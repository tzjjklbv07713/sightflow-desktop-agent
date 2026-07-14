// src/main/tests/test-settings-export-service.ts
//
// Unit tests for the settings export/import envelope and the file-backed
// SettingsExportService. Pure-Node, no Electron required so it can live in
// the core test runner.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExportableSettings } from '../settings-export-service'
import {
  parseSettings,
  serializeSettings,
  validateEnvelope,
  createSettingsExportService,
  SettingsExportService,
  SETTINGS_EXPORT_KIND,
  SETTINGS_EXPORT_VERSION
} from '../settings-export-service'

import type { BoxRegions } from '../../core/rpa/types'

interface TestResult { name: string; pass: boolean; detail?: string }

const results: TestResult[] = []
let failed = 0

function expect(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    results.push({ name, pass: true })
  } else {
    results.push({ name, pass: false, detail })
    failed += 1
  }
}

function buildRawSettings(): ExportableSettings {
  const regions: BoxRegions = {
    contactList: { x: 0, y: 0, width: 10, height: 10 },
    chatMain: { x: 10, y: 0, width: 100, height: 200 },
    inputBox: { x: 110, y: 0, width: 300, height: 50 },
    unreadIndicator: { x: 0, y: 0, width: 5, height: 5 },
    capturedAt: 1700000000000
  }
  return {
    locale: 'zh',
    appType: 'wechat',
    vision: { apiKey: 'vk', model: 'gpt-v', baseURL: 'https://v.example.com' },
    replyModel: { apiKey: 'rk', model: 'gpt-r', baseURL: 'https://r.example.com' },
    chatProvider: { manifestUrl: 'https://m.example.com', installed: { id: 'core' }, config: { theme: 'light' } } as never,
    defaultCaptureStrategy: 'vlm',
    reply: { mode: 'typing-with-paste-fallback', typingCpm: 480 },
    automation: { foo: 'bar' },
    capture: { wechat: { strategy: 'box-select', regions } }
  }
}

function buildPartialRaw(): Record<string, unknown> {
  return {
    locale: 'en',
    appType: 'wework',
    vision: { apiKey: '', model: 'm', baseURL: 'b' },
    reply: { mode: 'paste', typingCpm: 30 }
  }
}

async function exerciseFileService(): Promise<{ ok: boolean; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sightflow-settings-'))
  const file = join(dir, 'settings-export.json')
  const svc = createSettingsExportService(dir)
  const raw = buildRawSettings()
  const r = await svc.export(raw, 'machine-B')
  if (!r.ok) return { ok: false, error: r.error }
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  if (onDisk.kind !== SETTINGS_EXPORT_KIND) return { ok: false, error: 'on disk kind mismatch' }
  const imp = await svc.import()
  if (!imp.ok || !imp.settings) return { ok: false, error: imp.error }
  if (imp.settings.vision.apiKey !== 'vk') return { ok: false, error: 'vision apiKey mismatch' }
  if (imp.settings.appType !== 'wechat') return { ok: false, error: 'appType mismatch' }
  if (imp.settings.capture.wechat?.regions?.chatMain.width !== 100) return { ok: false, error: 'region width mismatch' }
  writeFileSync(file, 'not json', 'utf8')
  const broken = new SettingsExportService(file)
  const b = await broken.import()
  if (b.ok) return { ok: false, error: 'expected import to fail on malformed json' }
  if (!/json/i.test(b.error || '')) return { ok: false, error: 'expected json parse error, got ' + b.error }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}

async function doRun(): Promise<void> {
  const raw = buildRawSettings()
  const envelope = serializeSettings(raw, 'machine-A')
  expect('serialize uses known kind', envelope.kind === SETTINGS_EXPORT_KIND, envelope.kind)
  expect('serialize uses known version', envelope.version === SETTINGS_EXPORT_VERSION, String(envelope.version))
  expect('serialize preserves machineHint', envelope.machineHint === 'machine-A', envelope.machineHint)
  expect('serialize emits exportedAt ISO', typeof envelope.exportedAt === 'string' && /T/.test(envelope.exportedAt), envelope.exportedAt)
  expect('serialize preserves appType', envelope.settings.appType === 'wechat', envelope.settings.appType)
  expect('serialize preserves vision.apiKey', envelope.settings.vision.apiKey === 'vk', envelope.settings.vision.apiKey)
  expect('serialize preserves chatProvider.config', envelope.settings.chatProvider.config.theme === 'light', JSON.stringify(envelope.settings.chatProvider.config))
  expect('serialize preserves capture regions', envelope.settings.capture.wechat?.regions?.chatMain.width === 100, JSON.stringify(envelope.settings.capture.wechat?.regions))

  const round = parseSettings(JSON.stringify(envelope))
  expect('round-trip ok', round.ok, JSON.stringify(round))
  expect('round-trip preserves appType', round.settings?.appType === 'wechat', String(round.settings?.appType))
  expect('round-trip preserves reply mode', round.settings?.reply.mode === 'typing-with-paste-fallback', String(round.settings?.reply.mode))
  expect('round-trip preserves reply typingCpm', round.settings?.reply.typingCpm === 480, String(round.settings?.reply.typingCpm))
  expect('round-trip preserves chatProvider', round.settings?.chatProvider.installedId === 'core', String(round.settings?.chatProvider.installedId))
  expect('round-trip preserves automation', (round.settings?.automation)?.foo === 'bar', JSON.stringify(round.settings?.automation))

  const partial = buildPartialRaw()
  const partialEnv = serializeSettings(partial)
  const back = parseSettings(JSON.stringify(partialEnv))
  expect('partial input fills locale', back.settings?.locale === 'en', String(back.settings?.locale))
  expect('partial input preserves appType', back.settings?.appType === 'wework', String(back.settings?.appType))
  expect('partial input preserves explicit paste reply mode', back.settings?.reply.mode === 'paste', String(back.settings?.reply.mode))
  expect('partial input clamps typingCpm to >=60', (back.settings?.reply.typingCpm ?? 0) >= 60, String(back.settings?.reply.typingCpm))
  expect('partial input clamps typingCpm to <=1200', (back.settings?.reply.typingCpm ?? 9999) <= 1200, String(back.settings?.reply.typingCpm))

  const tooHigh = serializeSettings({ reply: { mode: 'typing', typingCpm: 99999 } })
  const back2 = parseSettings(JSON.stringify(tooHigh))
  expect('over-cap typingCpm clamps to 1200', back2.settings?.reply.typingCpm === 1200, String(back2.settings?.reply.typingCpm))

  const tooLow = serializeSettings({ reply: { mode: 'typing', typingCpm: 5 } })
  const back3 = parseSettings(JSON.stringify(tooLow))
  expect('under-cap typingCpm clamps to 60', back3.settings?.reply.typingCpm === 60, String(back3.settings?.reply.typingCpm))

  const wrongKind = parseSettings(JSON.stringify({ kind: 'something-else', version: 1, settings: {} }))
  expect('parse rejects wrong kind', wrongKind.ok === false && /kind/i.test(wrongKind.error || ''), wrongKind.error)
  const wrongVer = parseSettings(JSON.stringify({ kind: SETTINGS_EXPORT_KIND, version: 99, settings: {} }))
  expect('parse rejects unsupported version', wrongVer.ok === false && /version/i.test(wrongVer.error || ''), wrongVer.error)
  const missingSettings = parseSettings(JSON.stringify({ kind: SETTINGS_EXPORT_KIND, version: 1 }))
  expect('parse rejects missing settings', missingSettings.ok === false && /settings/i.test(missingSettings.error || ''), missingSettings.error)
  const noJson = parseSettings('not json {')
  expect('parse rejects non-JSON', noJson.ok === false && /json/i.test(noJson.error || ''), noJson.error)
  const nullEnv = validateEnvelope(null)
  expect('validate rejects null', nullEnv.ok === false, nullEnv.error)

  const fileRound = await exerciseFileService()
  expect('file-backed round-trip preserves settings', fileRound.ok, fileRound.error)

  console.log('[SettingsExportService] results', JSON.stringify(results, null, 2))
  if (failed > 0) {
    console.error('[SettingsExportService] failed: ' + failed)
    process.exit(1)
  }
  console.log('[SettingsExportService] all passed')
}

doRun().catch((error) => {
  console.error('test-settings-export-service crashed', error)
  process.exit(1)
})

