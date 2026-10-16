/** Independent converted archives. Source locations are provenance for explicit sync, not runtime dependencies. */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isWithin } from './source-registry.js'
const hash = value => createHash('sha256').update(value).digest('hex')
export function createCopyStore(root) {
  const indexPath = join(root, 'index.json')
  let state = { version: 1, copies: {} }
  if (existsSync(indexPath)) {
    const value = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (value.version !== 1 || !value.copies || typeof value.copies !== 'object' || Array.isArray(value.copies)) throw new Error('DSH 转换副本索引版本不兼容；未覆盖原文件。')
    state = value
  }
  function atomic(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, path)
  }
  const store = {
    get: key => state.copies[key],
    all: () => Object.values(state.copies),
    save(key, row, sourceFingerprint, events, stats, warnings) {
      const source = row.source
      if (!/^[a-z][a-z0-9-]*$/.test(source)) throw new Error('来源名称无效。')
      const createdAt = Date.parse(row.createdAt)
      const header = { type: 'session', version: 4, id: `copy-${hash(key).slice(0, 32)}`, createdAt: Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : Date.now(), isSeeded: true, ...(row.cwd?.startsWith('/') ? { cwd: row.cwd } : {}) }
      // This is a constructor seed archive. DSH itself owns session/end-seed when imported.
      const body = [header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n'
      const revision = hash(body), copyPath = join(root, 'converted', source, `${hash(key)}.v4.jsonl`)
      atomic(copyPath, body)
      const firstSurface = events.find(event => ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type))
      const entry = { key, source, row, sourceFingerprint, revision, copyPath, copiedAt: new Date().toISOString(), stats, warnings, protectedSystemHead: firstSurface?.type === 'system/message' }
      store.put(key, entry)
      return entry
    },
    put(key, entry) {
      const next = { ...state, copies: { ...state.copies, [key]: entry } }
      atomic(indexPath, JSON.stringify(next))
      state = next
    },
    read(key) {
      const entry = store.get(key)
      if (!entry) throw new Error('尚未复制这个会话，请先复制或导入。')
      const path = realpathSync(entry.copyPath), trusted = realpathSync(join(root, 'converted'))
      if (!isWithin(trusted, path)) throw new Error('DSH 副本文件超出了转换目录。')
      const body = readFileSync(path, 'utf8')
      if (hash(body) !== entry.revision) throw new Error('DSH 副本与索引不一致，请重新同步；未读取原来源。')
      const lines = body.split('\n').filter(Boolean).map(line => JSON.parse(line))
      const header = lines.shift()
      if (header.type !== 'session' || header.version !== 4 || !header.isSeeded) throw new Error('副本不是受支持的 DSH v4 seed 存档。')
      lines.forEach((event, index) => { if (event.seq !== index) throw new Error('副本事件序列不连续。') })
      return { ...entry, header, events: lines }
    },
  }
  return store
}

