import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createEngine } from '../lib/engine.js'
import { normalize } from '../lib/config.js'
import { buildReplyerRequest } from '../lib/reply.js'

const sourcePath = process.env.DSH_NATIVE_V4_SOURCE
export async function verifyNativeV4(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const start = source.indexOf('function source(message) {')
  assert.ok(start >= 0, 'installed codec must expose the source admission function')
  const end = source.indexOf('\n}', start) + 2
  const admitSource = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    isSessionFormatJsonObject: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    SessionFormatError: Error,
  })
  const config = normalize({
    planner: { enabled: false },
    memory: { enabled: false },
    learning: { enabled: false },
  })
  const engine = createEngine({
    store: { jobs: () => [] },
    config: () => config,
    llm: {
      stream() {
        throw Error('No model calls allowed')
      },
    },
  })
  const signal = new AbortController().signal
  const user = {
    id: 'existing-user',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '继续聊刚才的话题' }],
  }
  const agent = { session: { header: { id: 'native-compatibility', cwd: 'chat' } } }
  try {
    await engine.before({ agent, turn: 2, step: 1, signal, messages: [user] })
    const result = engine.admit(
      { agent, turn: 2, step: 1, signal },
      { kind: 'enter', messages: [user] },
    )
    const notice = result.messages.at(-1)
    assert.doesNotThrow(() => admitSource(user))
    assert.doesNotThrow(() => admitSource(notice))
    assert.equal(notice.source.kind, 'dsh-natural-dialogue')
    const reply = buildReplyerRequest({
      persona: config.persona,
      history: [{ id: user.id, role: 'user', text: '继续聊刚才的话题' }],
      current: [{ id: user.id, text: '继续聊刚才的话题' }],
      reference: '可选参考',
      conversational: true,
      chatChars: 240,
    })
    for (const message of reply.messages) assert.doesNotThrow(() => admitSource(message))
    assert.throws(
      () => admitSource({ ...notice, source: { kind: 'plugin', plugin: 'dsh-natural-dialogue' } }),
      /producer-owned/,
    )
  } finally {
    engine.dispose()
    await engine.drain()
  }
}
test(
  'installed v4 source admission accepts actual plugin notice and rejects retired wrappers',
  { skip: !sourcePath },
  () => verifyNativeV4(sourcePath),
)
