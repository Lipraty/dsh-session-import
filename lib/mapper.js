/**
 * omp → DSH transcript translation.
 *
 * Pure functions, no Cordis dependency: read an omp transcript, project it, and
 * emit a DSH seed event array. Kept apart from index.js so the mapping can be
 * exercised, and validated against the real Session class, without booting the
 * harness.
 *
 * CONTRACTS — not reverse engineering. Two files decide everything here:
 *
 *   omp  `oh-my-pi/docs/session.md`, session format v3. The `SessionEntry` union
 *        (16 types), the 8 persisted `message.role` values, and
 *        `buildSessionContext`'s leaf walk.
 *   DSH  `@deepseek-ai/dsh-session` 0.2.0-rc.2. `SessionEventMap` for the event
 *        vocabulary (core 14 + merge-extended `compaction/*`, `plan/mode`,
 *        `todo/write`) plus the runtime validators in `lib/index.js`
 *        (`assertSessionEventEnvelope`, `assertMessageEventShape`,
 *        `assertAssistantSettlementShape`) and `lib/types/surface.js`.
 *
 * Every validator constraint below was read out of the shipped build, and the
 * ones that silently corrupt a transcript are called out at their use site:
 *
 *   - `seq` must be contiguous from 0 (constructor).
 *   - envelope keys are closed: type|seq|time|data|surfaceOp|sourceEventSeqs|ignorable.
 *   - `time` must be a safe integer, so `Date.parse` results are screened.
 *   - no `undefined` anywhere in `data`; `snapshotJsonValue` rejects it, so keys
 *     are omitted rather than set to undefined.
 *   - every message-producing event needs a non-empty `message.id`.
 *   - `assistant/message` needs `stream: []` and integer `turn`/`step`.
 *   - `surfaceOp` is mandatory on the five surface types and forbidden elsewhere.
 *   - a `replace` op must cite every shadowed surface node in `sourceEventSeqs`.
 *   - `system/message` at surface node 0 may only be replaced by another
 *     `system/message` over exactly that node, so node 0 is never shadowed.
 *
 * THE PROJECTION IS LOSSY, and deliberately so. omp has concepts DSH lacks (a
 * branch tree, credential pins, TTSR rules, service tiers) and DSH has concepts
 * omp lacks (tool add/remove blocks, ContextForm, the attachment service).
 * ENTRIES / ROLES / CUSTOM / PARTS classify every one of them as mapped,
 * degraded, or dropped-with-a-reason, and `mappingReport()` renders that
 * classification so a format bump on either side can be reconciled
 * mechanically instead of by re-reading both specs.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { ensureProtectedSystemHead } from './protected-head.js'

const UUID = () => globalThis.crypto.randomUUID()

/** omp's physical title slot: a fixed-width first line the loader folds into the header. */
const TITLE_SLOT_BYTES = 256

/** Bound for a `notice` summary. DSH's CONTEXT_SUMMARY_MAX_CHARS is 120. */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/* ──────────────────────────── classification ──────────────────────────── */

/**
 * Verdict per omp `SessionEntry` type. `map` carries it into DSH events,
 * `degrade` carries it with loss, `drop` deliberately does not carry it — and
 * every `drop` states why, so nobody has to re-derive the decision.
 *
 * The taxonomy is the documented v3 union. `mcp_tool_selection` is included
 * because it can occur in transcripts but appears in no documented spec
 * version, so it is flagged rather than silently defaulted.
 */
export const ENTRIES = {
  session: { v: 'map', to: 'session header', note: 'id/cwd; the 256-byte title slot is folded in' },
  message: { v: 'map', to: 'user|developer|assistant|system|tool · /message', note: 'all 8 persisted roles dispatched' },
  model_usage: { v: 'drop', why: 'usage accounting outside the transcript; produces no model message' },
  thinking_level_change: { v: 'drop', why: 'omp reasoning-budget state; DSH has no equivalent field' },
  model_change: { v: 'degrade', to: 'per-message assistant source', why: 'no request/header is synthesized, so no model/selection event is emitted' },
  service_tier_change: { v: 'drop', why: 'DSH has no service-tier concept' },
  compaction: { v: 'map', to: 'compaction/start → compaction/summary → replacement user/message → compaction/end' },
  branch_summary: { v: 'degrade', to: 'developer/message', why: 'DSH has no branch-summary concept; kept as a developer note' },
  reset_boundary: { v: 'degrade', to: '(trim)', why: 'entries through the boundary leave the seed, matching omp buildSessionContext' },
  custom: { v: 'map', to: 'todo/write · plan/mode · tool/result.meta', note: 'dispatched per customType; see CUSTOM' },
  custom_message: { v: 'map', to: 'user/message + ContextForm', note: 'the largest single win: 11.9k entries that had no mapping before' },
  label: { v: 'drop', why: 'DSH has no bookmark concept' },
  title_change: { v: 'map', to: 'session/title' },
  ttsr_injection: { v: 'drop', why: 'DSH owns its own injection-rule system' },
  credential_pin: { v: 'drop', why: 'account binding; security sensitive and linkable, never imported' },
  session_init: { v: 'map', to: 'system/message', note: 'subagent sessions only — top-level transcripts never carry it' },
  mode_change: { v: 'map', to: 'plan/mode' },
  mcp_tool_selection: { v: 'drop', why: 'present in real transcripts but absent from the documented v3 union; no DSH equivalent' },
}

/** Verdict per `custom.customType`. Unknown values are reported, never silently skipped. */
export const CUSTOM = {
  tool_execution_start: { v: 'map', to: 'tool/result.meta.omp', note: 'startedAt and the truncated args projection are dropped' },
  user_todo_edit: { v: 'map', to: 'todo/write' },
  session_exit: { v: 'drop', why: 'exit diagnostics; only meaningful to an omp resume' },
  'vibe-session-lifecycle': { v: 'drop', why: 'omp runtime ownership state' },
  'autoresearch-control': { v: 'drop', why: 'omp runtime mode state' },
  'system-prompt-digest': { v: 'drop', why: 'prompt-cache hash; meaningless across harnesses' },
  todo_hud_state: { v: 'drop', why: "omp's todo-HUD render cache; the list itself arrives through user_todo_edit" },
  model_mention: { v: 'drop', why: "records an @-model mention for omp's own selector; DSH resolves models through its registry" },
  'goal-completed': { v: 'drop', why: "omp goal-run completion record; DSH's goal/change carries a strictly folded payload this shape cannot fill" },
}

/** Verdict per persisted `message.role`. */
export const ROLES = {
  user: { v: 'map', to: 'user/message', note: "kind 'user'; DSH's human kind carries no ContextForm, so `steering` is not expressible" },
  developer: { v: 'map', to: 'developer/message', note: 'text only — no tool-addition blocks, so no headerSeq' },
  assistant: { v: 'map', to: 'assistant/message', note: 'per-message provider/model; empty content + error → assistant/attempt' },
  toolResult: { v: 'map', to: 'tool/result', note: 'details → meta.omp, intent → meta.omp' },
  bashExecution: { v: 'degrade', to: 'user/message', note: "kind 'omp:bash'; excludeFromContext is honoured" },
  pythonExecution: { v: 'degrade', to: 'user/message', note: "kind 'omp:python'" },
  fileMention: { v: 'degrade', to: 'user/message + text', why: 'omp inlines file bodies; DSH FileBlock needs attachment bytes we do not copy' },
  hookMessage: { v: 'drop', why: 'the v2→v3 migration already rewrote these to custom' },
}

/** Verdict per content-block type on either side. */
export const PARTS = {
  text: { v: 'map', to: 'text' },
  thinking: { v: 'map', to: 'reasoning' },
  toolCall: { v: 'map', to: 'tool-call', note: 'omp stores `arguments` parsed; DSH needs the raw JSON string, so it is re-serialized' },
  image: { v: 'degrade', to: 'image', note: 'via the attachment service when the omp blob resolves; text placeholder otherwise' },
  file: { v: 'map', to: 'text', note: 'from fileMention' },
  'tool-addition': { v: 'drop', why: 'DSH activates additions from a request/header tool schema; omp records names only, and fabricating schemas would shadow the real registered tools' },
  'tool-removal': { v: 'drop', why: 'same as tool-addition' },
}

/**
 * `custom_message.customType` → `ContextForm`. DSH's `kind` answers "who
 * produced this" and `form` answers "what kind of thing it is"; omp's
 * customType strings are already semantic, so this is a clean projection.
 * An unlisted customType stays opaque, which DSH documents as the default.
 */
const CONTEXT_FORM = {
  // instructions — workspace-file instructions the model is expected to follow
  'skill-prompt': 'instructions',
  'plan-mode-reference': 'instructions',
  'collab-prompt': 'instructions',
  // catalog — available items, republished as the set changes
  'xdev-mount-notice': 'catalog',
  'plan-mode-context': 'catalog',
  // snapshot — current state, where a later snapshot supersedes an earlier one
  'mid-run-todo-nudge': 'snapshot',
  'todo-error-reminder': 'snapshot',
  // notice — a one-off account of something that just happened
  'resolve-reminder': 'notice',
  'rewind-report': 'notice',
  'checkpoint-active-reminder': 'notice',
  'interrupted-thinking': 'notice',
  'thinking-loop-redirect': 'notice',
  'tool-call-loop-redirect': 'notice',
  'launch-completion': 'notice',
  'goal-mode-context': 'notice',
  'goal-continuation': 'notice',
  'session-agent-notice': 'notice',
  'lsp-late-diagnostic': 'notice',
  'image-attachment': 'notice',
  'image-attachment-description': 'notice',
  'ttsr-injection': 'notice',
  // relay — a message another agent addressed to this one
  'a2a-inbound': 'relay',
  'irc:incoming': 'relay',
  'a2a-connection': 'relay',
  'a2a-presence': 'relay',
  'a2a-context': 'relay',
  '/a2a': 'relay',
  '/a2a status': 'relay',
  '/a2a project list': 'relay',
  // recall — material lifted out of another session's log
  'async-result': 'recall',
  // advisor and anything unlisted: an undeclared context stays opaque
}

/* ────────────────────────────── primitives ────────────────────────────── */

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Truncate long text, marking where it was cut. */
function clip(s, max) {
  if (typeof s !== 'string') return ''
  if (!(max > 0) || s.length <= max) return s
  return `${s.slice(0, max)}\n… [truncated, ${s.length - max} more chars]`
}

/** Bound a `notice` summary the way DSH's boundContextSummary does. */
function boundSummary(s) {
  const line = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= CONTEXT_SUMMARY_MAX_CHARS) return line
  return `${line.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** omp stores tool arguments parsed; DSH's ToolCallBlock wants the raw JSON string. */
function rawArguments(args) {
  if (typeof args === 'string') return args
  if (args === undefined || args === null) return '{}'
  try {
    return JSON.stringify(args)
  } catch {
    return '{}'
  }
}

/**
 * omp usage → DSH TokenUsage. Both carry the same counters under different
 * names. DSH documents its counts as disjoint (uncached input separate from
 * cache read/write); omp's `input` is mapped across unchanged, which is the
 * only reading its schema supports.
 */
function mapUsage(u) {
  if (!isObj(u)) return undefined
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const out = {
    inputTokens: num(u.input),
    outputTokens: num(u.output),
  }
  // Every optional field is omitted rather than defaulted: an absent counter is
  // not a measured zero, and snapshotJsonValue rejects an explicit undefined.
  if (typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens)) out.totalTokens = u.totalTokens
  if (typeof u.cacheRead === 'number' && Number.isFinite(u.cacheRead)) out.cacheReadTokens = u.cacheRead
  if (typeof u.cacheWrite === 'number' && Number.isFinite(u.cacheWrite)) out.cacheWriteTokens = u.cacheWrite
  return out
}

/** Concatenate the text of a content array, for result bodies and titles. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const p of content) if (isObj(p) && p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
  return parts.join('\n')
}

/** Namespaced `source.kind`. DSH requires a namespace because `kind` is merge-extensible. */
function sourceKindFor(customType, namespace = 'omp') {
  const raw = String(customType ?? 'unknown')
  const t = raw.startsWith(`${namespace}:`) ? raw.slice(namespace.length + 1) : raw
  if (t === 'irc:incoming' || t.startsWith('irc:')) return `${namespace}:irc`
  if (t.startsWith('a2a') || t.startsWith('/a2a')) return `${namespace}:a2a`
  return `${namespace}:${t.replace(/^\//, '').replace(/\s+/g, '-')}`
}

/* ──────────────────────────── transcript read ─────────────────────────── */

/**
 * Read an omp transcript.
 *
 * Physical layout is JSONL whose first line MIGHT be the 256-byte title slot
 * (407 of 449 local files have it; legacy files start at the header). The slot
 * is not a logical entry — it is folded into the header, exactly as omp's own
 * loader does — so it is parsed separately instead of being mistaken for a
 * `title` event.
 *
 * @param path - absolute path to the `.jsonl` transcript.
 * @param opts.maxBytes - read at most this many bytes (a truncated tail line is skipped).
 * @returns `{ head, entries, images, malformed, stats }`.
 */
export function readTranscript(path, opts = {}) {
  const size = opts.maxBytes === undefined ? statSync(path).size : Math.min(statSync(path).size, opts.maxBytes)
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(size)
  let got = 0
  try {
    got = readSync(fd, buf, 0, size, 0)
  } finally {
    closeSync(fd)
  }

  const head = {
    id: '',
    version: 0,
    cwd: '',
    createdAt: '',
    title: '',
    titleSource: '',
    slotTitle: '',
    slotSource: '',
    additionalDirectories: [],
    parentSession: '',
    models: {},
    defaultModel: '',
  }
  const entries = []
  const images = []
  const stats = { lines: 0, malformed: 0, titleSlot: false, unknownEntries: {}, unknownParts: {}, unknownRoles: {}, unknownCustom: {} }
  let titleChange = null
  let sawHeader = false

  for (const line of buf.subarray(0, got).toString('utf8').split('\n')) {
    if (line.length === 0) continue
    stats.lines += 1
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      stats.malformed += 1 // truncated tail line
      continue
    }
    if (!isObj(ev)) {
      stats.malformed += 1
      continue
    }

    // The fixed-width slot precedes the header and is the current title.
    if (!sawHeader && ev.type === 'title' && typeof ev.title === 'string') {
      head.slotTitle = ev.title
      head.slotSource = typeof ev.source === 'string' ? ev.source : ''
      stats.titleSlot = true
      continue
    }

    if (!sawHeader && ev.type === 'session') {
      sawHeader = true
      head.id = typeof ev.id === 'string' ? ev.id : ''
      head.version = typeof ev.version === 'number' ? ev.version : 0
      head.cwd = typeof ev.cwd === 'string' ? ev.cwd : ''
      head.createdAt = typeof ev.timestamp === 'string' ? ev.timestamp : ''
      head.title = typeof ev.title === 'string' ? ev.title : ''
      head.titleSource = typeof ev.titleSource === 'string' ? ev.titleSource : ''
      if (Array.isArray(ev.additionalDirectories)) {
        head.additionalDirectories = ev.additionalDirectories.filter((d) => typeof d === 'string')
      }
      head.parentSession = typeof ev.parentSession === 'string' ? ev.parentSession : ''
      continue
    }

    entries.push(ev)

    if (ev.type === 'title_change' && typeof ev.title === 'string') titleChange = ev
    if (ev.type === 'model_change' && typeof ev.model === 'string' && ev.model !== '') {
      const role = typeof ev.role === 'string' ? ev.role : 'default'
      head.models[role] = ev.model
      if (role === 'default') head.defaultModel = ev.model
    }

    // Collect every image blob so index.js can pre-commit them to the
    // attachment service in one async pass; the projection itself stays sync.
    if (ev.type === 'message' && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const p of ev.message.content) {
        if (isObj(p) && p.type === 'image') images.push({ blob: p.data, mimeType: p.mimeType, source: 'content' })
      }
    }
    if (ev.type === 'custom_message' && Array.isArray(ev.content)) {
      for (const p of ev.content) {
        if (isObj(p) && p.type === 'image') images.push({ blob: p.data, mimeType: p.mimeType, source: 'custom_message' })
      }
    }
  }

  // The slot is authoritative over the header (omp updates it on every rename);
  // the latest title_change audit entry carries the source, which the slot omits.
  if (titleChange !== null) {
    head.title = titleChange.title
    head.titleSource = typeof titleChange.source === 'string' ? titleChange.source : ''
  } else if (head.slotTitle !== '') {
    head.title = head.slotTitle
    head.titleSource = head.slotSource
  }

  return { head, entries, images, stats }
}

/* ───────────────────────────── tree resolution ─────────────────────────── */

/**
 * Resolve one root→leaf path.
 *
 * omp is an append-only tree with a mutable leaf pointer, and there is no
 * persisted leaf field: loading rebuilds it from the last physical entry
 * (`session.md`, "Tree and Leaf Semantics"). So this mirrors
 * `buildSessionContext`: start at the last entry, walk `parentId` to the root,
 * bound corrupt cycles, then reverse. Sibling branches are counted, never
 * silently forgotten.
 */
export function resolvePath(entries) {
  if (entries.length === 0) return { path: [], dropped: 0 }
  const byId = new Map()
  for (const e of entries) if (typeof e.id === 'string' && e.id !== '') byId.set(e.id, e)

  const path = []
  const seen = new Set()
  let cursor = entries[entries.length - 1]
  while (isObj(cursor)) {
    const id = typeof cursor.id === 'string' ? cursor.id : ''
    if (id !== '' && seen.has(id)) break // corrupt cycle
    if (id !== '') seen.add(id)
    path.push(cursor)
    const pid = cursor.parentId
    cursor = typeof pid === 'string' && pid !== '' ? byId.get(pid) : undefined
  }
  path.reverse()
  return { path, dropped: entries.length - path.length }
}

/* ────────────────────────────── projection ────────────────────────────── */

/**
 * Project a transcript into a DSH seed event array with contiguous seqs.
 *
 * The seed is replayed into every later request, so it is a permanent context
 * tax; the newest `maxTurns` turns are taken, then the oldest of those are shed
 * until the UTF-8 budget fits. Bytes, not characters, because the content is
 * Chinese-heavy (1 char ≈ 3 bytes).
 *
 * @param transcript - the result of {@link readTranscript}.
 * @param opts.maxTurns - keep at most this many trailing turns (default 150).
 * @param opts.maxSeedBytes - shed leading turns above this UTF-8 budget (default 400000).
 * @param opts.includeThinking - carry omp `thinking` blocks as `reasoning` (default true).
 * @param opts.includeToolResults - carry tool output (default true).
 * @param opts.maxTextChars / opts.maxResultChars - per-block clamps.
 * @param opts.resolveImage - `(blob, mimeType) => ImageAttachmentRef | null`; a sync
 *   lookup filled by index.js from the attachment service. Absent → text placeholder.
 */
export function toSeed(transcript, opts = {}) {
  const namespace = /^[a-z][a-z0-9-]*$/.test(transcript.source ?? '') ? transcript.source : 'omp'
  const warnings = [...(transcript.adapterWarnings ?? [])]
  const projectionClip = (text, cap) => {
    if (typeof text === 'string' && cap > 0 && text.length > cap) stats.truncatedBlocks += 1
    return clip(text, cap)
  }
  const contextCost = (entry) => {
    const content = entry.type === 'message' ? entry.message?.content : entry.content
    const cap = entry.message?.role === 'toolResult' ? o.maxResultChars : o.maxTextChars
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    let count = 64
    for (const block of blocks) {
      if (block.type === 'text') count += Buffer.byteLength(clip(block.text ?? '', cap))
      else if (block.type === 'thinking' && o.includeThinking) count += Buffer.byteLength(clip(block.thinking ?? '', cap))
      else if (block.type === 'toolCall') count += Buffer.byteLength(rawArguments(block.arguments)) + 64
      else if (block.type === 'image') count += 128
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') count += Buffer.byteLength(entry.summary ?? '')
    if (entry.message?.role === 'fileMention') for (const f of entry.message.files ?? []) count += Buffer.byteLength(clip(f.content ?? '', cap))
    if (entry.message?.role === 'bashExecution' || entry.message?.role === 'pythonExecution') count += Buffer.byteLength(clip(entry.message.output ?? '', o.maxResultChars))
    return count
  }

  const o = {
    includeThinking: opts.includeThinking !== false,
    includeToolResults: opts.includeToolResults !== false,
    maxTextChars: opts.maxTextChars ?? 4000,
    maxResultChars: opts.maxResultChars ?? 1200,
    resolveImage: typeof opts.resolveImage === 'function' ? opts.resolveImage : null,
    stats: null,
  }

  const stats = {
    pathEntries: 0,
    branchDropped: 0,
    resetTrimmed: 0,
    turnsAvailable: 0,
    turnsKept: 0,
    turnsShed: 0,
    contextBytes: 0,
    events: 0,
    seedBytes: 0,
    images: { total: 0, attached: 0, placeholder: 0 },
    compaction: { mapped: 0, dropped: 0 },
    verdicts: { map: 0, degrade: 0, drop: 0, unknown: 0 },
    unknownEntries: {},
    unknownParts: {},
    unknownRoles: {},
    unknownCustom: {},
    unknownCustomTypes: {},
    customMessages: {},
    noHome: [],
    warnings,
    truncatedBlocks: 0,
  }
  o.stats = stats
  const tally = (table, key, kind) => {
    const row = table[key]
    if (row === undefined) {
      stats.verdicts.unknown += 1
      const sink = kind === 'entry' ? stats.unknownEntries : kind === 'role' ? stats.unknownRoles : kind === 'part' ? stats.unknownParts : stats.unknownCustom
      sink[key] = (sink[key] ?? 0) + 1
      return
    }
    stats.verdicts[row.v] += 1
  }

  const resolved = resolvePath(transcript.entries)
  stats.branchDropped = resolved.dropped
  let path = resolved.path

  // reset_boundary: "the rebuilt model context begins after the latest
  // applicable boundary", so everything through it leaves the seed.
  let resetCut = -1
  for (let i = 0; i < path.length; i++) if (path[i].type === 'reset_boundary') resetCut = i
  if (resetCut >= 0) {
    stats.resetTrimmed = resetCut + 1
    path = path.slice(resetCut + 1)
  }

  const indexOf = new Map()
  path.forEach((e, i) => {
    if (typeof e.id === 'string' && e.id !== '') indexOf.set(e.id, i)
  })
  stats.pathEntries = path.length

  /**
   * Classify the WHOLE leaf path, before the turn budget trims it. The report
   * answers "which parts of the omp format survive an import", so measuring only
   * what one import happened to keep would understate coverage badly.
   */
  const classify = (entry) => {
    tally(ENTRIES, String(entry.type), 'entry')
    if (entry.type === 'custom') tally(CUSTOM, String(entry.customType ?? 'unknown'), 'custom')
    if (entry.type === 'custom_message') {
      // Census of injected-context producers, so a new customType shows up in the
      // report instead of quietly becoming opaque content.
      const ct = String(entry.customType ?? 'unknown')
      const row = stats.customMessages[ct] ?? { count: 0, form: entry.form ?? CONTEXT_FORM[ct] ?? null }
      row.count += 1
      stats.customMessages[ct] = row
    }
    if (entry.type !== 'message' || !isObj(entry.message)) return
    const m = entry.message
    tally(ROLES, String(m.role), 'role')
    const contents = [m.content]
    if (m.role === 'fileMention' && Array.isArray(m.files)) {
      for (const f of m.files) if (isObj(f) && f.image === true) contents.push([{ type: 'image' }])
    }
    for (const c of contents) {
      if (!Array.isArray(c)) continue
      for (const p of c) if (isObj(p)) tally(PARTS, String(p.type), 'part')
    }
  }
  for (const e of path) {
    if (e.type === 'session_init') continue // counted at its emission site, where the position is decided
    if (e.type === 'reset_boundary') continue // already applied; not a format question
    classify(e)
  }
  for (const e of path) {
    if (e.type !== 'custom_message') continue
    if (!Array.isArray(e.content)) continue
    for (const p of e.content) if (isObj(p)) tally(PARTS, String(p.type), 'part')
  }

  /* ---- turn budgeting ---------------------------------------------------- */

  const isHumanUser = (e) =>
    e.type === 'message' && isObj(e.message) && e.message.role === 'user' && e.message.steering !== true

  const starts = []
  for (let i = 0; i < path.length; i++) if (isHumanUser(path[i])) starts.push(i)
  // Content before the first human prompt still belongs to a turn of its own.
  if (path.length && (starts.length === 0 || starts[0] !== 0)) starts.unshift(0)
  stats.turnsAvailable = starts.length

  const maxTurns = opts.maxTurns ?? 150
  const maxSeedBytes = opts.maxSeedBytes ?? 400_000
  const turnEnd = (k) => (k + 1 < starts.length ? starts[k + 1] : path.length)
  // Count projected text, not providerPayload/contextSnapshot or presentation metadata.
  const turnBytes = starts.map((s, k) => {
    let n = 0
    for (let i = s; i < turnEnd(k); i++) n += contextCost(path[i])
    return n
  })

  let firstKept = starts.length
  let bytes = 0
  for (let k = starts.length - 1; k >= 0; k--) {
    if (starts.length - k > maxTurns) break
    if (k < starts.length - 1 && bytes + turnBytes[k] > maxSeedBytes) break
    bytes += turnBytes[k]
    firstKept = k
  }
  stats.contextBytes = turnBytes.slice(firstKept).reduce((a, b) => a + b, 0)
  stats.turnsKept = starts.length - firstKept
  stats.turnsShed = firstKept
  if (firstKept > 0 && starts[firstKept] !== undefined) path = path.slice(starts[firstKept])
  // Compaction bounds are relative to the RETAINED path, not the pre-budget path.
  indexOf.clear()
  path.forEach((e, i) => { if (typeof e.id === 'string') indexOf.set(e.id, i) })
  if (stats.turnsShed) warnings.push(`预算保留了最后 ${stats.turnsKept}/${stats.turnsAvailable} 轮；较早回合未进入导入会话。`)
  if (stats.contextBytes > maxSeedBytes) warnings.push('最后一轮本身超过预算，已整轮保留；字节预算不是硬截断。')


  /* ---- session_init ------------------------------------------------------ */

  // `session_init.systemPrompt` is the base prompt a model call was built from.
  // DSH renders the system prompt at surface node 0, so it can only be honoured
  // when omp recorded it before any model-visible entry; a later one has no
  // faithful position and is reported instead of being misplaced.
  const SURFACE_ENTRY = new Set(['message', 'custom_message', 'branch_summary'])
  let systemText = ''
  let firstSurface = path.findIndex((e) => SURFACE_ENTRY.has(e.type))
  if (firstSurface === -1) firstSurface = path.length
  const initIdx = path.findIndex((e) => e.type === 'session_init')
  if (initIdx >= 0) {
    if (initIdx < firstSurface) {
      const sp = path[initIdx].systemPrompt
      systemText = Array.isArray(sp) ? sp.filter((s) => typeof s === 'string').join('\n\n') : typeof sp === 'string' ? sp : ''
      tally(ENTRIES, 'session_init', 'entry')
    } else {
      stats.verdicts.drop += 1
      stats.noHome.push('session_init after model-visible content: a system prompt has no faithful position after surface node 0')
    }
  }

  /* ---- emit -------------------------------------------------------------- */

  const events = []
  let seq = 0
  /**
   * The live model-visible surface: current node seqs in order, plus the path
   * index of the entry that produced each one.
   *
   * This mirrors `applySurfacePlan` exactly rather than recording append order,
   * because a replacement REMOVES its shadowed nodes from the surface. A second
   * compaction in the same session must shadow against the surface as it stands
   * then, and the nodes an earlier compaction already replaced are gone.
   */
  const surfaceNodes = []
  const surfaceProducer = []
  /** Path index of the entry being emitted; -1 for the synthesized system prompt. */
  let currentPathIndex = -1
  /** callId → { name, arguments, intent } from the declaring assistant message. */
  const calls = new Map()
  /** callId → the turn/step that declared it, so a late result keeps its labels. */
  const callStep = new Map()
  let lastTime = 0
  const baseTime = (() => {
    const t = Date.parse(transcript.head.createdAt ?? '')
    return Number.isSafeInteger(t) ? t : Date.now()
  })()

  const push = (type, data, intent) => {
    const ev = { type, seq, time: lastTime, data }
    if (intent !== undefined) {
      ev.surfaceOp = intent.surfaceOp
      if (intent.sourceEventSeqs !== undefined) ev.sourceEventSeqs = intent.sourceEventSeqs
      // Only an append extends the surface here. A replacement lands by splicing,
      // which the compaction emitter performs after this call; pushing it too
      // would leave the replacement node listed twice.
      if (intent.surfaceOp === 'append') {
        surfaceNodes.push(seq)
        surfaceProducer.push(currentPathIndex)
      }
    }
    seq += 1
    events.push(ev)
    return ev
  }
  const stamp = (entry) => {
    const t = Date.parse(entry?.timestamp ?? '')
    lastTime = Number.isSafeInteger(t) && t >= lastTime ? t : lastTime + 1
  }
  lastTime = baseTime

  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let stepHasAssistant = false
  let firstHumanUserSeq = null
  let titleEmitted = false

  const openStep = () => {
    step += 1
    push('step/start', { turn, step })
    stepOpen = true
    stepHasAssistant = false
  }
  const closeStep = () => {
    if (!stepOpen) return
    push('step/end', { turn, step })
    stepOpen = false
  }
  const openTurn = () => {
    turn += 1
    step = 0
    push('turn/start', { turn })
    turnOpen = true
    openStep()
  }
  const closeTurn = () => {
    if (!turnOpen) return
    closeStep()
    push('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }
  const ensureTurn = () => {
    if (!turnOpen) openTurn()
  }
  const ensureStep = () => {
    ensureTurn()
    if (!stepOpen) openStep()
  }
  /**
   * Content that arrives between model calls needs its own step, and a step
   * that already holds an assistant message must be closed first: DSH pairs one
   * model call with the tool executions it requested, so two assistant messages
   * can never share a step.
   */
  const stepForInjection = () => {
    ensureTurn()
    const waiting = [...callStep.values()].some(home => home.turn === turn && home.step === step)
    if (stepOpen && stepHasAssistant && !waiting) closeStep()
    if (!stepOpen) openStep()
  }

  // The system prompt is surface node 0: the loop appends it before the step's
  // first user/message, and it must never be shadowed by a later replacement.
  if (systemText !== '') {
    openTurn()
    push('system/message', {
      turn,
      step,
      message: {
        id: UUID(),
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: projectionClip(systemText, o.maxTextChars) }],
      },
    }, { surfaceOp: 'append' })
  }
  /** Whether surface node 0 is the protected system prompt. */
  const node0IsSystem = systemText !== ''

  /**
   * Build one message-visible content array. Every branch is explicit: an
   * unrecognized block type is counted by classify(), never dropped in silence.
   *
   * @param cap - text clamp for this call; tool output is clamped far tighter
   *   than conversation text, and a tool result can itself carry an image.
   */
  const mapParts = (content, cap = o.maxTextChars) => {
    const out = []
    if (typeof content === 'string') {
      if (content.length > 0) out.push({ type: 'text', text: projectionClip(content, cap) })
      return out
    }
    if (!Array.isArray(content)) return out
    for (const p of content) {
      if (!isObj(p)) continue
      switch (p.type) {
        case 'text':
          if (typeof p.text === 'string' && p.text.length > 0) out.push({ type: 'text', text: projectionClip(p.text, cap) })
          break
        case 'thinking':
          if (o.includeThinking && typeof p.thinking === 'string' && p.thinking.length > 0) {
            out.push({ type: 'reasoning', text: projectionClip(p.thinking, cap) })
          }
          break
        case 'toolCall': {
          if (typeof p.id !== 'string' || p.id === '') break
          const args = rawArguments(p.arguments)
          out.push({ type: 'tool-call', id: p.id, name: String(p.name ?? ''), arguments: args })
          calls.set(p.id, {
            name: String(p.name ?? ''),
            arguments: args,
            ...(typeof p.intent === 'string' && p.intent !== '' ? { intent: p.intent } : {}),
          })
          break
        }
        case 'image': {
          stats.images.total += 1
          let ref = null
          if (o.resolveImage !== null && typeof p.data === 'string') ref = o.resolveImage(p.data, p.mimeType)
          if (ref !== null && ref !== undefined) {
            stats.images.attached += 1
            out.push({ type: 'image', attachment: ref })
          } else {
            stats.images.placeholder += 1
            const where = typeof p.data === 'string' ? p.data.slice(0, 32) : ''
            out.push({ type: 'text', text: `[${namespace} image ${p.mimeType ?? 'unknown'} ${where}…]` })
          }
          break
        }
        default:
          break // classify() already recorded the type
      }
    }
    return out
  }

  /** `custom_message` → `user/message` carrying its ContextForm. */
  const emitCustomMessage = (entry) => {
    const customType = typeof entry.customType === 'string' ? entry.customType : 'unknown'
    const form = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'].includes(entry.form) ? entry.form : CONTEXT_FORM[customType]
    const content = mapParts(entry.content)
    if (content.length === 0) return
    const kind = sourceKindFor(customType, namespace)
    let source
    if (form === 'snapshot') {
      // A snapshot declares the named contributions it assembled, in order.
      source = { kind, form, sections: [{ name: customType, text: textOf(entry.content) || textOf(content) }] }
    } else if (form === 'notice') {
      const first = content.find((b) => b.type === 'text')
      source = { kind, form, summary: boundSummary(first?.text ?? customType) }
    } else if (form === undefined) {
      source = { kind }
    } else {
      source = { kind, form }
    }
    stepForInjection()
    push('user/message', { content, role: 'user', id: UUID(), source }, { surfaceOp: 'append' })
  }

  /** toolResult → tool/call + tool/result, attached to the step that declared the call. */
  const emitToolResult = (entry, t, s) => {
    const m = entry.message
    const callId = typeof m.toolCallId === 'string' && m.toolCallId !== '' ? m.toolCallId : UUID()
    const decl = calls.get(callId)
    // A tool result is not necessarily text: a browser or screenshot tool returns
    // image blocks, and flattening those to `textOf` loses them outright. Map the
    // real blocks under the result clamp, and fall back to a text body when the
    // result carries nothing projectable (or when output is switched off).
    const projected = o.includeToolResults ? mapParts(m.content, o.maxResultChars) : []
    const content = o.includeToolResults
      ? projected.length > 0
        ? projected
        : [{ type: 'text', text: '' }]
      : [{ type: 'text', text: '[tool output omitted]' }]
    push('tool/call', {
      turn: t,
      step: s,
      callId,
      name: decl?.name ?? (typeof m.toolName === 'string' ? m.toolName : ''),
      // The tool row renders from THIS event, not from the assistant message's
      // tool-call block; an empty object here shows "ran a command" with no command.
      arguments: decl?.arguments ?? '{}',
    })
    // omp's `details` is tool-private presentation payload — exactly DSH's
    // `meta`, which the core never interprets and never sends to the model.
    const omp = {}
    if (m.details !== undefined) omp.details = m.details
    if (decl?.intent !== undefined) omp.intent = decl.intent
    const data = {
      turn: t,
      step: s,
      message: {
        id: UUID(),
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        // Preserve reported failures, but absence means unknown, not measured success.
        ...(typeof m.isError === 'boolean' ? { isError: m.isError } : {}),
        content,
      },
    }
    // `error` is deliberately NOT synthesized: it is a failure identity that DSH
    // policy routes on, and omp records no name/code for a failed tool. The
    // result text and `details` carry the same information without inventing one.
    if (Object.keys(omp).length > 0) data.meta = { [namespace]: omp }
    push('tool/result', data, { surfaceOp: 'append' })
    callStep.delete(callId)
  }

  /** One `message` entry, dispatched over all 8 persisted roles. */
  const emitMessage = (entry) => {
    const m = entry.message
    if (!isObj(m)) return
    const role = m.role
    switch (role) {
      case 'user': {
        const content = mapParts(m.content)
        if (content.length === 0) return
        const human = m.steering !== true
        if (human) {
          closeTurn()
          openTurn()
        } else {
          stepForInjection()
        }
        const ev = push('user/message', { content, role: 'user', id: UUID(), source: { kind: 'user' } }, { surfaceOp: 'append' })
        if (human && firstHumanUserSeq === null) firstHumanUserSeq = ev.seq
        break
      }
      case 'developer': {
        const content = mapParts(m.content)
        if (content.length === 0) return
        stepForInjection()
        push('developer/message', {
          turn,
          step,
          message: { id: UUID(), role: 'developer', source: { kind: `${namespace}:developer` }, content },
        }, { surfaceOp: 'append' })
        break
      }
      case 'assistant': {
        const content = mapParts(m.content)
        const failed = typeof m.errorMessage === 'string' && m.errorMessage !== ''
        // A failed attempt that produced no content committed no surface message;
        // DSH has a log-only record for exactly that, and no error channel on
        // assistant events, so this is where the fact survives.
        if (content.length === 0) {
          if (failed) {
            ensureStep()
            push('assistant/attempt', { turn, step, stream: [] })
            stats.noHome.push('assistant errorMessage/errorStatus/errorId: DSH has no error field on assistant events')
          }
          return
        }
        ensureTurn()
        if (stepOpen && stepHasAssistant) closeStep()
        if (!stepOpen) openStep()
        stepHasAssistant = true
        const raw = typeof m.model === 'string' && m.model !== '' ? m.model : transcript.head.defaultModel
        const slash = raw.indexOf('/')
        const provider = typeof m.provider === 'string' && m.provider !== '' ? m.provider : slash === -1 ? 'omp' : raw.slice(0, slash) || 'omp'
        const model = typeof m.provider === 'string' && m.provider !== ''
          ? raw || `${namespace}-import`
          : slash === -1 ? raw || `${namespace}-import` : raw.slice(slash + 1) || `${namespace}-import`
        const usage = mapUsage(m.usage)
        const data = {
          turn,
          step,
          // The settlement validator requires a stream array; imported history has
          // no chunk log to replay and an empty one is accepted. sourceEventSeqs is
          // forbidden here — an assistant message embeds its stream instead.
          stream: [],
          message: {
            id: UUID(),
            role: 'assistant',
            source: { kind: 'model', provider, model },
            content,
          },
        }
        if (usage !== undefined) data.usage = usage
        push('assistant/message', data, { surfaceOp: 'append' })
        // Remember where each call was declared. An injected message can land
        // between a call and its result, and the result must stay labelled with —
        // and therefore grouped under — its declaring step.
        for (const b of content) if (b.type === 'tool-call') callStep.set(b.id, { turn, step })
        break
      }
      case 'toolResult': {
        const cid = typeof m.toolCallId === 'string' ? m.toolCallId : ''
        const home = callStep.get(cid)
        if (home !== undefined) {
          emitToolResult(entry, home.turn, home.step)
        } else if (calls.has(cid)) {
          ensureStep()
          emitToolResult(entry, turn, step)
        } else {
          // Keep knowledge from a source-compacted result without inventing an assistant call.
          stepForInjection()
          const body = o.includeToolResults ? mapParts(m.content, o.maxResultChars) : [{ type: 'text', text: '[tool output omitted]' }]
          push('user/message', { id: UUID(), role: 'user', source: { kind: `${namespace}:orphan-tool-result`, form: 'notice', summary: boundSummary(`历史工具结果：${m.toolName ?? '未知工具'}（原调用不在导入窗口内）`) }, content: [{ type: 'text', text: `[历史工具结果 ${m.toolName ?? 'unknown'}]` }, ...body] }, { surfaceOp: 'append' })
          warnings.push('一个历史工具结果的原调用不在导入窗口中，已保留为上下文，未编造工具参数。')
        }
        break
      }
      case 'bashExecution': {
        if (m.excludeFromContext === true) return
        const cmd = typeof m.command === 'string' ? m.command : ''
        const out = typeof m.output === 'string' ? clip(m.output, o.maxResultChars) : ''
        const exit = m.exitCode === undefined || m.exitCode === null ? '' : ` (exit ${m.exitCode})`
        stepForInjection()
        push('user/message', {
          role: 'user',
          id: UUID(),
          source: { kind: 'omp:bash' },
          content: [{ type: 'text', text: `! ${cmd}${exit}\n${out}` }],
        }, { surfaceOp: 'append' })
        break
      }
      case 'pythonExecution': {
        const src = typeof m.code === 'string' ? m.code : typeof m.command === 'string' ? m.command : ''
        const out = typeof m.output === 'string' ? clip(m.output, o.maxResultChars) : ''
        stepForInjection()
        push('user/message', {
          role: 'user',
          id: UUID(),
          source: { kind: 'omp:python' },
          content: [{ type: 'text', text: `python\n${src}\n${out}` }],
        }, { surfaceOp: 'append' })
        break
      }
      case 'fileMention': {
        // omp inlined the file bodies; DSH's FileBlock needs bytes owned by its
        // own attachment service, so the bodies ride as text.
        const files = Array.isArray(m.files) ? m.files : []
        const blocks = []
        for (const f of files) {
          if (!isObj(f)) continue
          const path = typeof f.path === 'string' ? f.path : '?'
          const body = typeof f.content === 'string' ? clip(f.content, o.maxTextChars) : ''
          const lines = typeof f.lineCount === 'number' ? `${f.lineCount} lines` : ''
          const skip = typeof f.skippedReason === 'string' ? ` [skipped: ${f.skippedReason}]` : ''
          blocks.push({ type: 'text', text: `@${path} ${lines}${skip}\n${body}` })
        }
        if (blocks.length === 0) return
        stepForInjection()
        push('user/message', { role: 'user', id: UUID(), source: { kind: 'omp:file-mention' }, content: blocks }, { surfaceOp: 'append' })
        break
      }
      case 'hookMessage':
        // Already rewritten to `custom` by omp's own v2→v3 migration.
        break
      default:
        break // classify() already recorded the type
    }
  }

  /** `custom` → todo/write, plan/mode, or nothing, dispatched per customType. */
  const emitCustom = (entry) => {
    const customType = typeof entry.customType === 'string' ? entry.customType : 'unknown'
    if (CUSTOM[customType] === undefined) stats.unknownCustomTypes[customType] = (stats.unknownCustomTypes[customType] ?? 0) + 1
    switch (customType) {
      case 'user_todo_edit': {
        const phases = Array.isArray(entry.data?.phases) ? entry.data.phases : []
        const todos = []
        for (const ph of phases) {
          if (!isObj(ph)) continue
          const items = Array.isArray(ph.tasks) ? ph.tasks : Array.isArray(ph.items) ? ph.items : []
          for (const it of items) {
            if (!isObj(it)) continue
            const content = typeof it.content === 'string' ? it.content : typeof it.text === 'string' ? it.text : typeof it.title === 'string' ? it.title : ''
            if (content === '') continue
            const raw = String(it.status ?? 'pending')
            const status = raw === 'completed' || raw === 'done' ? 'completed' : raw === 'in_progress' || raw === 'in-progress' || raw === 'active' ? 'in_progress' : 'pending'
            todos.push({ content, status })
          }
        }
        if (todos.length === 0) return
        // Log-only, so it stays exactly where omp recorded it: closing the turn
        // here would strand the results of a call still in flight.
        ensureTurn()
        push('todo/write', { todos })
        break
      }
      case 'tool_execution_start': {
        const marker = entry.data
        if (typeof marker?.toolCallId === 'string' && typeof marker.intent === 'string') {
          const call = calls.get(marker.toolCallId)
          if (call) call.intent = marker.intent
        }
        break
      }
      default:
        break
    }
  }

  /** `compaction` → the four-step DSH lifecycle plus its surface replacement. */
  const emitCompaction = (entry) => {
    const summaryText = typeof entry.summary === 'string' ? entry.summary : ''
    if (summaryText === '') {
      stats.compaction.dropped += 1
      return
    }
    const kept = typeof entry.firstKeptEntryId === 'string' ? indexOf.get(entry.firstKeptEntryId) : undefined
    // Node 0 is excluded when it holds the system prompt: DSH protects it from
    // every replacement that is not another system/message over exactly that node.
    const floor = node0IsSystem ? 1 : 0
    // Shadow every CURRENT surface node produced by an entry before the kept
    // boundary. A boundary that left the seed (trimmed, reset, or off-branch) is
    // before the window, so nothing is shadowed.
    let upto = floor
    if (kept !== undefined) {
      while (upto < surfaceNodes.length && surfaceProducer[upto] < kept) upto += 1
    }
    const shadowed = surfaceNodes.slice(floor, Math.max(floor, upto))
    if (shadowed.length === 0) {
      // A budget may have removed its historical targets; NEVER lose the only
      // remaining knowledge checkpoint just because its replace span is absent.
      stepForInjection()
      push('user/message', { role: 'user', id: UUID(), source: { kind: `${namespace}:compaction-summary`, form: 'recall' }, content: [{ type: 'text', text: summaryText }] }, { surfaceOp: 'append' })
      stats.compaction.dropped += 1
      warnings.push('一个压缩摘要保留为回忆上下文；原遮蔽范围不在当前导入窗口中。')
      return
    }
    stats.compaction.mapped += 1

    const compactionId = `${namespace}-${entry.id ?? UUID()}`
    const start = shadowed[0]
    const end = shadowed[shadowed.length - 1]
    const summary = [{ type: 'text', text: summaryText }]
    const route = modelRoute(transcript.head)

    // The step is opened BEFORE the metering event, never between it and its
    // replacement: DSH's contract is that the replacement `user/message` comes
    // immediately after `compaction/summary`, and a consumer pairs the two.
    ensureTurn()
    if (stepOpen && stepHasAssistant) closeStep()
    if (!stepOpen) openStep()
    push('compaction/start', { compactionId, turn })
    const summaryEvent = push('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs: shadowed,
      // omp records the token counts of the summarized span; DSH's field is the
      // heuristic price of the shadowed nodes, which omp's measurement matches in kind.
      shadowedTokenCount: typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : 0,
      provider: route.provider,
      model: route.model,
    })
    const startEvent = events[events.length - 2]
    // The replacement is a REAL surface event: the summary text lives here, and
    // `sourceEventSeqs` must cite every node it shadows plus the metering event.
    const replacement = push('user/message', {
      role: 'user',
      id: UUID(),
      source: { kind: 'compact-checkpoint', compactionId },
      content: summary,
    }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowed] })
    // Mirror the fold's splice so a later compaction shadows the surface as it
    // now stands, not the append-ordered history that no longer exists.
    surfaceNodes.splice(floor, upto - floor, replacement.seq)
    surfaceProducer.splice(floor, upto - floor, Math.max(-1, kept - 1))
    // `end` closes the bracket immediately after the replacement, so the whole
    // start→summary→replacement→end lifecycle reads as one contiguous transaction.
    push('compaction/end', { compactionId, turn })
    closeStep()
  }

  const modelRoute = (head) => {
    const raw = typeof head.defaultModel === 'string' ? head.defaultModel : ''
    const slash = raw.indexOf('/')
    return slash === -1
      ? { provider: 'omp', model: raw || 'omp-import' }
      : { provider: raw.slice(0, slash) || 'omp', model: raw.slice(slash + 1) || 'omp-import' }
  }

  /* ---- walk -------------------------------------------------------------- */

  for (let i = 0; i < path.length; i++) {
    const entry = path[i]
    currentPathIndex = i
    stamp(entry)

    switch (entry.type) {
      case 'session':
        break // folded into the header by readTranscript
      case 'message':
        emitMessage(entry)
        break
      case 'custom_message':
        emitCustomMessage(entry)
        break
      case 'custom':
        emitCustom(entry)
        break
      case 'compaction':
        emitCompaction(entry)
        break
      case 'branch_summary': {
        const text = typeof entry.summary === 'string' ? entry.summary : ''
        if (text === '') break
        stepForInjection()
        push('developer/message', {
          turn,
          step,
          message: {
            id: UUID(),
            role: 'developer',
            source: { kind: 'omp:branch-summary' },
            content: [{ type: 'text', text: clip(`[branch summary from ${String(entry.fromId ?? 'root')}]\n${text}`, o.maxTextChars) }],
          },
        }, { surfaceOp: 'append' })
        break
      }
      case 'mode_change': {
        // Log-only, like todo/write: it must not close a step whose tool call is
        // still awaiting its result.
        ensureTurn()
        push('plan/mode', { active: entry.mode === 'plan' })
        break
      }
      case 'title_change':
        break // folded into the header; emitted once as session/title below
      case 'reset_boundary':
        break // applied as a trim before emission; unreachable here
      case 'session_init':
        break // consumed above
      case 'model_usage':
      case 'thinking_level_change':
      case 'service_tier_change':
      case 'label':
      case 'ttsr_injection':
      case 'credential_pin':
      case 'mcp_tool_selection':
        break
      default:
        // No silent default: classify() already recorded this type, so a format
        // bump shows up as an unclassified entry in the report instead of vanishing.
        break
    }

    // The title fold reads session/title events, and an automatic title must cite
    // at least one earlier HUMAN user/message — so it is emitted right after the
    // turn that carries one, never before it.
    if (!titleEmitted && firstHumanUserSeq !== null) {
      const title = typeof transcript.head.title === 'string' ? transcript.head.title.trim() : ''
      if (title !== '') {
        const human = transcript.head.titleSource === 'user'
        push('session/title', {
          title,
          // messageSeqs is empty iff the source is a user rename (DSH invariant).
          messageSeqs: human ? [] : [firstHumanUserSeq],
          source: human ? { kind: 'user' } : { kind: 'fallback' },
        })
      }
      titleEmitted = true
    }
  }

  // Cold snapshots may end during a historical call. A dangling tool-call block
  // is not runnable context; preserve its name/arguments as text instead.
  const settledCalls = new Set(events.filter(e => e.type === 'tool/result').map(e => e.data.message.toolCallId))
  let dangling = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    event.data.message.content = event.data.message.content.map(block => {
      if (block.type !== 'tool-call' || settledCalls.has(block.id)) return block
      dangling += 1
      return { type: 'text', text: `[历史工具调用 ${block.name}：原会话中尚无结果]\n${block.arguments}` }
    })
  }
  if (dangling) warnings.push(`${dangling} 个未完成历史工具调用已保留为文本，不会重新执行。`)
  closeTurn()

  stats.contextBytes = surfaceNodes.reduce((n, seq) => {
    const ev = events[seq]
    const message = ev.type === 'user/message' ? ev.data : ev.data.message
    return n + Buffer.byteLength(JSON.stringify(message.content))
  }, 0)
  if (stats.truncatedBlocks) warnings.push(`${stats.truncatedBlocks} 个文本块按导入上限截短，原始文件未被修改。`)
  if (stats.branchDropped) warnings.push(`${stats.branchDropped} 条旁支记录不在选定 root→leaf 路径中。`)
  if (stats.verdicts.unknown) warnings.push(`${stats.verdicts.unknown} 条未识别内容被跳过，请查看映射报告。`)
  const prepared = ensureProtectedSystemHead(events)
  stats.events = prepared.events.length
  stats.seedBytes = prepared.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e) ?? ''), 0)
  return { events: prepared.events, stats }
}

/* ──────────────────────────── coverage report ─────────────────────────── */

/**
 * Render the classification tables plus a measured pass over a transcript.
 *
 * The point is reconciliation: when either format bumps, this says which omp
 * types and fields are mapped, which are degraded, and which are dropped — and
 * which ones actually occurred — without re-reading both specifications.
 */
export function mappingReport(transcript, stats) {
  const lines = []
  const row = (k, v, extra) => lines.push(`  ${String(k).padEnd(24)} ${v.padEnd(9)} ${extra}`)
  lines.push(`${transcript.source ?? 'omp'} → DSH mapping coverage (normalized projection)`)
  lines.push('')
  lines.push(`ENTRIES (${Object.keys(ENTRIES).length} classified)`)
  for (const [k, v] of Object.entries(ENTRIES)) row(k, v.v, v.to ?? v.why ?? v.note ?? '')
  lines.push('')
  lines.push(`MESSAGE ROLES (${Object.keys(ROLES).length} classified)`)
  for (const [k, v] of Object.entries(ROLES)) row(k, v.v, v.to ?? v.why ?? v.note ?? '')
  lines.push('')
  lines.push(`CONTENT BLOCKS (${Object.keys(PARTS).length} classified)`)
  for (const [k, v] of Object.entries(PARTS)) row(k, v.v, v.to ?? v.why ?? v.note ?? '')
  lines.push('')
  lines.push(`CUSTOM TYPES (${Object.keys(CUSTOM).length} classified, ${Object.keys(CONTEXT_FORM).length} custom_message forms)`)
  for (const [k, v] of Object.entries(CUSTOM)) row(k, v.v, v.to ?? v.why ?? v.note ?? '')
  if (stats !== undefined) {
    lines.push('')
    lines.push('MEASURED')
    lines.push(`  entries on leaf path   ${stats.pathEntries}  (${stats.branchDropped} off-branch entries dropped)`)
    lines.push(`  reset_boundary trim    ${stats.resetTrimmed} entries`)
    lines.push(`  turns                  ${stats.turnsKept} kept of ${stats.turnsAvailable} (${stats.turnsShed} shed by budget)`)
    lines.push(`  events / seed bytes    ${stats.events} / ${stats.seedBytes}`)
    lines.push(`  model-visible bytes    ${stats.contextBytes} (the budget's unit)`)
    lines.push(`  images                 ${stats.images.total} (${stats.images.attached} attached, ${stats.images.placeholder} placeholder)`)
    lines.push(`  compaction             ${stats.compaction.mapped} mapped, ${stats.compaction.dropped} dropped`)
    lines.push(`  verdicts               ${JSON.stringify(stats.verdicts)}`)
    const un = { ...stats.unknownEntries, ...stats.unknownRoles, ...stats.unknownParts, ...stats.unknownCustomTypes }
    if (Object.keys(un).length > 0) lines.push(`  ⚠ UNCLASSIFIED        ${JSON.stringify(un)}`)
    const cms = Object.entries(stats.customMessages).sort((a, b) => b[1].count - a[1].count)
    if (cms.length > 0) {
      lines.push(`  custom_message types  ${cms.length}`)
      for (const [ct, row] of cms) lines.push(`      ${String(row.count).padStart(6)}  ${row.form ?? '(opaque)'}  ${ct}`)
    }
    if (stats.warnings?.length) for (const warning of new Set(stats.warnings)) lines.push(`  ⚠ ${warning}`)
    if (stats.noHome.length > 0) for (const n of new Set(stats.noHome)) lines.push(`  ⚠ no DSH home         ${n}`)
  }
  return lines.join('\n')
}

export { TITLE_SLOT_BYTES, CONTEXT_FORM }
