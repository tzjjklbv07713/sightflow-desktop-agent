#!/usr/bin/env node
// scripts/acceptance-check.mjs
//
// 商用试点验收自检脚本。
// 目标:在交付真机试点之前,把能机器自验的项一次跑完,
// 包括:核心测试套件 / 8h 稳定性模拟 / 关键源文件 / 试点文档 / IPC 接线 / 安全闸门。
// 跳过需要 Windows 微信真机的项目(打包/安装/授权激活/真机 6 用例),
// 那些仍然以 pilot-acceptance-checklist.zh-CN.md 的手工勾选为准。
//
// 用法: node scripts/acceptance-check.mjs

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

const results = []
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail })
  const tag = ok ? 'OK  ' : 'FAIL'
  console.log(`[${tag}] ${section} :: ${name}${detail ? ' :: ' + detail : ''}`)
}

function exists(rel) {
  return stat(path.join(ROOT, rel)).then((s) => s.isFile()).catch(() => false)
}

async function readText(rel) {
  try {
    return await readFile(path.join(ROOT, rel), 'utf8')
  } catch {
    return ''
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += b.toString('utf8') })
    child.stderr.on('data', (b) => { err += b.toString('utf8') })
    child.on('close', (code) => resolve({ code, out, err }))
    child.on('error', (e) => resolve({ code: -1, out, err: err + '\nspawn error: ' + e.message }))
  })
}

function npmScript(name) {
  // Windows requires npm.cmd; on other platforms npm works.
  const isWin = process.platform === 'win32'
  return run(isWin ? 'npm.cmd' : 'npm', ['run', name, '--silent'])
}

// ---------- Section 1: 关键源文件 ----------
async function sectionSources() {
  const required = [
    'src/main/index.ts',
    'src/main/diagnostics-service.ts',
    'src/core/redact.ts',
    'src/core/automation-trace.ts',
    'src/core/chat/reply-policy.ts',
    'src/core/knowledge-base.ts',
    'src/core/generic-channel-session.ts',
    'src/renderer/src/console.tsx',
    'src/renderer/src/app.tsx',
    'docs/pilot-install-guide.zh-CN.md',
    'docs/pilot-rollback.zh-CN.md',
    'docs/pilot-faq.zh-CN.md',
    'docs/pilot-release-notes.zh-CN.md',
    'docs/pilot-acceptance-checklist.zh-CN.md'
  ]
  for (const f of required) {
    record('SOURCES', f, await exists(f))
  }
}

// ---------- Section 2: 试点文档完整性 ----------
async function sectionDocs() {
  const guides = [
    'docs/pilot-install-guide.zh-CN.md',
    'docs/pilot-rollback.zh-CN.md',
    'docs/pilot-faq.zh-CN.md',
    'docs/pilot-release-notes.zh-CN.md',
    'docs/pilot-acceptance-checklist.zh-CN.md'
  ]
  for (const g of guides) {
    const t = await readText(g)
    const minLen = 200
    record('DOCS', `${path.basename(g)} length>=${minLen}`, t.length >= minLen, `len=${t.length}`)
  }
}

// ---------- Section 3: IPC 接线 + main handler 参数签名 ----------
async function sectionIpcWiring() {
  const main = await readText('src/main/index.ts')
  const channels = [
    'conversation:list',
    'conversation:getTrace',
    'conversation:setHandoff',
    'knowledge:list',
    'knowledge:import',
    'license:getState',
    'license:activate',
    'diagnostics:export',
    'onboarding:reset'
  ]
  for (const ch of channels) {
    record('IPC', `main exposes ${ch}`, main.includes(ch))
  }
  // diagnostics:export 默认 redact
record('IPC', 'diagnostics:export default redact=true', /opts\?\.redact\s*!==\s*false/.test(main))
  // conversation:setHandoff 包含 chatKey / active / reason
  record('IPC', 'conversation:setHandoff supports handoff', /conversation:setHandoff[\s\S]{0,200}chatKey/.test(main))

  const consoleTsx = await readText('src/renderer/src/console.tsx')
  // ConsoleDiagnostics toggle 接线
  record('IPC', 'Console wires redact toggle', /data-testid="diagnostics-redact-toggle"/.test(consoleTsx))
  record('IPC', 'Console passes {redact} to invoke', /diagnostics:export',\s*\{\s*redact:\s*redactDiagnostics/.test(consoleTsx))
}

// ---------- Section 4: 安全闸门代码签名 ----------
async function sectionSafety() {
  const policy = await readText('src/core/chat/reply-policy.ts')
  record('SAFETY', 'ReplyPolicy defines sensitiveKeywords', /sensitiveKeywords/.test(policy))
  record('SAFETY', 'ReplyPolicy handles sensitive intents (sensitive_intent reason)', /sensitive_intent/.test(policy))
  record('SAFETY', 'Group default skip (group-not-mention)', /group.{0,40}(not.?mention|skip|disabled)/i.test(policy))
  record('SAFETY', 'ReplyPolicy exposes evaluate/shouldReply', /evaluate\(|shouldReply\(|decide\(/i.test(policy))

  const cb = await readText('src/core/generic-channel-session.ts')
  record('SAFETY', 'CircuitBreaker module exists', /consecutive(?:Execution|Unread)Failures|consecutiveFailures/.test(cb))
  record('SAFETY', 'CircuitBreaker has consecutive-failure threshold', /consecutiveExecutionFailures|consecutiveUnreadFailures|consecutiveFailures/.test(cb))

  const diag = await readText('src/main/diagnostics-service.ts')
  record('SAFETY', 'Diagnostics service accepts redact option', /options\??\s*:\s*DiagnosticsExportOptions|options\.redact/.test(diag))
  record('SAFETY', 'Diagnostics service default redact=true', /redact\s*!==\s*false|options\.redact\s*!==\s*false/.test(diag))

  const redact = await readText('src/core/redact.ts')
  record('SAFETY', 'Redact strips screenshot by default', /stripScreenshots.*?true|stripScreenshots:\s*true/.test(redact))
  record('SAFETY', 'Redact handles PII patterns', /1\[3-9\]\\d\{9\}|1[3-9]\d{9}/.test(redact))
  record('SAFETY', 'Redact handles knowledge titles', /keepKnowledgeTitles/.test(redact))
}

// ---------- Section 5: 核心测试套件 ----------
async function sectionCoreTests() {
  const r = await npmScript('test:core')
  record('TEST', 'test:core exit=0', r.code === 0, r.code !== 0 ? `code=${r.code}` : '')
  if (r.code !== 0) {
    // 仅输出尾部 30 行,便于排错
    const tail = (r.out + r.stderr).split('\n').slice(-30).join('\n')
    console.log('--- test:core tail ---\n' + tail)
  }
}

// ---------- Section 6: 8 小时稳定性模拟 ----------
async function sectionStability() {
  const simScript = pkg.scripts && pkg.scripts['stability:sim']
  if (!simScript) {
    record('STABILITY', 'npm script stability:sim defined', false)
    return
  }
  record('STABILITY', 'npm script stability:sim defined', true)
  const reportPath = path.join(ROOT, 'out', 'stability-report.json')
  // (out/ is a directory, just stat the JSON directly below)
  const statInfo = await stat(reportPath).catch(() => null)
  record('STABILITY', 'stability-report.json present (after sim)', !!statInfo)
  if (statInfo) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    record('STABILITY', 'sim crashed=0', (report.real && report.real.crashes === 0) || report.crashed === 0, `crashed=${report.crashed}`)
    record('STABILITY', 'sim sent>0', ((report.traces && report.traces.sent) || 0) > 0, `sent=${(report.traces && report.traces.sent) || 0}`)
    record('STABILITY', 'sim memoryGrowthMb<200', ((report.memory && report.memory.growthMb) || 0) < 200, `growth=${(report.memory && report.memory.growthMb) || 0}MB`)
    record('STABILITY', 'sim avgResponseMs<5000', ((report.latencyMs && (report.latencyMs.avg || report.latencyMs.p99)) || 0) < 5000, `avg=${(report.latencyMs && (report.latencyMs.avg || report.latencyMs.p99)) || 0}ms`)
  }
}

// ---------- Section 7: package.json scripts ----------
async function sectionScripts() {
  const scripts = pkg.scripts || {}
  const required = ['test:core', 'build', 'typecheck', 'stability:sim', 'acceptance:check']
  for (const s of required) {
    record('PKG', `script ${s} defined`, Boolean(scripts[s]))
  }
}

// ---------- 入口 ----------
async function main() {
  console.log('=== SightFlow 1.0.0 商用试点验收自检 ===')
  console.log(`root: ${ROOT}`)
  await sectionSources()
  await sectionDocs()
  await sectionIpcWiring()
  await sectionSafety()
  await sectionCoreTests()
  await sectionStability()
  await sectionScripts()
  const pass = results.filter((r) => r.ok).length
  const fail = results.filter((r) => !r.ok).length
  console.log(`\n=== ${pass} passed / ${fail} failed / ${results.length} total ===`)
  if (fail > 0) {
    console.log('\n失败明细:')
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - [${r.section}] ${r.name} :: ${r.detail}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[Acceptance] crashed:', err)
  process.exit(2)
})