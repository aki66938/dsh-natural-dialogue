import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setup as apply, apply as pluginApply } from '../lib/index.js'
import { normalize } from '../lib/config.js'
import { PERSONAS } from '../lib/personas.js'
import vm from 'node:vm'
const tick = () => new Promise((r) => setImmediate(r))
async function fixture(t, production = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-host-')),
    sections = [],
    contexts = [],
    handlers = {},
    routes = [],
    disposers = []
  let trusted = true,
    connection = true
  const ctx = {
    llm: {
      async *stream() {
        throw Error('No model calls permitted in this integration test')
      },
    },
    systemPrompt: {
      section: (s) => {
        sections.push(s)
        return () => {}
      },
      context: (c) => {
        contexts.push(c)
        return () => {}
      },
    },
    on: (name, fn) => {
      handlers[name] = fn
    },
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    inject: (_deps, fn) => fn(ctx),
    get connection() {
      return connection ? { requestRejection: () => (trusted ? null : 403) } : null
    },
    webServer: {
      register: (r) => {
        routes.push(r)
        return () => {}
      },
    },
  }
  const api = await (production ? pluginApply : apply)(ctx, { directory })
  t.after(async () => {
    for (const d of disposers.reverse()) d()
    await api?.engine.drain()
    await tick()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  async function request(route, body, method = body ? 'POST' : 'GET', host = '127.0.0.1', chunks) {
    const req = Readable.from(
      chunks ||
        (body === undefined
          ? []
          : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]),
    )
    req.url = '/natural-dialogue/api/' + route
    req.headers = { host }
    req.method = method
    let result
    const res = {
      setHeader() {},
      writeHead(status) {
        this.status = status
      },
      end(text) {
        result = { status: this.status, data: JSON.parse(text) }
      },
    }
    const pathname = new URL(req.url, 'http://localhost').pathname
    const matched = routes.find((r) =>
      r.kind === 'exact'
        ? pathname === r.path
        : pathname === r.path || pathname.startsWith(r.path + '/'),
    )
    assert.ok(matched, 'request must match the route using DSH prefix semantics')
    await matched.handler(req, res)
    return result
  }
  return {
    api,
    ctx,
    sections,
    contexts,
    handlers,
    directory,
    request,
    trust: (x) => (trusted = x),
    connection: (x) => (connection = x),
  }
}
test('production entry returns no invalid Cordis effect and exports its client bundle', async (t) => {
  const f = await fixture(t, true)
  assert.equal(f.api, undefined)
  assert.equal(f.sections.length, 2)
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.ok(fs.existsSync(new URL('../' + manifest.exports['./client'], import.meta.url)))
})
test('host registers separate stable/context contributions and preserves DSH pre-step result', async (t) => {
  const f = await fixture(t)
  assert.equal(f.sections[0].name, 'natural-dialogue:identity')
  assert.equal(f.contexts.length, 0)
  assert.equal(f.sections[1].name, 'natural-dialogue:reply')
  assert.ok(f.sections[1].order > 10200)
  assert.equal(f.sections[0].complete, undefined)
  const agent = { id: 's', session: { header: { id: 's', cwd: 'chat' } } }
  assert.match(f.sections[0].text({ agent }), /自然对话/)
  const expected = { kind: 'continue' }
  assert.equal(
    await f.handlers['agent/pre-step'](
      { agent, turn: 1, messages: [], signal: new AbortController().signal },
      async () => expected,
    ),
    expected,
  )
})

test('first request receives this turn plan after DSH assembles prompts, tool steps do not duplicate notices', async (t) => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  const user = {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '我已经安装养鱼插件，关于让你运营账号，你有什么想法？' }],
  }
  const agent = { id: 'chat', session: { header: { id: 'chat', cwd: 'chat' } } }
  const assembled = f.sections.map((s) => ({ name: s.name, text: s.text({ agent, signal }) }))
  const expected = { kind: 'enter', messages: [user], customHostFlag: true }
  const payload = { agent, signal, turn: 1, step: 1, messages: [user] }
  const result = await f.handlers['agent/pre-step'](payload, async () => expected)
  assert.equal(result.customHostFlag, true)
  assert.equal(result.messages[0], user)
  assert.equal(result.messages.length, 2)
  assert.equal(f.api.engine.status.lastPlan.intent, 'chat')
  assert.equal(result.messages[1].source.kind, 'dsh-natural-dialogue')
  assert.equal(result.messages[1].source.plugin, undefined)
  assert.match(result.messages[1].content[0].text, /回复信息参考/)
  assert.match(assembled.at(-1).text, /独立 Replyer 接力/)
  assert.match(assembled.at(-1).text, /内部推理/)
  const toolDecision = { kind: 'enter', messages: [] }
  assert.equal(
    await f.handlers['agent/pre-step'](
      { ...payload, step: 2, messages: [] },
      async () => toolDecision,
    ),
    toolDecision,
  )
  const rejected = { kind: 'reject', reason: 'host' }
  assert.equal(
    await f.handlers['agent/pre-step']({ ...payload, turn: 2 }, async () => rejected),
    rejected,
  )
  assert.equal(f.api.engine.status.lastAdmission.turn, 1)
  const correction = {
    ...user,
    id: 'u2',
    content: [{ type: 'text', text: '先别聊账号，改聊音乐吧。' }],
  }
  const redirected = await f.handlers['agent/pre-step'](
    { ...payload, step: 3, messages: [correction] },
    async () => ({ kind: 'enter', messages: [correction] }),
  )
  assert.equal(redirected.messages.length, 2)
  assert.match(redirected.messages[1].content[0].text, /改聊音乐/)
  assert.notEqual(redirected.messages[1].id, result.messages[1].id)
})
test('native hooks route the final stream to Replyer and memory records the visible reply', async (t) => {
  const f = await fixture(t)
  f.ctx.llm.stream = async function* (options) {
    const value = options.system.startsWith('你的名字是')
      ? '这事我想先聊聊方向。'
      : JSON.stringify({ items: [], query: '运营账号', intent: 'chat' })
    yield { type: 'text-delta', index: 0, text: value }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const signal = new AbortController().signal
  const user = {
    id: 'u',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '你对运营账号有什么想法？' }],
  }
  let final = ''
  const agent = {
    id: 's',
    options: { provider: 'test', model: 'test' },
    session: {
      header: { id: 's', cwd: 'chat' },
      deriveMessages: () =>
        final
          ? [
              user,
              {
                id: 'a',
                role: 'assistant',
                source: { kind: 'model' },
                content: [{ type: 'text', text: final }],
              },
            ]
          : [user],
    },
  }
  await f.handlers['agent/pre-step'](
    { agent, turn: 1, step: 1, signal, messages: [user] },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  const raw = async function* () {
    yield { type: 'text-delta', index: 0, text: '主模型的内部回复参考' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  for await (const chunk of f.handlers['llm/stream'](
    { provider: 'test', model: 'test', signal },
    raw,
  ))
    if (chunk.type === 'text-delta') final += chunk.text
  assert.equal(final, '这事我想先聊聊方向。')
  assert.equal(f.api.engine.status.replyer.rendered, 1)
  const events = (await f.request('status')).data.replyerEvents
  assert.equal(events.at(-1).reason, 'rendered')
  assert.equal(events.at(-1).turn, 1)
  assert.ok(
    !fs.readFileSync(path.join(f.directory, 'replyer-events.jsonl'), 'utf8').includes(final),
  )
  f.handlers['agent/turn-stopping']({ agent, turn: 1 })
  await f.api.engine.drain()
  assert.equal(f.api.store.all('SELECT assistant FROM sources')[0].assistant, final)
  assert.equal(f.api.engine.replyState(signal), undefined)
})

test('API rejects unsafe access and invalid config; settings persist and memory can be corrected', async (t) => {
  const f = await fixture(t)
  const initial = (await f.request('status')).data
  assert.equal(initial.personas.length, 1)
  assert.equal(initial.defaults.persona.name, '余小渔')
  assert.equal((await f.request('status', undefined, 'GET', 'evil.example')).status, 403)
  f.trust(false)
  assert.equal((await f.request('status')).status, 403)
  f.trust(true)
  f.connection(false)
  assert.equal((await f.request('status')).status, 503)
  f.connection(true)
  assert.equal((await f.request('settings', '{bad')).status, 400)
  assert.equal(
    (await f.request('settings', { config: { persona: { probability: 2 } } })).status,
    400,
  )
  const cfg = normalize({ enabled: false, persona: PERSONAS[0].persona })
  assert.equal((await f.request('settings', { config: cfg })).status, 200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'config.json'))).enabled, false)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.directory, 'config.json'))).persona.interests,
    PERSONAS[0].persona.interests,
  )
  const namespace = 'a'.repeat(24),
    source = f.api.store.source({
      namespace,
      session: 's',
      turn: 1,
      user: '我喜欢茶',
      assistant: '',
    })
  const id = f.api.store.finish(source, [
    {
      kind: 'fact',
      subject: '用户',
      predicate: '饮品',
      text: '茶',
      evidence: ['喜欢茶'],
      confidence: 0.9,
    },
  ])[0]
  assert.equal((await f.request('review', { id, action: 'approve' })).status, 200)
  assert.equal((await f.request('correct', { id, text: '喜欢咖啡' })).status, 200)
  const rows = (await f.request('memories?scope=' + namespace)).data.items
  assert.ok(rows.some((x) => x.text === '喜欢咖啡' && x.status === 'active'))
  assert.equal((await f.request('memories?scope=wrong')).status, 400)
})
test('settings UI renders configuration and memory management without triggering model calls', () => {
  let exported,
    cursor = 0
  const states = [
    {
      scopes: [],
      status: {},
      stats: {},
      config: normalize({ persona: { name: '测试', style: '测试口吻' } }),
      defaults: normalize(),
      personas: PERSONAS,
    },
    normalize({ persona: { name: '测试', style: '测试口吻' } }),
    '',
    [],
    '',
    false,
    null,
    '',
  ]
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect: () => {},
    useState(initial) {
      const i = cursor++
      if (!(i in states)) states[i] = initial
      return [states[i], (x) => (states[i] = typeof x === 'function' ? x(states[i]) : x)]
    },
  }
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          exported = factory(() => react)
        },
      },
    },
    fetch: () => {
      throw Error('unexpected request')
    },
  })
  const tree = exported.Settings(),
    text = JSON.stringify(tree)
  assert.match(text, /记忆管理/)
  assert.match(text, /辅助 provider/)
  assert.match(text, /事实记忆需人工确认/)
  assert.match(text, /向量/)
  const nodes = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    nodes.push(node)
    node.children?.forEach(walk)
  }
  walk(tree)
  const button = (label) => nodes.find((n) => n.type === 'button' && n.children[0] === label)
  button('使用「日常聊天」').props.onClick()
  assert.match(states[1].persona.style, /简短.*口语/)
  assert.equal(states[1].persona.name, '测试')
  assert.equal(states[1].persona.interests, PERSONAS[0].persona.interests)
  assert.deepEqual(JSON.parse(JSON.stringify(states[1].memory)), normalize().memory)
  cursor = 0
  assert.match(JSON.stringify(exported.Settings()), /有未保存的修改/)
  button('恢复默认表达').props.onClick()
  assert.equal(states[1].persona.style, normalize().persona.style)
  button('查看配置预览（不调用模型）').props.onClick()
  cursor = 0
  assert.match(JSON.stringify(exported.Settings()), /这不是生成效果预览/)
})

test('empty settings and stale revisions cannot reset or overwrite a saved character', async (t) => {
  const f = await fixture(t),
    initial = (await f.request('status')).data
  const cfg = normalize({ persona: { name: '已保存的角色' } })
  const saved = await f.request('settings', { config: cfg, revision: initial.configRevision })
  assert.equal(saved.status, 200)
  const file = path.join(f.directory, 'config.json'),
    bytes = fs.readFileSync(file, 'utf8')
  for (const body of [{}, { config: {} }, { config: null }, { config: [] }, 'null', '[]'])
    assert.equal((await f.request('settings', body, 'POST')).status, 400)
  assert.equal(
    (
      await f.request('settings', {
        config: normalize({ persona: { name: '过期草稿' } }),
        revision: initial.configRevision,
      })
    ).status,
    409,
  )
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.equal(f.api.config().persona.name, '已保存的角色')
})

test('split UTF-8 requests preserve Chinese and malformed encoding is rejected', async (t) => {
  const f = await fixture(t),
    cfg = normalize({ persona: { name: '余小渔', style: '你好呀🌿，慢慢说' } })
  const bytes = Buffer.from(JSON.stringify({ config: cfg })),
    chunks = [...bytes].map((x) => Buffer.from([x]))
  const saved = await f.request('settings', undefined, 'POST', '127.0.0.1', chunks)
  assert.equal(saved.status, 200)
  assert.equal(saved.data.config.persona.style, cfg.persona.style)
  assert.equal(
    (await f.request('settings', undefined, 'POST', '127.0.0.1', [Buffer.from([0xc3, 0x28])]))
      .status,
    400,
  )
})

test('atomic save failure preserves memory configuration and removes its temporary file', async (t) => {
  const f = await fixture(t)
  await f.request('settings', { config: normalize({ persona: { name: '原角色' } }) })
  const file = path.join(f.directory, 'config.json'),
    before = fs.readFileSync(file, 'utf8'),
    rename = fs.renameSync
  fs.renameSync = (source, destination) => {
    if (destination === file) throw Error('simulated disk failure')
    return rename(source, destination)
  }
  try {
    assert.equal(
      (await f.request('settings', { config: normalize({ persona: { name: '不应写入' } }) }))
        .status,
      400,
    )
  } finally {
    fs.renameSync = rename
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(f.api.config().persona.name, '原角色')
  assert.equal(fs.readdirSync(f.directory).filter((x) => x.endsWith('.tmp')).length, 0)
})

test('unavailable memory disables persistence while leaving character planning operational', async (t) => {
  const f = await fixture(t)
  await f.request('settings', { config: normalize({ planner: { enabled: false } }) })
  const second = await apply(f.ctx, { directory: f.directory })
  const user = {
    id: 'local',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '只是聊天' }],
  }
  const agent = {
    session: { header: { id: 'local', cwd: f.directory }, deriveMessages: () => [user] },
  }
  await second.engine.before({
    agent,
    messages: [user],
    turn: 1,
    signal: new AbortController().signal,
  })
  second.engine.after({ agent, turn: 1 })
  await second.engine.drain()
  assert.equal(second.engine.status.memoryAvailable, false)
  assert.match(second.engine.stable(agent), /余小渔/)
  assert.match(second.engine.status.error, /记忆库/)
  assert.throws(() => second.store.correct('missing', 'text'), /当前不可用/)
})

test('memory review refresh preserves unsaved persona edits and their original revision', async () => {
  const baseline = normalize(),
    draft = normalize({ persona: { style: '还没保存的口吻' } }),
    states = [
      { config: baseline, configRevision: 'old', scopes: [], jobs: [], stats: {}, status: {} },
      draft,
      'scope',
      [
        {
          id: 'm',
          kind: 'fact',
          status: 'pending',
          evidence: '["原话"]',
          source: 's',
          created: 1,
          subject: '用户',
          predicate: '喜好',
          text: '茶',
        },
      ],
      '',
      false,
      null,
      '',
      false,
    ]
  let client,
    cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useEffect() {},
    useState(v) {
      const i = cursor++
      if (!(i in states)) states[i] = v
      return [states[i], (x) => (states[i] = typeof x === 'function' ? x(states[i]) : x)]
    },
  }
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          client = factory(() => react)
        },
      },
    },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith('status')
            ? {
                ok: true,
                config: normalize({ persona: { style: '另一个页面的配置' } }),
                configRevision: 'new',
                scopes: [],
                jobs: [],
                stats: {},
                status: {},
              }
            : { ok: true },
        ),
    }),
  })
  const walk = (n) =>
    n && typeof n === 'object' ? [n, ...(n.children || []).flat(Infinity).flatMap(walk)] : []
  const button = walk(client.Settings()).find(
    (n) => n.type === 'button' && n.children[0] === '确认 / 恢复',
  )
  await button.props.onClick()
  assert.equal(states[1].persona.style, '还没保存的口吻')
  assert.equal(states[0].configRevision, 'old')
  assert.equal(states[0].config.persona.style, baseline.persona.style)
})
