import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMemory } from '../lib/memory.js'
import { normalize, identity } from '../lib/config.js'
import { createEngine } from '../lib/engine.js'
import { PERSONAS, personaText } from '../lib/personas.js'
const user = {
  id: 'u1',
  role: 'user',
  content: [{ type: 'text', text: '我喜欢爵士乐' }],
  source: { kind: 'user' },
}
const assistant = {
  id: 'a1',
  role: 'assistant',
  content: [{ type: 'text', text: '我记下这个偏好了' }],
  source: { kind: 'model', provider: 'test', model: 'test' },
}
async function fixture(t, { fail = false, planner = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-engine-')),
    store = await openMemory(dir),
    calls = []
  let cfg = normalize({ planner: { enabled: planner } })
  const llm = {
    async *stream(opts) {
      calls.push(opts)
      assert.ok(opts.messages[0].id)
      if (fail) throw Error('provider unavailable')
      const result = opts.system.includes('规划器')
        ? { intent: 'chat', topic: '音乐', query: '爵士乐', stance: '自然交流' }
        : {
            items: [
              {
                kind: 'fact',
                subject: '用户',
                predicate: '音乐偏好',
                text: '喜欢爵士乐',
                evidence: ['喜欢爵士乐'],
                confidence: 0.95,
              },
              {
                kind: 'episode',
                subject: '用户',
                predicate: '音乐对话',
                text: '用户谈到喜欢爵士乐',
                evidence: ['喜欢爵士乐'],
                confidence: 0.9,
              },
            ],
          }
      yield { type: 'text-delta', text: JSON.stringify(result) }
    },
  }
  const agent = {
    id: 's1',
    options: { provider: 'test', model: 'test' },
    session: { header: { id: 's1', cwd: 'C:/chat' }, deriveMessages: () => [user, assistant] },
  }
  const engine = createEngine({ store, config: () => cfg, llm, rand: () => 0 })
  t.after(async () => {
    engine.dispose()
    await engine.drain()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { engine, store, calls, agent, llm, config: (c) => (cfg = normalize(c)) }
}
test('planning happens once per turn, tool steps reuse context, stable prompt does not vary', async (t) => {
  const f = await fixture(t),
    signal = new AbortController().signal,
    before = f.engine.stable(f.agent)
  await f.engine.before({ agent: f.agent, messages: [user], turn: 1, signal })
  const ctx = f.engine.context(signal)
  assert.match(ctx, /本轮/)
  await f.engine.before({ agent: f.agent, messages: [], turn: 1, signal })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(JSON.parse(f.calls[0].messages[0].content[0].text).persona, normalize().persona)
  assert.equal(f.engine.context(signal), ctx)
  assert.equal(f.engine.stable(f.agent), before)
  f.engine.after({ agent: f.agent, turn: 1 })
  await f.engine.drain()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(JSON.parse(f.calls[1].messages[0].content[0].text).persona, normalize().persona)
  const items = f.store.list(identity(f.agent, normalize()).namespace)
  assert.equal(items.find((x) => x.kind === 'fact').status, 'pending')
  assert.equal(items.find((x) => x.kind === 'episode').status, 'active')
})

test('complete personas reach stable identity; changing persona preserves memory namespace', async (t) => {
  const f = await fixture(t)
  const initialScope = identity(f.agent, normalize()).namespace
  for (const preset of PERSONAS) {
    const cfg = normalize({ persona: preset.persona })
    for (const key of ['name', 'personality', 'behavior', 'style']) assert.ok(cfg.persona[key], key)
    f.config(cfg)
    const stable = f.engine.stable(f.agent)
    assert.ok(stable.includes(personaText(preset.persona)))
    assert.match(stable, /示例当共同回忆/)
    assert.equal(identity(f.agent, cfg).namespace, initialScope)
  }
  assert.throws(() => normalize({ persona: { interests: 3 } }), /格式错误/)
  const legacy = normalize({
    persona: { name: '我自己的人格', personality: '冷静', style: '极简' },
  })
  assert.equal(legacy.persona.name, '我自己的人格')
  assert.equal(legacy.persona.style, '极简')
  assert.equal(legacy.persona.identity, '')
  assert.equal(legacy.persona.examples, '')
})

test('daily defaults keep a stable casual character without invented shared experiences', () => {
  const p = normalize().persona
  assert.equal(PERSONAS.length, 1)
  assert.equal(p.name, '余小渔')
  assert.match(p.identity, /女大学生/)
  assert.match(p.personality, /自己的.*判断/)
  assert.match(p.style, /简短.*口语/)
  assert.equal(p.probability, 0)
  assert.equal(p.alternates.length, 3)
  for (const key of ['relationship', 'interests', 'values', 'dislikes', 'examples'])
    assert.equal(p[key], '')
})

test('tool/plugin content is never learned as user facts; whale sessions are excluded', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  await f.engine.before({
    agent: f.agent,
    messages: [{ ...user, source: { kind: 'plugin', plugin: 'tool' } }],
    turn: 1,
    signal,
  })
  f.engine.after({ agent: f.agent, turn: 1 })
  await f.engine.drain()
  assert.equal(f.calls.length, 0)
  const whale = {
    ...f.agent,
    id: 'bili-whale',
    session: { ...f.agent.session, header: { id: 'bili-whale' } },
  }
  assert.equal(f.engine.stable(whale), '')
})
test('failed planner falls back and failed memory is queued; turning off stops contributions', async (t) => {
  const f = await fixture(t, { fail: true }),
    signal = new AbortController().signal
  await f.engine.before({ agent: f.agent, messages: [user], turn: 1, signal })
  assert.ok(f.engine.context(signal))
  f.engine.after({ agent: f.agent, turn: 1 })
  await f.engine.drain()
  assert.equal(f.store.jobs()[0].state, 'failed')
  f.config({ enabled: false })
  assert.equal(f.engine.stable(f.agent), '')
})

test('disabling automatic memory leaves persisted waiting jobs without new model calls', async (t) => {
  const f = await fixture(t),
    i = identity(f.agent, normalize())
  const id = f.store.source({
    namespace: i.namespace,
    session: 'old',
    turn: 1,
    user: '我喜欢爵士乐',
    assistant: '',
  })
  f.config({ memory: { automatic: false }, planner: { enabled: false } })
  await f.engine.before({
    agent: f.agent,
    messages: [user],
    turn: 2,
    signal: new AbortController().signal,
  })
  await f.engine.drain()
  assert.equal(f.calls.length, 0)
  assert.ok(f.store.jobs().some((j) => j.id === id))
})

test('continuation signals share one notice and all bindings are removed when the turn ends', async (t) => {
  const f = await fixture(t, { planner: false }),
    first = new AbortController().signal,
    second = new AbortController().signal
  await f.engine.before({ agent: f.agent, messages: [user], turn: 1, signal: first })
  const decision = { kind: 'enter', messages: [user] }
  assert.equal(
    f.engine.admit({ agent: f.agent, turn: 1, signal: first }, decision).messages.length,
    2,
  )
  assert.equal(f.engine.admit({ agent: f.agent, turn: 1, signal: second }, decision), decision)
  assert.ok(f.engine.replyState(first))
  assert.ok(f.engine.replyState(second))
  f.engine.after({ agent: f.agent, turn: 1 })
  assert.equal(f.engine.replyState(first), undefined)
  assert.equal(f.engine.replyState(second), undefined)
})

test('changing memory scope mid-turn cannot carry the conversation into the new namespace', async (t) => {
  const f = await fixture(t, { planner: false }),
    signal = new AbortController().signal
  await f.engine.before({ agent: f.agent, messages: [user], turn: 1, signal })
  f.engine.admit({ agent: f.agent, turn: 1, signal }, { kind: 'enter', messages: [user] })
  f.config({ scope: 'profile', planner: { enabled: false } })
  assert.equal(f.engine.replyState(signal), undefined)
  await f.engine.before({ agent: f.agent, messages: [user], turn: 1, signal })
  f.engine.after({ agent: f.agent, turn: 1 })
  await f.engine.drain()
  assert.equal(f.store.all('SELECT count(*) AS n FROM sources')[0].n, 0)
})

test('memory extraction finishing after disable does not commit items or consume a retry', async (t) => {
  const f = await fixture(t, { planner: false })
  let release, started
  const gate = new Promise((r) => (release = r)),
    begin = new Promise((r) => (started = r))
  f.llm.stream = async function* () {
    started()
    await gate
    yield {
      type: 'text-delta',
      text: JSON.stringify({
        items: [
          {
            kind: 'fact',
            subject: '用户',
            predicate: '偏好',
            text: '爵士乐',
            evidence: ['喜欢爵士乐'],
            confidence: 1,
          },
        ],
      }),
    }
  }
  await f.engine.before({
    agent: f.agent,
    messages: [user],
    turn: 1,
    signal: new AbortController().signal,
  })
  f.engine.after({ agent: f.agent, turn: 1 })
  await begin
  f.config({ memory: { enabled: false }, planner: { enabled: false } })
  release()
  await f.engine.drain()
  assert.equal(f.store.all('SELECT count(*) AS n FROM items')[0].n, 0)
  assert.equal(f.store.jobs()[0].state, 'pending')
  assert.equal(f.store.jobs()[0].attempts, 0)
})

test('queued extraction is deduplicated and records only the final visible assistant text', async (t) => {
  const f = await fixture(t, { planner: false })
  let release,
    started,
    calls = 0
  const gate = new Promise((r) => (release = r)),
    begin = new Promise((r) => (started = r))
  f.llm.stream = async function* () {
    calls++
    started()
    await gate
    yield { type: 'text-delta', text: '{"items":[]}' }
  }
  f.agent.session.deriveMessages = () => [
    user,
    {
      ...assistant,
      content: [
        { type: 'text', text: 'INTERNAL_PLAN' },
        { type: 'tool-call', name: 'test' },
      ],
    },
    { ...assistant, content: [{ type: 'text', text: '最终可见回复' }] },
  ]
  await f.engine.before({
    agent: f.agent,
    messages: [user],
    turn: 1,
    signal: new AbortController().signal,
  })
  f.engine.after({ agent: f.agent, turn: 1 })
  await begin
  const source = f.store.all('SELECT * FROM sources')[0]
  assert.equal(source.assistant, '最终可见回复')
  f.engine.enqueue(f.agent, source.id)
  f.engine.enqueue(f.agent, source.id)
  release()
  await f.engine.drain()
  assert.equal(calls, 1)
})

test('another workspace backlog cannot starve the current workspace queue', async (t) => {
  const f = await fixture(t, { planner: false }),
    i = identity(f.agent, normalize())
  for (let turn = 0; turn < 21; turn++)
    f.store.source({
      namespace: 'other',
      session: 'other',
      turn,
      user: '其他工作区的内容',
      assistant: '',
    })
  const own = f.store.source({
    namespace: i.namespace,
    session: 'own',
    turn: 1,
    user: '我喜欢爵士乐',
    assistant: '',
  })
  await f.engine.before({
    agent: f.agent,
    messages: [user],
    turn: 2,
    signal: new AbortController().signal,
  })
  await f.engine.drain()
  assert.equal(f.store.all('SELECT state FROM jobs WHERE id=?', [own])[0].state, 'done')
  assert.equal(f.store.all("SELECT count(*) AS n FROM jobs WHERE state='pending'")[0].n, 21)
})
