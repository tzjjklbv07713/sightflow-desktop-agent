import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AutomationTrace, AutomationTraceStats } from '../core/automation-trace'
import { redactTraces, redactSettingsSummary, type RedactionOptions } from '../core/redact'

export interface DiagnosticsExportInput {
  settingsSummary: unknown
  traces: AutomationTrace[]
  stats: AutomationTraceStats
  licenseState: unknown
  knowledgeCount: number
}

export interface DiagnosticsExportOptions {
  redact?: boolean
  redactOptions?: RedactionOptions
}

export async function exportDiagnosticsPackage(
  input: DiagnosticsExportInput,
  options: DiagnosticsExportOptions = {}
): Promise<{
  success: boolean
  filePath?: string
  error?: string
  redacted?: boolean
}> {
  try {
    const redact = options.redact !== false // default: redact on
    const payload = {
      exportedAt: new Date().toISOString(),
      platform: process.platform,
      app: 'sightflow-desktop-agent',
      redacted: redact,
      settingsSummary: redact ? redactSettingsSummary(input.settingsSummary, options.redactOptions) : input.settingsSummary,
      traces: redact ? redactTraces(input.traces, options.redactOptions) : input.traces,
      stats: input.stats,
      licenseState: redact ? redactSettingsSummary(input.licenseState, options.redactOptions) : input.licenseState,
      knowledgeCount: input.knowledgeCount
    }
    const dir = path.join(os.tmpdir(), 'sightflow-desktop-agent', 'diagnostics')
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return { success: true, filePath, redacted: redact }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
