/** Continuable DSH history must reserve its first surface node for the system prompt. */
import { randomUUID } from 'node:crypto'
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
export function needsProtectedSystemHead(input) {
  const first = input.find(event => SURFACE.has(event.type))
  return !!first && first.type !== 'system/message'
}
export function ensureProtectedSystemHead(input) {
  const position = input.findIndex(event => SURFACE.has(event.type))
  if (position < 0) return { events: input, changed: false, headSeq: null }
  if (input[position].type === 'system/message') return { events: input, changed: false, headSeq: input[position].seq }
  let turn = null, step = null
  for (const event of input.slice(0, position)) {
    if (event.type === 'turn/start') { turn = event.data.turn; step = null }
    if (event.type === 'turn/end') { turn = null; step = null }
    if (event.type === 'step/start') { if (event.data.turn !== turn) throw new Error('转换副本的首步骤不属于当前回合。'); step = event.data.step }
    if (event.type === 'step/end') step = null
  }
  if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1) throw new Error('转换副本的第一条消息没有有效的回合/步骤，无法建立 system 头。')
  input.forEach((event, index) => { if (event.seq !== index) throw new Error('转换副本事件编号不连续，不能调整引用。') })
  const events = structuredClone(input)
  const shifted = seq => Number.isSafeInteger(seq) && seq >= position ? seq + 1 : seq
  for (const event of events) {
    event.seq = shifted(event.seq)
    if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(shifted)
    if (event.surfaceOp && typeof event.surfaceOp === 'object') {
      event.surfaceOp.startSeq = shifted(event.surfaceOp.startSeq)
      event.surfaceOp.endSeq = shifted(event.surfaceOp.endSeq)
    }
    if (event.type === 'developer/message' && event.data.headerSeq !== undefined) event.data.headerSeq = shifted(event.data.headerSeq)
    if (event.type === 'session/title' || event.type === 'session/title-llm-request') event.data.messageSeqs = event.data.messageSeqs.map(shifted)
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      event.data.shadowedRange.start = shifted(event.data.shadowedRange.start)
      event.data.shadowedRange.end = shifted(event.data.shadowedRange.end)
      event.data.shadowedSeqs = event.data.shadowedSeqs.map(shifted)
    }
    // Tool-private metadata and references to OTHER sessions are deliberately unchanged.
  }
  events.splice(position, 0, { type: 'system/message', seq: position, time: input[position].time,
    data: { turn, step, message: { id: `import-system-head-${randomUUID()}`, role: 'system', source: { kind: 'system-prompt' }, content: [] } }, surfaceOp: 'append' })
  return { events, changed: true, headSeq: position }
}
