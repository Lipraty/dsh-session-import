/**
 * Official Z.ai ZCode only (not similarly named unofficial CLIs).
 * Pinned source: zai-org/ZCode aac4755666d09fdcd70272fcf063c077a639015f.
 * https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts
 * https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts
 * Durable message/part snapshots are authoritative; event journals, queued inputs,
 * settings/permissions and credentials are never read or replayed.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { configuredRoots, directoryEntries, openReadOnly, tables, columns, rowInfo, jsonData, checkDataBudget, normalizeV1, list, record, text, limits } from './opencode.js'

function branch(messages, revert, warnings) {
  if (!revert?.targetMessageID) return messages
  const byId = new Map(messages.map(m => [m.info.id, m]))
  const target = messages.findIndex(m => m.info.id === revert.targetMessageID)
  let kept
  if (Array.isArray(revert.keptMessageIDs)) {
    if (revert.keptMessageIDs.some(id => !byId.has(id))) throw new Error('ZCode rewind keptMessageIDs references missing rows; active branch cannot be reconstructed')
    kept = revert.keptMessageIDs.map(id => byId.get(id))
  } else {
    if (target < 0) throw new Error('ZCode rewind target missing; cannot reconstruct an unambiguous active branch')
    kept = messages.slice(0, target)
  }
  if (revert.branchCutAfterMessageID) {
    const cut = messages.findIndex(m => m.info.id === revert.branchCutAfterMessageID)
    if (cut < 0) throw new Error('ZCode rewind branch-cut cursor missing')
    warnings.push('zcode: append-only rewind projected as kept prefix plus messages after branch-cut cursor')
    return [...kept, ...messages.slice(cut + 1)]
  }
  if (revert.createdMessageID) {
    const created = messages.findIndex(m => m.info.id === revert.createdMessageID)
    if (created < 0) throw new Error('ZCode legacy rewind-created cursor missing')
    return [...kept, ...messages.slice(created)]
  }
  return kept
}
const activeBoundary = p => p.type === 'compaction' && (Boolean(p.compactBoundary) || !p.timelineStatus)
function compact(messages, warnings) {
  const index = messages.findLastIndex(m => list(m.parts).some(activeBoundary))
  if (index < 0) return messages
  const marker = messages[index]
  const boundary = list(marker.parts).find(p => p.type === 'compaction' && p.compactBoundary)?.compactBoundary
  let active = messages.slice(index)
  if (boundary?.preservedSegment) {
    const segment = boundary.preservedSegment
    const head = messages.findIndex(m => m.info.id === segment.headMessageId)
    const tail = messages.findIndex(m => m.info.id === segment.tailMessageId)
    if (head < 0 || tail < head || tail >= index) throw new Error('ZCode compaction preserved segment references an invalid pre-boundary range')
    const preserved = messages.slice(head, tail + 1).filter(m => m.info.semantics?.providerVisibility !== 'hidden' && !list(m.parts).some(p => p.type === 'compaction') && !(m.info.role === 'assistant' && m.info.error)).map(m => m.info.role === 'assistant' ? { ...m, info: { ...m.info, tokens: { ...m.info.tokens, total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } : m)
    const anchor = active.findIndex(m => m.info.id === segment.anchorMessageId)
    const insert = anchor >= 0 ? anchor + 1 : 1
    active = [...active.slice(0, insert), ...preserved, ...active.slice(insert)]
    warnings.push('zcode: compact preserved segment reinserted after its anchor; preserved assistant usage zeroed as in source context projection')
  }
  if (boundary?.summaryMessageIds?.some(id => !active.some(m => m.info.id === id))) throw new Error('ZCode compaction summary rows missing; cannot reconstruct compacted context')
  warnings.push('zcode: latest active compact boundary applied; original summarized history excluded')
  return active
}
export function normalizeZCode(info, messages, warnings = []) {
  const revert = info.revert
  let active
  if (revert?.branchCutAfterMessageID) active = compact(branch(messages, revert, warnings), warnings)
  else {
    // Preserve the official old-data compact-first/createdMessageID compatibility rule.
    const lastBoundary = messages.findLastIndex(m => list(m.parts).some(activeBoundary))
    const compacted = compact(messages, warnings)
    if (lastBoundary >= 0 && Array.isArray(revert?.keptMessageIDs) && !revert.keptMessageIDs.some(id => messages.slice(lastBoundary).some(m => m.info.id === id))) active = compacted
    else active = branch(compacted, revert, warnings)
  }
  if (info.parentID) warnings.push('zcode: fork/child history is already copied locally; parent history not concatenated')
  const result = normalizeV1(info, active, { source: 'zcode', warnings })
  result.stats.nativeMessages = messages.length
  result.stats.projectedMessages = active.length
  result.stats.schema = 'session/message/part'
  return result
}
export function createZCodeAdapter({ home = homedir(), config = {} } = {}) {
  const databasePath = config.databasePath ? path.resolve(config.databasePath) : path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  const roots = configuredRoots([path.dirname(databasePath)], config, home)
  if (config.databasePath && !roots.includes(databasePath)) roots.push(databasePath)
  const cap = limits(config)
  async function databases() {
    const paths = new Set(config.databasePath ? [databasePath] : [])
    for (const root of roots) {
      const stat = await fs.stat(root).catch(() => null)
      if (stat?.isFile() && /\.(?:sqlite|db)$/.test(root)) paths.add(root)
      if (stat?.isDirectory()) {
        for (const relative of ['db.sqlite', path.join('cli', 'db', 'db.sqlite')]) {
          const file = path.join(root, relative)
          if ((await fs.stat(file).catch(() => null))?.isFile()) paths.add(file)
        }
      }
    }
    return [...paths].slice(0, 30)
  }
  const verify = db => {
    const names = tables(db)
    if (!names.has('session') || !names.has('message') || !names.has('part')) throw new Error('Unsupported official ZCode database schema: expected session/message/part; no guessed import')
    const required = [['session', ['id', 'directory', 'title', 'time_created', 'time_updated']], ['message', ['id', 'session_id', 'data', 'time_created']], ['part', ['id', 'message_id', 'session_id', 'data', 'time_created']]]
    for (const [table, fields] of required) { const actual = columns(db, table); if (fields.some(field => !actual.has(field))) throw new Error(`Unsupported ZCode ${table} columns; no migration is run`) }
  }
  async function scan() {
    const sessions = [], warnings = []
    let unsupported = false
    for (const file of await databases()) {
      let opened
      try {
        opened = await openReadOnly(file, roots); verify(opened.db)
        for (const row of opened.db.prepare('SELECT * FROM session ORDER BY time_updated DESC, id LIMIT ?').all(cap.sessions - sessions.length)) {
          const info = rowInfo(row, 'zcode')
          sessions.push({ id: info.id, title: info.title || 'ZCode session', cwd: info.cwd, createdAt: info.createdAt, updatedAt: info.updatedAt, project: info.project, bytes: 0, path: file, locator: { kind: 'sqlite', sessionId: row.id, schema: 'zcode' } })
        }
      } catch (error) { if (/Unsupported|node:sqlite/.test(error.message)) unsupported = true; warnings.push(`ZCode ${file}: ${error.message}`) }
      finally { opened?.db.close() }
      if (sessions.length >= cap.sessions) { warnings.push('ZCode catalog bounded by maxSessions'); break }
    }
    return { sessions, warnings, ...(unsupported && !sessions.length ? { status: 'unsupported' } : {}) }
  }
  async function read(ref) {
    if (!record(ref) || ref.locator?.kind !== 'sqlite' || typeof ref.locator.sessionId !== 'string') throw new Error('ZCode requires a scanned SQLite session locator')
    const { db } = await openReadOnly(ref.path, roots)
    try {
      verify(db)
      const row = db.prepare('SELECT * FROM session WHERE id = ?').get(ref.locator.sessionId)
      if (!row) throw new Error('ZCode session no longer exists; rescan')
      const info = rowInfo(row, 'zcode'), warnings = []
      checkDataBudget(db, ['message', 'part'], row.id, cap.bytes)
      const mc = columns(db, 'message'), pc = columns(db, 'part')
      const messageOrder = mc.has('sequence') ? 'sequence IS NULL, sequence, time_created, rowid' : 'time_created, rowid'
      const partOrder = pc.has('sequence') ? 'message_id, sequence IS NULL, sequence, time_created, id' : 'message_id, time_created, id'
      if (!mc.has('sequence') || !pc.has('sequence')) warnings.push('zcode: pre-0014 sequence schema; legacy physical/time fallback used read-only')
      const rows = db.prepare(`SELECT * FROM message WHERE session_id = ? ORDER BY ${messageOrder} LIMIT ?`).all(row.id, cap.entries + 1)
      const partRows = db.prepare(`SELECT * FROM part WHERE session_id = ? ORDER BY ${partOrder} LIMIT ?`).all(row.id, cap.entries + 1)
      if (rows.length > cap.entries || partRows.length > cap.entries) throw new Error('ZCode session exceeds maxEntries; explicitly raise read limit')
      const byMessage = new Map()
      for (const p of partRows) {
        const data = { ...jsonData(p, warnings, 'part'), id: p.id, messageID: p.message_id, sessionID: p.session_id }
        const group = byMessage.get(p.message_id) || []; group.push(data); byMessage.set(p.message_id, group)
      }
      const messages = rows.map(r => ({ info: { ...jsonData(r, warnings, 'message'), id: r.id, sessionID: r.session_id }, parts: byMessage.get(r.id) || [] }))
      // Do not use providerID/modelID rollback snapshots as current providerId/modelId.
      for (const m of messages) if (m.info.role === 'assistant' && (!m.info.providerId || !m.info.modelId) && (m.info.providerID || m.info.modelID)) warnings.push('zcode: legacy rollback model fields ignored; current execution identity missing')
      // Session entries are configuration/provenance, not an additional transcript stream.
      if (tables(db).has('session_entry')) {
        const kinds = db.prepare('SELECT DISTINCT type FROM session_entry WHERE session_id = ? LIMIT 100').all(row.id)
        for (const kind of kinds) warnings.push(`zcode: session_entry ${text(kind.type)} state excluded; not replayed as a message`)
      }
      return normalizeZCode(info, messages, warnings)
    } finally { db.close() }
  }
  return { id: 'zcode', label: 'ZCode (Z.ai)', description: 'Read-only official zai-org/ZCode SQLite snapshots; active rewind/compaction context', roots, scan, read }
}
