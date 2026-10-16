/** Import stores history; DSH's ordinary Session Controller owns its runnable Agent. */
import { requireUnarchived } from './archive-state.js'
export async function importedRuntimeOptions(ctx) {
  const { provider, model } = ctx.agentDefaultModel.currentSelection()
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) throw new Error('DSH 尚未选择可用的默认模型，请先在 DSH 选择模型。')
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  const preset = presets ? await presets.resolve() : undefined
  if (preset?.broken) throw new Error(`DSH preset 无法激活：${preset.broken}`)
  return { agentOptions: { provider, model }, ...(preset?.id ? { agentPreset: preset.id } : {}) }
}
export async function activateImportedSession(ctx, sessionId) {
  await requireUnarchived(ctx, sessionId)
  const result = await ctx.sessionController.resolveAgent(sessionId)
  if (result.error) throw Object.assign(new Error(`历史已保存，但 DSH 原生激活失败：${result.error.message}`), { code: result.error.code, sessionId })
  if (!result.agent) throw Object.assign(new Error('DSH 原生激活未返回 Agent。'), { sessionId })
  return result.agent
}

/** Dry prompt assembly verifies model-variable registration; never submits a model request. */
export async function checkImportedPrompt(ctx, sessionId) {
  const agent = await activateImportedSession(ctx, sessionId)
  const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  const builder = presets?.serviceFor(agent, 'systemPrompt') ?? ctx.systemPrompt
  // Exact context shape used by native assembleContextFor(agent).
  const assembly = await builder.assemble({ agent, scope: agent })
  const { provider, model } = assembly.variables
  if (typeof model !== 'string' || !model) throw new Error('DSH 原生提示组装仍缺少 model，未进行模型调用。')
  return { sessionId, promptReady: true, provider, model, agentPreset: presets?.composedPreset(agent.ctx) ?? null }
}
