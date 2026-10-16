/** Session sources are read-only adapters. Browser input selects a catalog key, never a filename. */
import { readdirSync, statSync, lstatSync, openSync, readSync, closeSync, realpathSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { readTranscript } from './mapper.js'
import { createClaudeAdapter } from './adapters/claude.js'
import { createCodexAdapter } from './adapters/codex.js'
import { createOpenCodeAdapter } from './adapters/opencode.js'
import { createPiAdapter } from './adapters/pi.js'
import { createZCodeAdapter } from './adapters/zcode.js'

const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_CATALOG = 30000
export const sourceKey = (source, row) => `${source}:${createHash('sha256').update(JSON.stringify([row.path, row.locator ?? '', row.id])).digest('hex').slice(0, 32)}`
export function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function readHead(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(statSync(path).size, 65536))
    const count = readSync(fd, buf, 0, buf.length, 0)
    let slot, header
    for (const line of buf.subarray(0, count).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let item
      try { item = JSON.parse(line) } catch { break }
      if (item.type === 'title' && !header) slot = item
      if (item.type === 'session') { header = item; break }
    }
    return { header, slot }
  } finally { closeSync(fd) }
}
export function createOmpAdapter({ home = homedir(), config = {} } = {}) {
  const agentDir = resolve(config.agentDir ?? config.ompAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(home, '.omp', 'agent'))
  const roots = Array.isArray(config.roots) && config.roots.length ? config.roots.map(p => resolve(p)) : [join(agentDir, 'sessions')]
  return {
    id: 'omp', label: 'omp', description: 'Oh My Pi · JSONL 会话与分支路径', roots, blobDir: join(agentDir, 'blobs'),
    async scan() {
      const sessions = [], warnings = []
      for (const root of roots) {
        if (!existsSync(root)) continue
        for (const bucket of readdirSync(root, { withFileTypes: true })) {
          if (!bucket.isDirectory()) continue
          const bucketPath = join(root, bucket.name)
          for (const file of readdirSync(bucketPath, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
            if (sessions.length >= MAX_CATALOG) { warnings.push(`扫描达到 ${MAX_CATALOG} 条上限，请缩小来源目录。`); break }
            const path = join(bucketPath, file.name)
            try {
              const st = statSync(path), { header, slot } = readHead(path)
              if (!header || typeof header.id !== 'string') continue
              const childDir = path.slice(0, -6)
              let childSessions = 0
              if (existsSync(childDir) && lstatSync(childDir).isDirectory()) childSessions = readdirSync(childDir).filter(n => n.endsWith('.jsonl')).length
              sessions.push({ id: header.id, title: slot?.title || header.title || '', cwd: header.cwd || '', createdAt: header.timestamp || '', updatedAt: new Date(st.mtimeMs).toISOString(), project: basename(header.cwd || bucket.name), bytes: st.size, path, childSessions, importable: st.size <= MAX_FILE_BYTES })
            } catch (error) { warnings.push(`${file.name}: ${error.message}`) }
          }
        }
      }
      return { sessions, warnings }
    },
    async read(ref) {
      const transcript = readTranscript(ref.path)
      if (!transcript.head.id) throw new Error('不是有效的 omp 会话头。')
      return { ...transcript, source: 'omp', blobDir: join(agentDir, 'blobs'), adapterWarnings: [] }
    },
  }
}
const FACTORIES = [
  ['claude', 'Claude Code', createClaudeAdapter],
  ['codex', 'Codex CLI', createCodexAdapter],
  ['opencode', 'OpenCode', createOpenCodeAdapter],
  ['pi', 'pi', createPiAdapter],
  ['zcode', 'ZCode', createZCodeAdapter],
]
export async function createSourceRegistry({ home = homedir(), config = {}, adapters } = {}) {
  const sources = adapters ? [...adapters] : [createOmpAdapter({ home, config: { ...config.sources?.omp, ...(config.ompAgentDir ? { agentDir: config.ompAgentDir } : {}) } })]
  if (!adapters) {
    for (const [id, label, factory] of FACTORIES) {
      try {
        sources.push(factory({ home, config: config.sources?.[id] ?? {} }))
      } catch (error) {
        sources.push({ id, label, description: '适配器暂不可用', roots: [], status: 'error', scan: async () => ({ sessions: [], warnings: [`无法加载 ${label} 适配器：${error.message}`] }) })
      }
    }
  }
  const catalog = new Map()
  let scanning = null
  return {
    async scan() {
      if (scanning) return scanning
      scanning = (async () => {
        const next = new Map(), views = [], sessions = []
        for (const adapter of sources) {
          try {
            const result = await adapter.scan(), warnings = result.warnings ?? []
            const found = result.sessions ?? []
            const existingRoot = adapter.roots?.some(root => existsSync(root))
            const status = adapter.status ?? result.status ?? (found.length || existingRoot ? 'ready' : 'missing')
            for (const row of found.slice(0, Math.max(0, MAX_CATALOG - sessions.length))) {
              if (typeof row.path !== 'string' || typeof row.id !== 'string') continue
              const key = sourceKey(adapter.id, row)
              const normalized = { ...row, key, source: adapter.id, sourceLabel: adapter.label, project: row.project || basename(row.cwd || '') || '未知目录', bytes: row.bytes ?? 0, childSessions: row.childSessions ?? 0 }
              next.set(key, { adapter, row: normalized })
              sessions.push(normalized)
            }
            views.push({ id: adapter.id, label: adapter.label, description: adapter.description, status, count: found.length, root: adapter.roots?.join(', ') ?? '', warnings })
          } catch (error) { views.push({ id: adapter.id, label: adapter.label, status: 'error', count: 0, description: adapter.description, warnings: [error.message] }) }
        }
        catalog.clear()
        for (const [key, value] of next) catalog.set(key, value)
        sessions.sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
        return { sources: views, sessions, totals: { sessions: sessions.length, projects: new Set(sessions.map(s => s.cwd)).size, bytes: sessions.reduce((n, s) => n + s.bytes, 0) } }
      })()
      try { return await scanning } finally { scanning = null }
    },
    async select(input) {
      if (!catalog.size) await this.scan()
      let entry = typeof input.key === 'string' ? catalog.get(input.key) : undefined
      // Backward-compatible agent tools may specify a path, but only an exact catalog row.
      if (!entry && typeof input.path === 'string') {
        entry = [...catalog.values()].find(e => e.row.path === input.path && (!input.source || input.source === e.adapter.id))
      }
      if (!entry || (input.source && input.source !== entry.adapter.id)) throw Object.assign(new Error('会话不在所选来源的扫描列表中，请重新扫描后选择。'), { code: 'UNKNOWN_SESSION' })
      if (entry.row.importable === false) throw Object.assign(new Error(entry.row.unsupportedReason || '该会话的格式暂不支持导入。'), { code: 'UNSUPPORTED_FORMAT' })
      const file = realpathSync(entry.row.path)
      const validRoot = entry.adapter.roots?.some(root => {
        try { return isWithin(realpathSync(root), file) } catch { return false }
      })
      if (!validRoot) throw Object.assign(new Error('会话文件已移动或跳出了允许的来源目录。'), { code: 'PATH_OUTSIDE_SOURCE' })
      const st = statSync(file)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw Object.assign(new Error('会话必须是文件，且不超过 256 MiB。'), { code: 'SESSION_TOO_LARGE' })
      return { ...entry, fingerprint: createHash('sha256').update(`${entry.row.key}:${st.size}:${st.mtimeMs}`).digest('hex') }
    },
    async read(input) {
      const selection = await this.select(input)
      const transcript = await selection.adapter.read(selection.row)
      if (!transcript?.head || !Array.isArray(transcript.entries)) throw new Error('适配器没有返回有效会话。')
      transcript.source = selection.adapter.id
      transcript.images ??= []
      transcript.adapterWarnings ??= []
      // SQLite may change through its WAL without changing the main-file mtime.
      // Hash the normalized history too, so a new native turn isn't mistaken for a prior import.
      const fingerprint = createHash('sha256').update(selection.fingerprint).update(JSON.stringify(transcript.head)).update(JSON.stringify(transcript.entries)).digest('hex')
      return { ...selection, fingerprint, transcript }
    },
  }
}
export function checkedWorkspace(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
    throw Object.assign(new Error('工作目录不存在。请在导入选项中选择一个现有的绝对目录。'), { code: 'MISSING_WORKSPACE' })
  }
  return realpathSync(path)
}
export function validateImportOptions(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('导入选项必须是对象。')
  const integer = (name, fallback, min, max) => {
    const value = input[name] ?? fallback
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数。`)
    return value
  }
  for (const name of ['includeThinking', 'includeToolResults']) if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new Error(`${name} 必须是布尔值。`)
  return { maxTurns: integer('maxTurns', 150, 1, 10000), maxSeedBytes: integer('maxSeedBytes', 400000, 1024, 20000000), includeThinking: input.includeThinking !== false, includeToolResults: input.includeToolResults !== false }
}
export const normalizeProject = path => basename(path || '') || '未知目录'
export const catalogFile = row => dirname(row.path)
