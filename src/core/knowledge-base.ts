import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { messagePreview, type ObservedChatMessage } from './chat/message-types'

export type KnowledgeEntryKind = 'faq' | 'product' | 'policy' | 'tone' | 'forbidden'

export interface KnowledgeEntry {
  id: string
  kind: KnowledgeEntryKind
  title: string
  content: string
  keywords: string[]
  enabled: boolean
  updatedAt: string
}

export interface KnowledgeMatch {
  entry: KnowledgeEntry
  score: number
  matchedKeywords: string[]
}

export interface KnowledgeContext {
  matches: KnowledgeMatch[]
  confidence: number
  hasAnswer: boolean
  forbiddenMatched: boolean
  summary: string
}

export class KnowledgeBase {
  private entries: KnowledgeEntry[] = []

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content)
      this.entries = normalizeEntries(parsed)
    } catch {
      this.entries = []
    }
  }

  async importText(text: string, kind: KnowledgeEntryKind = 'faq'): Promise<KnowledgeEntry[]> {
    const imported = parseKnowledgeText(text, kind)
    const existingById = new Map(this.entries.map((entry) => [entry.id, entry]))
    for (const entry of imported) {
      existingById.set(entry.id, entry)
    }
    this.entries = Array.from(existingById.values())
    await this.save()
    return imported
  }

  async replace(entries: KnowledgeEntry[]): Promise<void> {
    this.entries = normalizeEntries(entries)
    await this.save()
  }

  list(): KnowledgeEntry[] {
    return [...this.entries]
  }

  search(message: ObservedChatMessage | null | undefined, limit = 5): KnowledgeContext {
    const query = normalizeText(messagePreview(message) || '')
    if (!query) return emptyKnowledgeContext()

    const matches = this.entries
      .filter((entry) => entry.enabled)
      .map((entry) => scoreEntry(entry, query))
      .filter((match): match is KnowledgeMatch => Boolean(match))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    const confidence = matches[0]?.score ?? 0
    const forbiddenMatched = matches.some((match) => match.entry.kind === 'forbidden')
    const hasAnswer = matches.some((match) => match.entry.kind !== 'forbidden' && match.score >= 0.2)

    return {
      matches,
      confidence,
      hasAnswer,
      forbiddenMatched,
      summary: matches
        .map((match) => `[${match.entry.kind}] ${match.entry.title}: ${match.entry.content}`)
        .join('\n')
        .slice(0, 4000)
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8')
  }
}

export function createKnowledgeBase(userDataPath: string): KnowledgeBase {
  return new KnowledgeBase(path.join(userDataPath, 'knowledge-base.json'))
}

function parseKnowledgeText(text: string, kind: KnowledgeEntryKind): KnowledgeEntry[] {
  const now = new Date().toISOString()
  const chunks = text
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  return chunks.map((chunk, index) => {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const title = (lines[0] || `Knowledge ${index + 1}`).replace(/^#+\s*/, '').slice(0, 120)
    const content = lines.slice(1).join('\n') || lines[0] || ''
    const keywords = extractKeywords(`${title}\n${content}`)
    return {
      id: stableId(`${kind}:${title}:${content}`),
      kind,
      title,
      content,
      keywords,
      enabled: true,
      updatedAt: now
    }
  })
}

function normalizeEntries(raw: unknown): KnowledgeEntry[] {
  const values = Array.isArray(raw) ? raw : []
  return values.flatMap((item): KnowledgeEntry[] => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (!title || !content) return []

    return [
      {
        id: typeof entry.id === 'string' && entry.id ? entry.id : stableId(`${title}:${content}`),
        kind: normalizeKind(entry.kind),
        title,
        content,
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.filter((keyword): keyword is string => typeof keyword === 'string').slice(0, 30)
          : extractKeywords(`${title}\n${content}`),
        enabled: entry.enabled !== false,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString()
      }
    ]
  })
}

function normalizeKind(raw: unknown): KnowledgeEntryKind {
  if (raw === 'product' || raw === 'policy' || raw === 'tone' || raw === 'forbidden') return raw
  return 'faq'
}

function scoreEntry(entry: KnowledgeEntry, query: string): KnowledgeMatch | null {
  const searchable = normalizeText(`${entry.title} ${entry.content} ${entry.keywords.join(' ')}`)
  const matchedKeywords = entry.keywords.filter((keyword) => {
    const normalized = normalizeText(keyword)
    return normalized && query.includes(normalized)
  })

  let score = matchedKeywords.length * 0.22
  if (query.includes(normalizeText(entry.title))) score += 0.35
  for (const token of tokenize(query)) {
    if (token.length >= 2 && searchable.includes(token)) score += 0.04
  }

  score = Math.min(1, score)
  return score > 0 ? { entry, score, matchedKeywords } : null
}

function emptyKnowledgeContext(): KnowledgeContext {
  return {
    matches: [],
    confidence: 0,
    hasAnswer: false,
    forbiddenMatched: false,
    summary: ''
  }
}

function extractKeywords(text: string): string[] {
  return Array.from(new Set(tokenize(normalizeText(text)).filter((token) => token.length >= 2))).slice(0, 20)
}

function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean)
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function stableId(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `kb_${(hash >>> 0).toString(36)}`
}
