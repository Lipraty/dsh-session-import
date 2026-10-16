/**
 * Pi JSONL v1/v2/v3, without invoking SessionManager (which migrates/repairs files).
 * Historical contract: https://github.com/badlogic/pi-mono/blob/v0.57.1/packages/coding-agent/docs/session.md
 * Current contract: https://github.com/earendil-works/pi/blob/3daa20280f6a7c7cbe0935680c9a38fdc3863005/packages/coding-agent/src/core/session-manager.ts
 * The format is still v3 despite additive system/usage/context_edit entries.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { configuredRoots, directoryEntries, secureFile, record, list, text, iso, limits, makeTranscript, linearize } from './opencode.js'

function parseJsonl(raw, cap) {
  const warnings = [], rows = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try { const row = JSON.parse(lines[i]); if (!record(row)) throw new Error(); rows.push(row) }
    catch { if (i === lines.length - 1 && !raw.endsWith('\n')) warnings.push('pi: incomplete final JSONL line ignored; source was not repaired'); else throw new Error(`Pi malformed JSONL at line ${i + 1}; refusing to silently drop a branch entry`) }
    if (rows.length > cap.entries + 1) throw new Error('Pi session exceeds maxEntries; explicitly raise read limit')
  }
  const head = rows.shift()
  if (head?.type !== 'session' || typeof head.id !== 'string' || !head.id) throw new Error('Not a Pi session: first parsed row must be a session header with an ID')
  const version = head.version ?? 1
  if (![1, 2, 3].includes(version)) throw new Error(`Unsupported Pi session version ${version}; supported versions are 1, 2, 3`)
  if (version === 1) {
    let parentId = null
    for (let i = 0; i < rows.length; i++) { const row = rows[i]; row.id = `${head.id}:legacy:${i + 1}`; row.parentId = parentId; parentId = row.id }
    for (const row of rows) if (row.type === 'compaction' && Number.isSafeInteger(row.firstKeptEntryIndex)) { row.firstKeptEntryId = rows[row.firstKeptEntryIndex - 1]?.id; delete row.firstKeptEntryIndex }
    warnings.push('pi: v1 linear entries migrated in memory; source file left unchanged')
  }
  if (version < 3) {
    for (const row of rows) if (row.type === 'message' && row.message?.role === 'hookMessage') row.message.role = 'custom'
    warnings.push('pi: legacy hookMessage renamed to custom in memory')
  }
  const byId = new Map()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id) throw new Error('Pi tree entry is missing its ID')
    if (byId.has(row.id)) throw new Error(`Pi duplicate tree entry ID ${row.id}; active branch is ambiguous`)
    byId.set(row.id, row)
  }
  const branch = [], seen = new Set()
  let current = rows.at(-1)
  while (current) {
    if (seen.has(current.id)) throw new Error('Pi branch contains a parent cycle')
    seen.add(current.id); branch.push(current)
    if (current.parentId === null) break
    if (typeof current.parentId !== 'string' || !byId.has(current.parentId)) throw new Error(`Pi broken parent chain at ${current.id}; no partial history imported`)
    current = byId.get(current.parentId)
  }
  branch.reverse()
  if (rows.length > branch.length) warnings.push(`pi: selected last physical entry's branch; ${rows.length - branch.length} off-branch entries not imported`)
  return { head, rows, branch, warnings, version }
}
function contentBlocks(content, images, warnings) {
  if (typeof content === 'string') return content
  const out = []
  for (const block of list(content)) {
    if (!record(block)) continue
    if (block.type === 'text') out.push({ type: 'text', text: text(block.text) })
    else if (block.type === 'thinking') {
      if (block.redacted) warnings.push('pi: redacted thinking contains opaque provider replay payload, not recovered reasoning text')
      if (block.thinkingSignature) warnings.push('pi: opaque thinking signatures not imported across providers')
      out.push({ type: 'thinking', thinking: text(block.thinking) })
    } else if (block.type === 'toolCall') {
      if (!block.id || typeof block.name !== 'string') { warnings.push('pi: malformed tool call excluded'); continue }
      out.push({ type: 'toolCall', id: block.id, name: block.name, arguments: record(block.arguments) ? block.arguments : block.arguments || {} })
      if (block.namespace) warnings.push('pi: tool namespace recorded by source but not activated in DSH')
    } else if (block.type === 'image') {
      if (typeof block.data !== 'string') { warnings.push('pi: malformed image excluded'); continue }
      // Pi's public contract specifies embedded base64, unlike omp blob:sha256 refs.
      if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) {
        out.push({ type: 'image', data: block.data, mimeType: text(block.mimeType) })
        images.push({ blob: block.data, data: block.data, mimeType: text(block.mimeType), source: 'content' })
      } else { out.push({ type: 'text', text: `[pi image ${text(block.mimeType)}: non-inline bytes not imported]` }); warnings.push('pi: non-base64 image reference degraded; referenced bytes not read') }
    } else warnings.push(`pi: unknown content block ${text(block.type) || '(missing)'} excluded`)
  }
  return out
}
export function normalizePi(raw, config = {}) {
  const { head, rows, branch, warnings, version } = parseJsonl(raw, limits(config))
  const images = [], entries = []
  const lastCompaction = branch.findLastIndex(row => row.type === 'compaction')
  let selected = branch
  if (lastCompaction >= 0) {
    const compact = branch[lastCompaction]
    const keep = branch.findIndex(row => row.id === compact.firstKeptEntryId)
    if (keep < 0 || keep > lastCompaction) throw new Error('Pi compaction firstKeptEntryId is not on the active pre-compaction path')
    selected = [compact, ...branch.slice(keep, lastCompaction).filter(row => row.message?.role !== 'system'), ...branch.slice(lastCompaction + 1)]
    warnings.push('pi: latest compaction projected to summary plus retained range; no synthetic DSH replacement range invented')
  }
  const edits = new Map()
  for (const row of selected) if (row.type === 'context_edit') {
    if (!selected.some(target => target.id === row.targetId && (target.type === 'custom_message' || target.type === 'message' && ['user', 'assistant', 'toolResult', 'custom'].includes(target.message?.role)))) { warnings.push(`pi: context_edit ${row.id} has no editable target in effective context`); continue }
    if (row.replacement !== null && !(record(row.replacement) && (typeof row.replacement.content === 'string' || Array.isArray(row.replacement.content)))) throw new Error(`Pi context_edit ${row.id} has an unsupported replacement shape`)
    edits.set(row.targetId, row)
  }
  let promptParts = [], sections = {}, promptEntry = null
  const updateSystem = (message, row) => {
    const body = typeof message.content === 'string' ? message.content : list(message.content).filter(p => p.type === 'text').map(p => text(p.text)).join('\n')
    if (body) promptParts.push(body)
    if (record(message.sections)) for (const [name, value] of Object.entries(message.sections)) { if (value === null) delete sections[name]; else if (typeof value === 'string') sections[name] = value; else warnings.push(`pi: invalid system section ${name} excluded`) }
    if (list(message.toolsAdded).length || list(message.toolsRemoved).length) warnings.push('pi: source tool loadout changes not activated; historical schemas do not replace registered DSH tools')
    promptEntry = row
  }
  if (lastCompaction >= 0 && branch[lastCompaction].systemMessage) updateSystem(branch[lastCompaction].systemMessage, branch[lastCompaction])
  for (const row of selected) if (row.type === 'message' && row.message?.role === 'system') updateSystem(row.message, row)
  const prompt = [...promptParts, ...Object.entries(sections).map(([name, value]) => `[Pi system section: ${name}]\n${value}`)].filter(Boolean).join('\n\n')
  if (prompt && promptEntry) { entries.push({ id: `${promptEntry.id}:effective-system`, parentId: null, timestamp: iso(promptEntry.timestamp), type: 'message', message: { role: 'developer', content: prompt } }); warnings.push('pi: effective system prompt/section patches collapsed into conservative developer context; historical patch timing not replayed') }
  const calls = new Set()
  for (const row of selected) {
    const edit = edits.get(row.id)
    if (edit?.replacement === null) { warnings.push(`pi: context_edit omitted ${row.id} from effective context`); continue }
    const entry = { id: row.id, parentId: null, timestamp: iso(row.timestamp), type: row.type }
    switch (row.type) {
      case 'message': {
        if (!record(row.message)) throw new Error(`Pi message ${row.id} is malformed`)
        const m = { ...row.message }
        if (edit) { m.content = edit.replacement.content; warnings.push(`pi: context_edit replacement applied to ${row.id}`) }
        if (m.role === 'system') break
        if (m.role === 'custom') { entries.push({ ...entry, type: 'custom_message', customType: `pi:${text(m.customType) || 'custom'}`, content: contentBlocks(m.content, images, warnings), display: m.display !== false }); break }
        if (m.role === 'compactionSummary' || m.role === 'branchSummary') { entries.push({ ...entry, type: 'custom_message', customType: `pi:${m.role}`, form: 'recall', content: text(m.summary), display: true }); break }
        if (m.role === 'bashExecution') { if (!m.excludeFromContext) entries.push({ ...entry, message: m }); else warnings.push('pi: excludeFromContext bash execution omitted'); break }
        if (!['user', 'assistant', 'toolResult'].includes(m.role)) { warnings.push(`pi: unknown extensible message role ${text(m.role)} excluded`); break }
        m.content = contentBlocks(m.content, images, warnings)
        if (m.role === 'assistant') {
          m.content = list(m.content).filter(p => { if (p.type !== 'toolCall') return true; if (calls.has(p.id)) { warnings.push(`pi: duplicate tool call ${p.id} excluded`); return false }; calls.add(p.id); return true })
          if (record(m.usage)) { const usage = { input: m.usage.input, output: m.usage.output }; for (const k of ['totalTokens', 'cacheRead', 'cacheWrite']) if (Number.isFinite(m.usage[k])) usage[k] = m.usage[k]; m.usage = usage }
          if (m.stopReason === 'deferred') warnings.push('pi: deferred provider handle not imported or polled')
        }
        if (m.role === 'toolResult' && !calls.has(m.toolCallId)) warnings.push(`pi: orphan tool result ${text(m.toolCallId)} after branch/compaction/context edits; retained for the common mapper's notice projection`)
        if (m.role === 'toolResult' && (m.usage || m.nestedCalls)) warnings.push('pi: nested tool usage/calls preserved only as source metadata; not counted as main assistant usage')
        entries.push({ ...entry, message: m }); break
      }
      case 'custom_message': entries.push({ ...entry, customType: `pi:${text(row.customType) || 'custom'}`, content: contentBlocks(edit ? edit.replacement.content : row.content, images, warnings), display: row.display !== false }); break
      case 'compaction': if (row === selected[0] && lastCompaction >= 0) entries.push({ ...entry, type: 'custom_message', customType: 'pi:compaction-summary', form: 'recall', content: text(row.summary), display: true }); break
      case 'branch_summary': entries.push({ ...entry, type: 'branch_summary', fromId: row.fromId, summary: text(row.summary) }); break
      case 'model_change': entries.push({ ...entry, provider: text(row.provider), modelId: text(row.modelId) }); break
      case 'thinking_level_change': entries.push({ ...entry, thinkingLevel: text(row.thinkingLevel) }); break
      case 'usage': warnings.push(`pi: non-context usage (${text(row.kind)}) excluded; main assistant usage remains per message`); break
      case 'custom': warnings.push(`pi: extension state ${text(row.customType)} excluded, never replayed`); break
      case 'session_info': case 'label': case 'context_edit': break
      default: warnings.push(`pi: unknown session entry ${text(row.type) || '(missing)'} excluded`)
    }
  }
  const title = [...rows].reverse().find(row => row.type === 'session_info')
  const info = { ...head, ...(title ? { title: text(title.name), titleSource: 'user' } : {}), createdAt: head.timestamp, parentID: head.parentSession }
  return makeTranscript(info, linearize(entries), images, warnings, 'pi', { nativeVersion: version, nativeEntries: rows.length, branchEntries: branch.length, branchDropped: rows.length - branch.length, contextEdits: edits.size })
}
export function createPiAdapter({ home = homedir(), config = {} } = {}) {
  const defaultSessionRoot = config.agentDir ? path.join(config.agentDir, 'sessions') : process.env.PI_CODING_AGENT_SESSION_DIR || path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'sessions')
  const roots = configuredRoots([defaultSessionRoot], config, home)
  const cap = limits(config)
  async function files() {
    const out = []
    // Pi default layout is exactly sessions/<encoded-cwd>/*.jsonl; --session-dir may be flat.
    for (const root of roots) {
      for (const e of await directoryEntries(root)) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(root, e.name))
        if (e.isDirectory()) for (const child of await directoryEntries(path.join(root, e.name))) if (child.isFile() && child.name.endsWith('.jsonl')) out.push(path.join(root, e.name, child.name))
        if (out.length >= cap.sessions) return out.slice(0, cap.sessions)
      }
    }
    return out
  }
  async function scan() {
    const sessions = [], warnings = []
    for (const file of await files()) {
      let handle
      try {
        const { file: actual, stat } = await secureFile(file, roots)
        handle = await fs.open(actual, 'r')
        const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const raw = buffer.subarray(0, bytesRead).toString('utf8')
        const first = raw.split('\n').find(line => line.trim())
        const head = JSON.parse(first || '{}')
        if (head.type !== 'session' || !head.id) continue
        const tailSize = Math.min(stat.size, 128 * 1024), tail = Buffer.alloc(tailSize)
        await handle.read(tail, 0, tailSize, stat.size - tailSize)
        const tailRows = tail.toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
        const title = tailRows.findLast(row => row.type === 'session_info')
        sessions.push({ id: head.id, title: text(title?.name || head.title) || 'Pi session', cwd: text(head.cwd), createdAt: iso(head.timestamp), updatedAt: iso(stat.mtimeMs), project: text(head.cwd), bytes: stat.size, path: file, locator: { kind: 'jsonl', sessionId: head.id } })
      } catch (error) { warnings.push(`Pi ${file}: ${error.message}`) }
      finally { await handle?.close() }
    }
    return { sessions, warnings }
  }
  async function read(ref) {
    const file = typeof ref === 'string' ? ref : ref.path
    const { file: actual, stat } = await secureFile(file, roots)
    if (stat.size > cap.bytes) throw new Error('Pi session exceeds maxFileBytes; explicitly raise read limit')
    const transcript = normalizePi(await fs.readFile(actual, 'utf8'), config)
    if (ref.locator?.sessionId && ref.locator.sessionId !== transcript.head.id) throw new Error('Pi session ID changed since discovery')
    return transcript
  }
  return { id: 'pi', label: 'Pi', description: 'Read-only badlogic/pi-mono (now earendil-works/pi) session JSONL v1–v3', roots, scan, read }
}
