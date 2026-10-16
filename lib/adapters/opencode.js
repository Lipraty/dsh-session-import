/**
 * Read-only OpenCode adapters, pinned contracts (not inferred from local logs):
 * v1.1.65 storage/storage.ts; v1.2.0 session/{session.sql,message-v2}.ts;
 * 5aabb619c0d98e238ada03f4d763d36d36539a99 packages/{core,schema}/src/session*.
 * https://github.com/anomalyco/opencode/tree/v1.2.0/packages/opencode/src/session
 * https://github.com/anomalyco/opencode/blob/5aabb619c0d98e238ada03f4d763d36d36539a99/packages/schema/src/session-message.ts
 * No source runtime is instantiated: doing so would apply migrations and writes.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

export const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
export const list = v => Array.isArray(v) ? v : []
export const text = v => typeof v === 'string' ? v : ''
export function iso(v) {
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) && Math.abs(n) <= 8640000000000000 ? new Date(n).toISOString() : ''
}
export function limits(config = {}) {
  const bound = (v, fallback, max) => Number.isSafeInteger(v) && v > 0 ? Math.min(v, max) : fallback
  return { sessions: bound(config.maxSessions, 10000, 50000), entries: bound(config.maxEntries, 100000, 500000), bytes: bound(config.maxFileBytes, 64 * 1024 * 1024, 256 * 1024 * 1024) }
}
export function configuredRoots(defaults, config = {}, home = homedir()) {
  const raw = Array.isArray(config.roots) ? config.roots : defaults
  return [...new Set(raw.filter(v => typeof v === 'string' && v).map(v => path.resolve(v.startsWith('~/') ? path.join(home, v.slice(2)) : v)))]
}
const contained = (root, candidate) => candidate === root || (!path.relative(root, candidate).startsWith('..' + path.sep) && path.relative(root, candidate) !== '..' && !path.isAbsolute(path.relative(root, candidate)))
export async function secureFile(file, roots) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Source path must be a non-empty filesystem path')
  const absolute = path.resolve(file)
  if (!roots.some(root => contained(path.resolve(root), absolute))) throw new Error('Source path is outside configured roots')
  const actual = await fs.realpath(absolute)
  const realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.resolve(root))))
  if (!realRoots.some(root => contained(root, actual))) throw new Error('Source symlink resolves outside configured roots')
  const stat = await fs.stat(actual)
  if (!stat.isFile()) throw new Error('Source path is not a regular file')
  return { file: actual, stat }
}
export async function readJson(file, roots, maxBytes = 64 * 1024 * 1024) {
  const safe = await secureFile(file, roots)
  if (safe.stat.size > maxBytes) throw new Error(`Source exceeds ${maxBytes}-byte read limit; raise maxFileBytes explicitly`)
  return JSON.parse(await fs.readFile(safe.file, 'utf8'))
}
export async function directoryEntries(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error }
}
export async function openReadOnly(file, roots) {
  const safe = await secureFile(file, roots)
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) }
  catch { throw new Error('Read-only SQLite imports require a Node runtime with node:sqlite (DSH Node 24); no external database package is installed') }
  const db = new DatabaseSync(safe.file, { readOnly: true })
  try { db.exec('PRAGMA query_only = ON; BEGIN'); return { db, stat: safe.stat } }
  catch (error) { db.close(); throw error }
}
export function tables(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)) }
export function columns(db, table) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid internal table identifier')
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name))
}
export function checkDataBudget(db, tableNames, sessionId, maxBytes) {
  let bytes = 0
  for (const table of tableNames) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid internal table identifier')
    bytes += Number(db.prepare(`SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM ${table} WHERE session_id = ?`).get(sessionId).bytes)
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error(`Native transcript exceeds ${maxBytes}-byte read limit; explicitly raise maxFileBytes`)
  }
  return bytes
}
export function jsonData(row, warnings, what) {
  try { const value = JSON.parse(row.data); if (!record(value)) throw new Error(); return value }
  catch { throw new Error(`Invalid ${what} JSON for source row ${row.id}; source is left unchanged`) }
}
export function rowInfo(row, source = 'opencode') {
  return { id: row.id, title: text(row.title), cwd: text(row.directory), createdAt: iso(row.time_created), updatedAt: iso(row.time_updated), project: text(row.project_id), version: row.version, parentID: row.parent_id, titleSource: source === 'zcode' && row.title_source === 'custom' ? 'user' : 'auto', revert: row.revert ? JSON.parse(row.revert) : undefined, fork: row.fork_session_id ? { sessionID: row.fork_session_id, boundary: row.fork_boundary ? JSON.parse(row.fork_boundary) : null } : undefined }
}
export function tokenUsage(tokens) {
  if (!record(tokens)) return undefined
  const out = { input: Number.isFinite(tokens.input) ? tokens.input : 0, output: Number.isFinite(tokens.output) ? tokens.output : 0 }
  if (Number.isFinite(tokens.total)) out.totalTokens = tokens.total
  if (Number.isFinite(tokens.cache?.read)) out.cacheRead = tokens.cache.read
  if (Number.isFinite(tokens.cache?.write)) out.cacheWrite = tokens.cache.write
  return out
}
export function makeTranscript(info, entries, images, warnings, source, stats = {}) {
  const lastModel = [...entries].reverse().find(e => e.message?.role === 'assistant' && e.message.model && e.message.provider)?.message
  const model = lastModel ? `${lastModel.provider}/${lastModel.model}` : ''
  return { head: { id: text(info.id), version: info.version ?? 0, cwd: text(info.cwd || info.directory || info.location?.directory), createdAt: iso(info.createdAt || info.time?.created), title: text(info.title), titleSource: info.titleSource === 'user' || info.titleSource === 'custom' ? 'user' : 'auto', defaultModel: model, models: model ? { default: model } : {}, ...(info.parentID ? { parentSession: `${source}:${info.parentID}` } : {}) }, entries, images, source, adapterWarnings: [...new Set(warnings)], stats }
}
export function linearize(entries) {
  let parentId = null
  return entries.map(entry => { const out = { ...entry, parentId }; parentId = out.id; return out })
}
export function fileContent(file, images, warnings, source) {
  const mime = text(file.mime || file.mediaType || file.mimeType)
  const url = text(file.url || file.uri)
  const inline = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\r\n]*)$/.exec(url)
  const embedded = typeof file.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data) ? file.data : null
  if (mime.startsWith('image/') && (inline || embedded !== null)) {
    const data = embedded ?? inline[2].replace(/[\r\n]/g, '')
    images.push({ blob: data, data, mimeType: mime || inline?.[1], source: 'content' })
    return { type: 'image', data, mimeType: mime || inline?.[1] }
  }
  warnings.push(`${source}: file reference retained as a placeholder; referenced files/URLs are never opened`)
  // Deliberately do not include potentially token-bearing URL query strings.
  return { type: 'text', text: `[${source} attachment: ${text(file.filename || file.name) || mime || 'file'}; bytes not imported]${text(file.metadata?.preview?.text) ? '\n' + file.metadata.preview.text : ''}` }
}
export function normalizeV1(info, messages, { source = 'opencode', warnings = [], images = [] } = {}) {
  const entries = []
  const add = (id, timestamp, payload) => entries.push({ id, parentId: null, timestamp: iso(timestamp), ...payload })
  const byMessage = new Map()
  for (const message of messages) {
    if (!record(message.info) || !message.info.id) throw new Error(`${source}: message has no source ID`)
    if (byMessage.has(message.info.id)) warnings.push(`${source}: duplicate message ID ${message.info.id}; latest snapshot wins`)
    byMessage.set(message.info.id, message)
  }
  let selected = [...byMessage.values()]
  if (source === 'opencode' && info.revert?.messageID) {
    const i = selected.findIndex(m => m.info.id === info.revert.messageID)
    if (i < 0) throw new Error('OpenCode revert boundary not present; refusing to import an ambiguous active history')
    if (info.revert.partID) throw new Error('OpenCode part-level revert is unsupported; clear/commit the revert in OpenCode or export an unambiguous session')
    selected = selected.slice(0, i)
    warnings.push('opencode: applied staged message revert; discarded reverted suffix')
  }
  // v1 filterCompacted: the latest finished summary cuts at its parent compaction marker.
  if (source === 'opencode') {
    const summary = selected.findLast(m => m.info.role === 'assistant' && m.info.summary && m.info.finish)
    if (summary) {
      if (summary.info.error) throw new Error('OpenCode finished compaction summary contains an error; create/export a valid textual compacted context before import')
      const marker = selected.findIndex(m => m.info.id === summary.info.parentID && list(m.parts).some(p => p.type === 'compaction'))
      if (marker < 0) throw new Error('OpenCode summary has no compaction marker; refusing an ambiguous context boundary')
      selected = selected.slice(marker)
      warnings.push('opencode: compacted context projected from finished summary; summarized prefix excluded')
    }
  }
  const calls = new Set()
  for (const item of selected) {
    const m = item.info, timestamp = m.time?.created
    let parts = [...new Map(list(item.parts).map(p => [p.id, p])).values()]
    if (source === 'zcode') {
      const latestTools = new Map(parts.filter(p => p.type === 'tool').map(p => [p.callID, p]))
      parts = parts.filter(p => p.type !== 'tool' || latestTools.get(p.callID) === p)
    }
    if (source === 'zcode' && (m.semantics?.providerVisibility === 'hidden' || (m.source === 'shared_context' && m.metadata?.sharedContextStatus && m.metadata.sharedContextStatus !== 'attached') || (m.synthetic && m.source === 'bot_topic_context'))) {
      warnings.push('zcode: provider-hidden/timeline/pending shared-context messages excluded from imported model context'); continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') { warnings.push(`${source}: unknown message role ${text(m.role) || '(missing)'} excluded`); continue }
    const content = [], toolParts = []
    for (const p of parts) {
      switch (p.type) {
        case 'text':
          if (p.ignored) { warnings.push(`${source}: ignored text excluded`); break }
          if (source === 'zcode' && p.synthetic && p.metadata?.source === 'bot_topic_context') break
          if (typeof p.text === 'string') content.push({ type: 'text', text: p.text })
          break
        case 'reasoning': content.push({ type: 'thinking', thinking: text(p.text) }); break
        case 'file': content.push(fileContent(p, images, warnings, source)); break
        case 'tool':
          if (m.role !== 'assistant') { warnings.push(`${source}: tool on non-assistant message excluded`); break }
          if (!p.callID || !p.tool || !record(p.state)) { warnings.push(`${source}: malformed tool part ${text(p.id)} excluded`); break }
          if (calls.has(p.callID)) { warnings.push(`${source}: duplicate tool call ID ${p.callID} excluded`); break }
          calls.add(p.callID)
          toolParts.push(p)
          break
        case 'agent': content.push({ type: 'text', text: `[Selected agent: ${text(p.name)}]` }); break
        case 'subtask': content.push({ type: 'text', text: `[Subtask ${text(p.agent)}: ${text(p.description)}]\n${text(p.prompt)}` }); warnings.push(`${source}: subtask metadata degraded to context text; no child runtime is started`); break
        case 'compaction': warnings.push(`${source}: compaction marker projected to effective context, not imported as a runtime event`); break
        case 'timeline': warnings.push(`${source}: timeline ${text(p.timelineType)} excluded (display-only)`); break
        case 'step-start': case 'step-finish': case 'snapshot': case 'patch': case 'retry':
          warnings.push(`${source}: ${p.type} runtime/UI record excluded`); break
        default: warnings.push(`${source}: unknown part type ${text(p.type) || '(missing)'} excluded`)
      }
    }
    // ZCode explicitly records local declaration order independent of completion order.
    if (source === 'zcode' && toolParts.every(p => Number.isSafeInteger(p.declarationIndex))) toolParts.sort((a, b) => a.declarationIndex - b.declarationIndex)
    for (const p of toolParts) content.push({ type: 'toolCall', id: p.callID, name: typeof p.metadata?.providerToolName === 'string' ? p.metadata.providerToolName : p.tool, arguments: record(p.state.input) ? p.state.input : p.state.raw || '{}' })
    if (m.role === 'user') {
      const synthetic = m.synthetic === true || (parts.some(p => p.type === 'text' && p.synthetic) && !parts.some(p => p.type === 'text' && !p.synthetic))
      if (content.length) add(m.id, timestamp, synthetic ? { type: 'custom_message', customType: `${source}:${text(m.source) || 'synthetic'}`, content, display: m.visibility !== 'model-only' } : { type: 'message', message: { role: 'user', content } })
      if (m.system) { add(`${m.id}:system`, timestamp, { type: 'message', message: { role: 'developer', content: m.system } }); warnings.push(`${source}: per-request system instructions degraded to developer context`) }
    } else {
      const model = source === 'zcode' ? text(m.modelId) : text(m.modelID)
      const provider = source === 'zcode' ? text(m.providerId) : text(m.providerID)
      if (source === 'zcode' && (!model || !provider)) warnings.push('zcode: assistant execution model absent; legacy rollback model fields are not used as current provenance')
      if (m.summary && !m.error) {
        if (content.length) add(m.id, timestamp, { type: 'custom_message', customType: `${source}:compaction-summary`, form: 'recall', content, display: true })
      } else if (content.length || m.error) {
        const message = { role: 'assistant', content, model, provider }
        const usage = tokenUsage(m.tokens); if (usage) message.usage = usage
        if (m.error) { message.errorMessage = text(m.error.data?.message || m.error.message || m.error.name) || 'Source assistant failed'; warnings.push(`${source}: assistant error diagnostics are not replayable execution errors`) }
        add(m.id, timestamp, { type: 'message', message })
      }
      for (const p of toolParts) {
        const s = p.state
        if (s.status !== 'completed' && s.status !== 'error') { warnings.push(`${source}: unresolved ${s.status} tool ${p.callID}; no successful result invented`); continue }
        const output = s.status === 'error' ? (source === 'zcode' && typeof s.metadata?.modelContent === 'string' ? s.metadata.modelContent : text(s.error)) : s.time?.compacted ? '[Old tool result content cleared by source compaction]' : text(s.output)
        const resultContent = [{ type: 'text', text: output }]
        for (const attachment of list(s.attachments)) resultContent.push(fileContent(attachment, images, warnings, source))
        if (source === 'zcode' && s.metadata?.modelContentLayout) warnings.push('zcode: tool media modelContentLayout degraded to text output plus inline attachments')
        add(`${m.id}:tool:${p.id}`, s.time?.end || timestamp, { type: 'message', message: { role: 'toolResult', toolCallId: p.callID, toolName: typeof p.metadata?.providerToolName === 'string' ? p.metadata.providerToolName : p.tool, content: resultContent, isError: s.status === 'error', ...(record(s.metadata) ? { details: { source, metadata: s.metadata } } : {}) } })
      }
    }
  }
  return makeTranscript(info, linearize(entries), images, warnings, source, { nativeMessages: messages.length, projectedMessages: selected.length })
}
export function normalizeV2(info, messages, warnings = []) {
  if (info.revert?.partID) throw new Error('OpenCode v2 legacy part revert is unsupported; commit/clear in the source before export')
  let selected = [...new Map(messages.map(m => [m.id, m])).values()]
  if (info.revert?.messageID) { const i = selected.findIndex(m => m.id === info.revert.messageID); if (i < 0) throw new Error('OpenCode v2 revert boundary missing'); selected = selected.slice(0, i + 1); warnings.push('opencode: staged v2 revert projected through boundary message') }
  const boundary = selected.findLastIndex(m => m.type === 'compaction' && m.status === 'completed')
  if (boundary >= 0) {
    if (selected[boundary].providerContext) throw new Error('OpenCode v2 native providerContext compaction is not model-neutral; export a textual compacted context in OpenCode before importing')
    selected = selected.slice(boundary); warnings.push('opencode: latest completed textual compaction projected; original prefix excluded')
  }
  const entries = [], images = [], calls = new Set()
  const add = (m, payload, suffix = '') => entries.push({ id: m.id + suffix, parentId: null, timestamp: iso(m.time?.created), ...payload })
  for (const m of selected) {
    if (!m.id) throw new Error('OpenCode v2 message ID missing')
    switch (m.type) {
      case 'user': { const content = [{ type: 'text', text: text(m.text) }]; for (const file of list(m.files)) content.push(fileContent(file, images, warnings, 'opencode')); add(m, { type: 'message', message: { role: 'user', content } }); if (list(m.agents).length || list(m.skills).length) warnings.push('opencode: user agent/skill selectors preserved only by source text, not source execution configuration'); break }
      case 'synthetic': add(m, { type: 'custom_message', customType: 'opencode:synthetic', content: text(m.text), display: true }); break
      case 'system': case 'skill': add(m, { type: 'message', message: { role: 'developer', content: text(m.text) } }); warnings.push(`opencode: ${m.type} update degraded to developer context`); break
      case 'shell': add(m, { type: 'message', message: { role: 'bashExecution', command: text(m.command), output: text(m.output?.output), exitCode: m.exit, cancelled: m.status !== 'completed', truncated: false } }); break
      case 'assistant': {
        const content = [], results = []
        for (const p of list(m.content)) {
          if (p.type === 'text') content.push({ type: 'text', text: text(p.text) })
          else if (p.type === 'reasoning') { content.push({ type: 'thinking', thinking: text(p.text) }); if (p.state) warnings.push('opencode: opaque provider reasoning replay state not imported') }
          else if (p.type === 'tool') {
            if (!p.id || !p.name || !record(p.state)) { warnings.push('opencode: malformed v2 tool excluded'); continue }
            if (calls.has(p.id)) { warnings.push(`opencode: duplicate tool ${p.id} excluded`); continue }
            calls.add(p.id)
            content.push({ type: 'toolCall', id: p.id, name: p.name, arguments: p.state.input })
            if (p.state.status === 'completed' || p.state.status === 'error') {
              const body = list(p.state.content).map(c => c.type === 'text' ? { type: 'text', text: text(c.text) } : fileContent(c, images, warnings, 'opencode'))
              if (!body.length) body.push({ type: 'text', text: p.state.status === 'error' ? text(p.state.error?.message || p.state.error?.data?.message || p.state.error?._tag) || 'Source tool failed' : '' })
              results.push({ type: 'message', message: { role: 'toolResult', toolCallId: p.id, toolName: p.name, isError: p.state.status === 'error', content: body, ...(record(p.state.metadata) ? { details: { source: 'opencode', metadata: p.state.metadata } } : {}) }, id: `${m.id}:tool:${p.id}`, timestamp: iso(p.time?.completed || m.time?.created), parentId: null })
            } else warnings.push(`opencode: unresolved ${p.state.status} tool ${p.id}; no result invented`)
          } else warnings.push(`opencode: unknown v2 assistant content type ${text(p.type)} excluded`)
        }
        const message = { role: 'assistant', content, provider: text(m.model?.providerID), model: text(m.model?.id) }
        const usage = tokenUsage(m.tokens); if (usage) message.usage = usage
        if (m.error) { message.errorMessage = text(m.error.message || m.error.data?.message || m.error._tag) || 'Source assistant failed'; warnings.push('opencode: assistant error diagnostics degraded; no failed tool identity synthesized') }
        add(m, { type: 'message', message }); entries.push(...results)
        break
      }
      case 'compaction':
        if (m.status === 'completed') { if (m.providerContext) throw new Error('OpenCode native providerContext checkpoint is unsupported'); add(m, { type: 'custom_message', customType: 'opencode:compaction-summary', form: 'recall', content: [text(m.summary), text(m.recent)].filter(Boolean).join('\n\n'), display: true }) }
        else warnings.push(`opencode: ${m.status} compaction attempt excluded; no summary invented`)
        break
      case 'model-switched': case 'agent-switched': case 'location-switched': case 'idle': warnings.push(`opencode: ${m.type} runtime state excluded; per-assistant provenance retained`); break
      default: warnings.push(`opencode: unknown v2 message type ${text(m.type) || '(missing)'} excluded`)
    }
  }
  return makeTranscript(info, linearize(entries), images, warnings, 'opencode', { nativeMessages: messages.length, projectedMessages: selected.length, schema: 'session_v2/session_message' })
}

export function createOpenCodeAdapter({ home = homedir(), config = {} } = {}) {
  const defaults = [path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode')]
  if (config.databasePath) defaults.push(path.resolve(config.databasePath))
  const roots = configuredRoots(defaults, config, home)
  // An explicit databasePath remains explicit authorization even with custom directory roots.
  if (config.databasePath && !roots.includes(path.resolve(config.databasePath))) roots.push(path.resolve(config.databasePath))
  const cap = limits(config)
  async function databases() {
    const files = new Set(config.databasePath ? [path.resolve(config.databasePath)] : [])
    for (const root of roots) {
      const stat = await fs.stat(root).catch(() => null)
      if (stat?.isFile() && /\.db$/.test(root)) files.add(root)
      else if (stat?.isDirectory()) for (const e of await directoryEntries(root)) if (e.isFile() && /^opencode(?:[-.][\w.-]+)?\.db$/.test(e.name)) files.add(path.join(root, e.name))
    }
    return [...files].slice(0, 30)
  }
  async function scan() {
    const sessions = [], warnings = []
    let unsupported = false
    for (const file of await databases()) {
      let opened
      try {
        opened = await openReadOnly(file, roots)
        const db = opened.db, names = tables(db)
        const schemas = names.has('session_v2') && names.has('session_message') ? ['v2'] : names.has('session') && names.has('message') && names.has('part') ? ['v1'] : []
        if (!schemas.length) { unsupported = true; warnings.push(`OpenCode database has unsupported schema: ${file}`); continue }
        for (const schema of schemas) {
          const table = schema === 'v2' ? 'session_v2' : 'session'
          for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY time_updated DESC, id LIMIT ?`).all(cap.sessions - sessions.length)) {
            const info = rowInfo(row)
            sessions.push({ id: info.id, title: info.title || 'OpenCode session', cwd: info.cwd, createdAt: info.createdAt, updatedAt: info.updatedAt, project: info.project, bytes: 0, path: file, locator: { kind: 'sqlite', sessionId: row.id, schema } })
          }
        }
      } catch (error) { if (/node:sqlite/.test(error.message)) unsupported = true; warnings.push(`OpenCode ${file}: ${error.message}`) }
      finally { opened?.db.close() }
      if (sessions.length >= cap.sessions) { warnings.push('OpenCode catalog bounded by maxSessions'); break }
    }
    for (const root of roots) {
      for (const storage of [path.join(root, 'storage'), root]) {
        const sessionDir = path.join(storage, 'session')
        for (const project of await directoryEntries(sessionDir)) {
          if (!project.isDirectory()) continue
          for (const e of await directoryEntries(path.join(sessionDir, project.name))) {
            if (!e.isFile() || !e.name.endsWith('.json')) continue
            const file = path.join(sessionDir, project.name, e.name)
            try {
              const data = await readJson(file, roots, Math.min(cap.bytes, 1024 * 1024))
              if (!data.id || !data.directory) continue
              // Migrated databases are authoritative; avoid listing stale legacy snapshots twice.
              if (sessions.some(s => s.id === data.id)) continue
              const stat = await fs.stat(file)
              sessions.push({ id: data.id, title: text(data.title), cwd: data.directory, createdAt: iso(data.time?.created), updatedAt: iso(data.time?.updated), project: text(data.projectID), bytes: stat.size, path: file, locator: { kind: 'legacy', storage, sessionId: data.id } })
            } catch (error) { warnings.push(`OpenCode legacy ${file}: ${error.message}`) }
            if (sessions.length >= cap.sessions) break
          }
          if (sessions.length >= cap.sessions) break
        }
        if (sessions.length >= cap.sessions) break
      }
      if (sessions.length >= cap.sessions) break
    }
    for (const file of list(config.exportPaths).slice(0, 100)) {
      try {
        const data = await readJson(file, roots, cap.bytes)
        if (!record(data.info) || !Array.isArray(data.messages) || !data.info.id) throw new Error('Not an OpenCode export')
        const info = data.info, stat = await fs.stat(file)
        sessions.push({ id: info.id, title: text(info.title), cwd: text(info.directory || info.location?.directory), createdAt: iso(info.time?.created), updatedAt: iso(info.time?.updated), bytes: stat.size, path: path.resolve(file), locator: { kind: 'export', sessionId: info.id } })
      } catch (error) { warnings.push(`OpenCode explicit export: ${error.message}`) }
    }
    return { sessions: sessions.slice(0, cap.sessions), warnings: [...new Set(warnings)], ...(unsupported && !sessions.length ? { status: 'unsupported' } : {}) }
  }
  async function read(ref) {
    const file = typeof ref === 'string' ? ref : ref.path
    const locator = typeof ref === 'object' && ref.locator ? ref.locator : { kind: 'export' }
    const warnings = []
    if (locator.kind === 'export') {
      const data = await readJson(file, roots, cap.bytes)
      if (!record(data.info) || !Array.isArray(data.messages)) throw new Error('Not an OpenCode session export JSON')
      if (data.messages.length > cap.entries) throw new Error('OpenCode export exceeds maxEntries; explicitly raise read limit')
      return data.messages.some(m => m.type) || data.info.location ? normalizeV2(data.info, data.messages, warnings) : normalizeV1(data.info, data.messages, { warnings })
    }
    if (locator.kind === 'legacy') {
      const info = await readJson(file, roots, cap.bytes), messages = []
      let byteTotal = (await secureFile(file, roots)).stat.size, partTotal = 0
      const readLegacy = async target => {
        byteTotal += (await secureFile(target, roots)).stat.size
        if (byteTotal > cap.bytes) throw new Error('Legacy transcript exceeds maxFileBytes')
        return readJson(target, roots, cap.bytes)
      }
      if (info.id !== locator.sessionId) throw new Error('Legacy session ID changed since discovery')
      const storage = locator.storage
      if (typeof storage !== 'string' || !path.resolve(file).startsWith(path.resolve(storage) + path.sep)) throw new Error('Invalid legacy storage locator')
      const leafId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
      if (!leafId(info.id)) throw new Error('Unsafe legacy session ID')
      const messageDir = path.join(storage, 'message', info.id)
      for (const e of await directoryEntries(messageDir)) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue
        const m = await readLegacy(path.join(messageDir, e.name))
        if (!leafId(m.id) || e.name !== `${m.id}.json`) throw new Error('Unsafe or mismatched legacy message ID')
        if (m.sessionID && m.sessionID !== info.id) throw new Error('Legacy message belongs to another session')
        const parts = []
        for (const p of await directoryEntries(path.join(storage, 'part', m.id))) if (p.isFile() && p.name.endsWith('.json')) {
          if (++partTotal > cap.entries) throw new Error('Legacy session parts exceed maxEntries')
          parts.push(await readLegacy(path.join(storage, 'part', m.id, p.name)))
        }
        messages.push({ info: m, parts })
        if (messages.length > cap.entries) throw new Error('Legacy session exceeds maxEntries')
      }
      messages.sort((a, b) => String(a.info.id).localeCompare(String(b.info.id)))
      return normalizeV1(info, messages, { warnings })
    }
    if (locator.kind !== 'sqlite' || typeof locator.sessionId !== 'string') throw new Error('Invalid OpenCode source locator')
    const { db } = await openReadOnly(file, roots)
    try {
      const names = tables(db), v2 = locator.schema === 'v2'
      if (v2 ? !names.has('session_v2') || !names.has('session_message') : !names.has('session') || !names.has('message') || !names.has('part')) throw new Error('OpenCode database schema changed; rescan sessions')
      const table = v2 ? 'session_v2' : 'session'
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(locator.sessionId)
      if (!row) throw new Error('OpenCode session no longer exists')
      const info = rowInfo(row)
      checkDataBudget(db, v2 ? ['session_message'] : ['message', 'part'], row.id, cap.bytes)
      if (v2) {
        const rows = db.prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ?').all(row.id, cap.entries + 1)
        if (rows.length > cap.entries) throw new Error('OpenCode v2 session exceeds maxEntries')
        const messages = rows.map(r => ({ ...jsonData(r, warnings, 'message'), id: r.id, type: r.type }))
        // Source forks copy their history into the child; never concatenate parent rows again.
        if (info.fork && !messages.length) throw new Error('OpenCode fork has no local message projection; cannot reconstruct its fork boundary safely')
        return normalizeV2(info, messages, warnings)
      }
      const rows = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?').all(row.id, cap.entries + 1)
      if (rows.length > cap.entries) throw new Error('OpenCode session exceeds maxEntries')
      const parts = db.prepare('SELECT * FROM part WHERE session_id = ? ORDER BY message_id, id LIMIT ?').all(row.id, cap.entries + 1)
      if (parts.length > cap.entries) throw new Error('OpenCode session parts exceed maxEntries')
      const grouped = new Map()
      for (const p of parts) { const data = { ...jsonData(p, warnings, 'part'), id: p.id, messageID: p.message_id, sessionID: p.session_id }; const group = grouped.get(p.message_id) || []; group.push(data); grouped.set(p.message_id, group) }
      const messages = rows.map(r => ({ info: { ...jsonData(r, warnings, 'message'), id: r.id, sessionID: r.session_id }, parts: grouped.get(r.id) || [] }))
      return normalizeV1(info, messages, { warnings })
    } finally { db.close() }
  }
  return { id: 'opencode', label: 'OpenCode', description: 'Read-only OpenCode legacy JSON, v1 SQLite, and v2 session_message projections', roots, scan, read }
}
