/**
 * Read-only Codex CLI legacy rollout projection, not a Codex runtime/resumer.
 * Pinned contract: openai/codex c22a06c18070c3e33bd2648c7210a00a2a9f6f80:
 * codex-rs/history/src/{lib.rs,rollout_payload.rs}; protocol/src/{models.rs,
 * models/item_metadata.rs,protocol.rs}; rollout/src/{policy.rs,recorder.rs}.
 * https://github.com/openai/codex/tree/c22a06c18070c3e33bd2648c7210a00a2a9f6f80/codex-rs/history/src
 * Deliberate initial gates: paginated history, external history_base, reverted
 * physical revisions, retained/compacted state and rollback are not guessed.
 */
import path from 'node:path'
import { homedir } from 'node:os'
import {
  object, string, array, adapterLimits, sourceRoots, sourceError, requireField,
  safeType, diagnostics, secureOpen, sampleSession, sessionSnapshot, discoverSessionFiles,
  boundedMap, verifyReference, linearEntries, embeddedImage,
} from './claude.js'

const CODEX_PIN = 'openai/codex@c22a06c18070c3e33bd2648c7210a00a2a9f6f80'
const revisionFile = file => /_[^/]+\.jsonl(?:\.zst)?$/.test(path.basename(file))
const nameFromFile = file => path.basename(file).replace(/\.jsonl(?:\.zst)?$/, '')
function gate(v, file = '') {
  if (file.endsWith('.jsonl.zst')) return 'UNSUPPORTED_CODEX_COMPRESSION: zstd rollout decompression is not implemented; select an existing plain JSONL export'
  if (revisionFile(file)) return 'UNRESOLVED_CODEX_REVERT_REVISION: physical revert revision requires immutable-prefix lineage resolution'
  if (v.type === 'session_meta' && object(v.payload)) {
    const p = v.payload
    if (p.history_mode != null && p.history_mode !== 'legacy') return `UNSUPPORTED_CODEX_HISTORY_MODE: ${p.history_mode === 'paginated' ? 'paginated' : 'unknown'} history requires a typed canonical TurnItem projection`
    if (p.history_base != null) return 'UNRESOLVED_CODEX_HISTORY_BASE: inherited immutable rollout prefix is not resolved; a tail is not a complete transcript'
    if (p.subagent_history_start_ordinal != null) return 'UNSUPPORTED_CODEX_INHERITED_BOUNDARY: child-local/inherited prefix boundary is not implemented'
    if (p.forked_from_ordinal_exclusive != null) return 'UNSUPPORTED_CODEX_FORK_BOUNDARY: bounded logical fork history is not implemented'
  }
  if (v.type === 'compacted') return 'UNSUPPORTED_CODEX_COMPACTION: replacement/retained compaction history is not implemented; refusing old-plus-new concatenation'
  if (v.type === 'retained_context') return 'UNSUPPORTED_CODEX_RETAINED_CONTEXT: retained history requires a canonical context projection'
  if (v.type === 'response_item' && ['compaction', 'context_compaction'].includes(v.payload?.type)) return 'UNSUPPORTED_CODEX_OPAQUE_COMPACTION: opaque checkpoint is not a readable effective history'
  if (v.type === 'event_msg' && v.payload?.type === 'thread_rolled_back') return 'UNSUPPORTED_CODEX_ROLLBACK: effective user-turn rollback is not implemented'
  return ''
}
function codexInfo(records, file) {
  const meta = records.find(v => v.type === 'session_meta' && object(v.payload))?.payload
  if (!meta) return null
  return { id: string(meta.id), cwd: string(meta.cwd), createdAt: string(meta.timestamp), title: string(meta.title), titleSource: 'auto', version: string(meta.cli_version), meta }
}
function tokenSnapshot(usage, line) {
  if (!object(usage)) return undefined
  const pairs = { input_tokens: 'input', output_tokens: 'output', total_tokens: 'totalTokens', cached_input_tokens: 'cacheRead', cache_write_input_tokens: 'cacheWrite', reasoning_output_tokens: 'reasoningOutput' }
  const out = {}
  for (const [native, target] of Object.entries(pairs)) {
    if (usage[native] === undefined) continue
    if (!Number.isSafeInteger(usage[native]) || usage[native] < 0) throw sourceError('INVALID_SOURCE_RECORD', 'invalid cumulative token counter', line)
    out[target] = usage[native]
  }
  return Object.keys(out).length ? out : undefined
}
function provenance(p, sibling, index, line) {
  // Per-part attribution lives on the ResponseMessage passthrough. Persisted
  // CodexHarnessMetadata is its SIBLING, not a property of payload. client_authored
  // describes developer instructions/tool retention and does not establish user.
  if (sibling?.inherited_user_message) return { kind: 'inherited-context', form: 'recall' }
  if (sibling?.compaction_output) return { kind: 'compaction-output', form: 'recall' }
  const metadata = p.internal_chat_message_metadata_passthrough
  if (metadata != null && !object(metadata)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid message provenance metadata', line)
  const parts = metadata?.content_item_metadata
  if (parts != null && (!Array.isArray(parts) || parts.length !== p.content.length)) throw sourceError('INVALID_SOURCE_RECORD', 'per-part provenance length does not match content', line)
  const part = parts?.[index]
  if (part != null && !object(part)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid content attribution', line)
  const declared = part?.provenance
  if (declared != null && (!object(declared) || typeof declared.type !== 'string')) throw sourceError('INVALID_SOURCE_RECORD', 'invalid declared provenance', line)
  const kind = declared?.type ?? (typeof part?.source_tool_namespace === 'string' ? 'tool' : part?.harness_injected === true ? 'harness' : 'unknown')
  if (kind === 'user') return null
  if (['developer_instructions', 'skills', 'agents_md'].includes(kind)) return { kind, form: 'instructions' }
  if (kind === 'harness') return { kind: declared?.hook ? 'hook-context' : 'harness-context', form: 'notice' }
  if (kind === 'tool') return { kind: 'tool-context', form: 'notice' }
  return { kind: 'unknown-user-context' }
}
function validateMetadata(metadata, line) {
  if (metadata == null) return
  if (!object(metadata)) throw sourceError('INVALID_SOURCE_RECORD', 'response sibling metadata must be an object', line)
  for (const key of ['client_authored', 'inherited_user_message', 'compaction_output']) requireField(metadata, key, 'boolean', line, true)
}
export function createCodexAdapter({ home = homedir(), config = {} } = {}) {
  const codexHome = config.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex')
  const defaults = [path.join(codexHome, 'sessions')]
  if (config.includeArchives === true) defaults.push(path.join(codexHome, 'archived_sessions'))
  const roots = sourceRoots(defaults, home, config), cap = adapterLimits(config)
  let catalog = new Map()
  async function scan() {
    const { files, warnings } = await discoverSessionFiles(roots, { cap })
    const paths = new Set(files), selected = files.filter(file => !file.endsWith('.zst') || !paths.has(file.slice(0, -4)))
    const next = new Map()
    const rows = await boundedMap(selected, async file => {
      try {
        // Compressed bytes are never decoded or parsed as plaintext: stat only
        // through the same regular-file/containment checks, then expose a gate.
        let sampled
        if (file.endsWith('.zst')) {
          const opened = await secureOpen(file, roots, { ...cap, bytes: Number.MAX_SAFE_INTEGER })
          try { sampled = { stat: opened.stat, records: [] } } finally { await opened.handle.close() }
        } else sampled = await sampleSession(file, roots, cap)
        const { stat, records } = sampled
        const info = file.endsWith('.zst') ? null : codexInfo(records, file)
        if (!info && !file.endsWith('.zst')) return null
        const reason = stat.size > cap.bytes ? `SOURCE_TOO_LARGE: exceeds ${cap.bytes}-byte limit` : gate({}, file) || records.map(v => gate(v)).find(Boolean) || ''
        const root = roots.find(root => file.startsWith(root + path.sep)) || roots[0]
        const id = info?.id || nameFromFile(file)
        if (!id) return null
        const row = { id, title: info?.title || 'Codex CLI session', cwd: info?.cwd || '', createdAt: info?.createdAt || '', updatedAt: stat.mtime.toISOString(), project: info?.cwd ? path.basename(info.cwd) : '', bytes: stat.size, path: file, locator: { kind: 'codex-jsonl', relativePath: path.relative(root, file), nativeId: id }, importable: !reason, ...(reason ? { unsupportedReason: reason } : {}) }
        next.set(file, { row: { ...row, locator: { ...row.locator } }, ino: stat.ino, dev: stat.dev })
        return row
      } catch (error) { warnings.push(`codex: session skipped (${safeType(error.code)})`); return null }
    })
    catalog = next
    if (files.length !== selected.length) warnings.push(`codex: ${files.length - selected.length} compressed sibling(s) suppressed because a plain JSONL rollout exists`)
    return { sessions: rows.filter(Boolean), warnings }
  }
  async function read(ref) {
    const saved = verifyReference(ref, catalog, 'codex')
    if (saved.row.importable === false) throw sourceError(saved.row.unsupportedReason.split(':')[0], saved.row.unsupportedReason)
    const report = diagnostics('codex', CODEX_PIN, 'legacy-response-item-conservative')
    const records = await sessionSnapshot(ref.path, roots, cap, saved, report)
    let priorOrdinal = -1
    for (const row of records) {
      const v = row.value
      requireField(v, 'timestamp', 'string', row.line)
      if (!Number.isFinite(Date.parse(v.timestamp))) throw sourceError('INVALID_SOURCE_RECORD', 'invalid envelope timestamp', row.line)
      if (v.ordinal !== undefined && (!Number.isSafeInteger(v.ordinal) || v.ordinal < 0 || v.ordinal <= priorOrdinal)) throw sourceError('INVALID_CODEX_ORDINAL', 'ordinal must be a strictly increasing nonnegative safe integer', row.line)
      if (v.ordinal !== undefined) priorOrdinal = v.ordinal
      if (!object(v.payload)) throw sourceError('INVALID_SOURCE_RECORD', 'rollout payload must be an object', row.line)
      // Invalid parallel replacement metadata is distinguished before the broad
      // unsupported gate, even though no compacted source is currently imported.
      if (v.type === 'compacted' && v.payload.replacement_history_metadata != null && (!Array.isArray(v.payload.replacement_history) || !Array.isArray(v.payload.replacement_history_metadata) || v.payload.replacement_history_metadata.length !== v.payload.replacement_history.length)) throw sourceError('INVALID_CODEX_REPLACEMENT_METADATA', 'replacement metadata does not match replacement history', row.line)
      const reason = gate(v, ref.path)
      if (reason) throw sourceError(reason.split(':')[0], reason.slice(reason.indexOf(':') + 2), row.line)
    }
    const metas = records.filter(r => r.value.type === 'session_meta')
    if (metas.length !== 1) throw sourceError('INVALID_CODEX_SESSION_META', 'exactly one session_meta is required; refusing merged histories')
    const metaRow = metas[0], meta = metaRow.value.payload
    for (const name of ['id', 'cwd', 'timestamp']) requireField(meta, name, 'string', metaRow.line)
    for (const name of ['session_id', 'model_provider', 'cli_version', 'forked_from_id', 'parent_thread_id']) requireField(meta, name, 'string', metaRow.line, true)
    if (!meta.id || meta.id !== saved.row.id) throw sourceError('SOURCE_CHANGED', 'session ID changed since discovery; rescan')
    if (meta.base_instructions != null && (!object(meta.base_instructions) || typeof meta.base_instructions.text !== 'string')) throw sourceError('INVALID_SOURCE_RECORD', 'invalid base_instructions', metaRow.line)
    if (meta.dynamic_tools != null && !Array.isArray(meta.dynamic_tools)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid dynamic_tools declaration', metaRow.line)
    const info = codexInfo(records.map(r => r.value), ref.path), entries = [], images = [], calls = new Map(), results = new Set(), nativeIds = new Set()
    let currentModel = '', currentProvider = string(meta.model_provider) || 'codex'
    if (!meta.model_provider) report.note('missing-model-provider', metaRow.line, 'native provider absent; source namespace used rather than assuming OpenAI')
    const rawFamilies = new Set(), rawTexts = new Map(), rawOutputIds = new Set()
    const rememberText = (family, parts) => {
      rawFamilies.add(family)
      const texts = rawTexts.get(family) ?? new Set()
      texts.add(array(parts).filter(p => object(p) && typeof p.text === 'string').map(p => p.text).join('\n'))
      rawTexts.set(family, texts)
    }
    for (const row of records) if (row.value.type === 'response_item') {
      const p = row.value.payload
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) rememberText(p.role, p.content)
      if (p.type === 'reasoning') {
        rememberText('reasoning', p.summary)
        if (p.content?.length) rememberText('reasoning', p.content)
      }
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && typeof p.call_id === 'string') rawOutputIds.add(p.call_id)
    }
    const add = (row, payload, suffix = '') => {
      // Physical ordinal/line identifies fragments even when API IDs repeat.
      entries.push({ id: `codex:${meta.id}:${row.value.ordinal ?? `line-${row.line}`}${suffix}`, timestamp: row.value.timestamp, ...payload })
    }
    const custom = (row, kind, content, form, suffix = '') => add(row, { type: 'custom_message', customType: kind, ...(form ? { form } : {}), content }, suffix)
    const assistant = (row, content, suffix = '') => add(row, { type: 'message', message: { role: 'assistant', provider: currentProvider, model: currentModel || 'codex-import', content } }, suffix)
    const contentParts = (value, row) => {
      if (typeof value === 'string') return [{ type: 'text', text: value }]
      if (!Array.isArray(value)) throw sourceError('INVALID_SOURCE_RECORD', 'content/output must be string or array', row.line)
      return value.flatMap(part => {
        if (!object(part) || typeof part.type !== 'string') throw sourceError('INVALID_SOURCE_RECORD', 'invalid content part', row.line)
        if (['input_text', 'output_text', 'text', 'summary_text', 'reasoning_text'].includes(part.type)) { requireField(part, 'text', 'string', row.line); return [{ type: 'text', text: part.text }] }
        if (part.type === 'input_image') {
          requireField(part, 'image_url', 'string', row.line, true); requireField(part, 'file_id', 'string', row.line, true)
          const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(string(part.image_url))
          if (match) return [embeddedImage(match[2], match[1], images, report, cap, row.line)]
          report.note('external-image', row.line, 'URL/file_id/local media references are never dereferenced')
          return [{ type: 'text', text: '[Codex image reference; external bytes not imported]' }]
        }
        if (['encrypted_content', 'input_audio'].includes(part.type)) { report.note(part.type, row.line, 'opaque or external media body omitted'); return [{ type: 'text', text: `[Codex ${part.type} omitted]` }] }
        report.note(part.type, row.line, 'unsupported content family replaced by inert placeholder (no raw payload copied)', { unknown: true, part: true })
        report.classify(row.line, 'degraded')
        return [{ type: 'text', text: `[Codex unsupported content: ${safeType(part.type)}]` }]
      })
    }
    const output = (row, p) => {
      requireField(p, 'call_id', 'string', row.line, p.type !== 'custom_tool_call_output')
      requireField(p, 'name', 'string', row.line, true)
      const body = contentParts(p.output, row), callId = string(p.call_id)
      if (callId && results.has(callId)) throw sourceError('CODEX_DUPLICATE_TOOL_OUTPUT', 'multiple authoritative outputs for the same call ID', row.line)
      if (callId) results.add(callId)
      if (!callId) {
        report.note('unpaired-tool-output', row.line, 'missing native call_id; output retained as notice without a fabricated tool match')
        custom(row, 'unpaired-tool-output', body, 'notice')
        return
      }
      const message = { role: 'toolResult', toolCallId: callId, toolName: calls.get(callId) || string(p.name), content: body }
      // The wire custom serializer does not persist success. Never infer it
      // from absence of an error, response status, or assistant text.
      report.note('unknown-tool-status', row.line, 'success/error is absent from the output wire contract; isError intentionally absent', { incomplete: false })
      if (!calls.has(callId)) report.note('orphan-tool-result', row.line, 'native declaration not present; no arguments or successful execution invented')
      add(row, { type: 'message', message })
    }
    for (const row of records) {
      const v = row.value, p = v.payload
      report.classify(row.line)
      switch (v.type) {
        case 'session_meta':
          report.classify(row.line, 'dropped')
          if (meta.base_instructions?.text) custom(row, 'base-instructions', [{ type: 'text', text: meta.base_instructions.text }], 'instructions', ':base-instructions')
          if (array(meta.dynamic_tools).length) report.note('dynamic-tool-schemas', row.line, 'historical tool schemas excluded; no imported tool is registered or executed', { incomplete: false })
          if (meta.forked_from_id || meta.parent_thread_id) report.note('source-lineage', row.line, 'source ancestry metadata is not restored as DSH runtime parentage', { incomplete: false })
          break
        case 'turn_context':
          requireField(p, 'model', 'string', row.line, true); requireField(p, 'model_provider', 'string', row.line, true)
          if (p.model) currentModel = p.model
          if (p.model_provider) currentProvider = p.model_provider
          if (p.cwd != null) { requireField(p, 'cwd', 'string', row.line); if (p.cwd !== meta.cwd) report.note('cwd-change', row.line, 'source cwd changed; no runtime working-directory change or branch merge performed', { incomplete: false }) }
          report.classify(row.line, 'dropped')
          break
        case 'response_item': {
          requireField(p, 'type', 'string', row.line)
          requireField(p, 'id', 'string', row.line, true)
          validateMetadata(v.metadata, row.line)
          if (p.id) {
            if (nativeIds.has(p.id)) report.note('duplicate-response-id', row.line, 'API response ID repeated; distinct physical records retained', { incomplete: false })
            nativeIds.add(p.id)
          }
          if (p.type === 'message') {
            requireField(p, 'role', 'string', row.line)
            if (!Array.isArray(p.content)) throw sourceError('INVALID_SOURCE_RECORD', 'response message content must be an array', row.line)
            if (p.encrypted_content != null) report.note('encrypted-message-state', row.line, 'opaque replay body omitted; only readable content preserved')
            if (p.role === 'user') {
              let pending = [], prior = undefined, segment = 0
              const flush = () => {
                if (!pending.length) return
                const content = pending; pending = []
                if (prior === null) add(row, { type: 'message', message: { role: 'user', content } }, `:part:${segment++}`)
                else custom(row, prior.kind, content, prior.form, `:part:${segment++}`)
              }
              p.content.forEach((part, index) => {
                const context = provenance(p, v.metadata, index, row.line)
                if (JSON.stringify(context) !== JSON.stringify(prior)) { flush(); prior = context }
                if (context?.kind === 'unknown-user-context') report.note('unknown-user-provenance', row.line, 'legacy user role lacks proven human attribution; retained as unknown context, not direct authorization')
                if (context?.kind === 'inherited-context') report.note('inherited-context', row.line, 'sibling metadata marks copied parent context; not a child-local human request', { incomplete: false })
                pending.push(...contentParts([part], row))
              })
              flush()
            } else if (p.role === 'assistant') {
              const content = contentParts(p.content, row)
              if (v.metadata?.compaction_output || v.metadata?.inherited_user_message) custom(row, v.metadata.compaction_output ? 'compaction-output' : 'inherited-assistant-context', content, 'recall')
              else if (content.length) assistant(row, content)
              if (!currentModel) report.note('missing-assistant-model', row.line, 'execution model absent; placeholder is not inferred from a later turn')
            } else if (['developer', 'system'].includes(p.role)) {
              custom(row, `${p.role}-instructions`, contentParts(p.content, row), 'instructions')
              if (p.role === 'system') report.note('system-context', row.line, 'provider system text retained as namespaced instructions, not DSH runtime policy', { incomplete: false })
            } else {
              report.classify(row.line, 'dropped'); report.note(`role-${safeType(p.role)}`, row.line, 'unknown response message role omitted', { unknown: true })
            }
          } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            for (const field of ['call_id', 'name', p.type === 'function_call' ? 'arguments' : 'input']) requireField(p, field, 'string', row.line)
            requireField(p, 'namespace', 'string', row.line, true)
            if (!p.call_id || !p.name) throw sourceError('INVALID_SOURCE_RECORD', 'tool call requires non-empty call ID and name', row.line)
            if (calls.has(p.call_id)) throw sourceError('CODEX_DUPLICATE_TOOL_ID', 'duplicate authoritative call declaration ID', row.line)
            const name = p.namespace ? `${p.namespace}.${p.name}` : p.name
            calls.set(p.call_id, name)
            const args = p.type === 'function_call' ? p.arguments : JSON.stringify({ text: p.input })
            if (p.type === 'custom_tool_call') { report.note('freeform-tool-input', row.line, 'freeform input preserved losslessly in a text wrapper; not a recovered JSON tool schema'); report.classify(row.line, 'degraded') }
            assistant(row, [{ type: 'toolCall', id: p.call_id, name, arguments: args }])
          } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) output(row, p)
          else if (p.type === 'reasoning') {
            if (!Array.isArray(p.summary)) throw sourceError('INVALID_SOURCE_RECORD', 'reasoning summary must be an array', row.line)
            if (p.content != null && !Array.isArray(p.content)) throw sourceError('INVALID_SOURCE_RECORD', 'readable reasoning content must be an array', row.line)
            const readable = p.content?.length ? p.content : p.summary
            const text = contentParts(readable, row).filter(part => part.type === 'text').map(part => part.text).join('\n')
            if (text) assistant(row, [{ type: 'thinking', thinking: text }])
            if (p.encrypted_content != null) report.note('encrypted-reasoning', row.line, 'opaque encrypted reasoning body omitted; never decoded as text')
          } else {
            // local_shell_call may lack call_id. Hosted tools have no equivalent
            // local schema. They are never fabricated into invocations.
            custom(row, 'unsupported-response-item', [{ type: 'text', text: `[Codex unsupported response item: ${safeType(p.type)}; native execution not restored]` }], 'notice')
            report.classify(row.line, 'degraded')
            report.note(p.type, row.line, 'unsupported response family retained as inert notice; payload not copied', { unknown: true })
          }
          break
        }
        case 'event_msg': {
          requireField(p, 'type', 'string', row.line)
          report.classify(row.line, 'dropped')
          if (['task_started', 'turn_started', 'task_complete', 'turn_complete'].includes(p.type)) break
          if (p.type === 'token_count') {
            if (p.info != null && !object(p.info)) throw sourceError('INVALID_SOURCE_RECORD', 'invalid token_count info', row.line)
            const totals = tokenSnapshot(p.info?.total_token_usage, row.line)
            if (totals) report.stats.cumulativeUsage = totals
            report.note('cumulative-token-usage', row.line, 'last session snapshot retained in stats only; repeated totals never summed or assigned to assistant messages', { incomplete: false })
            break
          }
          const family = p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'assistant' : ['agent_reasoning', 'agent_reasoning_raw_content'].includes(p.type) ? 'reasoning' : ''
          if (family) {
            requireField(p, family === 'reasoning' ? 'text' : 'message', 'string', row.line)
            if (rawFamilies.has(family)) {
              const text = family === 'reasoning' ? p.text : p.message
              if (rawTexts.get(family)?.has(text)) {
                report.note('duplicate-event-view', row.line, 'raw response_item is canonical; matching legacy message/reasoning event view excluded', { incomplete: false })
                report.stats.duplicateTransportViews = (report.stats.duplicateTransportViews ?? 0) + 1
              } else report.note('unmatched-event-view', row.line, 'response stream is canonical; uncorrelated display content excluded rather than guessed into a second conversation')
            } else {
              const text = family === 'reasoning' ? p.text : p.message
              if (family === 'user') { custom(row, 'event-user-context', [{ type: 'text', text }]); report.note('unknown-event-user-provenance', row.line, 'event-only user text retained as unknown context, not a proven human request') }
              else assistant(row, [family === 'reasoning' ? { type: 'thinking', thinking: text } : { type: 'text', text }])
              report.classify(row.line, 'degraded')
              report.note('event-only-content', row.line, 'readable family absent from response stream; display event retained with degraded transport semantics')
            }
            if (array(p.images).length || array(p.local_images).length || array(p.file_ids).length || array(p.audio).length || array(p.local_audio).length) report.note('event-media', row.line, 'event media references omitted; no external bytes opened')
            break
          }
          if (p.type === 'item_completed') {
            if (!object(p.item) || typeof p.item.type !== 'string') throw sourceError('INVALID_SOURCE_RECORD', 'invalid item_completed TurnItem', row.line)
            const item = p.item
            if (item.type === 'FunctionCallOutput') {
              requireField(item, 'id', 'string', row.line); requireField(item, 'name', 'string', row.line)
              if (rawOutputIds.has(item.id)) { report.note('duplicate-item-output', row.line, 'completed output view correlated with canonical response_item, independent of file order', { incomplete: false }); break }
              custom(row, 'completed-tool-output', contentParts(item.output, row), 'notice')
              report.classify(row.line, 'degraded')
              report.note('completed-tool-output', row.line, 'display output retained as notice; TurnItem.id is not assumed to be native call_id')
            } else {
              // Minimal safe bridge, not a TurnItem runtime simulation.
              report.note(`item-${safeType(item.type)}`, row.line, 'noncanonical display-only TurnItem omitted; full paginated projection is unsupported', { unknown: true })
            }
          } else report.note(p.type, row.line, 'unknown/noncanonical event family omitted; no second conversation manufactured', { unknown: true })
          break
        }
        case 'token_usage_record':
          report.classify(row.line, 'dropped'); report.note('token_usage_record', row.line, 'version-specific usage record excluded; no attribution guessed', { incomplete: false }); break
        case 'inter_agent_communication':
          if (typeof p.message === 'string') { custom(row, 'inter-agent-context', [{ type: 'text', text: p.message }], 'relay'); report.classify(row.line, 'degraded') }
          else report.classify(row.line, 'dropped')
          report.note('inter_agent_communication', row.line, 'only explicit readable message supported; agent/runtime routing metadata not restored')
          break
        case 'inter_agent_communication_metadata': case 'security_risk_score': case 'realtime_item':
          report.classify(row.line, 'dropped'); report.note(v.type, row.line, 'host/runtime presentation metadata excluded', { incomplete: false }); break
        case 'world_state':
          custom(row, 'world-state', [{ type: 'text', text: '[Codex world-state snapshot/patch omitted; not an ordinary user message]' }], 'snapshot')
          report.classify(row.line, 'degraded'); report.note('world_state', row.line, 'structured state not serialized into model context'); break
        default:
          report.classify(row.line, 'dropped'); report.note(v.type, row.line, 'unknown rollout family omitted; not a claim of exhaustive native support', { unknown: true })
      }
    }
    if (!info.title) {
      // Environment/instruction carriers make poor titles, especially after migration.
      const first = entries.find(e => e.message?.role === 'user')
      info.title = array(first?.message?.content || first?.content).filter(part => part.type === 'text').map(part => part.text).join(' ').replace(/\s+/g, ' ').slice(0, 100) || 'Codex CLI session'
    }
    const last = [...entries].reverse().find(e => e.message?.role === 'assistant')?.message
    const defaultModel = last ? `${last.provider}/${last.model}` : ''
    const normalized = linearEntries(entries)
    return { head: { id: info.id, version: info.version, cwd: info.cwd, createdAt: info.createdAt, title: info.title, titleSource: 'auto', defaultModel, models: defaultModel ? { default: defaultModel } : {} }, entries: normalized, images, source: 'codex', adapterWarnings: report.finish(normalized), stats: report.stats }
  }
  return { id: 'codex', label: 'Codex CLI', description: 'Read-only legacy rollout response items; paginated/inherited/reverted/compacted histories explicitly gated', roots, scan, read }
}
