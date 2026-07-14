import crypto from 'node:crypto'
import os from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface LicenseState {
  machineId: string
  activated: boolean
  plan: 'trial' | 'commercial'
  activatedAt?: string
  expiresAt?: string
  lastCheckedAt?: string
  message?: string
}

export class LicenseService {
  constructor(private readonly filePath: string) {}

  async getState(): Promise<LicenseState> {
    const machineId = this.machineId()
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content)
      return normalizeState(parsed, machineId)
    } catch {
      return this.trialState(machineId)
    }
  }

  async activate(licenseKey: string): Promise<LicenseState> {
    const key = licenseKey.trim()
    const machineId = this.machineId()
    if (!key) {
      return { ...this.trialState(machineId), message: 'License key is required' }
    }

    const now = new Date()
    const state: LicenseState = {
      machineId,
      activated: true,
      plan: key.startsWith('SF-COM-') ? 'commercial' : 'trial',
      activatedAt: now.toISOString(),
      expiresAt: key.startsWith('SF-COM-')
        ? addDays(now, 366).toISOString()
        : addDays(now, 14).toISOString(),
      lastCheckedAt: now.toISOString(),
      message: 'activated'
    }
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return state
  }

  private trialState(machineId: string): LicenseState {
    const now = new Date()
    return {
      machineId,
      activated: false,
      plan: 'trial',
      expiresAt: addDays(now, 14).toISOString(),
      message: 'trial'
    }
  }

  private machineId(): string {
    const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)
  }
}

export function createLicenseService(userDataPath: string): LicenseService {
  return new LicenseService(path.join(userDataPath, 'license.json'))
}

function normalizeState(raw: unknown, machineId: string): LicenseState {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    machineId,
    activated: source.activated === true,
    plan: source.plan === 'commercial' ? 'commercial' : 'trial',
    activatedAt: typeof source.activatedAt === 'string' ? source.activatedAt : undefined,
    expiresAt: typeof source.expiresAt === 'string' ? source.expiresAt : undefined,
    lastCheckedAt: new Date().toISOString(),
    message: typeof source.message === 'string' ? source.message : undefined
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}
