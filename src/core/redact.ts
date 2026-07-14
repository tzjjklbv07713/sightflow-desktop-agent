// src/core/redact.ts
// Lightweight redactor for diagnostics exports.
//
// - Only fields in STRING_KEYS_TO_REDACT (or nested chat/knowledge/screenshot
//   structures) are masked. Other strings (id, status, type, kind, source,
//   confidence, timestamps, model names, URLs, etc.) are preserved verbatim so
//   engineering can still triage.
// - PII patterns (CN mobile, email, 18-digit ID-card-like, long card-like,
//   digits+Chinese+digit) are still scrubbed from any string that flows
//   through the sensitive key set.
// - Screenshot dataUrls are stripped by default.

export interface RedactionOptions {
  stripScreenshots?: boolean
  redactPII?: boolean
  keepKnowledgeTitles?: boolean
}

export const DEFAULT_REDACTION_OPTIONS = {
  stripScreenshots: true,
  redactPII: true,
  keepKnowledgeTitles: false
}

const PII_PATTERNS = [
  /(?<=^|[^\d])(?:\+?86[-\s]?)?1[3-9]\d{9}(?=$|[^\d])/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<=^|[^\d])\d{17}[\dXx](?=$|[^\d])/g,
  /(?<=^|[^\d])\d{16,19}(?=$|[^\d])/g,
  /\d{2,}\s*[\u4e00-\u9fa5]+\d+/g
]

const STRING_KEYS_TO_REDACT = new Set(["content", "summary", "replyText", "senderName", "message", "text", "rawText"])
const NESTED_CHAT_KEYS = new Set(["chat"])
const KNOWLEDGE_KEYS = new Set(["knowledge"])
const SCREENSHOT_KEY = "screenshot"
const SCREENSHOT_EVIDENCE_KEY = "screenshotEvidence"
const DATA_URL_KEY = "dataUrl"

function isPlainObject(v) { return typeof v === "object" && v !== null && !Array.isArray(v) }

export function redactPII(s) {
  if (typeof s !== "string" || s.length === 0) return s
  let out = s
  for (const re of PII_PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}

function redactSensitiveString(v, opts) {
  if (typeof v !== "string") return v
  if (v.length === 0) return v
  const keep = v.length <= 16 ? "" : v.slice(0, 16)
  const masked = keep + "[REDACTED-TEXT]"
  return opts.redactPII ? redactPII(masked) : masked
}

export function redactTrace(trace: unknown, options?: RedactionOptions): unknown {
  const opts = Object.assign({}, DEFAULT_REDACTION_OPTIONS, options || {})
  return redactValue(trace, opts, 0)
}

function redactValue(v, opts, depth) {
  if (depth > 12) return v
  if (v == null) return v
  // Plain string outside the sensitive key set: preserve verbatim so
  // engineering can still read ids, statuses, types, model names, urls.
  if (typeof v === "string") {
    return opts.redactPII ? redactPII(v) : v
  }
  if (typeof v !== "object") return v
  if (Array.isArray(v)) return v.map((x) => redactValue(x, opts, depth + 1))
  if (!isPlainObject(v)) return v
  const out = {}
  for (const k of Object.keys(v)) {
    const value = v[k]
    if (STRING_KEYS_TO_REDACT.has(k)) { out[k] = redactSensitiveString(value, opts); continue }
    if (NESTED_CHAT_KEYS.has(k) && isPlainObject(value)) {
      out[k] = redactValue({ id: value.id, type: value.type, whitelisted: value.whitelisted, name: typeof value.name === "string" ? redactSensitiveString(value.name, opts) : undefined }, opts, depth + 1)
      continue
    }
    if (KNOWLEDGE_KEYS.has(k) && isPlainObject(value)) {
      const red = {}
      for (const kk of Object.keys(value)) {
        if (kk === "content" || kk === "summary") red[kk] = redactSensitiveString(value[kk], opts)
        else if (kk === "title" && !opts.keepKnowledgeTitles) red[kk] = redactSensitiveString(value[kk], opts)
        else red[kk] = redactValue(value[kk], opts, depth + 1)
      }
      out[k] = red
      continue
    }
    if (k === SCREENSHOT_KEY || k === SCREENSHOT_EVIDENCE_KEY) {
      if (opts.stripScreenshots) out[k] = isPlainObject(value) ? { stripped: true, capturedAt: value.capturedAt } : "[stripped]"
      else out[k] = redactValue(value, opts, depth + 1)
      continue
    }
    if (k === DATA_URL_KEY && typeof value === "string") { out[k] = opts.stripScreenshots ? "[stripped]" : value.slice(0, 32) + "...[truncated]"; continue }
    out[k] = redactValue(value, opts, depth + 1)
  }
  return out
}

export function redactTraces(traces: unknown[], options?: RedactionOptions): unknown[] { return traces.map((t) => redactTrace(t, options)) }

export function redactSettingsSummary(summary: unknown, options?: RedactionOptions): unknown {
  const opts = Object.assign({}, DEFAULT_REDACTION_OPTIONS, options || {}, { stripScreenshots: false })
  return redactValue(summary, opts, 0)
}
