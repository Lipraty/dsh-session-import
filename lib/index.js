/** Multi-source copy migration. Historical tools are records, NEVER executed during import. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isWithin } from './source-registry.js'
import { createCopyImporter } from './copy-importer.js'

export const name = 'omp-import'
export const inject = ['tools', 'webServer', 'connection', 'agents', 'sessions', 'workspaceRegistry', 'attachments', 'sessionPersistence', 'sessionController', 'agentDefaultModel', 'systemPrompt', 'workspaceController']
const BODY_LIMIT = 16384
const error = (message, code, status = 400) => Object.assign(new Error(message), { code, status })

/** Decode embedded raster bytes or an omp content-addressed blob. No arbitrary path references. */
export async function commitImages(ctx, transcript, selected) {
  const refs = new Map(), warnings = []
  const limit = Math.min(ctx.attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, 20 * 1024 * 1024)
  for (const [blob, mediaType] of selected) {
    try {
      let bytes
      if (blob.startsWith('blob:sha256:') && transcript.source === 'omp') {
        const hash = blob.slice('blob:sha256:'.length)
        if (!/^[0-9a-f]{64}$/i.test(hash) || !transcript.blobDir) throw new Error('无效的 omp 图片哈希')
        const root = realpathSync(transcript.blobDir), target = realpathSync(join(root, hash))
        if (!isWithin(root, target) || statSync(target).size > limit) throw new Error('图片超限或超出来源 blob 目录')
        bytes = readFileSync(target)
      } else {
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(blob)
        const base64 = match ? match[2] : blob
        if (blob.startsWith('blob:') || blob.startsWith('http') || blob.startsWith('file:')) throw new Error('外部图片引用不自动读取')
        if (base64.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('图片编码无效或超限')
        bytes = Buffer.from(base64, 'base64')
        if (bytes.toString('base64') !== base64) throw new Error('非标准 base64 图片')
      }
      if (!bytes.length || bytes.length > limit) throw new Error('图片为空或超限')
      const actualType = /^data:(image\/[^;]+);/.exec(blob)?.[1] ?? mediaType
      const [ref] = await ctx.attachments.saveImages([{ data: new Uint8Array(bytes), mediaType: actualType }])
      if (ref) refs.set(blob, ref)
    } catch (failure) { warnings.push(`一张图片保留为文字占位：${failure.message}`) }
  }
  return { refs, warnings }
}

export function createImporter(ctx, config = {}, registry) {
  return createCopyImporter(ctx, config, registry, commitImages)
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function requestJson(req) {
  let size = 0, body = ''
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > BODY_LIMIT) throw error('请求体超过 16 KiB。', 'BODY_TOO_LARGE', 413)
    body += chunk
  }
  let value
  try { value = JSON.parse(body) } catch { throw error('请求 JSON 无效。', 'INVALID_JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('请求必须是对象。', 'INVALID_REQUEST')
  return value
}
export function apply(ctx, config = {}) {
  const importer = createImporter(ctx, config)
  function route(path, method, handler) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path,
      async handler(req, res) {
        // Use DSH's existing trust/auth boundary. Never inspect or forge stored credentials.
        const rejection = ctx.connection.requestRejection({ headers: req.headers })
        if (rejection) return respond(res, rejection, { ok: false, error: '请从已登录的 DSH 页面使用导入功能。', code: 'UNAUTHORIZED' })
        if (req.method !== method) return respond(res, 405, { ok: false, error: `只允许 ${method}。`, code: 'METHOD_NOT_ALLOWED' })
        if (method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { ok: false, error: '需要 application/json。', code: 'CONTENT_TYPE' })
        try { return respond(res, 200, await handler(req)) }
        catch (failure) { return respond(res, failure.status ?? 400, { ok: false, error: failure.message, code: failure.code ?? 'IMPORT_ERROR' }) }
      },
    }), `session-import: ${path}`)
  }
  route('/omp-import/list', 'GET', () => importer.list())
  route('/omp-import/preview', 'POST', async req => importer.preview(await requestJson(req)))
  route('/omp-import/do', 'POST', async req => importer.importSession(await requestJson(req)))
  route('/omp-import/sync', 'POST', async req => importer.sync(await requestJson(req)))
  route('/omp-import/report', 'GET', async req => {
    const url = new URL(req.url, 'http://localhost')
    return importer.preview({ key: url.searchParams.get('key') ?? undefined, path: url.searchParams.get('path') ?? undefined })
  })
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
  function tool(toolName, description, properties, required, run) {
    ctx.tools.register({ name: toolName, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output,
      async execute(args) { try { return JSON.stringify(await run(args ?? {}), null, 2) } catch (failure) { return `失败：${failure.message}` } },
    })
  }
  const selector = { key: { type: 'string', description: '扫描返回的会话 key。' }, path: { type: 'string', description: '兼容旧工具：必须完全匹配扫描列表中的路径。' }, source: { type: 'string', description: '来源 id：omp、claude、codex、opencode、pi 或 zcode。' } }
  const optionProperties = { maxTurns: { type: 'number', description: '兼容旧接口：副本现在完整转换，DSH 自己处理上下文。' }, maxSeedBytes: { type: 'number', description: '兼容旧接口：不再用此预算剪掉迁移副本。' }, includeThinking: { type: 'boolean' }, includeToolResults: { type: 'boolean' }, cwd: { type: 'string', description: '现有工作目录的绝对路径。' } }
  tool('session_import_scan', '只读扫描已支持来源的历史会话，返回可预览和导入的 key；不访问登录凭据。', { source: { type: 'string' }, limit: { type: 'number' }, project: { type: 'string' } }, [], async args => {
    const result = await importer.list()
    result.sessions = result.sessions.filter(row => (!args.source || row.source === args.source) && (!args.project || `${row.cwd} ${row.project}`.includes(args.project))).slice(0, Math.min(Math.max(args.limit ?? 40, 1), 200))
    return result
  })
  tool('session_import_preview', '预览一个已扫描会话的映射覆盖与降级信息，不创建会话。', { ...selector, ...optionProperties }, [], args => importer.preview(args))
  tool('session_import', '每次调用都从独立 DSH 副本创建新的对话；没有副本时先复制转换。不会复用、替换或归档任何旧会话。', { ...selector, ...optionProperties }, [], args => importer.importSession(args))
  tool('session_import_copy', '同步源存档到待导入的独立 DSH v4 副本。不创建或改动任何已导入会话，与旧会话是否继续无关。', selector, [], args => importer.sync(args))
  tool('session_import_check', '按明确的 sessionId 核对原生模型与 preset 初始化，不发送模型请求。副本不绑定任何会话。', { sessionId: { type: 'string' } }, ['sessionId'], args => importer.check(args))
  // Keep existing agent integrations working without granting arbitrary file access.
  tool('omp_scan', '只读扫描 omp 会话。新来源使用 session_import_scan。', { limit: { type: 'number' }, project: { type: 'string' } }, [], async args => {
    const result = await importer.list()
    return { ...result, sessions: result.sessions.filter(s => s.source === 'omp' && (!args.project || `${s.project} ${s.cwd}`.includes(args.project))).slice(0, Math.min(args.limit ?? 40, 200)) }
  })
  tool('omp_import', '导入扫描列表中的 omp 会话；其他来源使用 session_import。', { ...selector, ...optionProperties }, [], args => importer.importSession({ ...args, source: 'omp' }))
  tool('omp_mapping', '预览 omp 会话映射报告，原文件只读。', selector, [], args => importer.preview({ ...args, source: 'omp' }))
  // This is already a completed handwritten bundle: publish it through DSH's
  // own module graph, rather than inventing cache-busting file paths or servers.
  const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
  if (clientModules?.clientPath('dsh-session-import')) clientModules.rebuilt('dsh-session-import')
}
