/** Two independent operations: sync a conversion copy; import it as a NEW conversation. */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { toSeed, mappingReport } from './mapper.js'
import { createSourceRegistry, checkedWorkspace } from './source-registry.js'
import { createCopyStore } from './copy-store.js'
import { importedRuntimeOptions, activateImportedSession, checkImportedPrompt } from './native-activation.js'
import { archivedSessionIds } from './archive-state.js'
import { ensureProtectedSystemHead } from './protected-head.js'

const FULL = { maxTurns: Number.MAX_SAFE_INTEGER, maxSeedBytes: Number.MAX_SAFE_INTEGER, maxTextChars: 0, maxResultChars: 0, includeThinking: true, includeToolResults: true }
const unique = values => [...new Set(values)]
function copyOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('选项必须是对象。')
  for (const key of ['includeThinking', 'includeToolResults']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`)
  return { includeThinking: input.includeThinking !== false, includeToolResults: input.includeToolResults !== false }
}
const sourceRow = value => ({ ...value.row, source: value.adapter.id, title: value.transcript.head.title || value.row.title || '未命名会话', cwd: value.transcript.head.cwd || value.row.cwd || '' })
export function createCopyImporter(ctx, config = {}, registry, hydrateImages) {
  const home = config.home ?? homedir(), sources = registry ? Promise.resolve(registry) : createSourceRegistry({ home, config })
  const copies = createCopyStore(config.copyRoot ?? join(home, '.dsh', 'session-import'))
  const copying = new Map()
  let importing = 0
  function findCopy(input) {
    if (input.key) {
      const copy = copies.get(input.key)
      if (copy && (!input.source || copy.source === input.source)) return copy
    }
    return input.path ? copies.all().find(copy => copy.row.path === input.path && (!input.source || copy.source === input.source)) : undefined
  }
  async function list() {
    const catalog = await (await sources).scan(), rows = new Map(catalog.sessions.map(row => [row.key, row]))
    for (const copy of copies.all()) {
      const nativeRow = rows.get(copy.key)
      rows.set(copy.key, { ...(nativeRow ?? copy.row), key: copy.key, copied: true, copiedAt: copy.copiedAt, copyPath: copy.copyPath, copyRevision: copy.revision, sourceMissing: !nativeRow, importable: true })
    }
    catalog.sessions = [...rows.values()].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
    catalog.totals = { ...catalog.totals, sessions: catalog.sessions.length, projects: new Set(catalog.sessions.map(row => row.cwd)).size }
    // Only used to guard opening a result. Copies themselves have no associated session.
    catalog.archivedSessionIds = [...await archivedSessionIds(ctx)]
    const modules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
    const client = modules?.graph().entries.find(entry => entry.id === 'dsh-plugin-omp-import')
    if (client) catalog.client = { id: client.id, rev: client.rev, url: client.url }
    return catalog
  }
  function validate(events) { ctx.sessions?.prepare(`copy-validation-${randomUUID()}`, { seed: events, inheritedEventCount: events.length, meta: { isSeeded: true } }) }
  async function readSource(input) {
    const value = await (await sources).read(input), selected = new Map()
    const projected = toSeed(value.transcript, { ...FULL, resolveImage: (blob, type) => { selected.set(blob, type); return null } })
    if (!projected.events.some(event => ['user/message', 'assistant/message', 'developer/message'].includes(event.type))) throw new Error('该会话没有可复制的对话内容。')
    validate(projected.events)
    return { ...value, ...projected, selected }
  }
  const copyResult = (copy, extra = {}) => ({ ok: true, copied: true, key: copy.key, source: copy.source, title: copy.row.title, cwd: copy.row.cwd, copyPath: copy.copyPath, copiedAt: copy.copiedAt, stats: copy.stats, warnings: copy.warnings, ...extra })
  // Kept for existing diagnostic tool callers; no preview UI.
  async function preview(input) {
    const existing = findCopy(input)
    if (existing) {
      const copy = copies.read(existing.key), prepared = ensureProtectedSystemHead(copy.events)
      validate(prepared.events)
      return { ...copyResult(copy), report: `${copy.source} → DSH 独立副本，${prepared.events.length} 条事件；导入不会读取任何旧 DSH 会话。` }
    }
    const value = await readSource(input)
    return { ok: true, copied: false, source: value.adapter.id, title: sourceRow(value).title, cwd: sourceRow(value).cwd, stats: value.stats, warnings: unique([...(value.stats.warnings ?? []), ...(value.stats.noHome ?? [])]), report: mappingReport(value.transcript, value.stats) }
  }
  async function convert(input) {
    const existing = findCopy(input), value = await readSource(input)
    if (existing?.sourceFingerprint === value.fingerprint && existing.protectedSystemHead === true) return copyResult(existing, { unchanged: true })
    const { refs, warnings: imageWarnings } = await hydrateImages(ctx, value.transcript, value.selected)
    const projected = toSeed(value.transcript, { ...FULL, resolveImage: blob => refs.get(blob) ?? null })
    validate(projected.events)
    const copy = copies.save(value.row.key, sourceRow(value), value.fingerprint, projected.events, projected.stats, unique([...(projected.stats.warnings ?? []), ...(projected.stats.noHome ?? []), ...imageWarnings]))
    return copyResult(copy, { updated: !!existing })
  }
  async function sync(input) {
    const key = input.key || input.path
    if (!key) throw new Error('请选择一个扫描到的会话。')
    // Coalesce only conversion of the same source. This never creates/changes an Agent.
    if (copying.has(key)) return copying.get(key)
    const operation = convert(input)
    copying.set(key, operation)
    try { return await operation } finally { copying.delete(key) }
  }
  function importEvents(copy, options) {
    const events = structuredClone(copy.events)
    if (!options.includeThinking) for (const event of events) {
      const message = event.type === 'user/message' ? event.data : event.data.message
      if (message?.content) message.content = message.content.filter(block => block.type !== 'reasoning')
    }
    if (!options.includeToolResults) for (const event of events) if (event.type === 'tool/result') event.data.message.content = [{ type: 'text', text: '[本次导入省略工具输出；完整副本仍保留]' }]
    return events
  }
  async function importSession(input) {
    const options = copyOptions(input.options ?? input)
    let record = findCopy(input)
    if (!record) { const copied = await sync(input); record = copies.get(copied.key) }
    if (importing >= 4) throw new Error('请等待当前导入完成。')
    importing++
    try {
      let copy = copies.read(record.key)
      const prepared = ensureProtectedSystemHead(copy.events)
      if (prepared.changed) {
        validate(prepared.events)
        const stats = { ...copy.stats, events: prepared.events.length, seedBytes: prepared.events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0) }
        const upgraded = copies.save(copy.key, copy.row, copy.sourceFingerprint, prepared.events, stats, copy.warnings)
        // A schema-only upgrade is not a new synchronization from the source.
        copies.put(copy.key, { ...upgraded, copiedAt: copy.copiedAt })
        copy = copies.read(record.key)
      }
      const cwd = checkedWorkspace(input.cwd || copy.row.cwd), runtime = await importedRuntimeOptions(ctx)
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd) ?? await ctx.workspaceRegistry.create(cwd)
      const events = importEvents(copy, options)
      validate(events)
      // Every import call gets a new identity, regardless of previous imports.
      const sessionId = `session-${randomUUID()}`
      const handle = await ctx.agents.create({ sessionId, seed: events, inheritedEventCount: events.length, agentOptions: runtime.agentOptions, meta: { cwd, isSeeded: true, ...(runtime.agentPreset ? { agentPreset: runtime.agentPreset } : {}) } })
      try { await workspace.attachSession(sessionId) }
      catch (failure) { try { await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }) } catch {}; await handle.dispose(); throw new Error(`副本已保存，但不能归入工作区：${failure.message}`) }
      const warnings = [...copy.warnings], live = ctx.sessions?.get(sessionId), titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      if (live && titleService && !titleService.get(live)) { try { titleService.rename(live, copy.row.title) } catch (failure) { warnings.push(`标题未设置：${failure.message}`) } }
      if (live) { try { await ctx.sessions.flush(live) } catch (failure) { warnings.push(`会话检查点失败：${failure.message}`) } }
      await handle.dispose()
      await activateImportedSession(ctx, sessionId)
      // Do not write a session ID back into the copy index: imports are independent.
      return { ...copyResult(copy), sessionId, workspace: workspace.id, attached: true, warnings, summary: '已创建新的 DSH 对话；同步副本不会再改动这条对话。' }
    } finally { importing-- }
  }
  async function check(input) {
    if (!input.sessionId) throw new Error('请指定要检查的 DSH sessionId；转换副本不绑定任何会话。')
    return checkImportedPrompt(ctx, input.sessionId)
  }
  return { list, preview, importSession, sync, check }
}
