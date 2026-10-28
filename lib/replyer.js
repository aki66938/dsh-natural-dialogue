import crypto from 'node:crypto'
import { human, textOf } from './config.js'
import { buildReplyerRequest } from './reply.js'

export function protectReference(text, { allowOmission = false } = {}) {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const entries = []
  const masked = text.replace(
    /```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>]+|(?:[A-Za-z]:[\\/]|[\p{L}\p{N}_.-]+[\\/]|\/)[\p{L}\p{N}_.\-\\/]+|\b[\p{L}\p{N}_.-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|json|md|ya?ml|toml|sql|html|css|sh|ps1)\b/gu,
    (value) => {
      const marker = `⟦ND_${nonce}_${entries.length}⟧`
      entries.push({ marker, value })
      return marker
    },
  )
  return {
    text: masked,
    restore(value) {
      for (const { marker, value: original } of entries) {
        const count = value.split(marker).length - 1
        if (count === 0 && allowOmission) continue
        if (count !== 1) throw Error('protected-reference-changed')
        value = value.replace(marker, original)
      }
      if (/⟦ND_/.test(value)) throw Error('unknown-reference-marker')
      const numbers = (s) =>
        new Set(
          s.replace(/^\s*\d+(?:\.(?!\d)|[)、])\s*/gm, '').match(/\d+(?:[.,]\d+)*(?:%|％)?/g) ?? [],
        )
      const expected = numbers(text),
        actual = numbers(value)
      if (
        (!allowOmission && [...expected].some((n) => !actual.has(n))) ||
        [...actual].some((n) => !expected.has(n))
      )
        throw Error('numeric-facts-changed')
      for (const status of ['暂停', '未发送', '未执行', '未提交', '未授权', '失败', '只读'])
        if (!allowOmission && text.includes(status) && !value.includes(status))
          throw Error('execution-status-omitted')
      for (const status of ['已发送', '已提交', '已发布', '已执行'])
        if (!text.includes(status) && value.includes(status))
          throw Error('execution-status-invented')
      return value
    },
  }
}

export function exactOutput(text, user) {
  if (/只(?:输出|返回).{0,12}(?:JSON|json|XML|xml|CSV|csv|代码|补丁)|原样输出|逐字输出/.test(user))
    return true
  const trimmed = text.trim()
  if (/^```[\s\S]*```$/.test(trimmed) || /^<\?xml\b/.test(trimmed)) return true
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function usageSum(a, b) {
  if (!a) return b
  if (!b) return a
  const result = {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  }
  for (const k of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'])
    if (a[k] !== undefined || b[k] !== undefined) result[k] = (a[k] ?? 0) + (b[k] ?? 0)
  if (a.totalTokens !== undefined && b.totalTokens !== undefined)
    result.totalTokens = a.totalTokens + b.totalTokens
  return result
}

function textFrom(chunks) {
  const parts = new Map(),
    closed = new Set()
  for (const c of chunks) {
    const index = c.index ?? 0
    if (c.type === 'text-delta' && !closed.has(index))
      parts.set(index, (parts.get(index) ?? '') + c.text)
    if (c.type === 'block-end' && c.block.type === 'text') {
      parts.set(index, c.block.text)
      closed.add(index)
    }
  }
  return [...parts.values()].join('\n\n')
}
const isTool = (c) =>
  c.type === 'tool-call-delta' ||
  (c.type === 'block-start' && c.blockType === 'tool-call') ||
  (c.type === 'block-end' && c.block.type === 'tool-call')
const supported = (c) =>
  !(
    (c.type === 'block-start' && !['text', 'reasoning', 'tool-call'].includes(c.blockType)) ||
    (c.type === 'block-end' && !['text', 'reasoning', 'tool-call'].includes(c.block.type))
  )

export function createReplyer({ llm, config, stateFor, status, lifetimeSignal, onTrace }) {
  const metrics = (status.replyer = {
    calls: 0,
    rendered: 0,
    fallback: 0,
    bypassed: 0,
    lastReason: null,
  })
  function trace(state, reason, draftChars, replyChars, mode) {
    const event = {
      at: new Date().toISOString(),
      session: state.agent?.session?.header?.id,
      turn: state.turn,
      reason,
      draftChars,
      replyChars,
      mode,
      layout: 'dialogue-roles-v1',
    }
    metrics.lastEvent = event
    try {
      onTrace?.(event)
    } catch {}
  }
  async function* replay(chunks, extraUsage) {
    if (!extraUsage) {
      yield* chunks
      return
    }
    const usage = usageSum(chunks.findLast((c) => c.type === 'usage')?.usage, extraUsage)
    let emitted = false
    for (const c of chunks) {
      if (c.type === 'usage') continue
      if (c.type === 'finish' && !emitted) {
        yield { type: 'usage', usage }
        emitted = true
      }
      yield c
    }
    if (!emitted) yield { type: 'usage', usage }
  }
  return async function* wrap(options, next) {
    const state = stateFor(options.signal),
      c = config()
    const stillActive = () => {
      const live = config()
      return live.enabled && live.replyer.enabled && stateFor(options.signal) === state
    }
    if (!state || !c.enabled || !c.replyer.enabled) {
      yield* await next()
      return
    }
    const chunks = []
    let bytes = 0,
      passthrough = false
    try {
      for await (const chunk of await next()) {
        options.signal?.throwIfAborted()
        if (passthrough) {
          yield chunk
          continue
        }
        chunks.push(chunk)
        bytes += JSON.stringify(chunk).length
        if (isTool(chunk) || !supported(chunk) || bytes > 2000000 || chunks.length > 40000) {
          metrics.bypassed++
          metrics.lastReason = isTool(chunk) ? 'tool-call' : 'unsupported-or-large-stream'
          yield* chunks
          chunks.length = 0
          passthrough = true
        }
      }
    } catch (error) {
      if (!options.signal?.aborted && !passthrough) yield* chunks
      throw error
    }
    if (passthrough) return
    options.signal?.throwIfAborted()
    const finish = chunks.findLast((x) => x.type === 'finish')
    const draft = textFrom(chunks)
    const user = state.messages.map((m) => m.text).join('\n')
    if (
      finish?.reason?.kind !== 'stop' ||
      !draft.trim() ||
      draft.length > 30000 ||
      exactOutput(draft, user)
    ) {
      metrics.bypassed++
      metrics.lastReason = 'non-final-or-exact-output'
      trace(state, metrics.lastReason, draft.length, draft.length, 'passthrough')
      yield* chunks
      return
    }
    let extraUsage,
      result = ''
    const conversational =
      ['chat', 'support'].includes(state.intent) &&
      !/详细|完整|逐条|清单|报告|全部列|一步步/.test(user)
    const mode = conversational ? 'conversation' : 'task'
    try {
      if (!stillActive()) throw Error('replyer-disabled-during-turn')
      const protectedDraft = protectReference(draft, { allowOmission: conversational })
      const history = state.agent.session
        .deriveMessages()
        .filter(
          (m) =>
            human(m) ||
            (m.role === 'assistant' &&
              m.source?.kind === 'model' &&
              !m.content.some((b) => b.type === 'tool-call')),
        )
        .slice(-10)
        .map((m) => ({
          id: m.id,
          source: m.source,
          role: m.role,
          text: textOf(m).slice(-3000),
        }))
      const request = buildReplyerRequest({
        persona: c.persona,
        history,
        current: state.messages,
        reference: protectedDraft.text,
        context: state.replyContext,
        conversational,
        chatChars: c.replyer.chatChars,
      })
      const signal = AbortSignal.any([
        options.signal ?? new AbortController().signal,
        lifetimeSignal ?? new AbortController().signal,
        AbortSignal.timeout(c.replyer.timeoutMs),
      ])
      signal.throwIfAborted()
      metrics.calls++
      status.calls++
      let replyFinish
      for await (const part of llm.stream({
        provider: options.provider,
        model: options.model,
        ...request,
        maxTokens: c.replyer.maxTokens,
        temperature: c.replyer.temperature,
        signal,
      })) {
        signal.throwIfAborted()
        if (part.type === 'text-delta') result += part.text
        if (part.type === 'usage') extraUsage = part.usage
        if (part.type === 'finish') replyFinish = part.reason
        if (isTool(part)) throw Error('replyer-attempted-tool-call')
        if (result.length > 50000) throw Error('replyer-output-too-large')
      }
      signal.throwIfAborted()
      if (!stillActive()) throw Error('replyer-disabled-during-turn')
      if (replyFinish?.kind !== 'stop' || !result.trim()) throw Error('replyer-incomplete')
      result = protectedDraft.restore(result.trim())
      options.signal?.throwIfAborted()
      const usage = usageSum(chunks.findLast((x) => x.type === 'usage')?.usage, extraUsage)
      metrics.rendered++
      metrics.lastReason = 'rendered'
      metrics.usageComplete = !!extraUsage && chunks.some((x) => x.type === 'usage')
      trace(state, 'rendered', draft.length, result.length, mode)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: result }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result } }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (options.signal?.aborted || lifetimeSignal?.aborted) throw error
      metrics.fallback++
      const known = [
        'protected-reference-changed',
        'unknown-reference-marker',
        'numeric-facts-changed',
        'execution-status-omitted',
        'execution-status-invented',
        'replyer-attempted-tool-call',
        'replyer-output-too-large',
        'replyer-incomplete',
        'replyer-disabled-during-turn',
      ]
      metrics.lastReason =
        error.name === 'TimeoutError'
          ? 'replyer-timeout'
          : known.includes(error.message)
            ? error.message
            : 'replyer-error'
      trace(state, metrics.lastReason, draft.length, result.length, mode)
      yield* replay(chunks, extraUsage)
    }
  }
}
