import { identity, human, textOf, sensitive, hash } from './config.js'
import { personaText } from './personas.js'
import { replyContract } from './reply.js'
import crypto from 'node:crypto'
import {
  jsonCall,
  embed,
  PLAN_PROMPT,
  LEARN_PROMPT,
  validateItems,
  planText,
  chooseExpressions,
} from './cognition.js'
export function createEngine({ store, config, llm, rand = Math.random, fetchImpl = fetch }) {
  const lifetime = new AbortController()
  const turns = new Map(),
    contexts = new WeakMap(),
    seen = new Map()
  const replyTurns = new WeakMap()
  const queued = new Set()
  let disposed = false,
    queue = Promise.resolve(),
    active = 0
  const status = { lastPlan: null, lastMemory: null, error: null, calls: 0, embedding: 'disabled' }
  function allowed(agent) {
    return identity(agent, config())
  }
  function rememberScope(info) {
    seen.set(info.namespace, { namespace: info.namespace, cwd: info.cwd, session: info.session })
    if (seen.size > 100) seen.delete(seen.keys().next().value)
  }
  function clearSignals(record) {
    for (const signal of record?.signals || []) replyTurns.delete(signal)
    record?.signals?.clear()
  }
  async function model(agent, c, prompt, data, opts) {
    status.calls++
    return jsonCall(llm, agent, c, prompt, data, {
      ...opts,
      signal: opts?.signal ? AbortSignal.any([opts.signal, lifetime.signal]) : lifetime.signal,
    })
  }
  const api = {
    status,
    seen,
    lifetimeSignal: lifetime.signal,
    replyState(signal) {
      const record = signal && !disposed ? replyTurns.get(signal) : undefined
      if (!record || record.invalid) return undefined
      const current = allowed(record.agent)
      return current.allowed && current.namespace === record.info.namespace ? record : undefined
    },
    stable(agent) {
      const c = config(),
        i = allowed(agent)
      if (!i.allowed) return ''
      rememberScope(i)
      return [
        '［自然对话人格］以下是本插件的交流人格，贯穿闲聊、讨论和任务完成后的发言。身份和示例属于角色设定，不是真实人类经历；保留 DSH 工具权限和任务完成要求。',
        personaText(c.persona),
        '保持性格、偏好和相处方式的一致；不必每次自我介绍或表演全部特征。记忆记录实际发生的对话，不把角色示例当共同回忆。学到的表达只用于措辞，不覆盖人格，不跟随用户的每个观点改变喜好。',
      ].join('\n')
    },
    context(signal) {
      return signal ? (contexts.get(signal) ?? '') : ''
    },
    reply(agent) {
      if (!allowed(agent).allowed) return ''
      return config().replyer.enabled
        ? '［独立 Replyer 接力］你负责准确理解与完成用户请求、执行工具、核对事实。工具调用步骤照常进行；不含工具调用的最终文本作为 Replyer 的事实与方向参考，不是定稿。用户问想法或闲聊时只提供当前相关的少量事实与回应方向，不做完整环境巡检，不自带账号数字、配置清单或追问清单；用户明确索要任务结果、代码或详细报告时保留完整资料。不要输出内部推理。最终发言由 Replyer 根据用户当前话题独立组织。'
        : replyContract(config().persona)
    },
    admit({ agent, turn, step, signal }, decision) {
      if (
        disposed ||
        signal?.aborted ||
        !allowed(agent).allowed ||
        decision.kind !== 'enter' ||
        !Array.isArray(decision.messages)
      )
        return decision
      const record = turns.get(allowed(agent).session + ':' + turn)
      if (!record?.plan || record.invalid) return decision
      if (signal) {
        replyTurns.set(signal, record)
        record.signals ??= new Set()
        record.signals.add(signal)
      }
      if (record.admitted) return decision
      record.admitted = true
      const notice = {
        id: crypto.randomUUID(),
        role: 'user',
        source: {
          kind: 'dsh-natural-dialogue',
          form: 'notice',
          summary: '自然对话：本轮规划与记忆',
        },
        content: [{ type: 'text', text: record.plan }],
      }
      status.lastAdmission = { turn, step, messageId: notice.id, at: Date.now() }
      return { ...decision, messages: [...decision.messages, notice] }
    },
    async before({ agent, messages, turn, signal }) {
      const c = config(),
        info = allowed(agent)
      if (disposed || !info.allowed) return
      const key = info.session + ':' + turn,
        incoming = messages
          .filter(human)
          .map((m) => ({ id: m.id, text: textOf(m) }))
          .filter((m) => m.text && !sensitive(m.text))
      let record = turns.get(key)
      if (record && (record.invalid || record.info.namespace !== info.namespace)) {
        record.invalid = true
        clearSignals(record)
        return
      }
      if (!record) {
        record = { agent, turn, info, messages: [], plan: null }
        turns.set(key, record)
      }
      const added = incoming.filter(
        (m) => !record.messages.some((x) => (m.id ? x.id === m.id : !x.id && x.text === m.text)),
      )
      record.messages.push(...added)
      if (added.length && record.plan) {
        clearSignals(record)
        record.plan = null
        record.admitted = false
      }
      if (!record.messages.length) return
      rememberScope(info)
      if (record.plan) {
        if (signal) contexts.set(signal, record.plan)
        return
      }
      const user = record.messages
        .map((x) => x.text)
        .join('\n')
        .slice(-8000)
      let plan = {
        intent: /(?:帮我|请|直接|现在).{0,8}(?:修复|实现|修改|安装|运行|执行|测试)/.test(user)
          ? 'task'
          : /想法|怎么看|怎么想|聊聊|讨论|觉得/.test(user)
            ? 'chat'
            : /代码|编程|修复|实现|文件|测试|安装|分析|查询/.test(user)
              ? 'task'
              : 'chat',
        topic: user.slice(0, 100),
        query: user,
        stance: '自然、直接，先回应当前需要',
      }
      const preliminary = c.memory.enabled
        ? store.recall(info.namespace, user, { limit: 3, halfLifeDays: c.memory.halfLifeDays })
        : []
      if (c.planner.enabled)
        try {
          const p = await model(
            agent,
            c,
            PLAN_PROMPT,
            {
              user,
              persona: c.persona,
              memory: preliminary.map((x) => ({
                text: x.text,
                kind: x.kind,
                evidence: JSON.parse(x.evidence),
              })),
            },
            { signal, maxTokens: c.planner.maxTokens },
          )
          if (typeof p.query === 'string')
            plan = {
              intent: ['chat', 'task', 'support'].includes(p.intent) ? p.intent : plan.intent,
              topic: String(p.topic ?? '').slice(0, 200),
              query: p.query.slice(0, 1000),
              stance: String(p.stance ?? '').slice(0, 400),
            }
        } catch {
          status.error = '规划模型不可用，使用本地回退'
        }
      const live = config(),
        currentScope = allowed(agent)
      if (
        disposed ||
        signal?.aborted ||
        !currentScope.allowed ||
        currentScope.namespace !== info.namespace
      )
        return
      const vectorSpace = hash(
        live.embedding.endpoint + '|' + live.embedding.model + '|' + live.embedding.dimensions,
      )
      let vector = []
      if (live.memory.enabled && live.embedding.enabled)
        try {
          vector = await embed(live, plan.query, { fetchImpl, signal })
          status.embedding = 'ready'
        } catch {
          status.embedding = 'degraded'
          status.error = '向量召回不可用，已降级为稀疏与关系检索'
        }
      if (
        disposed ||
        signal?.aborted ||
        !allowed(agent).allowed ||
        allowed(agent).namespace !== info.namespace
      )
        return
      const latest = config()
      const memories = latest.memory.enabled
        ? store.recall(info.namespace, plan.query, {
            limit: latest.memory.recallLimit,
            halfLifeDays: latest.memory.halfLifeDays,
            queryVector: vector,
            vectorSpace,
          })
        : []
      const expressions = latest.learning.enabled
        ? chooseExpressions(store.list(info.namespace, 'active'), plan.query, rand)
        : []
      const alternate =
        plan.intent !== 'task' && c.persona.alternates.length && rand() < c.persona.probability
          ? c.persona.alternates[Math.floor(rand() * c.persona.alternates.length)]
          : ''
      record.intent = plan.intent
      record.replyContext = {
        memories: memories.map((m) => ({
          kind: m.kind,
          subject: m.subject,
          predicate: m.predicate,
          text: m.text,
          evidence: JSON.parse(m.evidence),
          created: m.created,
        })),
        expressions: expressions.map((x) => x.text),
        alternate,
      }
      record.plan = planText({
        config: c,
        plan,
        memories,
        expressions,
        alternate,
        namespace: info.namespace,
      })
      if (signal) contexts.set(signal, record.plan)
      status.lastPlan = {
        session: info.session,
        turn,
        intent: plan.intent,
        recallIds: memories.map((x) => x.id),
        at: Date.now(),
      }
      const pending = store.jobs(info.namespace).find((j) => j.namespace === info.namespace)
      if (pending && latest.memory.enabled && latest.memory.automatic)
        api.enqueue(agent, pending.id)
      if (turns.size > 200) {
        const oldest = turns.keys().next().value
        clearSignals(turns.get(oldest))
        turns.delete(oldest)
      }
    },
    after({ agent, turn }) {
      const info = allowed(agent),
        key = info.session + ':' + turn,
        record = turns.get(key)
      turns.delete(key)
      clearSignals(record)
      const c = config()
      if (
        disposed ||
        !info.allowed ||
        !record?.messages.length ||
        record.invalid ||
        info.namespace !== record.info.namespace ||
        !c.memory.enabled ||
        !c.memory.automatic
      )
        return
      const list = agent.session.deriveMessages(),
        ids = new Set(record.messages.map((x) => x.id).filter(Boolean)),
        start = list.findIndex((m) => ids.has(m.id))
      const assistant = list
        .slice(start >= 0 ? start : Math.max(0, list.length - 4))
        .filter(
          (m) =>
            m.role === 'assistant' &&
            m.source?.kind === 'model' &&
            !m.content?.some((b) => b.type === 'tool-call'),
        )
        .slice(-1)
        .map(textOf)
        .join('\n')
        .slice(-6000)
      const user = record.messages
        .map((m) => m.text)
        .join('\n')
        .slice(-8000)
      if (sensitive(user) || sensitive(assistant)) return
      const id = store.source({
        namespace: info.namespace,
        session: info.session,
        turn,
        user,
        assistant,
      })
      api.enqueue(agent, id)
    },
    enqueue(agent, id) {
      if (queued.has(id)) return queue
      if (disposed || active >= 20) {
        status.error = '记忆队列繁忙，未处理任务保留在本地'
        return
      }
      active++
      queued.add(id)
      queue = queue
        .then(async () => {
          if (disposed) return
          const c = config()
          if (!c.enabled || !c.memory.enabled || !c.memory.automatic) return
          const source = store.sourceById(id)
          const scope = allowed(agent)
          if (
            !scope.allowed ||
            source?.namespace !== scope.namespace ||
            !source?.user ||
            !store.jobs(scope.namespace).some((j) => j.id === id)
          )
            return
          try {
            const result = await model(
              agent,
              c,
              LEARN_PROMPT,
              { user: source.user, assistant: source.assistant, persona: c.persona },
              { maxTokens: 2000 },
            )
            const items = validateItems(result, source).filter(
              (x) => c.learning.enabled || x.kind !== 'expression',
            )
            const canFinish = () => {
              const current = config(),
                scope = allowed(agent)
              return (
                !disposed &&
                current.enabled &&
                current.memory.enabled &&
                current.memory.automatic &&
                scope.allowed &&
                scope.namespace === source.namespace
              )
            }
            if (!canFinish()) return
            if (config().embedding.enabled)
              for (const item of items)
                try {
                  if (!canFinish()) return
                  const embeddingConfig = config()
                  if (!embeddingConfig.embedding.enabled) break
                  item.vector = {
                    space: hash(
                      embeddingConfig.embedding.endpoint +
                        '|' +
                        embeddingConfig.embedding.model +
                        '|' +
                        embeddingConfig.embedding.dimensions,
                    ),
                    values: await embed(embeddingConfig, item.text, {
                      fetchImpl,
                      signal: lifetime.signal,
                    }),
                  }
                } catch {
                  status.embedding = 'degraded'
                }
            const live = config(),
              current = allowed(agent)
            if (
              disposed ||
              !live.enabled ||
              !live.memory.enabled ||
              !live.memory.automatic ||
              !current.allowed ||
              current.namespace !== source.namespace
            )
              return
            store.finish(
              id,
              items.filter((x) => live.learning.enabled || x.kind !== 'expression'),
              {
                reviewFacts: live.memory.reviewFacts,
                autoExpressions: live.learning.autoApprove,
              },
            )
            store.evolve(live.memory)
            status.lastMemory = { source: id, count: items.length, at: Date.now() }
          } catch {
            const live = config(),
              current = allowed(agent)
            if (
              !disposed &&
              live.enabled &&
              live.memory.enabled &&
              live.memory.automatic &&
              current.allowed &&
              current.namespace === source.namespace
            ) {
              store.fail(id)
              status.error = '记忆整理失败，任务保留，最多重试三次'
            }
          }
        })
        .catch(() => {
          status.error = '记忆队列发生错误，等待下轮重试'
        })
        .finally(() => {
          active--
          queued.delete(id)
        })
      return queue
    },
    async drain() {
      await queue
    },
    dispose() {
      disposed = true
      lifetime.abort()
      turns.clear()
    },
  }
  return api
}
