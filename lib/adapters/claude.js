/**
 * Conservative, read-only Claude Code internal-disk projection. NOT a native
 * resume implementation or an exhaustive Claude disk union.
 * Evidence: claude-agent-sdk 0.3.299; Python SDK sessions.py at
 * 65a6676344ca793a09843f2c9b150da50668d2e2; public Anthropic Messages types.
 * https://code.claude.com/docs/en/agent-sdk/session-storage.md
 * https://github.com/anthropics/claude-agent-sdk-python/blob/65a6676344ca793a09843f2c9b150da50668d2e2/src/claude_agent_sdk/_internal/sessions.py
 * Only selected transcript files are opened. No source CLI, settings, indexes,
 * credentials, referenced attachments, subagents, or historical tools are run.
 */
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// Shared JSONL primitives also used by codex.js; no business Service dependencies.
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
export const string = v => typeof v === 'string' ? v : ''
export const array = v => Array.isArray(v) ? v : []
const bound = (v, fallback, max) => Number.isSafeInteger(v) && v > 0 ? Math.min(v, max) : fallback
export function adapterLimits(config) {
  return {
    files: bound(config.maxFiles ?? config.maxSessions, 30000, 30000),
    bytes: bound(config.maxFileBytes, 256 * 1024 * 1024, 256 * 1024 * 1024),
    line: bound(config.maxLineBytes, 16 * 1024 * 1024, 32 * 1024 * 1024),
    entries: bound(config.maxEntries, 100000, 500000),
    image: bound(config.maxImageBytes, 10 * 1024 * 1024, 16 * 1024 * 1024),
    images: bound(config.maxTotalImageBytes, 32 * 1024 * 1024, 64 * 1024 * 1024),
    depth: bound(config.maxDepth, 6, 12),
  }
}
export function sourceRoots(defaults, home, config) {
  const supplied = config.roots
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.some(v => typeof v !== 'string' || !v || v.includes('\0')))) throw new Error('Adapter roots must be an array of non-empty paths')
  return [...new Set((supplied ?? defaults).map(v => path.resolve(v.startsWith('~/') ? path.join(home, v.slice(2)) : v)))]
}
const within = (root, file) => {
  const rel = path.relative(root, file)
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
}
export function sourceError(code, message, line) {
  return Object.assign(new Error(`${code}: ${message}${line ? ` (line ${line})` : ''}`), { code })
}
export function requireField(value, name, type, line, optional = false) {
  if (optional && (value[name] === undefined || value[name] === null)) return
  if (typeof value[name] !== type) throw sourceError('INVALID_SOURCE_RECORD', `invalid ${name} field`, line)
}
export function safeType(v) { return typeof v === 'string' && /^[a-zA-Z0-9_:-]{1,80}$/.test(v) ? v : '(unknown)' }
export function diagnostics(source, pin, mode, nativeRecords = 0) {
  const stats = { sourcePin: pin, mode, complete: true, nativeRecords, records: { mapped: 0, degraded: 0, dropped: 0 }, losses: {}, unknownRecords: {}, unknownParts: {}, imageBytes: 0, projectedEntries: 0 }
  const notes = new Map(), verdicts = new Map()
  return {
    stats,
    classify(line, verdict = 'mapped') {
      const prior = verdicts.get(line)
      if (prior === 'degraded') return
      verdicts.set(line, verdict)
    },
    note(key, line, reason, { unknown = false, part = false, incomplete = true } = {}) {
      key = safeType(key)
      stats.losses[key] = (stats.losses[key] ?? 0) + 1
      if (unknown) {
        const table = part ? stats.unknownParts : stats.unknownRecords
        table[key] = (table[key] ?? 0) + 1
      }
      if (incomplete) {
        stats.complete = false
        if (line && verdicts.get(line) === 'mapped') verdicts.set(line, 'degraded')
      }
      const row = notes.get(key) ?? { count: 0, lines: [], reason }
      row.count += 1
      if (line && row.lines.length < 8 && !row.lines.includes(line)) row.lines.push(line)
      notes.set(key, row)
    },
    finish(entries) {
      for (const value of verdicts.values()) stats.records[value] += 1
      stats.projectedEntries = entries.length
      const sum = table => Object.values(table).reduce((a, b) => a + b, 0)
      return [
        `${source}: projection-accounting parsed=${stats.nativeRecords} mapped=${stats.records.mapped} degraded=${stats.records.degraded} dropped=${stats.records.dropped} unknownRecords=${sum(stats.unknownRecords)} unknownParts=${sum(stats.unknownParts)} complete=${stats.complete}; ${mode}; source pin ${pin}`,
        ...[...notes].map(([key, row]) => `${source}: ${key} count=${row.count}${row.lines.length ? ` lines=${row.lines.join(',')}` : ''}; ${row.reason}`),
      ]
    },
  }
}
export async function secureOpen(file, roots, cap, expected) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || !roots.some(root => within(root, file))) throw sourceError('PATH_OUTSIDE_SOURCE', 'path is outside declared session roots')
  const real = await fs.realpath(file)
  const realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)))
  if (!realRoots.some(root => within(root, real))) throw sourceError('PATH_OUTSIDE_SOURCE', 'session symlink escapes declared roots')
  if ((await fs.lstat(file)).isSymbolicLink()) throw sourceError('SYMLINK_SESSION', 'session symlinks are not supported')
  const checked = await fs.stat(real)
  if (!checked.isFile()) throw sourceError('INVALID_SOURCE_FILE', 'session is not a regular file')
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== checked.ino || stat.dev !== checked.dev || (expected && (stat.ino !== expected.ino || stat.dev !== expected.dev))) throw sourceError('SOURCE_CHANGED', 'file identity changed; rescan sessions')
    if (stat.size > cap.bytes) throw sourceError('SOURCE_TOO_LARGE', `session exceeds ${cap.bytes}-byte limit`)
    return { handle, stat, real }
  } catch (error) { await handle.close(); throw error }
}
async function readAt(handle, length, position) {
  const data = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(data, offset, length - offset, position + offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  if (offset !== length) throw sourceError('SOURCE_CHANGED', 'session shrank during snapshot read; rescan')
  return data
}
export async function sampleSession(file, roots, cap) {
  // Oversized rows must remain visible without allocating the whole file.
  const opened = await secureOpen(file, roots, { ...cap, bytes: Number.MAX_SAFE_INTEGER })
  try {
    const { handle, stat } = opened, length = Math.min(stat.size, 65536)
    const head = await readAt(handle, length, 0)
    const tailStart = Math.max(length, stat.size - 65536)
    const tail = tailStart < stat.size ? await readAt(handle, stat.size - tailStart, tailStart) : Buffer.alloc(0)
    const parse = (buffer, skipFirst, cutLast) => {
      const lines = buffer.toString('utf8').split('\n')
      if (skipFirst) lines.shift()
      if (cutLast) lines.pop()
      return lines.flatMap(line => { try { const v = JSON.parse(line); return object(v) ? [v] : [] } catch { return [] } })
    }
    return { stat, records: [...parse(head, false, length < stat.size), ...parse(tail, tailStart > 0, false)] }
  } finally { await opened.handle.close() }
}
export async function sessionSnapshot(file, roots, cap, expected, report) {
  const { handle, stat } = await secureOpen(file, roots, cap, expected)
  let buffer
  try { buffer = await readAt(handle, stat.size, 0) } finally { await handle.close() }
  const records = [], lines = buffer.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    if (Buffer.byteLength(line) > cap.line) throw sourceError('SOURCE_LINE_TOO_LARGE', `line exceeds ${cap.line}-byte limit`, i + 1)
    let value
    try { value = JSON.parse(line) }
    catch {
      if (i === lines.length - 1 && buffer[buffer.length - 1] !== 10) {
        report.note('incomplete-final-line', i + 1, 'unfinished trailing record omitted; effective projection is incomplete')
        report.stats.incompleteFinalLines = 1
        continue
      }
      throw sourceError('MALFORMED_SOURCE_JSON', 'malformed complete record; refusing ambiguous history', i + 1)
    }
    if (!object(value)) throw sourceError('INVALID_SOURCE_RECORD', 'JSONL record must be an object', i + 1)
    requireField(value, 'type', 'string', i + 1)
    records.push({ value, line: i + 1, position: i })
    if (records.length > cap.entries) throw sourceError('SOURCE_TOO_MANY_ENTRIES', `session exceeds ${cap.entries}-record limit`)
  }
  report.stats.nativeRecords = records.length
  return records
}
// opendir bounds directory enumeration too (not just the returned session list).
export async function discoverSessionFiles(roots, { claude = false, flat = false, cap }) {
  const files = [], warnings = [], seen = new Set()
  let visited = 0, stopped = false
  async function visit(dir, depth) {
    if (stopped) return
    let iterator
    try { iterator = await fs.opendir(dir) }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`session root unavailable (${error.code || 'IO_ERROR'})`); return }
    for await (const entry of iterator) {
      if (++visited > 60000 || files.length >= cap.files) { stopped = true; break }
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile() && (claude ? entry.name.endsWith('.jsonl') && (depth === 1 || (flat && depth === 0)) : /^rollout-.+\.jsonl(?:\.zst)?$/.test(entry.name))) {
        if (!seen.has(file)) { files.push(file); seen.add(file) }
      } else if (entry.isDirectory() && depth < (claude ? 1 : cap.depth)) await visit(file, depth + 1)
      if (stopped) break
    }
  }
  for (const root of roots) { await visit(root, 0); if (stopped) break }
  if (stopped) warnings.push(`session discovery bounded at ${cap.files} files / 60000 directory entries; narrow roots to scan more`)
  files.sort()
  return { files, warnings }
}
export async function boundedMap(items, fn, concurrency = 4) {
  const output = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; output[i] = await fn(items[i], i) }
  }))
  return output
}
export function verifyReference(ref, catalog, source) {
  if (!object(ref) || ['id', 'title', 'cwd', 'createdAt', 'updatedAt', 'path'].some(k => typeof ref[k] !== 'string') || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !object(ref.locator)) throw sourceError('INVALID_SOURCE_REFERENCE', `${source} read requires a scanned session row`)
  const saved = catalog.get(ref.path)
  if (!saved || ['id', 'title', 'cwd', 'createdAt', 'updatedAt', 'path', 'bytes'].some(key => ref[key] !== saved.row[key]) || JSON.stringify(ref.locator) !== JSON.stringify(saved.row.locator)) throw sourceError('UNKNOWN_SOURCE_SESSION', 'reference does not match the last scanned session catalog')
  return saved
}
export function linearEntries(entries) {
  let parentId = null
  return entries.map(entry => { const result = { ...entry, parentId }; parentId = entry.id; return result })
}
export function embeddedImage(data, mimeType, images, report, cap, line) {
  if (typeof data !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(mimeType ?? '') || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    report.note('invalid-embedded-image', line, 'unrecognized MIME or invalid base64 omitted')
    return { type: 'text', text: '[embedded image omitted: invalid or unsupported encoding]' }
  }
  const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  if (size > cap.image || report.stats.imageBytes + size > cap.images) {
    report.note('oversized-embedded-image', line, 'decoded image exceeds bounded attachment budget')
    return { type: 'text', text: '[embedded image omitted: decoded attachment limit]' }
  }
  report.stats.imageBytes += size
  images.push({ blob: data, mimeType, source: 'content' })
  return { type: 'image', data, mimeType }
}

const CLAUDE_PIN = 'claude-agent-sdk@0.3.299;python-sessions@65a6676344ca793a09843f2c9b150da50668d2e2'
const CHAIN = new Set(['user', 'assistant', 'progress', 'system', 'attachment'])
function relinkGate(v) {
  if (v.preserved_messages != null || v.preserved_segment != null || v.compact_metadata?.preserved_messages != null || v.compact_metadata?.preserved_segment != null || v.compactMetadata?.preserved_messages != null || v.compactMetadata?.preserved_segment != null) return 'UNSUPPORTED_CLAUDE_COMPACTION_RELINK: preserved_messages/preserved_segment relinking is not implemented; export a self-contained effective transcript'
  return ''
}
function claudeInfo(records, fallback) {
  const info = { id: '', cwd: '', title: '', titleSource: 'auto', createdAt: '', version: 0 }
  let explicitTitle = '', autoTitle = ''
  for (const v of records) {
    if (!info.id && typeof v.sessionId === 'string') info.id = v.sessionId
    if (!info.cwd && typeof v.cwd === 'string') info.cwd = v.cwd
    if (!info.createdAt && typeof v.timestamp === 'string') info.createdAt = v.timestamp
    if (typeof v.version === 'string' || typeof v.version === 'number') info.version = v.version
    if (v.type === 'custom-title' && typeof v.customTitle === 'string' && (!v.sessionId || v.sessionId === info.id)) explicitTitle = v.customTitle
    else if (typeof v.customTitle === 'string' && (!v.sessionId || v.sessionId === info.id)) explicitTitle = v.customTitle
    if (typeof v.aiTitle === 'string') autoTitle = v.aiTitle
    else if (typeof v.summary === 'string' && !autoTitle) autoTitle = v.summary
    if (!autoTitle && typeof v.lastPrompt === 'string') autoTitle = v.lastPrompt
  }
  if (!info.id) info.id = path.basename(fallback, '.jsonl')
  info.title = (explicitTitle || autoTitle).slice(0, 500)
  info.titleSource = explicitTitle ? 'user' : 'auto'
  return info
}
function claudeChain(records, report, nativeId) {
  const byId = new Map()
  for (const row of records) {
    const v = row.value
    if (!CHAIN.has(v.type)) continue
    requireField(v, 'uuid', 'string', row.line)
    if (!v.uuid) throw sourceError('INVALID_SOURCE_RECORD', 'chain UUID must be non-empty', row.line)
    requireField(v, 'parentUuid', 'string', row.line, true)
    for (const key of ['sessionId', 'timestamp', 'teamName']) requireField(v, key, 'string', row.line, true)
    for (const key of ['isSidechain', 'isMeta', 'isCompactSummary', 'isSynthetic', 'shouldQuery']) requireField(v, key, 'boolean', row.line, true)
    if (byId.has(v.uuid)) report.note('duplicate-uuid', row.line, 'later source UUID snapshot wins; API message IDs are not deduplication keys', { incomplete: false })
    byId.set(v.uuid, row)
  }
  const parents = new Set([...byId.values()].map(r => r.value.parentUuid).filter(Boolean))
  const candidates = new Map()
  for (const row of byId.values()) {
    if (parents.has(row.value.uuid)) continue
    let current = row, seen = new Set()
    while (current && !['user', 'assistant'].includes(current.value.type)) {
      if (seen.has(current.value.uuid)) throw sourceError('CLAUDE_CHAIN_CYCLE', 'cycle in native UUID chain', current.line)
      seen.add(current.value.uuid)
      current = byId.get(current.value.parentUuid)
    }
    if (current && !current.value.isSidechain && !current.value.teamName && !current.value.isMeta) candidates.set(current.value.uuid, current)
  }
  const leaf = [...candidates.values()].sort((a, b) => b.position - a.position)[0]
  if (!leaf && byId.size) throw sourceError('UNRESOLVED_CLAUDE_MAIN_CHAIN', 'no unambiguous main conversation leaf (cycle, sidechain, or meta-only history)')
  const selected = [], seen = new Set()
  let cursor = leaf
  while (cursor) {
    const v = cursor.value
    if (seen.has(v.uuid)) throw sourceError('CLAUDE_CHAIN_CYCLE', 'cycle in native UUID chain', cursor.line)
    seen.add(v.uuid)
    if (v.sessionId && v.sessionId !== nativeId) throw sourceError('CLAUDE_MIXED_SESSION_CHAIN', 'main chain contains a different session ID', cursor.line)
    if (v.isSidechain || v.teamName) throw sourceError('CLAUDE_MIXED_SIDECHAIN', 'main chain crosses sidechain/team records', cursor.line)
    selected.push(cursor)
    if (!v.parentUuid) break
    cursor = byId.get(v.parentUuid)
    if (!cursor) throw sourceError('CLAUDE_MISSING_PARENT', 'main chain parent UUID is missing; refusing partial effective history', selected[selected.length - 1].line)
  }
  selected.reverse()
  report.stats.discardedBranches = byId.size - selected.length
  if (report.stats.discardedBranches) report.note('discarded-branches', 0, `${report.stats.discardedBranches} off-chain UUID records excluded; sibling branches/subagents were not merged`, { incomplete: false })
  return selected
}
function claudeUsage(usage, line, report) {
  if (usage === undefined || usage === null) return undefined
  if (!object(usage)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid assistant usage', line)
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid token counter', line)
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) { report.note('partial-usage', line, 'incomplete response usage omitted'); return undefined }
  return { input: usage.input_tokens, output: usage.output_tokens, ...(usage.cache_read_input_tokens !== undefined ? { cacheRead: usage.cache_read_input_tokens } : {}), ...(usage.cache_creation_input_tokens !== undefined ? { cacheWrite: usage.cache_creation_input_tokens } : {}) }
}
function userOrigin(v) {
  const origin = typeof v.origin === 'string' ? v.origin : object(v.origin) ? v.origin.type : ''
  if (v.isCompactSummary) return { kind: 'compaction-summary', form: 'recall' }
  if (v.isMeta || v.isSynthetic || v.shouldQuery === false || origin === 'channel' || origin === 'peer') return { kind: origin === 'channel' || origin === 'peer' ? origin : 'injected-context', form: origin === 'channel' || origin === 'peer' ? 'relay' : 'notice' }
  return origin === 'human' ? null : { kind: 'unknown-user-context' }
}
export function createClaudeAdapter({ home = homedir(), config = {} } = {}) {
  const configDir = config.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
  const roots = sourceRoots([path.join(configDir, 'projects')], home, config), cap = adapterLimits(config)
  let catalog = new Map()
  async function scan() {
    const { files, warnings } = await discoverSessionFiles(roots, { claude: true, flat: Array.isArray(config.roots), cap })
    const next = new Map()
    const rows = await boundedMap(files, async file => {
      try {
        const { stat, records } = await sampleSession(file, roots, cap)
        const info = claudeInfo(records, file)
        if (!records.some(v => CHAIN.has(v.type) && typeof v.uuid === 'string')) return null
        const reason = stat.size > cap.bytes ? `SOURCE_TOO_LARGE: exceeds ${cap.bytes}-byte limit` : records.map(relinkGate).find(Boolean) || ''
        const root = roots.find(root => within(root, file))
        const row = { id: info.id, title: info.title || 'Claude Code session', cwd: info.cwd, createdAt: info.createdAt, updatedAt: stat.mtime.toISOString(), project: info.cwd ? path.basename(info.cwd) : path.basename(path.dirname(file)), bytes: stat.size, path: file, locator: { kind: 'claude-jsonl', relativePath: path.relative(root, file), nativeId: info.id }, importable: !reason, ...(reason ? { unsupportedReason: reason } : {}) }
        next.set(file, { row: { ...row, locator: { ...row.locator } }, ino: stat.ino, dev: stat.dev })
        return row
      } catch (error) { warnings.push(`claude: session skipped (${safeType(error.code)})`); return null }
    })
    catalog = next
    return { sessions: rows.filter(Boolean), warnings }
  }
  async function read(ref) {
    const saved = verifyReference(ref, catalog, 'claude')
    if (saved.row.importable === false) throw sourceError(saved.row.unsupportedReason.split(':')[0], saved.row.unsupportedReason)
    const report = diagnostics('claude', CLAUDE_PIN, 'effective-main-chain-conservative')
    const records = await sessionSnapshot(ref.path, roots, cap, saved, report)
    for (const { value, line } of records) {
      const reason = relinkGate(value)
      if (reason) throw sourceError('UNSUPPORTED_CLAUDE_COMPACTION_RELINK', 'preserved_messages/preserved_segment requires faithful native relinking before import', line)
      for (const key of ['sessionId', 'cwd', 'timestamp', 'customTitle', 'aiTitle', 'lastPrompt']) requireField(value, key, 'string', line, true)
      if (value.version != null && typeof value.version !== 'string' && typeof value.version !== 'number') throw sourceError('INVALID_SOURCE_RECORD', 'invalid native version field', line)
    }
    const info = claudeInfo(records.map(r => r.value), ref.path)
    if (info.id !== saved.row.id) throw sourceError('SOURCE_CHANGED', 'session ID changed since discovery; rescan')
    const selected = claudeChain(records, report, info.id), images = [], entries = [], calls = new Map(), usageOwner = new Map()
    for (const row of selected) if (row.value.type === 'assistant' && row.value.message?.usage != null && typeof row.value.message.id === 'string') usageOwner.set(row.value.message.id, row.value.uuid)
    const add = (row, payload, suffix = '') => entries.push({ id: `claude:${row.value.uuid}${suffix}`, timestamp: string(row.value.timestamp), ...payload })
    const blocks = (content, row, assistant = false) => {
      if (typeof content === 'string') return [{ type: 'text', text: content }]
      if (!Array.isArray(content)) throw sourceError('INVALID_SOURCE_RECORD', 'message content must be text or an array', row.line)
      return content.flatMap(p => {
        if (!object(p) || typeof p.type !== 'string') throw sourceError('INVALID_SOURCE_RECORD', 'invalid content block', row.line)
        switch (p.type) {
          case 'text': requireField(p, 'text', 'string', row.line); return [{ type: 'text', text: p.text }]
          case 'thinking':
            requireField(p, 'thinking', 'string', row.line)
            if (!assistant) { report.note('nonassistant-thinking', row.line, 'thinking outside assistant omitted'); return [] }
            return [{ type: 'thinking', thinking: p.thinking }]
          case 'redacted_thinking': report.note('redacted_thinking', row.line, 'opaque encrypted reasoning body omitted'); return []
          case 'image': {
            if (!object(p.source)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid image source', row.line)
            if (p.source.type === 'base64') return [embeddedImage(p.source.data, p.source.media_type, images, report, cap, row.line)]
            report.note('external-image', row.line, 'referenced local/remote image bytes are never opened')
            return [{ type: 'text', text: '[Claude image reference; external bytes not imported]' }]
          }
          case 'tool_use':
            if (!assistant) { report.note('nonassistant-tool-use', row.line, 'tool declaration outside assistant omitted'); return [] }
            requireField(p, 'id', 'string', row.line); requireField(p, 'name', 'string', row.line)
            if (!p.id || !p.name || p.input === undefined) throw sourceError('INVALID_SOURCE_RECORD', 'tool use requires native ID, name, and input', row.line)
            if (calls.has(p.id)) throw sourceError('CLAUDE_DUPLICATE_TOOL_ID', 'duplicate tool declaration ID', row.line)
            calls.set(p.id, p.name)
            return [{ type: 'toolCall', id: p.id, name: p.name, arguments: JSON.stringify(p.input) }]
          default:
            report.note(p.type, row.line, 'unsupported content family replaced by inert placeholder (no opaque payload copied)', { unknown: true, part: true })
            report.classify(row.line, 'degraded')
            return [{ type: 'text', text: `[Claude unsupported content: ${safeType(p.type)}]` }]
        }
      })
    }
    const selectedPositions = new Set(selected.map(r => r.position))
    for (const row of records) {
      if (selectedPositions.has(row.position)) continue
      const v = row.value
      if (CHAIN.has(v.type) || ['custom-title', 'summary', 'tag', 'file-history-snapshot', 'queue-operation', 'last-prompt'].includes(v.type)) report.classify(row.line, 'dropped')
      else { report.classify(row.line, 'dropped'); report.note(v.type, row.line, 'unknown non-chain disk record omitted; this is not a complete internal Claude schema', { unknown: true }) }
    }
    for (const row of selected) {
      const v = row.value
      report.classify(row.line)
      if (!['user', 'assistant'].includes(v.type)) {
        report.classify(row.line, 'dropped')
        if (v.type === 'system' && v.subtype === 'compact_boundary') report.note('compact-boundary', row.line, 'effective parentUuid chain selected; logicalParentUuid intentionally not followed; boundary retained only through readable summary', { incomplete: false })
        else report.note(v.type, row.line, 'non-conversation chain entry excluded from context', { incomplete: v.type === 'attachment' || v.type === 'system' })
        continue
      }
      if (!object(v.message)) throw sourceError('INVALID_SOURCE_RECORD', 'conversation entry requires message object', row.line)
      const m = v.message
      requireField(m, 'role', 'string', row.line, true)
      requireField(m, 'id', 'string', row.line, true)
      // The disk schema is internal: origin metadata has changed shape between releases.
      // Its shape cannot invalidate otherwise readable conversation content.
      if (v.type === 'user' && v.origin != null && typeof v.origin !== 'string' && (!object(v.origin) || typeof v.origin.type !== 'string')) {
        report.note('unrecognized-origin-shape', row.line, 'unknown origin metadata omitted; readable content retained as context')
      }
      if (m.role && m.role !== v.type) throw sourceError('INVALID_SOURCE_RECORD', 'native envelope/message role mismatch', row.line)
      if (v.type === 'assistant') {
        requireField(m, 'model', 'string', row.line, true)
        const content = blocks(m.content, row, true)
        const message = { role: 'assistant', content, provider: 'anthropic', model: string(m.model) || 'claude-import' }
        const usage = claudeUsage(m.usage, row.line, report)
        if (usage && (!m.id || usageOwner.get(m.id) === v.uuid)) message.usage = usage
        else if (usage) report.note('fragmented-response-usage', row.line, 'shared API response usage retained only on the last selected UUID fragment', { incomplete: false })
        if (!m.model) report.note('missing-assistant-model', row.line, 'execution model absent; import placeholder model is not native provenance')
        if (content.length) add(row, { type: 'message', message })
        continue
      }
      const provenance = userOrigin(v)
      if (provenance?.kind === 'unknown-user-context') report.note('unknown-user-provenance', row.line, 'legacy user carrier not proven human; retained as namespaced unknown context, not a human request')
      const input = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      if (!Array.isArray(input)) throw sourceError('INVALID_SOURCE_RECORD', 'user content must be text or array', row.line)
      let pending = [], part = 0
      const flush = () => {
        if (!pending.length) return
        const content = pending; pending = []
        add(row, provenance ? { type: 'custom_message', customType: provenance.kind, ...(provenance.form ? { form: provenance.form } : {}), content } : { type: 'message', message: { role: 'user', content } }, `:part:${part++}`)
      }
      for (const p of input) {
        if (p?.type !== 'tool_result') { pending.push(...blocks([p], row)); continue }
        flush()
        requireField(p, 'tool_use_id', 'string', row.line); requireField(p, 'is_error', 'boolean', row.line, true)
        if (!p.tool_use_id) throw sourceError('INVALID_SOURCE_RECORD', 'tool result requires native call ID', row.line)
        const content = p.content === undefined || p.content === null ? [] : blocks(p.content, row)
        const message = { role: 'toolResult', toolCallId: p.tool_use_id, toolName: calls.get(p.tool_use_id) || '', content, ...(typeof p.is_error === 'boolean' ? { isError: p.is_error } : {}) }
        if (!calls.has(p.tool_use_id)) report.note('orphan-tool-result', row.line, 'native call declaration not present; no arguments or successful execution invented')
        if (p.is_error === undefined || p.is_error === null) report.note('unknown-tool-status', row.line, 'tool success/error status is unknown; isError intentionally absent', { incomplete: false })
        if (v.toolUseResult !== undefined) report.note('tool-private-metadata', row.line, 'supplemental toolUseResult omitted; no unbounded private metadata copied')
        add(row, { type: 'message', message }, `:part:${part++}`)
      }
      flush()
    }
    if (!info.title) {
      const first = entries.find(e => e.message?.role === 'user' || e.customType === 'unknown-user-context')
      info.title = array(first?.message?.content || first?.content).filter(p => p.type === 'text').map(p => p.text).join(' ').replace(/\s+/g, ' ').slice(0, 100) || 'Claude Code session'
    }
    const model = [...entries].reverse().find(e => e.message?.role === 'assistant')?.message.model
    const defaultModel = model ? `anthropic/${model}` : ''
    const normalized = linearEntries(entries)
    return { head: { ...info, defaultModel, models: defaultModel ? { default: defaultModel } : {} }, entries: normalized, images, source: 'claude', adapterWarnings: report.finish(normalized), stats: report.stats }
  }
  return { id: 'claude', label: 'Claude Code', description: 'Read-only conservative main UUID chain; preserved-message compaction relinking and subagents unsupported', roots, scan, read }
}
