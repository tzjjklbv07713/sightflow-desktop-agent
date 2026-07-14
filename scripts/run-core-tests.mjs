// scripts/run-core-tests.mjs
//
// Unified entry point for the SightFlow desktop-agent core test suite.
// Runs every test-*.ts file under src/core that can be executed in plain
// Node.js (no Electron, no real VLM provider). Failures from any single
// script fail the overall run with a non-zero exit code.
//
// Usage: node scripts/run-core-tests.mjs

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const CORE_DIR = path.join(ROOT, 'src', 'core')
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const NODE_BIN = process.execPath

// Each entry is a path relative to ROOT, plus a human label. Tests that
// require Electron / a live VLM provider are intentionally excluded here;
// they are exercised through `npm run dev:test-*` against a real desktop.
const SUITES = [
  ['src/core/chat/tests/test-reply-quality.ts', 'ReplyQuality (KB+Policy)'],
  ['src/core/tests/test-redact.ts', 'Redact (diagnostics)'],
  ['src/core/chat/tests/test-knowledge-base.ts', 'KnowledgeBase'],
  ['src/core/chat/tests/test-reply-policy-high-risk.ts', 'ReplyPolicy (high-risk)'],
  ['src/core/chat/tests/test-reply-policy-uia.ts', 'ReplyPolicy (UIA group/scope)'],
  ['src/core/chat/tests/test-message-dedupe.ts', 'MessageDedupe'],
  ['src/core/chat/tests/test-rate-limiter.ts', 'RateLimiter'],
  ['src/core/uiautomation/tests/test-chat-messages.ts', 'UIA chat-messages'],
  ['src/core/uiautomation/tests/test-observed-from-uia.ts', 'UIA observed-from-uia'],
  ['src/core/tests/test-session-circuit-breaker.ts', 'Session circuit-breaker'],
  ['src/main/tests/test-settings-export-service.ts', 'SettingsExportService']
]

async function fileExists(p) {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

async function findSuites() {
  // Walk src/core and pick up test-*.ts that aren't on the excluded list.
  const excluded = new Set([
    'test-group-debug.ts', // requires a real VLM provider
    'test-group-rules.ts', // debug-print script, no asserts
    'test-probe.ts', // requires Electron + UI Automation host
    'test-hybrid-perception.ts', // requires a real VLM provider
    'test-screenshot.ts', // requires Electron screen capture
    'test-reply.ts', // requires Electron RPA
    'test-switch.ts', // requires Electron RPA
    'test-vlm-parallel.ts', // requires Electron + VLM
    'test-overlay-capture.ts', // requires Electron overlay window
    'test-workbench-capture.ts' // requires Electron main + stub IPC
  ])
  const discovered = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.name.startsWith('test-') && entry.name.endsWith('.ts') && !excluded.has(entry.name)) {
        discovered.push(full)
      }
    }
  }
  await walk(CORE_DIR)
  return discovered
}

function runOne(suiteAbsPath, label) {
  return new Promise((resolve) => {
    // Invoke tsx through Node directly to avoid .cmd shim resolution issues
    // on Windows when the project path contains spaces.
    const child = spawn(NODE_BIN, [TSX_CLI, suiteAbsPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(`  [${label}] ${text}`)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(`  [${label}] ${text}`)
    })
    child.on('error', (err) => {
      resolve({ ok: false, code: -1, error: err, stdout, stderr })
    })
    child.on('exit', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr })
    })
  })
}

async function main() {
  if (!(await fileExists(TSX_CLI))) {
    console.error(`[run-core-tests] tsx CLI not found at ${TSX_CLI}. Run 'npm install' first.`)
    process.exit(2)
  }

  // Resolve suite paths: prefer the curated ordering, then surface any
  // newly added test-*.ts files that pass the exclude filter.
  const discovered = await findSuites()
  const known = new Set(SUITES.map(([rel]) => path.resolve(ROOT, rel)))
  const ordered = [
    ...SUITES.map(([rel, label]) => ({ abs: path.resolve(ROOT, rel), label })),
    ...discovered
      .filter((abs) => !known.has(abs))
      .map((abs) => ({
        abs,
        label: path.relative(CORE_DIR, abs).replace(/\\/g, '/')
      }))
  ]

  console.log(`[run-core-tests] discovered ${discovered.length} test file(s) under src/core`)
  console.log(`[run-core-tests] running ${ordered.length} suite(s) in sequence`)

  const results = []
  for (const { abs, label } of ordered) {
    if (!(await fileExists(abs))) {
      console.error(`[run-core-tests] missing suite file: ${abs}`)
      results.push({ label, ok: false, code: -1 })
      continue
    }
    console.log(`\n--- ${label} (${path.relative(ROOT, abs)}) ---`)
    const r = await runOne(abs, label)
    results.push({ label, ok: r.ok, code: r.code })
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log('\n[run-core-tests] summary')
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.label} (exit ${r.code})`)
  }
  console.log(`[run-core-tests] ${passed}/${results.length} suites passed`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[run-core-tests] crashed', err)
  process.exit(1)
})

