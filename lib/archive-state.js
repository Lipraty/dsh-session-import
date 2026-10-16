/** Consume DSH's canonical Workspace baseline, not its on-disk storage cache. */
export async function archivedSessionIds(ctx) {
  const control = new AbortController()
  const iterator = ctx.workspaceController.follow(control.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value.type !== 'baseline' || !Array.isArray(first.value.value.archivedSessionIds)) throw new Error('DSH 归档状态暂不可读取，未打开或恢复任何会话。')
    return new Set(first.value.value.archivedSessionIds)
  } finally {
    control.abort()
    await iterator.return?.()
  }
}
export async function requireUnarchived(ctx, sessionId) {
  if ((await archivedSessionIds(ctx)).has(sessionId)) throw Object.assign(new Error('这个 DSH 会话已归档，不能作为当前会话继续或打开。可从保留的独立副本重新导入。'), { code: 'SESSION_ARCHIVED' })
}
